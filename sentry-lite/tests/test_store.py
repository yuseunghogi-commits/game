from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from sentry.models import Finding, Severity, Status
from sentry.normalize import fingerprint
from sentry.scanners.base import ToolCoverage
from sentry.store import Store, StoreError

REPO = "yuseunghogi-commits/game"


def mk(
    rule: str = "r.xss",
    file: str = "a.js",
    snippet: str = "el.innerHTML = q",
    line: int = 3,
    tool: str = "semgrep",
    sev: Severity = Severity.medium,
    **meta: object,
) -> Finding:
    return Finding(
        id=fingerprint(rule, REPO, file, snippet),
        repo=REPO,
        source_tool=tool,
        rule_id=rule,
        title=f"{rule} in {file}",
        file=file,
        start_line=line,
        end_line=line,
        snippet=snippet,
        severity=sev,
        metadata=dict(meta),
    )


@pytest.fixture
def store(tmp_path: Path) -> Iterator[Store]:
    s = Store(tmp_path / "findings.db")
    yield s
    s.close()


def scan(store: Store, findings: list[Finding], coverages: list[ToolCoverage] | None = None):
    sid = store.create_scan(
        repo=REPO,
        root="/x",
        profile="web",
        since_ref=None,
        offline=False,
        git_head=None,
        scope_method="owner-verified",
    )
    cov = coverages if coverages is not None else [ToolCoverage("semgrep")]
    return sid, store.ingest(sid, REPO, findings, cov)


def test_new_findings_are_candidates_with_history(store: Store) -> None:
    _, res = scan(store, [mk(), mk(file="b.js")])
    assert len(res.new) == 2
    f = store.get(res.new[0][:8])
    assert f.status == Status.candidate and f.first_seen is not None
    assert store.history(f.id)[0]["kind"] == "created"


def test_rescan_preserves_verdict_and_refreshes_location(store: Store) -> None:
    a = mk(sev=Severity.medium)
    scan(store, [a])
    store.update(
        a.id,
        {
            "status": "likely",
            "severity": "high",
            "justification": "q from location.hash",
            "dataflow": [{"file": "a.js", "line": 1, "note": "source"}],
        },
        actor="claude-triage",
    )
    moved = mk(line=10, sev=Severity.low)  # same code, shifted down, scanner now says low
    _, res = scan(store, [moved])
    assert res.seen_again == [a.id]
    f = store.get(a.id)
    assert f.status == Status.likely and f.severity == Severity.high  # verdict + triaged severity kept
    assert f.justification == "q from location.hash" and f.dataflow[0].note == "source"
    assert f.start_line == 10 and f.metadata["scanner_severity"] == "low"


def test_untriaged_candidate_follows_scanner_severity(store: Store) -> None:
    scan(store, [mk(sev=Severity.medium)])
    scan(store, [mk(sev=Severity.high)])
    assert store.get(mk().id).severity == Severity.high


def test_disappeared_finding_becomes_fixed_pending_verification(store: Store) -> None:
    a, b = mk(), mk(file="b.js")
    scan(store, [a, b])
    store.update(a.id, {"status": "confirmed"}, actor="claude-verify")
    sid, res = scan(store, [b])
    assert res.auto_fixed == [a.id]
    f = store.get(a.id)
    assert f.status == Status.fixed and not f.fix_verified
    assert f.metadata["status_before_fixed"] == "confirmed"
    ev = store.history(a.id)[-1]
    assert ev["kind"] == "auto_fixed" and "pending verification" in ev["note"] and sid in ev["note"]


def test_reappearing_finding_is_reopened_with_previous_status(store: Store) -> None:
    a = mk()
    scan(store, [a])
    store.update(a.id, {"status": "likely"}, actor="claude-triage")
    scan(store, [])
    _, res = scan(store, [mk()])
    assert res.reopened == [a.id]
    f = store.get(a.id)
    assert f.status == Status.likely and "status_before_fixed" not in f.metadata
    assert store.history(a.id)[-1]["kind"] == "reopened"


def test_verified_fix_that_reappears_is_a_regression(store: Store) -> None:
    a = mk()
    scan(store, [a])
    store.update(a.id, {"status": "confirmed"}, actor="claude-verify")
    store.update(a.id, {"status": "fixed", "fix_verified": True}, actor="claude-fix")
    scan(store, [mk()])
    f = store.get(a.id)
    assert f.status == Status.confirmed and not f.fix_verified
    assert store.history(a.id)[-1]["kind"] == "regression"


def test_closed_verdicts_are_not_auto_fixed(store: Store) -> None:
    fp, wf = mk(), mk(file="c.js")
    scan(store, [fp, wf])
    store.update(fp.id, {"status": "triaged_fp", "justification": "escaped by framework"}, actor="claude-triage")
    store.update(wf.id, {"status": "wont_fix"}, actor="human")
    _, res = scan(store, [])
    assert res.auto_fixed == []
    assert store.get(fp.id).status == Status.triaged_fp and store.get(wf.id).status == Status.wont_fix


def test_coverage_limits_auto_fix(store: Store) -> None:
    a, b = mk(file="a.js"), mk(file="b.js")
    scan(store, [a, b])
    _, res = scan(store, [], [ToolCoverage("semgrep", files={"a.js"})])  # diff-aware scan of a.js only
    assert res.auto_fixed == [a.id]
    assert store.get(b.id).status == Status.candidate
    _, res2 = scan(store, [], [ToolCoverage("semgrep", skip_files={"b.js"})])  # semgrep errored on b.js
    assert res2.auto_fixed == []


def test_failed_tool_and_other_tools_are_not_auto_fixed(store: Store) -> None:
    sem = mk()
    hunt = mk(rule="claude.idor", tool="claude-hunt", snippet="db.doc(req.params.id)")
    leak = mk(
        rule="gitleaks.generic-api-key",
        tool="gitleaks",
        snippet="secret-sha256:aa",
        commits=[{"commit": "abc"}],
    )
    scan(store, [sem, hunt, leak], [ToolCoverage("semgrep"), ToolCoverage("gitleaks")])
    _, res = scan(store, [], [])  # every tool failed → no coverage
    assert res.auto_fixed == []
    _, res = scan(store, [], [ToolCoverage("gitleaks", history_findings_covered=False)])  # --since scan
    assert res.auto_fixed == []
    _, res = scan(store, [], [ToolCoverage("semgrep")])
    assert res.auto_fixed == [sem.id]
    assert store.get(hunt.id).status == Status.candidate


def test_add_for_hunt_findings(store: Store) -> None:
    f = mk(rule="claude.idor", tool="claude-hunt")
    f.status = Status.likely
    store.add(f, actor="claude-hunt", note="IDOR via doc id")
    assert store.get(f.id).status == Status.likely
    with pytest.raises(StoreError):
        store.add(f, actor="claude-hunt")


def test_update_validation_and_fixed_bookkeeping(store: Store) -> None:
    a = mk()
    scan(store, [a])
    with pytest.raises(StoreError):
        store.update(a.id, {"repo": "evil"}, actor="x")
    with pytest.raises(ValueError):
        store.update(a.id, {"status": "pwned"}, actor="x")
    with pytest.raises(ValueError):
        store.update(a.id, {"confidence": 2}, actor="x")
    store.update(a.id, {"status": "fixed"}, actor="claude-fix")
    assert store.get(a.id).metadata["status_before_fixed"] == "candidate"
    store.update(a.id, {"status": "likely"}, actor="human")
    assert "status_before_fixed" not in store.get(a.id).metadata
    hist = store.history(a.id)
    assert hist[-1]["data"]["status"] == {"old": "fixed", "new": "likely"}


def test_resolve_id_prefix(store: Store) -> None:
    a = mk()
    scan(store, [a])
    assert store.resolve_id(a.id[:6].upper()) == a.id
    with pytest.raises(StoreError):
        store.resolve_id("ab")
    with pytest.raises(StoreError):
        store.resolve_id("zzzz")
    with pytest.raises(StoreError):
        store.resolve_id("ffffffff")


def test_list_filters_and_order(store: Store) -> None:
    scan(
        store,
        [
            mk(sev=Severity.low),
            mk(file="b.js", sev=Severity.critical),
            mk(file="src/c.js", sev=Severity.high),
        ],
    )
    assert [f.file for f in store.list_findings()] == ["b.js", "src/c.js", "a.js"]
    assert [f.file for f in store.list_findings(severities=["high"])] == ["src/c.js"]
    assert [f.file for f in store.list_findings(file_prefix="src/")] == ["src/c.js"]
    assert len(store.list_findings(statuses=["confirmed"])) == 0
    assert store.counts(REPO)["candidate"] == {"low": 1, "critical": 1, "high": 1}


def test_consent_and_scans(store: Store) -> None:
    store.record_consent("/r", "h1", "i-own-this", "school project fork", "me")
    assert store.get_consent("/r", "h1") is not None
    assert store.get_consent("/r", "h2") is None
    sid, _ = scan(store, [mk()])
    store.finish_scan(sid, "ok", {"duration_s": 1})
    assert store.list_scans(REPO)[0]["summary"] == {"duration_s": 1}

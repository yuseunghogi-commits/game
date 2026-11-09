"""CLI end-to-end with scanners replaced by fakes that replay recorded outputs."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, ClassVar

import pytest
from typer.testing import CliRunner

from sentry import pipeline
from sentry.cli import app
from sentry.config import Paths
from sentry.normalize import semgrep_to_findings
from sentry.scanners.base import ScanContext, ScannerOutput, ToolCoverage

from .conftest import DATA, load_json

runner = CliRunner()
RULE_IDS = set(re.findall(r"- id: (\S+)", (DATA / "rec_rules.yaml").read_text()))


class ReplaySemgrep:
    """Returns the recorded semgrep results, optionally dropping some rules (simulating a fix)."""

    name = "semgrep"
    drop: ClassVar[set[str]] = set()

    def run(self, ctx: ScanContext) -> ScannerOutput:
        data = load_json("semgrep.json")
        findings, _ = semgrep_to_findings(data, root=ctx.root, repo=ctx.repo, local_rule_ids=RULE_IDS)
        findings = [f for f in findings if f.rule_id not in self.drop]
        return ScannerOutput(tool="semgrep", ok=True, findings=findings, coverage=ToolCoverage("semgrep"))


class Broken:
    name = "gitleaks"

    def run(self, ctx: ScanContext) -> ScannerOutput:
        raise RuntimeError("binary crashed")


@pytest.fixture
def fake_scanners(monkeypatch: pytest.MonkeyPatch) -> type[ReplaySemgrep]:
    ReplaySemgrep.drop = set()
    monkeypatch.setattr(pipeline, "ALL_SCANNERS", {"semgrep": ReplaySemgrep, "gitleaks": Broken})
    return ReplaySemgrep


def invoke(*args: str, input: str | None = None) -> Any:
    res = runner.invoke(app, list(args), input=input)
    return res


def jinvoke(*args: str, input: str | None = None) -> Any:
    res = invoke(*args, "--json", input=input)
    assert res.exit_code in (0, 3), res.output
    return json.loads(res.stdout)


def test_scan_triage_rescan_flow(home: Paths, owned_repo: Path, fake_scanners: type[ReplaySemgrep]) -> None:
    summary = jinvoke("scan", str(owned_repo))
    assert summary["repo"] == "yuseunghogi-commits/game" and summary["ingest"]["new"] == 4
    tools = {t["tool"]: t for t in summary["tools"]}
    assert tools["semgrep"]["ok"] and not tools["gitleaks"]["ok"] and "binary crashed" in tools["gitleaks"]["error"]
    assert (home.repo_dir("yuseunghogi-commits/game") / "inventory.json").is_file()

    listed = jinvoke("findings", "list", "--status", "candidate")
    assert len(listed) == 4 and listed[0]["severity"] == "high"
    eval_f = next(f for f in listed if f["rule_id"] == "rec.eval-user-input")

    shown = jinvoke("findings", "show", eval_f["id"][:8])
    assert shown["repo_root"] == str(owned_repo.resolve()) and shown["history"][0]["kind"] == "created"

    upd = {
        "status": "confirmed",
        "severity": "critical",
        "justification": "req.query.expr → eval, no auth",
        "dataflow": [
            {"file": "src/server.js", "line": 11, "note": "source req.query.expr"},
            {"file": "src/server.js", "line": 12, "note": "sink eval"},
        ],
        "note": "verified by PoC",
    }
    res = invoke(
        "findings",
        "update",
        eval_f["id"][:8],
        "--from-json",
        "-",
        "--actor",
        "claude-verify",
        input=json.dumps(upd),
    )
    assert res.exit_code == 0, res.output

    # confirmed critical → CI-style non-zero exit (3)
    res = invoke("scan", str(owned_repo), "--json")
    assert res.exit_code == 3
    assert json.loads(res.stdout)["blocking"] == [eval_f["id"]]
    kept = jinvoke("findings", "show", eval_f["id"])
    assert kept["status"] == "confirmed" and kept["justification"].startswith("req.query")

    # the eval disappears → auto-fixed pending verification, exit code back to 0
    fake_scanners.drop = {"rec.eval-user-input"}
    res = invoke("scan", str(owned_repo), "--json")
    assert res.exit_code == 0
    assert json.loads(res.stdout)["ingest"]["auto_fixed"] == 1
    hist = jinvoke("findings", "history", eval_f["id"])
    assert [h["kind"] for h in hist] == ["created", "updated", "auto_fixed"]
    assert hist[1]["actor"] == "claude-verify" and hist[1]["note"] == "verified by PoC"

    scans = jinvoke("scans", "list")
    assert len(scans) == 3 and scans[0]["status"] == "partial"
    assert jinvoke("repos")[0]["key"] == "yuseunghogi-commits/game"


def test_fail_on_candidate(home: Paths, owned_repo: Path, fake_scanners: type[ReplaySemgrep]) -> None:
    assert invoke("scan", str(owned_repo), "--fail-on", "candidate", "--json").exit_code == 3
    assert invoke("scan", str(owned_repo), "--fail-on", "never", "--json").exit_code == 0


def test_scope_refusal_exit_code(home: Paths, foreign_repo: Path, fake_scanners: type[ReplaySemgrep]) -> None:
    res = invoke("scan", str(foreign_repo))
    assert res.exit_code == 2 and "--i-own-this" in res.output
    assert invoke("scan", str(foreign_repo), "--i-own-this", "--scope-note", "old account", "--json").exit_code == 0
    assert invoke("scan", str(foreign_repo), "--json").exit_code == 0  # remembered for unchanged remotes
    audit = (home.logs / "audit.jsonl").read_text()
    assert '"ownership_confirmed"' in audit and "old account" in audit


def test_human_summary_renders(home: Paths, owned_repo: Path, fake_scanners: type[ReplaySemgrep]) -> None:
    res = invoke("scan", str(owned_repo), "--tools", "semgrep")
    assert res.exit_code == 0, res.output
    assert "Sentry-Lite scan" in res.output and "Top open findings" in res.output and "/triage" in res.output
    res = invoke("findings", "show", jinvoke("findings", "list")[0]["id"][:6])
    assert res.exit_code == 0 and "history" in res.output


def test_bad_inputs(home: Paths, owned_repo: Path, fake_scanners: type[ReplaySemgrep]) -> None:
    assert invoke("findings", "list", "--status", "bogus").exit_code == 1
    assert invoke("findings", "show", "abcd").exit_code == 1
    assert invoke("scan", str(owned_repo), "--tools", "nope").exit_code == 1
    assert invoke("scan", str(owned_repo), "--since", "--evil").exit_code != 0
    jinvoke("scan", str(owned_repo))
    fid = jinvoke("findings", "list")[0]["id"]
    assert invoke("findings", "update", fid).exit_code == 1  # nothing to update
    assert invoke("findings", "update", fid, "--status", "pwned").exit_code == 1
    assert invoke("findings", "update", fid, "--from-json", '{"repo": "x"}').exit_code == 1


def test_inventory_and_sarif_import(home: Paths, owned_repo: Path) -> None:
    inv = jinvoke("inventory", str(owned_repo))
    assert "Express" in inv["frameworks"] and inv["repo"] == "yuseunghogi-commits/game"
    res = invoke("import-sarif", str(DATA / "semgrep.sarif"), "--path", str(owned_repo), "--tool", "ext")
    assert res.exit_code == 0, res.output
    assert {f["source_tool"] for f in jinvoke("findings", "list")} == {"ext"}


def test_since_scan(home: Paths, owned_repo: Path, fake_scanners: type[ReplaySemgrep]) -> None:
    summary = jinvoke("scan", str(owned_repo), "--since", "HEAD~1", "--tools", "semgrep")
    assert summary["ingest"]["new"] == 4
    assert invoke("scan", str(owned_repo), "--since", "no-such-ref").exit_code == 1


def test_brackets_in_titles_and_paths_are_not_eaten_by_rich(
    home: Paths, owned_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sentry import cli
    from sentry.models import Finding
    from sentry.store import Store

    monkeypatch.setattr(cli.console, "width", 200)

    page = owned_repo / "pages" / "[id].tsx"
    page.parent.mkdir()
    page.write_text("el.innerHTML = q[0];\n")
    f = Finding(
        id="ab" * 20,
        repo="yuseunghogi-commits/game",
        source_tool="gitleaks",
        rule_id="x",
        title="하드코딩된 비밀값 [generic-api-key] — git",
        file="pages/[id].tsx",
        snippet="q[0] [bold]x[/]",
    )
    with Store(home.db) as store:
        store.add(f, actor="test")
    listed = invoke("findings", "list")
    assert "[generic-api-key]" in listed.output and "[id].tsx" in listed.output
    shown = invoke("findings", "show", "abab")
    assert shown.exit_code == 0 and "q[0] [bold]x[/]" in shown.output

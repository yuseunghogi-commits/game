from __future__ import annotations

import copy
import re
from pathlib import Path
from typing import Any

from sentry.models import Finding, Severity
from sentry.normalize import (
    canonical_rule_id,
    extract_cwes,
    fingerprint,
    gitleaks_to_findings,
    osv_to_findings,
    redact,
    sarif_to_findings,
    semgrep_to_findings,
    to_rel,
)

from .conftest import DATA, LEAKED_KEY, load_json

REC_RULE_IDS = set(re.findall(r"- id: (\S+)", (DATA / "rec_rules.yaml").read_text()))


def test_fingerprint_ignores_whitespace_and_path_separators() -> None:
    a = fingerprint("r1", "o/repo", "src\\a.js", "x  =\n  1")
    b = fingerprint("r1", "o/repo", "./src/a.js", " x = 1 ")
    assert a == b
    assert fingerprint("r2", "o/repo", "src/a.js", "x = 1") != a
    assert fingerprint("r1", "o/repo", "src/a.js", "x = 1", occurrence=1) != a
    assert fingerprint("r1", "o/other", "src/a.js", "x = 1") != a


def test_canonical_rule_id_strips_install_path_prefix() -> None:
    ids = {"sentry.dom-xss", "dom-xss"}
    assert canonical_rule_id("C.Users.me.sentry-lite.rules.sentry.dom-xss", ids) == "sentry.dom-xss"
    assert canonical_rule_id("sentry.dom-xss", ids) == "sentry.dom-xss"
    assert canonical_rule_id("javascript.express.xss", ids) == "javascript.express.xss"


def test_extract_cwes_formats() -> None:
    assert extract_cwes("CWE-79: Improper Neutralization") == ["CWE-79"]
    assert extract_cwes(["CWE-095: Eval", "cwe-79", "external/cwe/cwe-022"]) == ["CWE-95", "CWE-79", "CWE-22"]
    assert extract_cwes(None) == []


def test_semgrep_recorded_output(rec_app: Path) -> None:
    findings, failed = semgrep_to_findings(
        load_json("semgrep.json"), root=rec_app, repo="o/rec", local_rule_ids=REC_RULE_IDS
    )
    assert failed == set()
    assert len(findings) == 4
    by_rule = {f.rule_id: f for f in findings}
    assert set(by_rule) == REC_RULE_IDS  # path prefix removed
    xss = by_rule["rec.express-reflected-xss"]
    assert xss.severity == Severity.high
    assert xss.cwe == ["CWE-79"]
    assert xss.confidence == 0.5
    assert "res.send(" in xss.snippet and "requires login" not in xss.snippet
    assert xss.file == "src/server.js" and xss.start_line == 7
    dom = [f for f in findings if f.rule_id == "rec.dom-innerhtml"]
    assert len(dom) == 2 and dom[0].id != dom[1].id
    assert dom[0].severity == Severity.medium
    assert all(len(f.id) == 40 for f in findings)


def test_semgrep_ids_are_line_number_independent(rec_app: Path) -> None:
    data = load_json("semgrep.json")
    before, _ = semgrep_to_findings(data, root=rec_app, repo="o/rec", local_rule_ids=REC_RULE_IDS)
    server = rec_app / "src/server.js"
    server.write_text("// header\n// added\n\n" + server.read_text())
    shifted = copy.deepcopy(data)
    for r in shifted["results"]:
        if r["path"] == "src/server.js":
            r["start"]["line"] += 3
            r["end"]["line"] += 3
    after, _ = semgrep_to_findings(shifted, root=rec_app, repo="o/rec", local_rule_ids=REC_RULE_IDS)
    assert {f.id for f in before} == {f.id for f in after}
    assert {f.start_line for f in after if f.file == "src/server.js"} == {10, 15}


def test_semgrep_identical_snippets_get_occurrence_ids(rec_app: Path) -> None:
    (rec_app / "dup.js").write_text("el.innerHTML = x;\nfoo();\nel.innerHTML = x;\n")
    res: dict[str, Any] = {
        "check_id": "dup.rule",
        "path": "dup.js",
        "start": {"line": 1},
        "end": {"line": 1},
        "extra": {"message": "m", "severity": "ERROR", "metadata": {}},
    }
    res2 = copy.deepcopy(res)
    res2["start"]["line"] = res2["end"]["line"] = 3
    dup_again = copy.deepcopy(res)  # semgrep reporting the same location twice is collapsed
    findings, _ = semgrep_to_findings({"results": [res2, res, dup_again]}, root=rec_app, repo="o/r")
    assert len(findings) == 2
    first = next(f for f in findings if f.start_line == 1)
    assert first.id == fingerprint("dup.rule", "o/r", "dup.js", "el.innerHTML = x;")


def test_semgrep_errors_mark_files_as_failed(rec_app: Path) -> None:
    data = {
        "results": [],
        "errors": [
            {"level": "error", "type": "Timeout", "path": "src/server.js"},
            {"level": "info", "path": "public/app.js"},
        ],
    }
    _, failed = semgrep_to_findings(data, root=rec_app, repo="o/r")
    assert failed == {"src/server.js"}


def _gitleaks_records() -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = load_json("gitleaks_dir.json") + load_json("gitleaks_git.json")
    return records


def test_gitleaks_redacts_and_classifies_exposure(rec_app: Path) -> None:
    findings = gitleaks_to_findings(
        _gitleaks_records(), root=rec_app, repo="o/rec", tracked={"src/config.js"}, ignored={".env"}
    )
    assert len(findings) == 3
    dumped = "\n".join(f.model_dump_json() for f in findings)
    for rec in _gitleaks_records():
        assert rec["Secret"] not in dumped
    assert LEAKED_KEY not in dumped
    by_loc = {(f.file, f.start_line): f for f in findings}
    vite = by_loc[(".env", 1)]
    assert vite.metadata["exposure"] == "client-bundle" and vite.severity == Severity.high
    assert vite.metadata["env_var"] == "VITE_ADMIN_TOKEN"
    assert "[REDACTED 32 chars]" in vite.snippet
    db = by_loc[(".env", 2)]
    assert db.metadata["exposure"] == "local-ignored-file" and db.severity == Severity.low
    hist = by_loc[("src/config.js", 2)]
    assert hist.metadata["exposure"] == "committed" and hist.severity == Severity.high
    assert hist.metadata["commits"][0]["commit"] == "b6f20f001adc"
    assert hist.cwe == ["CWE-798"]


def test_gitleaks_same_secret_in_tree_and_history_is_one_finding(rec_app: Path) -> None:
    rec = load_json("gitleaks_git.json")[0]
    wt = dict(rec, Commit="", StartLine=5, EndLine=5)
    findings = gitleaks_to_findings([rec, wt], root=rec_app, repo="o/r", tracked={"src/config.js"}, ignored=set())
    assert len(findings) == 1
    f = findings[0]
    assert f.start_line == 5 and f.metadata["in_working_tree"] and f.metadata["commits"]


def test_gitleaks_firebase_web_key_is_info(rec_app: Path) -> None:
    (rec_app / "src/firebase.js").write_text('const cfg = { apiKey: "AIzaFAKE", authDomain: "x.firebaseapp.com" };\n')
    rec = {
        "RuleID": "gcp-api-key",
        "Description": "GCP API key",
        "StartLine": 1,
        "EndLine": 1,
        "Match": 'apiKey: "AIza-FAKE-not-a-real-key-000"',
        "Secret": "AIza-FAKE-not-a-real-key-000",
        "File": "src/firebase.js",
        "Commit": "",
    }
    (f,) = gitleaks_to_findings([rec], root=rec_app, repo="o/r", tracked={"src/firebase.js"}, ignored=set())
    assert f.severity == Severity.info
    assert f.metadata["exposure"] == "firebase-web-config"
    assert "App Check" in (f.fix_suggestion or "")


def test_redact() -> None:
    assert redact("short") == "[REDACTED]"
    assert redact("A" * 30) == "AAAA…[REDACTED 30 chars]"


def test_osv_recorded_output(rec_app: Path) -> None:
    data = load_json("osv.json", rec_app)
    findings, stats = osv_to_findings(data, root=rec_app, repo="o/rec", imported={"npm": {"lodash", "express"}})
    assert stats == {"vulns_total": 3, "kept": 3, "dropped_no_fix_unreachable": 0}
    by_rule = {f.rule_id: f for f in findings}
    mini = by_rule["osv.GHSA-xvch-5gv4-984h"]
    assert mini.severity == Severity.critical
    assert mini.metadata["imported"] is False and mini.confidence == 0.3
    assert "1.2.6" in (mini.fix_suggestion or "")
    lodash = by_rule["osv.GHSA-35jh-r3h4-6jhm"]
    assert lodash.severity == Severity.high and lodash.metadata["reachable"] is True
    assert lodash.file == "package-lock.json" and lodash.start_line > 1
    assert lodash.cwe == ["CWE-77", "CWE-94"]
    assert "CVE-2021-23337" in lodash.metadata["aliases"]
    assert by_rule["osv.GHSA-29mw-wpgm-hmr9"].severity == Severity.medium


def test_osv_drops_unfixable_unreachable_and_keeps_imported(rec_app: Path) -> None:
    data = load_json("osv.json", rec_app)
    for result in data["results"]:
        for pkg in result["packages"]:
            for v in pkg["vulnerabilities"]:
                for aff in v["affected"]:
                    for rng in aff["ranges"]:
                        rng["events"] = [e for e in rng["events"] if "fixed" not in e]
    _, stats = osv_to_findings(data, root=rec_app, repo="o/r", imported={"npm": set()})
    assert stats["kept"] == 0 and stats["dropped_no_fix_unreachable"] == 3
    kept, stats2 = osv_to_findings(data, root=rec_app, repo="o/r", imported={"npm": {"lodash"}})
    assert stats2["kept"] == 2 and {f.metadata["package"] for f in kept} == {"lodash"}
    assert all("수정 버전이 없습니다" in (f.fix_suggestion or "") for f in kept)


def test_osv_fingerprint_survives_version_bump(rec_app: Path) -> None:
    data = load_json("osv.json", rec_app)
    before, _ = osv_to_findings(data, root=rec_app, repo="o/r", imported={})
    for result in data["results"]:
        for pkg in result["packages"]:
            if pkg["package"]["name"] == "minimist":
                pkg["package"]["version"] = "1.2.5-patched"
    after, _ = osv_to_findings(data, root=rec_app, repo="o/r", imported={})
    assert {f.id for f in before} == {f.id for f in after}


def test_sarif_import(rec_app: Path) -> None:
    findings = sarif_to_findings(load_json("semgrep.sarif"), root=rec_app, repo="o/r", tool_name="semgrep-sarif")
    assert len(findings) == 2
    assert all(f.source_tool == "semgrep-sarif" for f in findings)
    assert {tuple(f.cwe) for f in findings} == {("CWE-79",), ("CWE-95",)}
    assert all(f.snippet for f in findings)


def test_sarif_file_uri_and_codeflow(rec_app: Path) -> None:
    uri = (rec_app / "src/server.js").resolve().as_uri()
    data = {
        "runs": [
            {
                "tool": {
                    "driver": {
                        "name": "X",
                        "rules": [
                            {
                                "id": "x1",
                                "properties": {"security-severity": "9.1", "tags": ["external/cwe/cwe-089"]},
                            }
                        ],
                    }
                },
                "results": [
                    {
                        "ruleId": "x1",
                        "message": {"text": "SQLi. More."},
                        "locations": [
                            {
                                "physicalLocation": {
                                    "artifactLocation": {"uri": uri},
                                    "region": {"startLine": 12},
                                }
                            }
                        ],
                        "codeFlows": [
                            {
                                "threadFlows": [
                                    {
                                        "locations": [
                                            {
                                                "location": {
                                                    "physicalLocation": {
                                                        "artifactLocation": {"uri": "src/server.js"},
                                                        "region": {"startLine": 11},
                                                    },
                                                    "message": {"text": "source"},
                                                }
                                            }
                                        ]
                                    }
                                ]
                            }
                        ],
                    }
                ],
            }
        ]
    }
    (f,) = sarif_to_findings(data, root=rec_app, repo="o/r")
    assert f.file == "src/server.js" and f.severity == Severity.critical and f.cwe == ["CWE-89"]
    assert f.title == "SQLi." and f.dataflow[0].line == 11 and f.source_tool == "x"


def test_to_rel(rec_app: Path) -> None:
    assert to_rel(str(rec_app / "src" / "server.js"), rec_app) == "src/server.js"
    assert to_rel("./src/x.js", rec_app) == "src/x.js"


def test_finding_validation() -> None:
    f = Finding(id="a" * 40, source_tool="t", rule_id="r", title="t", file="f", start_line=0, confidence=0.12345)
    assert f.start_line == 1 and f.confidence == 0.123 and f.short_id == "a" * 10
    try:
        Finding(id="x", source_tool="t", rule_id="r", title="t", file="f", confidence=1.5)
    except ValueError:
        pass
    else:  # pragma: no cover
        raise AssertionError("confidence > 1 must be rejected")

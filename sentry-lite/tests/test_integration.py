"""Real tool runs (semgrep with local rules only, gitleaks, osv-scanner with a local offline DB).

No network: semgrep uses only local rules with metrics/version-check off, osv-scanner runs with
--offline-vulnerabilities against a tiny DB built from tests/data/osv_db. Skipped if a tool is missing.
"""

from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

import pytest

from sentry.config import Paths, find_tool
from sentry.models import Status
from sentry.pipeline import run_scan
from sentry.store import Store

from .conftest import DATA, LEAKED_KEY

pytestmark = pytest.mark.integration


def need(tool: str, paths: Paths) -> None:
    if find_tool(tool, paths) is None:
        pytest.skip(f"{tool} not installed")


@pytest.fixture
def real_home(home: Paths, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Paths:
    project_bin = Path(__file__).resolve().parents[1] / "bin"
    if project_bin.is_dir():
        monkeypatch.setenv("PATH", f"{project_bin}{__import__('os').pathsep}{__import__('os').environ['PATH']}")
    home.rules.mkdir(parents=True, exist_ok=True)
    shutil.copy(DATA / "rec_rules.yaml", home.rules / "rec.yaml")
    db_root = tmp_path / "osvdb"
    (db_root / "osv-scalibr" / "npm").mkdir(parents=True)
    with zipfile.ZipFile(db_root / "osv-scalibr" / "npm" / "all.zip", "w") as z:
        for f in (DATA / "osv_db").glob("*.json"):
            z.write(f, f.name)
    monkeypatch.setenv("OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY", str(db_root))
    return home


def test_full_offline_pipeline_with_real_tools(real_home: Paths, owned_repo: Path) -> None:
    for tool in ("semgrep", "gitleaks", "osv-scanner"):
        need(tool, real_home)
    first = run_scan(owned_repo, paths=real_home, offline=True)
    by_tool = {o.tool: o for o in first.outputs}
    assert all(o.ok for o in first.outputs), [o.error for o in first.outputs]
    assert len(by_tool["semgrep"].findings) == 4
    assert {f.rule_id for f in by_tool["semgrep"].findings} == {
        "rec.express-reflected-xss",
        "rec.eval-user-input",
        "rec.dom-innerhtml",
    }
    leaks = {(f.file, f.metadata["exposure"]) for f in by_tool["gitleaks"].findings}
    assert ("src/config.js", "committed") in leaks and (".env", "client-bundle") in leaks
    assert {f.rule_id for f in by_tool["osv-scanner"].findings} == {
        "osv.GHSA-35jh-r3h4-6jhm",
        "osv.GHSA-29mw-wpgm-hmr9",
        "osv.GHSA-xvch-5gv4-984h",
    }
    assert all(o.peak_rss_mb < 2000 for o in first.outputs)

    # The planted secret must never reach logs, raw scan data or the database.
    for path in [*real_home.logs.rglob("*"), *real_home.data.rglob("*")]:
        if path.is_file():
            assert LEAKED_KEY.encode() not in path.read_bytes(), path

    # Fix the eval → rescan: that finding becomes fixed (pending verification), others keep their ids.
    server = owned_repo / "src/server.js"
    server.write_text(server.read_text().replace("eval(expr)", "Number(expr)"))
    second = run_scan(owned_repo, paths=real_home, offline=True)
    assert len(second.ingest.auto_fixed) == 1 and len(second.ingest.new) == 0
    with Store(real_home.db) as store:
        fixed = store.get(second.ingest.auto_fixed[0])
        assert fixed.rule_id == "rec.eval-user-input" and fixed.status == Status.fixed and not fixed.fix_verified
        assert store.list_scans(second.repo)[0]["summary"]["tools"][0]["version"]


def test_since_scan_with_real_semgrep(real_home: Paths, owned_repo: Path) -> None:
    need("semgrep", real_home)
    run_scan(owned_repo, paths=real_home, offline=True, tools=["semgrep"])
    (owned_repo / "public/new.js").write_text("document.body.innerHTML = location.hash;\n")
    out = run_scan(owned_repo, paths=real_home, offline=True, tools=["semgrep"], since="HEAD")
    sem = out.outputs[0]
    assert sem.ok and sem.stats["files_scanned"] == 1
    assert len(out.ingest.new) == 1 and out.ingest.auto_fixed == []  # untouched files are not "fixed"

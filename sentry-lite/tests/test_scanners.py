"""Scanner wrappers with run_tool mocked to return recorded outputs (no external tools needed)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from sentry.config import Paths
from sentry.inventory import build_inventory
from sentry.scanners import gitleaks as gl_mod
from sentry.scanners import osv as osv_mod
from sentry.scanners import semgrep as sg_mod
from sentry.scanners.base import ScanContext
from sentry.scanners.gitleaks import GitleaksScanner
from sentry.scanners.osv import OsvScanner, build_args
from sentry.scanners.semgrep import SemgrepScanner, chunk_targets, local_rule_ids
from sentry.toolrun import ToolResult

from .conftest import DATA, LEAKED_KEY


class FakeRun:
    def __init__(self, outputs: list[tuple[int, str]], **flags: Any) -> None:
        self.outputs = outputs
        self.calls: list[list[str]] = []
        self.flags = flags

    def __call__(self, tool: str, exe: Path | None, args: list[str], **kw: Any) -> ToolResult:
        self.calls.append(args)
        rc, out = self.outputs[min(len(self.calls) - 1, len(self.outputs) - 1)]
        return ToolResult(
            tool=tool,
            version="9.9.9",
            argv=[tool, *args],
            returncode=rc,
            stdout=out,
            stderr="boom",
            duration_s=1.0,
            peak_rss_mb=321.0,
            **self.flags,
        )


def ctx_for(root: Path, home: Paths, **kw: Any) -> ScanContext:
    return ScanContext(
        root=root,
        repo="yuseunghogi-commits/game",
        scan_id="s1",
        paths=home,
        profile="web",
        inventory=build_inventory(root, "yuseunghogi-commits/game"),
        **kw,
    )


@pytest.fixture
def rules_home(home: Paths) -> Paths:
    home.rules.mkdir(parents=True, exist_ok=True)
    shutil.copy(DATA / "rec_rules.yaml", home.rules / "rec.yaml")
    return home


# ------------------------------------------------------------------------------------------ semgrep


def test_semgrep_args_enforce_laptop_limits(monkeypatch: pytest.MonkeyPatch, rules_home: Paths, rec_app: Path) -> None:
    fake = FakeRun([(0, (DATA / "semgrep.json").read_text())])
    monkeypatch.setattr(sg_mod, "run_tool", fake)
    out = SemgrepScanner().run(ctx_for(rec_app, rules_home))
    args = fake.calls[0]
    for flag, value in (("--jobs", "2"), ("--max-memory", "1500"), ("--timeout", "30")):
        assert args[args.index(flag) + 1] == value
    assert "--metrics=off" in args and "--json" in args
    excludes = {args[i + 1] for i, a in enumerate(args) if a == "--exclude"}
    assert {"node_modules", "dist", "build", ".venv"} <= excludes
    configs = [args[i + 1] for i, a in enumerate(args) if a == "--config"]
    assert configs[:5] == ["p/default", "p/owasp-top-ten", "p/secrets", "p/javascript", "p/typescript"]
    assert configs[-1] == str(rules_home.rules) and args[-1] == "."
    assert out.ok and len(out.findings) == 4 and out.coverage is not None and out.coverage.files is None
    assert {f.rule_id for f in out.findings} == local_rule_ids([str(rules_home.rules)])
    assert out.peak_rss_mb == 321.0
    assert json.loads((rules_home.repo_dir("yuseunghogi-commits/game") / "scans/s1/semgrep.json").read_text())


def test_semgrep_profiles_and_offline(monkeypatch: pytest.MonkeyPatch, home: Paths, rec_app: Path) -> None:
    sc = SemgrepScanner()
    c = ctx_for(rec_app, home)
    c.profile = "python"
    assert sc.configs(c) == ["p/default", "p/owasp-top-ten", "p/secrets", "p/python"]
    c.offline = True
    out = sc.run(c)
    assert out.skipped and not out.ok and "offline" in (out.error or "")


def test_semgrep_since_targets_changed_files_only(
    monkeypatch: pytest.MonkeyPatch, rules_home: Paths, rec_app: Path
) -> None:
    fake = FakeRun([(0, json.dumps({"results": [], "errors": [], "paths": {"scanned": ["src/server.js"]}}))])
    monkeypatch.setattr(sg_mod, "run_tool", fake)
    (rec_app / "node_modules/x").mkdir(parents=True)
    (rec_app / "node_modules/x/i.js").write_text("x")
    changed = {"src/server.js", "node_modules/x/i.js", "deleted.js"}
    out = SemgrepScanner().run(ctx_for(rec_app, rules_home, changed_files=changed, since_ref="HEAD~1"))
    assert fake.calls[0][-1] == "src/server.js" and "." not in fake.calls[0][-2:]
    assert out.coverage is not None and out.coverage.files == changed
    empty = SemgrepScanner().run(ctx_for(rec_app, rules_home, changed_files={"README.md"}))
    assert empty.ok and empty.coverage is not None and empty.coverage.files == set() and len(fake.calls) == 1


def test_chunk_targets_respects_windows_cmdline_limit() -> None:
    targets = [f"src/{'x' * 90}/{i}.js" for i in range(1000)]
    chunks = chunk_targets(targets)
    assert len(chunks) > 1 and sum(len(c) for c in chunks) == 1000
    assert all(sum(len(t) + 1 for t in c) <= 24_000 for c in chunks)


@pytest.mark.parametrize(
    ("rc", "stdout", "flags", "msg"),
    [
        (2, "", {}, "semgrep exited 2"),
        (0, "not json", {}, "semgrep exited 0"),
        (-9, "", {"killed_for_memory": True}, "RAM cap"),
        (-9, "", {"timed_out": True}, "timed out"),
    ],
)
def test_semgrep_failures(
    monkeypatch: pytest.MonkeyPatch,
    rules_home: Paths,
    rec_app: Path,
    rc: int,
    stdout: str,
    flags: dict[str, Any],
    msg: str,
) -> None:
    monkeypatch.setattr(sg_mod, "run_tool", FakeRun([(rc, stdout)], **flags))
    out = SemgrepScanner().run(ctx_for(rec_app, rules_home))
    assert not out.ok and msg in (out.error or "") and out.coverage is None


# ----------------------------------------------------------------------------------------- gitleaks


def test_gitleaks_dir_and_history(monkeypatch: pytest.MonkeyPatch, home: Paths, owned_repo: Path) -> None:
    fake = FakeRun([(0, (DATA / "gitleaks_dir.json").read_text()), (0, (DATA / "gitleaks_git.json").read_text())])
    monkeypatch.setattr(gl_mod, "run_tool", fake)
    ctx = ctx_for(owned_repo, home, git_toplevel=owned_repo.resolve())
    out = GitleaksScanner().run(ctx)
    assert out.ok, out.error
    dir_args, git_args = fake.calls
    assert dir_args[0] == "dir" and dir_args[-1] == "."
    assert git_args[0] == "git" and git_args[git_args.index("--log-opts") + 1] == "--all"
    for args in fake.calls:
        assert args[args.index("--report-path") + 1] == "-" and args[args.index("--exit-code") + 1] == "0"
    exposures = {(f.file, f.metadata["exposure"]) for f in out.findings}
    assert exposures == {
        (".env", "client-bundle"),
        (".env", "local-ignored-file"),
        ("src/config.js", "committed"),
    }
    toml = (ctx.raw_dir / "gitleaks.toml").read_text()
    assert "useDefault = true" in toml and "node_modules" in toml and "dist" not in toml
    saved = (ctx.raw_dir / "gitleaks.redacted.json").read_text()
    assert LEAKED_KEY not in saved and "Secret" not in saved
    assert out.coverage is not None and out.coverage.history_findings_covered


def test_gitleaks_since_uses_commit_range(monkeypatch: pytest.MonkeyPatch, home: Paths, owned_repo: Path) -> None:
    fake = FakeRun([(0, "[]")])
    monkeypatch.setattr(gl_mod, "run_tool", fake)
    ctx = ctx_for(owned_repo, home, git_toplevel=owned_repo.resolve(), since_ref="HEAD~1", changed_files=set())
    out = GitleaksScanner().run(ctx)
    log_opts = fake.calls[1][fake.calls[1].index("--log-opts") + 1]
    assert log_opts.endswith("..HEAD") and len(log_opts) == 46
    assert out.coverage is not None and not out.coverage.history_findings_covered


def test_gitleaks_without_git_and_failures(monkeypatch: pytest.MonkeyPatch, home: Paths, rec_app: Path) -> None:
    fake = FakeRun([(0, "[]")])
    monkeypatch.setattr(gl_mod, "run_tool", fake)
    out = GitleaksScanner().run(ctx_for(rec_app, home))
    assert out.ok and len(fake.calls) == 1 and "working tree only" in " ".join(out.notes)
    monkeypatch.setattr(gl_mod, "run_tool", FakeRun([(1, "")]))
    assert not GitleaksScanner().run(ctx_for(rec_app, home)).ok


# --------------------------------------------------------------------------------------------- osv


def test_osv_parses_and_marks_imports(monkeypatch: pytest.MonkeyPatch, home: Paths, rec_app: Path) -> None:
    (rec_app / "package-lock.json").write_text((DATA / "package-lock.json").read_text())
    data = (DATA / "osv.json").read_text().replace("__ROOT__", rec_app.as_posix())
    fake = FakeRun([(1, data)])
    monkeypatch.setattr(osv_mod, "run_tool", fake)
    monkeypatch.setattr(osv_mod, "tool_version", lambda *a, **k: "2.7.0")
    out = OsvScanner().run(ctx_for(rec_app, home))
    assert fake.calls[0][:4] == ["scan", "source", "--format", "json"] and fake.calls[0][-2:] == [
        "--recursive",
        ".",
    ]
    assert out.ok and len(out.findings) == 3
    lodash = [f for f in out.findings if f.metadata["package"] == "lodash"]
    assert all(f.metadata["imported"] for f in lodash)  # server.js requires lodash


def test_osv_no_packages_and_errors(monkeypatch: pytest.MonkeyPatch, home: Paths, rec_app: Path) -> None:
    monkeypatch.setattr(osv_mod, "tool_version", lambda *a, **k: "2.7.0")
    monkeypatch.setattr(osv_mod, "run_tool", FakeRun([(128, "")]))
    out = OsvScanner().run(ctx_for(rec_app, home))
    assert out.ok and out.findings == []
    monkeypatch.setattr(osv_mod, "run_tool", FakeRun([(127, "")]))
    c = ctx_for(rec_app, home, offline=True)
    out = OsvScanner().run(c)
    assert not out.ok and "offline DB missing" in (out.error or "")
    assert "--offline-vulnerabilities" in build_args("2.7.0", c, None)
    assert build_args("1.9.0", c, ["package-lock.json"])[:2] == ["--format", "json"]


def test_osv_skips(monkeypatch: pytest.MonkeyPatch, home: Paths, tmp_path: Path, rec_app: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    assert OsvScanner().run(ctx_for(empty, home)).skipped
    out = OsvScanner().run(ctx_for(rec_app, home, changed_files={"src/server.js"}))
    assert out.skipped and out.coverage is None
    fake = FakeRun([(0, json.dumps({"results": []}))])
    monkeypatch.setattr(osv_mod, "run_tool", fake)
    monkeypatch.setattr(osv_mod, "tool_version", lambda *a, **k: "2.7.0")
    out = OsvScanner().run(ctx_for(rec_app, home, changed_files={"package-lock.json"}))
    assert fake.calls[0][-2:] == ["--lockfile", "package-lock.json"]
    assert out.coverage is not None and out.coverage.files == {"package-lock.json"}

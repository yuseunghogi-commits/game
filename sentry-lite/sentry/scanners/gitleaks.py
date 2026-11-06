"""gitleaks wrapper: working tree (incl. dist/ bundles) + full git history.

gitleaks output contains plaintext secrets. It is read from stdout, hashed/redacted in memory and never
written to disk or logs; only a redacted copy is saved under data/.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..config import SECRET_SCAN_EXCLUDE_DIRS, find_tool
from ..gitutil import Git, GitError
from ..normalize import gitleaks_to_findings, to_rel
from ..toolrun import ToolNotFoundError, ToolResult, run_tool
from .base import ScanContext, ScannerOutput, ToolCoverage, describe_abort, failed

_REDACT_KEYS = {"Secret", "Match", "Line"}


def write_config(path: Path) -> Path:
    """Default gitleaks rules plus an allowlist for dependency/cache directories."""
    patterns = ",\n  ".join(f"'''(^|/){d.replace('.', chr(92) + '.')}/'''" for d in SECRET_SCAN_EXCLUDE_DIRS)
    path.write_text(
        "[extend]\nuseDefault = true\n\n"
        "[allowlist]\n"
        'description = "sentry-lite: skip dependency and cache directories"\n'
        f"paths = [\n  {patterns}\n]\n",
        encoding="utf-8",
    )
    return path


def common_args(config: Path) -> list[str]:
    return [
        "--config",
        str(config),
        "--report-format",
        "json",
        "--report-path",
        "-",
        "--exit-code",
        "0",
        "--no-banner",
        "--log-level",
        "error",
        "--max-target-megabytes",
        "5",
    ]


def _parse(res: ToolResult) -> list[dict[str, Any]]:
    text = res.stdout.strip()
    if not text:
        return []
    data = json.loads(text)
    return data if isinstance(data, list) else []


class GitleaksScanner:
    name = "gitleaks"

    def run(self, ctx: ScanContext) -> ScannerOutput:
        exe = find_tool(self.name, ctx.paths)
        config = write_config(ctx.raw_dir / "gitleaks.toml")
        runs: list[ToolResult] = []
        records: list[dict[str, Any]] = []
        invocations: list[tuple[str, list[str]]] = [("dir", ["dir", *common_args(config), "."])]
        history_mode = "none"
        if ctx.git_toplevel is not None:
            if ctx.since_ref:
                git = Git(ctx.root, ctx.paths.logs, ctx.scan_id)
                try:
                    commit = git.verify_ref(ctx.since_ref)
                except GitError as exc:
                    return failed(self.name, str(exc))
                log_opts, history_mode = f"{commit}..HEAD", f"since {ctx.since_ref}"
            else:
                log_opts, history_mode = "--all", "full"
            invocations.append(("git", ["git", *common_args(config), "--log-opts", log_opts, str(ctx.git_toplevel)]))

        for _label, args in invocations:
            try:
                res = run_tool(
                    self.name,
                    exe,
                    args,
                    logs_dir=ctx.paths.logs,
                    cwd=ctx.root,
                    mem_cap_mb=ctx.mem_cap_mb,
                    scan_id=ctx.scan_id,
                )
            except ToolNotFoundError as exc:
                return failed(self.name, str(exc), runs)
            runs.append(res)
            abort = describe_abort(res, ctx.mem_cap_mb)
            if abort:
                return failed(self.name, abort, runs)
            if res.returncode != 0:
                return failed(self.name, f"gitleaks exited {res.returncode}: {res.stderr.strip()[-400:]}", runs)
            try:
                records.extend(_parse(res))
            except json.JSONDecodeError as exc:
                return failed(self.name, f"could not parse gitleaks output: {exc}", runs)

        tracked: set[str] = set()
        ignored: set[str] = set()
        if ctx.git_toplevel is not None:
            git = Git(ctx.root, ctx.paths.logs, ctx.scan_id)
            tracked = git.tracked_files()
            wt_files = sorted({to_rel(str(r.get("File", "")), ctx.root) for r in records if not r.get("Commit")})
            ignored = git.ignored([f for f in wt_files if f not in tracked])

        toplevel = ctx.git_toplevel

        def history_path(p: str) -> str | None:
            if toplevel is None:
                return to_rel(p, ctx.root)
            absolute = (toplevel / p).resolve()
            try:
                return absolute.relative_to(ctx.root.resolve()).as_posix()
            except ValueError:
                return None  # outside the scanned sub-directory

        findings = gitleaks_to_findings(
            records, root=ctx.root, repo=ctx.repo, tracked=tracked, ignored=ignored, path_map=history_path
        )
        ctx.save_raw(
            "gitleaks.redacted.json",
            [{k: v for k, v in r.items() if k not in _REDACT_KEYS} for r in records],
        )
        coverage = ToolCoverage(self.name, files=None, history_findings_covered=not bool(ctx.since_ref))
        notes = [f"history: {history_mode}"]
        if ctx.git_toplevel is None:
            notes.append("not a git repository: working tree only")
        return ScannerOutput(
            tool=self.name,
            ok=True,
            findings=findings,
            coverage=coverage,
            runs=runs,
            notes=notes,
            stats={"raw_leaks": len(records), "history": history_mode},
        )

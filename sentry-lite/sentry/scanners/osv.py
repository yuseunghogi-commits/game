"""osv-scanner wrapper: dependency CVEs from lockfiles, filtered to fixable or reachable packages."""

from __future__ import annotations

import json
from pathlib import Path

from ..config import find_tool
from ..normalize import osv_to_findings
from ..toolrun import ToolNotFoundError, ToolResult, run_tool, tool_version
from .base import ScanContext, ScannerOutput, ToolCoverage, describe_abort, failed

_NO_PACKAGES_RC = 128


def _dependency_files(ctx: ScanContext) -> list[str]:
    inv = ctx.inventory
    deps = list(inv.lockfiles)
    deps += [m for m in inv.manifests if Path(m).name.startswith("requirements") and m.endswith(".txt")]
    return sorted(set(deps))


def build_args(version: str, ctx: ScanContext, lockfiles: list[str] | None) -> list[str]:
    major = int(version.split(".", 1)[0]) if version[:1].isdigit() else 2
    args: list[str] = ["scan", "source"] if major >= 2 else []
    args += ["--format", "json"]
    if ctx.offline:
        args.append("--offline-vulnerabilities")
    if lockfiles:
        for lf in lockfiles:
            args += ["--lockfile", lf]
    else:
        args += ["--recursive", "."]
    return args


class OsvScanner:
    name = "osv-scanner"

    def run(self, ctx: ScanContext) -> ScannerOutput:
        dep_files = _dependency_files(ctx)
        if not dep_files:
            return ScannerOutput(
                tool=self.name,
                ok=True,
                skipped=True,
                coverage=ToolCoverage(self.name, files=set()),
                notes=["no lockfiles found"],
            )
        lockfiles: list[str] | None = None
        if ctx.changed_files is not None:
            lockfiles = [f for f in dep_files if f in ctx.changed_files]
            if not lockfiles:
                return ScannerOutput(
                    tool=self.name,
                    ok=True,
                    skipped=True,
                    notes=["no dependency changes since ref"],
                )
        exe = find_tool(self.name, ctx.paths)
        runs: list[ToolResult] = []
        try:
            version = tool_version(self.name, exe) if exe else "2"
            res = run_tool(
                self.name,
                exe,
                build_args(version, ctx, lockfiles),
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
        if res.returncode == _NO_PACKAGES_RC:
            return ScannerOutput(
                tool=self.name,
                ok=True,
                runs=runs,
                coverage=ToolCoverage(self.name, files=None),
                notes=["osv-scanner found no packages"],
            )
        if res.returncode not in (0, 1):
            hint = " (offline DB missing? run once without --offline)" if ctx.offline else ""
            return failed(self.name, f"osv-scanner exited {res.returncode}{hint}: {res.stderr.strip()[-400:]}", runs)
        try:
            data = json.loads(res.stdout) if res.stdout.strip() else {}
        except json.JSONDecodeError as exc:
            return failed(self.name, f"could not parse osv-scanner output: {exc}", runs)
        ctx.save_raw("osv.json", data)
        findings, stats = osv_to_findings(data, root=ctx.root, repo=ctx.repo, imported=ctx.inventory.imported_sets())
        notes = []
        if stats["dropped_no_fix_unreachable"]:
            notes.append(f"{stats['dropped_no_fix_unreachable']} vuln(s) dropped: no fixed version and not imported")
        return ScannerOutput(
            tool=self.name,
            ok=True,
            findings=findings,
            coverage=ToolCoverage(self.name, files=set(lockfiles) if lockfiles else None),
            runs=runs,
            notes=notes,
            stats=stats,
        )

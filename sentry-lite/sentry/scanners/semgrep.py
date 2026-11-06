"""Semgrep wrapper: registry packs + local ./rules, laptop-safe resource flags, diff-aware mode."""

from __future__ import annotations

import contextlib
import json
import re
from pathlib import Path
from typing import Any

from ..config import EXCLUDE_DIRS, SEMGREP_JOBS, SEMGREP_MAX_MEMORY_MB, SEMGREP_TIMEOUT_S, find_tool
from ..normalize import semgrep_to_findings
from ..toolrun import ToolNotFoundError, ToolResult, run_tool
from .base import ScanContext, ScannerOutput, ToolCoverage, describe_abort, failed

BASE_PACKS = ["p/default", "p/owasp-top-ten", "p/secrets"]
PROFILE_PACKS: dict[str, list[str]] = {
    "web": ["p/javascript", "p/typescript"],
    "python": ["p/python"],
    "mixed": ["p/javascript", "p/typescript", "p/python"],
}
#: Keep each argv well below the 32 767-char Windows command-line limit.
MAX_ARGV_CHARS = 24_000


def registry_packs(profile: str) -> list[str]:
    return [*BASE_PACKS, *PROFILE_PACKS.get(profile, PROFILE_PACKS["mixed"])]


def local_rule_configs(rules_dir: Path) -> list[str]:
    if not rules_dir.is_dir():
        return []
    has_rules = any(p.suffix in {".yml", ".yaml"} for p in rules_dir.rglob("*") if p.is_file())
    return [str(rules_dir)] if has_rules else []


_RULE_ID_RE = re.compile(r"^\s*-\s+id:\s*['\"]?([\w.\-/]+)", re.M)


def local_rule_ids(configs: list[str]) -> set[str]:
    """Rule ids declared in local YAML configs (files or directories); registry packs are skipped."""
    ids: set[str] = set()
    for cfg in configs:
        p = Path(cfg)
        if cfg.startswith(("p/", "r/", "http://", "https://")) or not p.exists():
            continue
        files = [p] if p.is_file() else [f for f in p.rglob("*") if f.suffix in {".yml", ".yaml"}]
        for f in files:
            with contextlib.suppress(OSError):
                ids.update(_RULE_ID_RE.findall(f.read_text(encoding="utf-8", errors="replace")))
    return ids


def base_args(configs: list[str]) -> list[str]:
    args = [
        "scan",
        "--json",
        "--metrics=off",
        "--disable-version-check",
        "--quiet",
        "--jobs",
        str(SEMGREP_JOBS),
        "--max-memory",
        str(SEMGREP_MAX_MEMORY_MB),
        "--timeout",
        str(SEMGREP_TIMEOUT_S),
        "--dataflow-traces",
    ]
    for cfg in configs:
        args += ["--config", cfg]
    for d in EXCLUDE_DIRS:
        args += ["--exclude", d]
    return args


def chunk_targets(targets: list[str], budget: int = MAX_ARGV_CHARS) -> list[list[str]]:
    chunks: list[list[str]] = []
    current: list[str] = []
    size = 0
    for t in targets:
        if current and size + len(t) + 1 > budget:
            chunks.append(current)
            current, size = [], 0
        current.append(t)
        size += len(t) + 1
    if current:
        chunks.append(current)
    return chunks


def _excluded(rel: str) -> bool:
    parts = rel.split("/")
    return any(p in EXCLUDE_DIRS for p in parts[:-1])


class SemgrepScanner:
    name = "semgrep"

    def configs(self, ctx: ScanContext) -> list[str]:
        configs: list[str] = [] if ctx.offline else registry_packs(ctx.profile)
        configs += local_rule_configs(ctx.paths.rules)
        configs += ctx.semgrep_configs
        return list(dict.fromkeys(configs))

    def run(self, ctx: ScanContext) -> ScannerOutput:
        exe = find_tool("semgrep", ctx.paths)
        configs = self.configs(ctx)
        if not configs:
            return ScannerOutput(
                tool=self.name, ok=False, skipped=True, error="offline mode and no local rules in ./rules"
            )
        if ctx.changed_files is not None:
            targets = sorted(f for f in ctx.changed_files if (ctx.root / f).is_file() and not _excluded(f))
            if not targets:
                return ScannerOutput(
                    tool=self.name,
                    ok=True,
                    coverage=ToolCoverage(self.name, files=set()),
                    notes=["no changed files to scan"],
                )
            chunks = chunk_targets(targets)
        else:
            targets = ["."]
            chunks = [targets]

        merged: dict[str, Any] = {"results": [], "errors": [], "paths": {"scanned": []}}
        runs: list[ToolResult] = []
        for chunk in chunks:
            try:
                res = run_tool(
                    self.name,
                    exe,
                    [*base_args(configs), *chunk],
                    logs_dir=ctx.paths.logs,
                    cwd=ctx.root,
                    mem_cap_mb=ctx.mem_cap_mb,
                    env={"SEMGREP_SEND_METRICS": "off", "SEMGREP_ENABLE_VERSION_CHECK": "0"},
                    scan_id=ctx.scan_id,
                )
            except ToolNotFoundError as exc:
                return failed(self.name, str(exc), runs)
            runs.append(res)
            abort = describe_abort(res, ctx.mem_cap_mb)
            if abort:
                return failed(self.name, abort, runs)
            try:
                data = json.loads(res.stdout) if res.stdout.strip() else {}
            except json.JSONDecodeError:
                data = {}
            if res.returncode not in (0, 1) or not data:
                err = (res.stderr.strip() or res.stdout.strip())[-600:]
                return failed(self.name, f"semgrep exited {res.returncode}: {err}", runs)
            merged["results"].extend(data.get("results", []) or [])
            merged["errors"].extend(data.get("errors", []) or [])
            merged["paths"]["scanned"].extend((data.get("paths") or {}).get("scanned", []) or [])
            if data.get("version"):
                merged["version"] = data["version"]

        ctx.save_raw("semgrep.json", merged)
        findings, failed_files = semgrep_to_findings(
            merged, root=ctx.root, repo=ctx.repo, local_rule_ids=local_rule_ids(configs)
        )
        coverage = ToolCoverage(
            self.name,
            files=set(ctx.changed_files) if ctx.changed_files is not None else None,
            skip_files=failed_files,
        )
        notes = []
        if failed_files:
            notes.append(f"{len(failed_files)} file(s) had semgrep errors/timeouts (excluded from auto-fix)")
        if ctx.offline:
            notes.append("offline: registry packs skipped, local rules only")
        return ScannerOutput(
            tool=self.name,
            ok=True,
            findings=findings,
            coverage=coverage,
            runs=runs,
            notes=notes,
            stats={
                "configs": configs,
                "raw_results": len(merged["results"]),
                "errors": len(merged["errors"]),
                "files_scanned": len(set(merged["paths"]["scanned"])),
                "invocations": len(runs),
            },
        )

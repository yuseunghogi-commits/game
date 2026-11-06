"""Scanner interface shared by semgrep / gitleaks / osv-scanner (and the Firebase analyzer in M2)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from ..config import DEFAULT_MEM_CAP_MB, Paths
from ..inventory import Inventory
from ..models import Finding
from ..toolrun import ToolResult


@dataclass
class ToolCoverage:
    """What a scanner actually examined. Used to decide which old findings may be auto-marked ``fixed``.

    ``files=None`` means the whole repository. Findings in ``skip_files`` (tool errors/timeouts) are never
    auto-fixed. ``history_findings_covered=False`` protects git-history findings in diff-aware scans.
    """

    tool: str
    files: set[str] | None = None
    skip_files: set[str] = field(default_factory=set)
    history_findings_covered: bool = True

    def covers(self, finding: Finding) -> bool:
        if finding.source_tool != self.tool:
            return False
        if finding.file in self.skip_files:
            return False
        if self.files is not None and finding.file not in self.files:
            return False
        return not (not self.history_findings_covered and finding.metadata.get("commits"))


@dataclass
class ScanContext:
    root: Path
    repo: str
    scan_id: str
    paths: Paths
    profile: str
    inventory: Inventory
    since_ref: str | None = None
    changed_files: set[str] | None = None
    offline: bool = False
    git_toplevel: Path | None = None
    mem_cap_mb: float = DEFAULT_MEM_CAP_MB
    semgrep_configs: list[str] = field(default_factory=list)  # extra --config values

    @property
    def raw_dir(self) -> Path:
        d = self.paths.repo_dir(self.repo) / "scans" / self.scan_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def save_raw(self, name: str, data: Any) -> Path:
        path = self.raw_dir / name
        path.write_text(json.dumps(data, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
        return path


@dataclass
class ScannerOutput:
    tool: str
    ok: bool
    findings: list[Finding] = field(default_factory=list)
    coverage: ToolCoverage | None = None
    runs: list[ToolResult] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    error: str | None = None
    stats: dict[str, Any] = field(default_factory=dict)
    skipped: bool = False

    @property
    def version(self) -> str:
        return self.runs[0].version if self.runs else "-"

    @property
    def duration_s(self) -> float:
        return round(sum(r.duration_s for r in self.runs), 2)

    @property
    def peak_rss_mb(self) -> float:
        return max((r.peak_rss_mb for r in self.runs), default=0.0)


class Scanner(Protocol):
    name: str

    def run(self, ctx: ScanContext) -> ScannerOutput: ...


def failed(tool: str, error: str, runs: list[ToolResult] | None = None) -> ScannerOutput:
    return ScannerOutput(tool=tool, ok=False, error=error, runs=runs or [])


def describe_abort(res: ToolResult, mem_cap_mb: float) -> str | None:
    if res.killed_for_memory:
        return f"killed: process tree exceeded {mem_cap_mb:.0f} MB RAM cap (peak {res.peak_rss_mb:.0f} MB)"
    if res.timed_out:
        return f"killed: timed out after {res.duration_s:.0f}s"
    return None

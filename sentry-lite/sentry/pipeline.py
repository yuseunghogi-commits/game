"""Deterministic scan pipeline: scope check → inventory → scanners → normalize → store → summary."""

from __future__ import annotations

import getpass
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import DEFAULT_MEM_CAP_MB, Paths
from .gitutil import Git, GitError
from .inventory import Inventory, auto_profile, build_inventory, write_inventory
from .logs import append_jsonl, audit_log_path
from .models import Finding, Severity, Status
from .scanners import ALL_SCANNERS, ScanContext, Scanner, ScannerOutput
from .scope import ScopeDecision, check_scope
from .store import IngestResult, Store, new_scan_id

PROFILES = ("auto", "web", "python", "mixed")
FAIL_ON = {
    "confirmed": {Status.confirmed},
    "likely": {Status.confirmed, Status.likely},
    "candidate": {Status.confirmed, Status.likely, Status.candidate},
    "never": set(),
}


@dataclass
class ScanOutcome:
    scan_id: str
    repo: str
    root: Path
    profile: str
    scope: ScopeDecision
    inventory: Inventory
    outputs: list[ScannerOutput]
    ingest: IngestResult
    duration_s: float
    blocking: list[Finding] = field(default_factory=list)
    open_findings: list[Finding] = field(default_factory=list)

    @property
    def exit_code(self) -> int:
        return 3 if self.blocking else 0

    def summary(self) -> dict[str, Any]:
        return {
            "scan_id": self.scan_id,
            "repo": self.repo,
            "profile": self.profile,
            "duration_s": round(self.duration_s, 2),
            "inventory": {
                "total_loc": self.inventory.total_loc,
                "total_files": self.inventory.total_files,
                "frameworks": self.inventory.frameworks,
                "entrypoints": len(self.inventory.entrypoints),
            },
            "tools": [
                {
                    "tool": o.tool,
                    "ok": o.ok,
                    "skipped": o.skipped,
                    "version": o.version,
                    "duration_s": o.duration_s,
                    "peak_rss_mb": o.peak_rss_mb,
                    "findings": len(o.findings),
                    "error": o.error,
                    "notes": o.notes,
                    "stats": o.stats,
                }
                for o in self.outputs
            ],
            "ingest": self.ingest.as_dict(),
            "blocking": [f.id for f in self.blocking],
        }


def run_scan(
    path: Path,
    *,
    paths: Paths,
    profile: str = "auto",
    since: str | None = None,
    i_own_this: bool = False,
    scope_note: str | None = None,
    offline: bool = False,
    tools: list[str] | None = None,
    fail_on: str = "confirmed",
    mem_cap_mb: float = DEFAULT_MEM_CAP_MB,
    extra_semgrep_configs: list[str] | None = None,
    scanners: dict[str, Scanner] | None = None,
    progress: Callable[[str], None] | None = None,
) -> ScanOutcome:
    if profile not in PROFILES:
        raise ValueError(f"profile must be one of {', '.join(PROFILES)}")
    if fail_on not in FAIL_ON:
        raise ValueError(f"fail_on must be one of {', '.join(FAIL_ON)}")
    say = progress or (lambda _msg: None)
    paths.ensure()
    started = time.monotonic()
    scan_id = new_scan_id()

    with Store(paths.db) as store:
        scope = check_scope(
            path, paths=paths, store=store, i_own_this=i_own_this, scope_note=scope_note, scan_id=scan_id
        )
        root = scope.root
        say(f"scope: {scope.message}")
        if scope.method == "i-own-this":
            store.record_consent(str(root), scope.remotes_hash, "i-own-this", scope_note, getpass.getuser())

        git = Git(root, paths.logs, scan_id)
        changed: set[str] | None = None
        head = None
        if scope.git_toplevel is not None:
            head = git.head()
            if since:
                changed = git.changed_files_since(since)
                say(f"diff-aware: {len(changed)} file(s) changed since {since}")
        elif since:
            raise GitError("--since requires a git repository")

        say("inventory…")
        inventory = build_inventory(root, scope.repo_key)
        effective_profile = auto_profile(inventory) if profile == "auto" else profile
        repo_dir = paths.repo_dir(scope.repo_key)
        write_inventory(inventory, repo_dir / "inventory.json")

        store.upsert_repo(scope.repo_key, str(root), [f"{r.name} {r.url}" for r in scope.remotes])
        store.create_scan(
            repo=scope.repo_key,
            root=str(root),
            profile=effective_profile,
            since_ref=since,
            offline=offline,
            git_head=head,
            scope_method=scope.method,
            scan_id=scan_id,
        )
        ctx = ScanContext(
            root=root,
            repo=scope.repo_key,
            scan_id=scan_id,
            paths=paths,
            profile=effective_profile,
            inventory=inventory,
            since_ref=since,
            changed_files=changed,
            offline=offline,
            git_toplevel=scope.git_toplevel,
            mem_cap_mb=mem_cap_mb,
            semgrep_configs=extra_semgrep_configs or [],
        )
        write_inventory(inventory, ctx.raw_dir / "inventory.json")

        available: dict[str, Scanner] = scanners or {k: cls() for k, cls in ALL_SCANNERS.items()}
        selected = tools or list(available)
        outputs: list[ScannerOutput] = []
        for name in selected:
            if name not in available:
                raise ValueError(f"unknown tool {name!r}; choose from {', '.join(available)}")
            say(f"{name}…")
            try:
                out = available[name].run(ctx)
            except Exception as exc:  # a broken scanner must not abort the others
                out = ScannerOutput(tool=name, ok=False, error=f"{exc.__class__.__name__}: {exc}")
            for run in out.runs:
                store.record_tool_run(scan_id, run)
            outputs.append(out)

        all_findings = [f for o in outputs if o.ok for f in o.findings]
        coverages = [o.coverage for o in outputs if o.ok and o.coverage is not None]
        ingest = store.ingest(scan_id, scope.repo_key, all_findings, coverages)

        open_findings = store.list_findings(repo=scope.repo_key, statuses=["candidate", "likely", "confirmed"])
        blocking = [
            f
            for f in open_findings
            if f.status in FAIL_ON[fail_on] and f.severity in {Severity.critical, Severity.high}
        ]
        outcome = ScanOutcome(
            scan_id=scan_id,
            repo=scope.repo_key,
            root=root,
            profile=effective_profile,
            scope=scope,
            inventory=inventory,
            outputs=outputs,
            ingest=ingest,
            duration_s=time.monotonic() - started,
            blocking=blocking,
            open_findings=open_findings,
        )
        status = "ok" if all(o.ok or o.skipped for o in outputs) else "partial"
        store.finish_scan(scan_id, status, outcome.summary())
        append_jsonl(
            audit_log_path(paths.logs),
            {"event": "scan_finished", "scan_id": scan_id, "repo": scope.repo_key, "status": status},
        )
        return outcome

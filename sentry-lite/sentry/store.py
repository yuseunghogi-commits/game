"""SQLite store (``data/findings.db``) with fingerprint dedupe and verdict preservation.

Re-scan rules:
* a finding seen again keeps its status/verdict, severity (once triaged), justification and PoC fields;
* an open finding (candidate/likely/confirmed) that a tool *covered* but no longer reports becomes
  ``fixed`` with ``fix_verified = False`` (pending verification);
* a ``fixed`` finding that reappears is reopened with the status it had before (regression).
Every state change is written to ``finding_events`` (audit trail used by reports).
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from .logs import utcnow, utcnow_iso
from .models import OPEN_STATUSES, DataflowStep, Finding, Severity, Status
from .scanners.base import ToolCoverage
from .toolrun import ToolResult

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS repos (
    key TEXT PRIMARY KEY,
    root TEXT NOT NULL,
    remotes TEXT NOT NULL DEFAULT '[]',
    first_scan_at TEXT,
    last_scan_at TEXT
);
CREATE TABLE IF NOT EXISTS consents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root TEXT NOT NULL,
    remotes_hash TEXT NOT NULL,
    method TEXT NOT NULL,
    note TEXT,
    user TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    root TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    profile TEXT,
    since_ref TEXT,
    offline INTEGER NOT NULL DEFAULT 0,
    git_head TEXT,
    scope_method TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    summary TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS tool_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    version TEXT,
    argv TEXT,
    returncode INTEGER,
    duration_s REAL,
    peak_rss_mb REAL,
    timed_out INTEGER,
    killed_for_memory INTEGER,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    source_tool TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    cwe TEXT NOT NULL DEFAULT '[]',
    title TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    file TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    snippet TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    severity TEXT NOT NULL,
    confidence REAL NOT NULL,
    dataflow TEXT NOT NULL DEFAULT '[]',
    poc_path TEXT,
    repro_steps TEXT,
    fix_suggestion TEXT,
    justification TEXT,
    evidence TEXT,
    refs TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    fix_verified INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    scan_id TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_repo_status ON findings(repo, status);
CREATE TABLE IF NOT EXISTS scan_findings (
    scan_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    PRIMARY KEY (scan_id, finding_id)
);
CREATE TABLE IF NOT EXISTS finding_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    finding_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    note TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_finding ON finding_events(finding_id);
"""

#: Fields a scanner refreshes on every re-scan (never verdict fields).
_SCANNER_FIELDS = ("title", "message", "start_line", "end_line", "snippet", "cwe", "references")
#: Fields the CLI ``findings update`` command may change.
UPDATABLE_FIELDS = frozenset(
    {
        "status",
        "severity",
        "confidence",
        "title",
        "cwe",
        "dataflow",
        "poc_path",
        "repro_steps",
        "fix_suggestion",
        "justification",
        "evidence",
        "fix_verified",
        "references",
    }
)


class StoreError(RuntimeError):
    pass


@dataclass
class IngestResult:
    new: list[str] = field(default_factory=list)
    seen_again: list[str] = field(default_factory=list)
    reopened: list[str] = field(default_factory=list)
    auto_fixed: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, int]:
        return {k: len(v) for k, v in self.__dict__.items()}


def _dump(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, default=str)


def _row_to_finding(row: sqlite3.Row) -> Finding:
    return Finding(
        id=row["id"],
        repo=row["repo"],
        source_tool=row["source_tool"],
        rule_id=row["rule_id"],
        cwe=json.loads(row["cwe"]),
        title=row["title"],
        message=row["message"],
        file=row["file"],
        start_line=row["start_line"],
        end_line=row["end_line"],
        snippet=row["snippet"],
        status=Status(row["status"]),
        severity=Severity(row["severity"]),
        confidence=row["confidence"],
        dataflow=[DataflowStep(**d) for d in json.loads(row["dataflow"])],
        poc_path=row["poc_path"],
        repro_steps=row["repro_steps"],
        fix_suggestion=row["fix_suggestion"],
        justification=row["justification"],
        evidence=row["evidence"],
        references=json.loads(row["refs"]),
        metadata=json.loads(row["metadata"]),
        fix_verified=bool(row["fix_verified"]),
        first_seen=datetime.fromisoformat(row["first_seen"]),
        last_seen=datetime.fromisoformat(row["last_seen"]),
        scan_id=row["scan_id"],
    )


class Store:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.conn = sqlite3.connect(str(path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA journal_mode = WAL")
        self._migrate()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self.conn:
            yield self.conn

    def _migrate(self) -> None:
        version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise StoreError(f"{self.path} was written by a newer Sentry-Lite (schema {version})")
        with self.tx() as c:
            c.executescript(_SCHEMA)
            c.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    # ------------------------------------------------------------------ repos, consents, scans

    def upsert_repo(self, key: str, root: str, remotes: list[str]) -> None:
        now = utcnow_iso()
        with self.tx() as c:
            c.execute(
                "INSERT INTO repos(key, root, remotes, first_scan_at, last_scan_at) VALUES (?,?,?,?,?) "
                "ON CONFLICT(key) DO UPDATE SET root=excluded.root, remotes=excluded.remotes, "
                "last_scan_at=excluded.last_scan_at",
                (key, root, _dump(remotes), now, now),
            )

    def get_repo(self, key: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM repos WHERE key = ?", (key,)).fetchone()
        return dict(row) if row else None

    def list_repos(self) -> list[dict[str, Any]]:
        return [dict(r) for r in self.conn.execute("SELECT * FROM repos ORDER BY last_scan_at DESC")]

    def record_consent(self, root: str, remotes_hash: str, method: str, note: str | None, user: str) -> None:
        with self.tx() as c:
            c.execute(
                "INSERT INTO consents(root, remotes_hash, method, note, user, created_at) VALUES (?,?,?,?,?,?)",
                (root, remotes_hash, method, note, user, utcnow_iso()),
            )

    def get_consent(self, root: str, remotes_hash: str) -> str | None:
        row = self.conn.execute(
            "SELECT created_at FROM consents WHERE root = ? AND remotes_hash = ? AND method = 'i-own-this' "
            "ORDER BY id DESC LIMIT 1",
            (root, remotes_hash),
        ).fetchone()
        return str(row["created_at"]) if row else None

    def create_scan(
        self,
        *,
        repo: str,
        root: str,
        profile: str,
        since_ref: str | None,
        offline: bool,
        git_head: str | None,
        scope_method: str,
        scan_id: str | None = None,
    ) -> str:
        scan_id = scan_id or new_scan_id()
        with self.tx() as c:
            c.execute(
                "INSERT INTO scans(id, repo, root, started_at, profile, since_ref, offline, git_head, scope_method) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (scan_id, repo, root, utcnow_iso(), profile, since_ref, int(offline), git_head, scope_method),
            )
        return scan_id

    def finish_scan(self, scan_id: str, status: str, summary: dict[str, Any]) -> None:
        with self.tx() as c:
            c.execute(
                "UPDATE scans SET finished_at = ?, status = ?, summary = ? WHERE id = ?",
                (utcnow_iso(), status, _dump(summary), scan_id),
            )

    def list_scans(self, repo: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        q = "SELECT * FROM scans"
        args: list[Any] = []
        if repo:
            q += " WHERE repo = ?"
            args.append(repo)
        q += " ORDER BY started_at DESC, rowid DESC LIMIT ?"
        args.append(limit)
        out = []
        for r in self.conn.execute(q, args):
            d = dict(r)
            d["summary"] = json.loads(d["summary"] or "{}")
            out.append(d)
        return out

    def record_tool_run(self, scan_id: str, res: ToolResult) -> None:
        with self.tx() as c:
            c.execute(
                "INSERT INTO tool_runs(scan_id, tool, version, argv, returncode, duration_s, peak_rss_mb, "
                "timed_out, killed_for_memory, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    scan_id,
                    res.tool,
                    res.version,
                    _dump(res.argv),
                    res.returncode,
                    res.duration_s,
                    res.peak_rss_mb,
                    int(res.timed_out),
                    int(res.killed_for_memory),
                    utcnow_iso(),
                ),
            )

    def tool_runs(self, scan_id: str) -> list[dict[str, Any]]:
        return [dict(r) for r in self.conn.execute("SELECT * FROM tool_runs WHERE scan_id = ? ORDER BY id", (scan_id,))]

    # ------------------------------------------------------------------ findings

    def _event(
        self, c: sqlite3.Connection, fid: str, actor: str, kind: str, data: dict[str, Any], note: str | None
    ) -> None:
        c.execute(
            "INSERT INTO finding_events(finding_id, ts, actor, kind, data, note) VALUES (?,?,?,?,?,?)",
            (fid, utcnow_iso(), actor, kind, _dump(data), note),
        )

    def _insert(self, c: sqlite3.Connection, f: Finding) -> None:
        c.execute(
            "INSERT INTO findings(id, repo, source_tool, rule_id, cwe, title, message, file, start_line, end_line, "
            "snippet, status, severity, confidence, dataflow, poc_path, repro_steps, fix_suggestion, justification, "
            "evidence, refs, metadata, fix_verified, first_seen, last_seen, scan_id, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                f.id,
                f.repo,
                f.source_tool,
                f.rule_id,
                _dump(f.cwe),
                f.title,
                f.message,
                f.file,
                f.start_line,
                f.end_line,
                f.snippet,
                f.status.value,
                f.severity.value,
                f.confidence,
                _dump([d.model_dump() for d in f.dataflow]),
                f.poc_path,
                f.repro_steps,
                f.fix_suggestion,
                f.justification,
                f.evidence,
                _dump(f.references),
                _dump(f.metadata),
                int(f.fix_verified),
                (f.first_seen or utcnow()).isoformat(),
                (f.last_seen or utcnow()).isoformat(),
                f.scan_id,
                utcnow_iso(),
            ),
        )

    def _write(self, c: sqlite3.Connection, f: Finding) -> None:
        c.execute("DELETE FROM findings WHERE id = ?", (f.id,))
        self._insert(c, f)

    def ingest(
        self, scan_id: str, repo: str, findings: Iterable[Finding], coverages: Iterable[ToolCoverage]
    ) -> IngestResult:
        now = utcnow()
        result = IngestResult()
        seen: set[str] = set()
        with self.tx() as c:
            for f in findings:
                if f.id in seen:
                    continue
                seen.add(f.id)
                existing = self._get(c, f.id)
                if existing is None:
                    f.repo = repo
                    f.status = Status.candidate
                    f.first_seen = f.last_seen = now
                    f.scan_id = scan_id
                    f.metadata.setdefault("scanner_severity", f.severity.value)
                    self._insert(c, f)
                    self._event(c, f.id, "scanner", "created", {"severity": f.severity.value}, None)
                    result.new.append(f.id)
                else:
                    merged = existing.model_copy(deep=True)
                    for name in _SCANNER_FIELDS:
                        setattr(merged, name, getattr(f, name))
                    merged.metadata = {
                        **existing.metadata,
                        **f.metadata,
                        "scanner_severity": f.severity.value,
                    }
                    if not merged.dataflow and f.dataflow:
                        merged.dataflow = f.dataflow
                    if existing.status == Status.candidate:  # untriaged: follow the scanner
                        merged.severity = f.severity
                        merged.confidence = f.confidence
                        merged.fix_suggestion = existing.fix_suggestion or f.fix_suggestion
                    merged.last_seen = now
                    merged.scan_id = scan_id
                    if existing.status == Status.fixed:
                        previous = Status(existing.metadata.get("status_before_fixed", Status.candidate.value))
                        merged.status = previous
                        merged.fix_verified = False
                        merged.metadata.pop("status_before_fixed", None)
                        kind = "regression" if existing.fix_verified else "reopened"
                        self._event(c, f.id, "scanner", kind, {"status": previous.value}, f"reappeared in {scan_id}")
                        result.reopened.append(f.id)
                    else:
                        result.seen_again.append(f.id)
                    self._write(c, merged)
                c.execute("INSERT OR IGNORE INTO scan_findings(scan_id, finding_id) VALUES (?,?)", (scan_id, f.id))

            open_values = [s.value for s in OPEN_STATUSES]
            placeholders = ",".join("?" * len(open_values))
            for cov in coverages:
                rows = c.execute(
                    f"SELECT * FROM findings WHERE repo = ? AND source_tool = ? AND status IN ({placeholders})",  # noqa: S608
                    (repo, cov.tool, *open_values),
                ).fetchall()
                for row in rows:
                    old = _row_to_finding(row)
                    if old.id in seen or not cov.covers(old):
                        continue
                    old.metadata["status_before_fixed"] = old.status.value
                    old.status = Status.fixed
                    old.fix_verified = False
                    self._write(c, old)
                    self._event(
                        c,
                        old.id,
                        "scanner",
                        "auto_fixed",
                        {"status": "fixed", "previous": old.metadata["status_before_fixed"]},
                        f"not reported by {cov.tool} in {scan_id} (pending verification)",
                    )
                    result.auto_fixed.append(old.id)
        return result

    def _get(self, c: sqlite3.Connection, fid: str) -> Finding | None:
        row = c.execute("SELECT * FROM findings WHERE id = ?", (fid,)).fetchone()
        return _row_to_finding(row) if row else None

    def resolve_id(self, prefix: str) -> str:
        prefix = prefix.strip().lower()
        if len(prefix) < 4 or not all(ch in "0123456789abcdef" for ch in prefix):
            raise StoreError("finding id must be at least 4 hex characters")
        rows = self.conn.execute(
            "SELECT id FROM findings WHERE id LIKE ? LIMIT 2", (prefix.replace("%", "") + "%",)
        ).fetchall()
        if not rows:
            raise StoreError(f"no finding with id {prefix}")
        if len(rows) > 1:
            raise StoreError(f"id prefix {prefix} is ambiguous; use more characters")
        return str(rows[0]["id"])

    def get(self, id_or_prefix: str) -> Finding:
        fid = self.resolve_id(id_or_prefix)
        found = self._get(self.conn, fid)
        if found is None:  # pragma: no cover - resolve_id guarantees existence
            raise StoreError(f"no finding with id {fid}")
        return found

    def list_findings(
        self,
        *,
        repo: str | None = None,
        statuses: Iterable[str] | None = None,
        severities: Iterable[str] | None = None,
        tool: str | None = None,
        file_prefix: str | None = None,
        limit: int | None = None,
    ) -> list[Finding]:
        q = "SELECT * FROM findings WHERE 1=1"
        args: list[Any] = []
        if repo:
            q += " AND repo = ?"
            args.append(repo)
        st = list(statuses or [])
        if st:
            q += f" AND status IN ({','.join('?' * len(st))})"
            args += st
        sv = list(severities or [])
        if sv:
            q += f" AND severity IN ({','.join('?' * len(sv))})"
            args += sv
        if tool:
            q += " AND source_tool = ?"
            args.append(tool)
        if file_prefix:
            q += " AND file LIKE ?"
            args.append(file_prefix.replace("%", "") + "%")
        rows = self.conn.execute(q, args).fetchall()
        findings = [_row_to_finding(r) for r in rows]
        findings.sort(key=lambda f: (-f.severity.rank, -f.confidence, f.file, f.start_line))
        return findings[:limit] if limit else findings

    def add(self, f: Finding, actor: str, note: str | None = None) -> Finding:
        """Insert a finding produced outside the scanners (e.g. Claude /hunt)."""
        now = utcnow()
        with self.tx() as c:
            if self._get(c, f.id) is not None:
                raise StoreError(f"finding {f.id} already exists")
            f.first_seen = f.last_seen = now
            self._insert(c, f)
            self._event(c, f.id, actor, "created", {"status": f.status.value, "severity": f.severity.value}, note)
        return f

    def update(self, id_or_prefix: str, changes: dict[str, Any], actor: str, note: str | None = None) -> Finding:
        unknown = set(changes) - UPDATABLE_FIELDS
        if unknown:
            raise StoreError(f"cannot update field(s): {', '.join(sorted(unknown))}")
        fid = self.resolve_id(id_or_prefix)
        with self.tx() as c:
            current = self._get(c, fid)
            if current is None:  # pragma: no cover
                raise StoreError(f"no finding with id {fid}")
            data = current.model_dump()
            data.update(changes)
            updated = Finding.model_validate(data)
            if updated.status == Status.fixed and current.status != Status.fixed:
                updated.metadata["status_before_fixed"] = current.status.value
            if current.status == Status.fixed and updated.status != Status.fixed:
                updated.metadata.pop("status_before_fixed", None)
                if "fix_verified" not in changes:
                    updated.fix_verified = False
            diff = {
                k: {"old": _jsonable(getattr(current, k)), "new": _jsonable(getattr(updated, k))}
                for k in changes
                if getattr(current, k) != getattr(updated, k)
            }
            self._write(c, updated)
            self._event(c, fid, actor, "updated", diff, note)
        return updated

    def history(self, id_or_prefix: str) -> list[dict[str, Any]]:
        fid = self.resolve_id(id_or_prefix)
        out = []
        for r in self.conn.execute("SELECT * FROM finding_events WHERE finding_id = ? ORDER BY id", (fid,)):
            d = dict(r)
            d["data"] = json.loads(d["data"])
            out.append(d)
        return out

    def counts(self, repo: str) -> dict[str, dict[str, int]]:
        out: dict[str, dict[str, int]] = {}
        for r in self.conn.execute(
            "SELECT status, severity, COUNT(*) AS n FROM findings WHERE repo = ? GROUP BY status, severity",
            (repo,),
        ):
            out.setdefault(r["status"], {})[r["severity"]] = r["n"]
        return out


def _jsonable(v: Any) -> Any:
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    if hasattr(v, "model_dump"):
        return v.model_dump()
    if isinstance(v, Status | Severity):
        return v.value
    return v


def new_scan_id() -> str:
    return utcnow().strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]

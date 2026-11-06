"""Append-only JSON-lines logs: external tool invocations and scope/audit events.

Never pass raw tool output here: gitleaks output contains secrets. Only metadata is logged.
"""

from __future__ import annotations

import json
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()


def utcnow() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def utcnow_iso() -> str:
    return utcnow().isoformat()


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({"ts": utcnow_iso(), **record}, ensure_ascii=False, default=str)
    with _LOCK, path.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def tool_log_path(logs_dir: Path) -> Path:
    return logs_dir / "tools.jsonl"


def audit_log_path(logs_dir: Path) -> Path:
    return logs_dir / "audit.jsonl"

"""Common Finding schema shared by every scanner, the store, the CLI and the Claude Code layer."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, field_validator


class Status(StrEnum):
    candidate = "candidate"
    triaged_fp = "triaged_fp"
    likely = "likely"
    confirmed = "confirmed"
    fixed = "fixed"
    wont_fix = "wont_fix"


#: Statuses that represent an open problem. Only these are auto-marked ``fixed`` when they disappear.
OPEN_STATUSES: frozenset[Status] = frozenset({Status.candidate, Status.likely, Status.confirmed})


class Severity(StrEnum):
    critical = "critical"
    high = "high"
    medium = "medium"
    low = "low"
    info = "info"

    @property
    def rank(self) -> int:
        """Higher is worse; used for sorting and thresholds."""
        return {"critical": 4, "high": 3, "medium": 2, "low": 1, "info": 0}[self.value]


class DataflowStep(BaseModel):
    file: str
    line: int
    note: str = ""


class Finding(BaseModel):
    """One (potential) vulnerability.

    ``id`` is a stable, line-number-independent fingerprint (see :func:`sentry.normalize.fingerprint`).
    Fields after ``scan_id`` are Sentry-Lite extensions to the base schema.
    """

    id: str
    source_tool: str
    rule_id: str
    cwe: list[str] = Field(default_factory=list)
    title: str
    file: str
    start_line: int = 1
    end_line: int = 1
    snippet: str = ""
    status: Status = Status.candidate
    severity: Severity = Severity.medium
    confidence: float = 0.3
    dataflow: list[DataflowStep] = Field(default_factory=list)
    poc_path: str | None = None
    repro_steps: str | None = None
    fix_suggestion: str | None = None
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    scan_id: str | None = None
    # --- extensions ---
    repo: str = ""
    message: str = ""
    justification: str | None = None
    evidence: str | None = None
    references: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    fix_verified: bool = False

    @field_validator("confidence")
    @classmethod
    def _confidence_range(cls, v: float) -> float:
        if not 0.0 <= v <= 1.0:
            raise ValueError("confidence must be within 0..1")
        return round(v, 3)

    @field_validator("start_line", "end_line")
    @classmethod
    def _positive_line(cls, v: int) -> int:
        return max(1, v)

    @property
    def short_id(self) -> str:
        return self.id[:10]

    @property
    def location(self) -> str:
        if self.end_line and self.end_line != self.start_line:
            return f"{self.file}:{self.start_line}-{self.end_line}"
        return f"{self.file}:{self.start_line}"

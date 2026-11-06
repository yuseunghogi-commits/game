"""Paths, constants and external tool discovery."""

from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

#: GitHub owners whose repositories may be scanned without ``--i-own-this``.
ALLOWED_OWNERS: frozenset[str] = frozenset({"yuseunghogi-commits"})

#: Git hosts on which an owner name is meaningful for the ownership check.
TRUSTED_GIT_HOSTS: frozenset[str] = frozenset({"github.com", "www.github.com", "ssh.github.com"})

#: Directories never scanned by semgrep/inventory (dependencies, build output, caches).
EXCLUDE_DIRS: tuple[str, ...] = (
    "node_modules",
    "dist",
    "build",
    ".venv",
    "venv",
    ".git",
    "__pycache__",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "coverage",
    ".firebase",
    ".netlify",
    ".turbo",
    ".cache",
    ".parcel-cache",
    "bower_components",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    "target",
)

#: For secret scanning we deliberately keep dist/ and build/: front-end bundles are what gets deployed.
SECRET_SCAN_EXCLUDE_DIRS: tuple[str, ...] = tuple(d for d in EXCLUDE_DIRS if d not in {"dist", "build"})

#: Semgrep resource limits required for an 8 GB laptop (§2 of the spec).
SEMGREP_JOBS = 2
SEMGREP_MAX_MEMORY_MB = 1500
SEMGREP_TIMEOUT_S = 30

#: Hard cap on the summed RSS of any external tool's process tree; the tool is killed above it.
DEFAULT_MEM_CAP_MB = 1900

#: Wall-clock cap for one external tool invocation.
DEFAULT_TOOL_TIMEOUT_S = 1800


def _default_home() -> Path:
    env = os.environ.get("SENTRY_LITE_HOME")
    if env:
        return Path(env).expanduser().resolve()
    project_root = Path(__file__).resolve().parents[1]
    if (project_root / "pyproject.toml").is_file() and (project_root / "sentry").is_dir():
        return project_root
    return Path.home() / ".sentry-lite"


@dataclass(frozen=True)
class Paths:
    """All on-disk locations used by Sentry-Lite, rooted at ``home``."""

    home: Path

    @classmethod
    def default(cls) -> Paths:
        return cls(_default_home())

    @property
    def data(self) -> Path:
        return self.home / "data"

    @property
    def db(self) -> Path:
        env = os.environ.get("SENTRY_LITE_DB")
        return Path(env).expanduser().resolve() if env else self.data / "findings.db"

    @property
    def bin(self) -> Path:
        return self.home / "bin"

    @property
    def logs(self) -> Path:
        return self.home / "logs"

    @property
    def reports(self) -> Path:
        return self.home / "reports"

    @property
    def pocs(self) -> Path:
        return self.home / "pocs"

    @property
    def rules(self) -> Path:
        return self.home / "rules"

    def repo_dir(self, repo_key: str) -> Path:
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in repo_key)
        return self.data / "repos" / safe

    def ensure(self) -> None:
        for p in (self.data, self.logs):
            p.mkdir(parents=True, exist_ok=True)


def exe_name(name: str) -> str:
    return name + ".exe" if os.name == "nt" else name


def find_tool(name: str, paths: Paths) -> Path | None:
    """Locate an external tool: ``<home>/bin`` first, then the active venv, then PATH."""
    candidates = [paths.bin / exe_name(name), Path(sys.executable).parent / exe_name(name)]
    for cand in candidates:
        if cand.is_file():
            return cand
    found = shutil.which(name)
    return Path(found) if found else None

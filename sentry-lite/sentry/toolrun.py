"""Single choke point for running external tools.

Every invocation is logged (tool, version, argv, duration, peak RAM, exit code) to ``logs/tools.jsonl``.
The summed RSS of the tool's process tree is sampled while it runs; if it exceeds ``mem_cap_mb`` the
tree is killed so a single tool can never push an 8 GB laptop into swap.
"""

from __future__ import annotations

import contextlib
import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import psutil

from .logs import append_jsonl, tool_log_path

_VERSION_ARGS: dict[str, list[str]] = {
    "semgrep": ["--version"],
    "gitleaks": ["version"],
    "osv-scanner": ["--version"],
    "git": ["--version"],
}
_VERSION_CACHE: dict[str, str] = {}
_POLL_S = 0.2


class ToolNotFoundError(RuntimeError):
    """Raised when a required external tool is not installed."""


@dataclass
class ToolResult:
    tool: str
    version: str
    argv: list[str]
    returncode: int
    stdout: str
    stderr: str
    duration_s: float
    peak_rss_mb: float
    timed_out: bool = False
    killed_for_memory: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def aborted(self) -> bool:
        return self.timed_out or self.killed_for_memory


def _tree_rss_mb(proc: psutil.Process) -> float:
    total = 0
    procs = [proc]
    with contextlib.suppress(psutil.Error):
        procs.extend(proc.children(recursive=True))
    for p in procs:
        with contextlib.suppress(psutil.Error):
            total += p.memory_info().rss
    return total / (1024 * 1024)


def _kill_tree(proc: psutil.Process) -> None:
    children: list[psutil.Process] = []
    with contextlib.suppress(psutil.Error):
        children = proc.children(recursive=True)
    for p in [*children, proc]:
        with contextlib.suppress(psutil.Error):
            p.kill()


def _child_env(extra: dict[str, str] | None) -> dict[str, str]:
    env = dict(os.environ)
    # Force UTF-8 for Python-based tools (semgrep) on Windows consoles using cp949 etc.
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    # Privacy + speed: semgrep otherwise phones home (version check, metrics) on every call, which also
    # stalls for minutes when semgrep.dev is unreachable.
    env["SEMGREP_ENABLE_VERSION_CHECK"] = "0"
    env["SEMGREP_SEND_METRICS"] = "off"
    if extra:
        env.update(extra)
    return env


def _execute(
    argv: list[str],
    *,
    cwd: Path | None,
    timeout_s: float,
    mem_cap_mb: float | None,
    env: dict[str, str] | None,
    stdin_data: str | None,
) -> tuple[int, str, str, float, float, bool, bool]:
    start = time.monotonic()
    proc = psutil.Popen(
        argv,
        cwd=str(cwd) if cwd else None,
        stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_child_env(env),
    )
    peak = 0.0
    timed_out = killed_mem = False
    pending_input: bytes | None = stdin_data.encode("utf-8") if stdin_data is not None else None
    while True:
        try:
            out, err = proc.communicate(input=pending_input, timeout=_POLL_S)
            break
        except subprocess.TimeoutExpired:
            pending_input = None  # already delivered on the first call
            peak = max(peak, _tree_rss_mb(proc))
            if mem_cap_mb is not None and peak > mem_cap_mb:
                killed_mem = True
                _kill_tree(proc)
            elif time.monotonic() - start > timeout_s:
                timed_out = True
                _kill_tree(proc)
    duration = time.monotonic() - start
    return (
        proc.returncode if proc.returncode is not None else -1,
        out.decode("utf-8", errors="replace"),
        err.decode("utf-8", errors="replace"),
        duration,
        peak,
        timed_out,
        killed_mem,
    )


def tool_version(tool: str, exe: Path, logs_dir: Path | None = None) -> str:
    key = f"{tool}:{exe}"
    if key in _VERSION_CACHE:
        return _VERSION_CACHE[key]
    argv = [str(exe), *_VERSION_ARGS.get(tool, ["--version"])]
    duration = 0.0
    try:
        rc, out, err, duration, *_ = _execute(argv, cwd=None, timeout_s=60, mem_cap_mb=None, env=None, stdin_data=None)
        text = (out or err).strip()
        m = re.search(r"\d+\.\d+(?:\.\d+)?", text)
        version = m.group(0) if m else (text.splitlines()[0] if text else f"unknown(rc={rc})")
        if "set by build process" in text:
            version = "unknown (source build)"
    except OSError as exc:
        version = f"unknown ({exc.__class__.__name__})"
    _VERSION_CACHE[key] = version
    if logs_dir is not None:
        append_jsonl(
            tool_log_path(logs_dir),
            {
                "tool": tool,
                "version": version,
                "argv": argv,
                "duration_s": round(duration, 3),
                "probe": "version",
            },
        )
    return version


def run_tool(
    tool: str,
    exe: Path | None,
    args: list[str],
    *,
    logs_dir: Path,
    cwd: Path | None = None,
    timeout_s: float = 1800,
    mem_cap_mb: float | None = None,
    env: dict[str, str] | None = None,
    stdin_data: str | None = None,
    scan_id: str | None = None,
    log_argv: bool = True,
) -> ToolResult:
    """Run ``exe args`` and return its output plus resource usage. Logs metadata only, never output."""
    if exe is None:
        raise ToolNotFoundError(f"{tool} is not installed (run setup.ps1 or `sentry doctor`)")
    version = tool_version(tool, exe, logs_dir)
    argv = [str(exe), *args]
    try:
        rc, out, err, duration, peak, timed_out, killed_mem = _execute(
            argv, cwd=cwd, timeout_s=timeout_s, mem_cap_mb=mem_cap_mb, env=env, stdin_data=stdin_data
        )
    except OSError as exc:
        append_jsonl(
            tool_log_path(logs_dir),
            {"scan_id": scan_id, "tool": tool, "version": version, "error": str(exc)},
        )
        raise ToolNotFoundError(f"failed to start {tool}: {exc}") from exc
    result = ToolResult(
        tool=tool,
        version=version,
        argv=argv,
        returncode=rc,
        stdout=out,
        stderr=err,
        duration_s=round(duration, 3),
        peak_rss_mb=round(peak, 1),
        timed_out=timed_out,
        killed_for_memory=killed_mem,
    )
    append_jsonl(
        tool_log_path(logs_dir),
        {
            "scan_id": scan_id,
            "tool": tool,
            "version": version,
            "argv": argv if log_argv else [str(exe), "<redacted>"],
            "cwd": str(cwd) if cwd else None,
            "returncode": rc,
            "duration_s": result.duration_s,
            "peak_rss_mb": result.peak_rss_mb,
            "timed_out": timed_out,
            "killed_for_memory": killed_mem,
        },
    )
    return result

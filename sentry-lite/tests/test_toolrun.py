from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from sentry.toolrun import ToolNotFoundError, run_tool

PY = Path(sys.executable)


def _log(logs: Path) -> list[dict[str, Any]]:
    return [json.loads(x) for x in (logs / "tools.jsonl").read_text().splitlines()]


def test_run_logs_version_duration_and_rss(tmp_path: Path) -> None:
    res = run_tool("python", PY, ["-c", "import time; print('hi'); time.sleep(0.5)"], logs_dir=tmp_path)
    assert res.returncode == 0 and res.stdout.strip() == "hi"
    assert res.version.startswith("3.") and res.duration_s >= 0.5 and res.peak_rss_mb > 0
    entries = _log(tmp_path)
    assert entries[0]["probe"] == "version"
    assert entries[-1]["tool"] == "python" and entries[-1]["version"] == res.version
    assert entries[-1]["duration_s"] == res.duration_s and "stdout" not in entries[-1]


def test_stdin_and_env(tmp_path: Path) -> None:
    code = "import os,sys; print(sys.stdin.read().upper(), os.environ['SEMGREP_ENABLE_VERSION_CHECK'], os.environ['X'])"
    res = run_tool("python", PY, ["-c", code], logs_dir=tmp_path, stdin_data="abc", env={"X": "1"})
    assert res.stdout.split() == ["ABC", "0", "1"]


def test_timeout_kills_process(tmp_path: Path) -> None:
    start = time.monotonic()
    res = run_tool("python", PY, ["-c", "import time; time.sleep(60)"], logs_dir=tmp_path, timeout_s=1)
    assert res.timed_out and res.aborted and time.monotonic() - start < 15


def test_memory_cap_kills_process_tree(tmp_path: Path) -> None:
    code = "import time; b = bytearray(400 * 1024 * 1024); b[::4096] = b'x' * len(b[::4096]); time.sleep(30)"
    res = run_tool("python", PY, ["-c", code], logs_dir=tmp_path, mem_cap_mb=150)
    assert res.killed_for_memory and res.peak_rss_mb > 150 and res.duration_s < 25
    assert _log(tmp_path)[-1]["killed_for_memory"] is True


def test_missing_tool(tmp_path: Path) -> None:
    with pytest.raises(ToolNotFoundError):
        run_tool("gitleaks", None, ["version"], logs_dir=tmp_path)

"""Thin git helpers. All calls go through :func:`sentry.toolrun.run_tool` so they are logged."""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from .toolrun import run_tool


class GitError(RuntimeError):
    pass


@dataclass(frozen=True)
class RemoteInfo:
    name: str
    url: str
    host: str | None
    owner: str | None
    repo: str | None


_SCP_RE = re.compile(r"^(?:(?P<user>[^@/]+)@)?(?P<host>[^:/]+):(?P<path>[^/].*)$")
_URL_RE = re.compile(r"^(?P<scheme>[a-z][a-z0-9+.-]*)://(?:[^@/]+@)?(?P<host>[^/:]+)(?::\d+)?/(?P<path>.*)$", re.I)


def parse_remote_url(name: str, url: str) -> RemoteInfo:
    """Extract host/owner/repo from https, ssh:// and scp-like (git@host:owner/repo) remote URLs."""
    url = url.strip()
    host: str | None = None
    path: str | None = None
    m = _URL_RE.match(url)
    if m:
        if m.group("scheme").lower() == "file":
            return RemoteInfo(name, url, None, None, None)
        host, path = m.group("host"), m.group("path")
    else:
        m2 = _SCP_RE.match(url)
        if m2 and not re.match(r"^[A-Za-z]:[\\/]", url):  # not a Windows drive path like C:\repo
            host, path = m2.group("host"), m2.group("path")
    if not host or not path:
        return RemoteInfo(name, url, None, None, None)
    segments = [s for s in path.strip("/").split("/") if s]
    if len(segments) < 2:
        return RemoteInfo(name, url, host.lower(), None, None)
    owner, repo = segments[-2], segments[-1]
    if repo.endswith(".git"):
        repo = repo[:-4]
    # Only "host/owner/repo" is unambiguous; deeper paths (e.g. proxies, GitLab subgroups) keep owner None
    # unless the path is exactly two segments long.
    if len(segments) != 2:
        return RemoteInfo(name, url, host.lower(), None, repo)
    return RemoteInfo(name, url, host.lower(), owner, repo)


class Git:
    def __init__(self, root: Path, logs_dir: Path, scan_id: str | None = None) -> None:
        self.root = root
        self.logs_dir = logs_dir
        self.scan_id = scan_id
        found = shutil.which("git")
        self.exe = Path(found) if found else None

    @property
    def available(self) -> bool:
        return self.exe is not None

    def _run(self, *args: str, stdin: str | None = None, check: bool = True) -> str:
        if self.exe is None:
            raise GitError("git is not installed")
        res = run_tool(
            "git",
            self.exe,
            ["-C", str(self.root), *args],
            logs_dir=self.logs_dir,
            timeout_s=300,
            stdin_data=stdin,
            scan_id=self.scan_id,
        )
        if check and res.returncode != 0:
            raise GitError(f"git {' '.join(args[:2])} failed: {res.stderr.strip()[:300]}")
        return res.stdout

    def toplevel(self) -> Path | None:
        if self.exe is None:
            return None
        try:
            out = self._run("rev-parse", "--show-toplevel").strip()
        except GitError:
            return None
        return Path(out).resolve() if out else None

    def remotes(self) -> list[RemoteInfo]:
        out = self._run("remote", "-v", check=False)
        seen: dict[str, str] = {}
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 2 and (len(parts) < 3 or parts[2] == "(fetch)"):
                seen.setdefault(parts[0], parts[1])
        return [parse_remote_url(n, u) for n, u in sorted(seen.items())]

    def head(self) -> str | None:
        try:
            return self._run("rev-parse", "HEAD").strip() or None
        except GitError:
            return None

    def verify_ref(self, ref: str) -> str:
        if not ref or ref.startswith("-") or any(c.isspace() for c in ref):
            raise GitError(f"refusing suspicious git ref {ref!r}")
        out = self._run("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", check=False).strip()
        if not out:
            raise GitError(f"unknown git ref {ref!r}")
        return out

    def changed_files_since(self, ref: str) -> set[str]:
        """Files changed between ``ref`` and the working tree (committed + uncommitted + untracked)."""
        commit = self.verify_ref(ref)
        changed = self._run("diff", "--name-only", "--relative", "--diff-filter=ACMRT", "-z", commit, "--").split("\0")
        untracked = self._run("ls-files", "--others", "--exclude-standard", "-z").split("\0")
        return {p for p in (*changed, *untracked) if p}

    def tracked_files(self) -> set[str]:
        return {p for p in self._run("ls-files", "-z", check=False).split("\0") if p}

    def ignored(self, paths: list[str]) -> set[str]:
        if not paths:
            return set()
        out = self._run("check-ignore", "--stdin", "-z", stdin="\0".join(paths) + "\0", check=False)
        return {p for p in out.split("\0") if p}

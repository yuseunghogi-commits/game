"""Scope safety for static scanning (spec §0.1), enforced in code.

* Only directories the user explicitly passes are scanned (no discovery).
* If the repo has a git remote, the remote owner must be in :data:`ALLOWED_OWNERS` on a trusted git host.
  Otherwise the user must pass ``--i-own-this``; that confirmation is written to ``logs/audit.jsonl`` and
  to the database, and remembered only while the set of remotes is unchanged.
"""

from __future__ import annotations

import contextlib
import getpass
import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from .config import ALLOWED_OWNERS, TRUSTED_GIT_HOSTS, Paths
from .gitutil import Git, RemoteInfo
from .logs import append_jsonl, audit_log_path

if TYPE_CHECKING:
    from .store import Store


class ScopeError(RuntimeError):
    """The target is outside the allowed scope; the scan must not run."""


@dataclass
class ScopeDecision:
    root: Path
    repo_key: str
    method: str  # no-remote | owner-verified | i-own-this | recorded-confirmation
    remotes: list[RemoteInfo] = field(default_factory=list)
    remotes_hash: str = ""
    git_toplevel: Path | None = None
    message: str = ""


def _remotes_hash(remotes: list[RemoteInfo]) -> str:
    text = "\n".join(sorted(f"{r.name} {r.url}" for r in remotes))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def remote_is_owned(remote: RemoteInfo) -> bool:
    return (
        remote.host is not None
        and remote.host in TRUSTED_GIT_HOSTS
        and remote.owner is not None
        and remote.owner.lower() in {o.lower() for o in ALLOWED_OWNERS}
    )


def _repo_key(root: Path, toplevel: Path | None, remotes: list[RemoteInfo]) -> str:
    origin = next((r for r in remotes if r.name == "origin"), remotes[0] if remotes else None)
    if origin and origin.owner and origin.repo:
        base = f"{origin.owner}/{origin.repo}"
    elif toplevel is not None:
        base = f"local/{toplevel.name}"
    else:
        base = f"local/{root.name}"
    if toplevel is not None and toplevel != root:
        with contextlib.suppress(ValueError):
            base += "/" + root.relative_to(toplevel).as_posix()
    return base


def _validate_target(root: Path) -> Path:
    if not root.exists():
        raise ScopeError(f"{root} does not exist")
    if not root.is_dir():
        raise ScopeError(f"{root} is not a directory; pass the repository folder")
    resolved = root.resolve()
    if resolved == Path(resolved.anchor) or resolved == Path.home().resolve():
        raise ScopeError(
            f"refusing to scan {resolved}: pass a single repository folder, not a drive root or home directory"
        )
    return resolved


def check_scope(
    root: Path,
    *,
    paths: Paths,
    store: Store | None,
    i_own_this: bool = False,
    scope_note: str | None = None,
    scan_id: str | None = None,
) -> ScopeDecision:
    resolved = _validate_target(root)
    git = Git(resolved, paths.logs, scan_id)
    toplevel = git.toplevel() if git.available else None
    remotes = git.remotes() if toplevel is not None else []
    relevant = [r for r in remotes if r.name == "origin"] or remotes
    rhash = _remotes_hash(remotes)
    key = _repo_key(resolved, toplevel, remotes)
    decision = ScopeDecision(resolved, key, "", remotes, rhash, toplevel)
    audit = audit_log_path(paths.logs)
    base_event = {
        "scan_id": scan_id,
        "root": str(resolved),
        "repo_key": key,
        "remotes": [f"{r.name} {r.url}" for r in remotes],
        "user": getpass.getuser(),
    }

    if not relevant:
        decision.method = "no-remote"
        decision.message = "no git remote: local-only repository"
    elif all(remote_is_owned(r) for r in relevant):
        decision.method = "owner-verified"
        decision.message = "remote owner verified: " + ", ".join(f"{r.owner}/{r.repo}" for r in relevant)
    elif i_own_this:
        decision.method = "i-own-this"
        decision.message = "ownership confirmed with --i-own-this"
        append_jsonl(audit, {"event": "ownership_confirmed", **base_event, "note": scope_note or ""})
    else:
        prior = store.get_consent(str(resolved), rhash) if store is not None else None
        if prior is not None:
            decision.method = "recorded-confirmation"
            decision.message = f"using ownership confirmation recorded at {prior}"
        else:
            foreign = ", ".join(f"{r.name}={r.url}" for r in relevant if not remote_is_owned(r))
            append_jsonl(audit, {"event": "scope_refused", **base_event})
            raise ScopeError(
                f"remote(s) {foreign} are not owned by {', '.join(sorted(ALLOWED_OWNERS))}. "
                "Only scan code you own. If you do own it, re-run with --i-own-this "
                "(optionally --scope-note '<why>'); the confirmation is logged."
            )
    append_jsonl(audit, {"event": "scope_ok", "method": decision.method, **base_event})
    return decision

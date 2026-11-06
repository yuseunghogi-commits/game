from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from sentry.config import Paths
from sentry.gitutil import Git, GitError, parse_remote_url
from sentry.scope import ScopeError, check_scope, remote_is_owned
from sentry.store import Store

from .conftest import git, init_git, write_rec_app


@pytest.mark.parametrize(
    ("url", "host", "owner", "repo"),
    [
        ("https://github.com/yuseunghogi-commits/game.git", "github.com", "yuseunghogi-commits", "game"),
        ("https://github.com/yuseunghogi-commits/game", "github.com", "yuseunghogi-commits", "game"),
        ("git@github.com:yuseunghogi-commits/game.git", "github.com", "yuseunghogi-commits", "game"),
        ("ssh://git@github.com:22/yuseunghogi-commits/game.git", "github.com", "yuseunghogi-commits", "game"),
        ("https://token@github.com/someone/else/", "github.com", "someone", "else"),
        ("https://gitlab.com/yuseunghogi-commits/game", "gitlab.com", "yuseunghogi-commits", "game"),
        ("https://proxy.local/git/yuseunghogi-commits/game", "proxy.local", None, "game"),
        ("https://github.com/only-owner", "github.com", None, None),
        ("C:\\repos\\game", None, None, None),
        ("/srv/git/game.git", None, None, None),
        ("file:///srv/git/game.git", None, None, None),
    ],
)
def test_parse_remote_url(url: str, host: str | None, owner: str | None, repo: str | None) -> None:
    r = parse_remote_url("origin", url)
    assert (r.host, r.owner, r.repo) == (host, owner, repo)


def test_remote_ownership_rules() -> None:
    assert remote_is_owned(parse_remote_url("o", "git@github.com:YuSeungHoGi-Commits/x.git"))  # case-insensitive
    assert not remote_is_owned(parse_remote_url("o", "https://gitlab.com/yuseunghogi-commits/x"))  # other host
    assert not remote_is_owned(parse_remote_url("o", "https://github.com/yuseunghogi-commits-evil/x"))
    assert not remote_is_owned(parse_remote_url("o", "https://evil.com/github.com/yuseunghogi-commits/x"))


def _audit(paths: Paths) -> list[dict[str, Any]]:
    f = paths.logs / "audit.jsonl"
    return [json.loads(x) for x in f.read_text().splitlines()] if f.exists() else []


def test_owned_repo_passes(home: Paths, owned_repo: Path) -> None:
    d = check_scope(owned_repo, paths=home, store=None)
    assert d.method == "owner-verified" and d.repo_key == "yuseunghogi-commits/game"
    assert _audit(home)[-1]["event"] == "scope_ok"


def test_foreign_repo_refused_without_flag(home: Paths, foreign_repo: Path) -> None:
    with pytest.raises(ScopeError, match="--i-own-this"):
        check_scope(foreign_repo, paths=home, store=None)
    assert _audit(home)[-1]["event"] == "scope_refused"


def test_flag_is_logged_and_remembered_until_remotes_change(home: Paths, foreign_repo: Path) -> None:
    with Store(home.db) as store:
        d = check_scope(foreign_repo, paths=home, store=store, i_own_this=True, scope_note="my old account")
        assert d.method == "i-own-this"
        ev = [e for e in _audit(home) if e["event"] == "ownership_confirmed"]
        assert ev and ev[0]["note"] == "my old account" and "someone-else" in ev[0]["remotes"][0]
        store.record_consent(str(d.root), d.remotes_hash, "i-own-this", "my old account", "me")
        again = check_scope(foreign_repo, paths=home, store=store)
        assert again.method == "recorded-confirmation"
        git(foreign_repo, "remote", "add", "upstream", "https://github.com/third/party.git")
        with pytest.raises(ScopeError):  # origin unchanged but remote set changed → ask again
            check_scope(foreign_repo, paths=home, store=store)


def test_origin_owned_upstream_foreign_is_allowed(home: Paths, owned_repo: Path) -> None:
    git(owned_repo, "remote", "add", "upstream", "https://github.com/OWASP/NodeGoat.git")
    assert check_scope(owned_repo, paths=home, store=None).method == "owner-verified"


def test_without_origin_all_remotes_must_be_owned(home: Paths, tmp_path: Path) -> None:
    root = init_git(write_rec_app(tmp_path / "r"))
    git(root, "remote", "add", "mine", "https://github.com/yuseunghogi-commits/r.git")
    git(root, "remote", "add", "theirs", "https://github.com/other/r.git")
    with pytest.raises(ScopeError):
        check_scope(root, paths=home, store=None)


def test_untrusted_host_and_unparseable_remote_require_flag(home: Paths, tmp_path: Path) -> None:
    a = init_git(write_rec_app(tmp_path / "a"), "https://gitlab.com/yuseunghogi-commits/a.git")
    b = init_git(write_rec_app(tmp_path / "b"), "/srv/mirror/b.git")
    for root in (a, b):
        with pytest.raises(ScopeError):
            check_scope(root, paths=home, store=None)


def test_no_remote_and_no_git_are_local(home: Paths, rec_app: Path, tmp_path: Path) -> None:
    assert check_scope(rec_app, paths=home, store=None).method == "no-remote"
    local = init_git(write_rec_app(tmp_path / "local"))
    d = check_scope(local, paths=home, store=None)
    assert d.method == "no-remote" and d.repo_key == "local/local"


def test_subdirectory_key(home: Paths, owned_repo: Path) -> None:
    d = check_scope(owned_repo / "src", paths=home, store=None)
    assert d.repo_key == "yuseunghogi-commits/game/src" and d.git_toplevel == owned_repo.resolve()


def test_refuses_bad_targets(home: Paths, rec_app: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ScopeError):
        check_scope(rec_app / "missing", paths=home, store=None)
    with pytest.raises(ScopeError):
        check_scope(rec_app / "package.json", paths=home, store=None)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: rec_app))
    with pytest.raises(ScopeError, match="home directory"):
        check_scope(rec_app, paths=home, store=None)


def test_git_ref_injection_is_rejected(home: Paths, owned_repo: Path) -> None:
    g = Git(owned_repo, home.logs)
    for bad in ("--output=/tmp/x", "-p", "HEAD~1 --x", ""):
        with pytest.raises(GitError):
            g.verify_ref(bad)
    with pytest.raises(GitError, match="unknown"):
        g.verify_ref("no-such-branch")
    assert len(g.verify_ref("HEAD~1")) == 40
    (owned_repo / "new.js").write_text("x")
    (owned_repo / "src/server.js").write_text("changed")
    assert g.changed_files_since("HEAD") == {"new.js", "src/server.js"}

"""Shared fixtures. Tool outputs in tests/data were recorded from real semgrep 1.184 / gitleaks 8.30 /
osv-scanner 2.7 runs against the small app that :func:`write_rec_app` recreates."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

import pytest

from sentry.config import Paths

DATA = Path(__file__).parent / "data"
LEAKED_KEY = "pk9Qz7XvT2mLw8RbN4cYh6JdK3sF5gA1"  # fake secret planted in the recorded app's history

REC_FILES: dict[str, str] = {
    "src/server.js": """const express = require('express');
const _ = require('lodash');
const app = express();

app.get('/search', (req, res) => {
  const q = req.query.q;
  res.send('<h1>Results for ' + q + '</h1>');
});

app.get('/calc', (req, res) => {
  const expr = req.query.expr;
  const out = eval(expr);
  res.json({ out });
});

app.listen(3000);
""",
    "public/app.js": """const params = new URLSearchParams(location.search);
const name = params.get('name');
document.getElementById('greet').innerHTML = 'Hello ' + name;
document.getElementById('greet2').innerHTML = 'Hello ' + name;
""",
    "src/config.js": """module.exports = {
  paymentsApiKey: process.env.PAYMENTS_KEY,
};
""",
    "package.json": (
        '{ "name": "rec-app", "version": "1.0.0", "dependencies": { "express": "4.17.1", "lodash": "4.17.20" } }\n'
    ),
    ".gitignore": "node_modules/\n.env\n",
}


def write_rec_app(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    for rel, text in REC_FILES.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="\n")
    lock = DATA / "package-lock.json"
    (root / "package-lock.json").write_text(lock.read_text(encoding="utf-8"), encoding="utf-8", newline="\n")
    (root / ".env").write_text(
        "VITE_ADMIN_TOKEN=Hq8vR3nT6wY1zK4mP7sL2xC9bF5dG0jQ\nDB_PASSWORD=Zr7Kp2Wq9Xv4Lm8Tn3Bc6Yd1Fs5Gh0Jj\n",
        encoding="utf-8",
        newline="\n",
    )
    return root


def git(root: Path, *args: str) -> str:
    res = subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True)
    return res.stdout


def init_git(root: Path, remote: str | None = None, with_leaked_history: bool = True) -> Path:
    git(root, "init", "-q", "-b", "main")
    if with_leaked_history:
        cfg = root / "src" / "config.js"
        final = cfg.read_text(encoding="utf-8")
        cfg.write_text(final.replace("process.env.PAYMENTS_KEY", f'"{LEAKED_KEY}"'), encoding="utf-8", newline="\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "initial with key")
        cfg.write_text(final, encoding="utf-8", newline="\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "move key to env", "--allow-empty")
    if remote:
        git(root, "remote", "add", "origin", remote)
    return root


def load_json(name: str, root: Path | None = None) -> Any:
    text = (DATA / name).read_text(encoding="utf-8")
    if root is not None:
        text = text.replace("__ROOT__", root.as_posix())
    return json.loads(text)


@pytest.fixture(autouse=True)
def _isolated_git(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for var in ("GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"):
        monkeypatch.setenv(var, "Test")
    for var in ("GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"):
        monkeypatch.setenv(var, "test@example.com")
    monkeypatch.delenv("SENTRY_LITE_DB", raising=False)


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Paths:
    h = tmp_path / "home"
    monkeypatch.setenv("SENTRY_LITE_HOME", str(h))
    paths = Paths(h)
    paths.ensure()
    return paths


@pytest.fixture
def rec_app(tmp_path: Path) -> Path:
    return write_rec_app(tmp_path / "rec-app")


@pytest.fixture
def owned_repo(tmp_path: Path) -> Path:
    root = write_rec_app(tmp_path / "game")
    return init_git(root, "https://github.com/yuseunghogi-commits/game.git")


@pytest.fixture
def foreign_repo(tmp_path: Path) -> Path:
    root = write_rec_app(tmp_path / "other")
    return init_git(root, "git@github.com:someone-else/other.git")

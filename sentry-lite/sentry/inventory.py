"""Inventory: languages, package managers, frameworks and attack-surface entrypoints of a repository.

Pure Python, regex based, single pass, no external tools — cheap enough to run before every scan.
The output (``inventory.json``) drives profile selection and gives /triage and /hunt a map of the app.
"""

from __future__ import annotations

import json
import os
import re
import tomllib
from collections import defaultdict
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .config import EXCLUDE_DIRS
from .logs import utcnow_iso

LANG_BY_EXT: dict[str, str] = {
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".py": "python",
    ".html": "html",
    ".htm": "html",
    ".vue": "vue",
    ".svelte": "svelte",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".php": "php",
    ".rs": "rust",
    ".cs": "csharp",
    ".swift": "swift",
    ".rules": "firebase-rules",
    ".sql": "sql",
    ".sh": "shell",
    ".ps1": "powershell",
}
CODE_LANGS = {"javascript", "typescript", "python", "html", "vue", "svelte"}
MAX_SCAN_BYTES = 1_000_000
MAX_ENTRYPOINTS = 3000

LOCKFILES = {
    "package-lock.json": "npm",
    "npm-shrinkwrap.json": "npm",
    "yarn.lock": "yarn",
    "pnpm-lock.yaml": "pnpm",
    "bun.lockb": "bun",
    "poetry.lock": "poetry",
    "Pipfile.lock": "pipenv",
    "uv.lock": "uv",
    "pdm.lock": "pdm",
}
MANIFESTS = {
    "package.json": "npm",
    "requirements.txt": "pip",
    "pyproject.toml": "python",
    "Pipfile": "pipenv",
    "setup.py": "setuptools",
    "setup.cfg": "setuptools",
}

NPM_FRAMEWORKS: dict[str, str] = {
    "express": "Express",
    "koa": "Koa",
    "fastify": "Fastify",
    "@hapi/hapi": "hapi",
    "next": "Next.js",
    "nuxt": "Nuxt",
    "vite": "Vite",
    "react": "React",
    "vue": "Vue",
    "svelte": "Svelte",
    "@sveltejs/kit": "SvelteKit",
    "@angular/core": "Angular",
    "firebase": "Firebase JS SDK",
    "firebase-admin": "Firebase Admin SDK",
    "firebase-functions": "Cloud Functions for Firebase",
    "@netlify/functions": "Netlify Functions",
    "electron": "Electron",
    "@tauri-apps/api": "Tauri",
}
NPM_SECURITY_LIBS = {
    "jsonwebtoken",
    "jose",
    "passport",
    "express-session",
    "cookie-session",
    "cors",
    "helmet",
    "csurf",
    "mongoose",
    "mongodb",
    "pg",
    "mysql",
    "mysql2",
    "sqlite3",
    "better-sqlite3",
    "sequelize",
    "knex",
    "prisma",
    "@prisma/client",
    "multer",
    "axios",
    "node-fetch",
    "dompurify",
    "isomorphic-dompurify",
    "marked",
    "serialize-javascript",
    "bcrypt",
    "bcryptjs",
    "stripe",
}
PY_FRAMEWORKS: dict[str, str] = {
    "flask": "Flask",
    "fastapi": "FastAPI",
    "django": "Django",
    "starlette": "Starlette",
    "firebase-admin": "Firebase Admin SDK",
    "firebase-functions": "Cloud Functions for Firebase (Python)",
}
PY_SECURITY_LIBS = {
    "pyjwt",
    "python-jose",
    "sqlalchemy",
    "pymongo",
    "psycopg2",
    "requests",
    "httpx",
    "pyyaml",
    "jinja2",
}

_JS_ROUTE = re.compile(
    r"\b(?P<obj>app|router|server|api|routes|\w*[Rr]outer)\s*\.\s*(?P<method>get|post|put|patch|delete|all|options|head)"
    r"\s*\(\s*(?P<q>['\"`])(?P<route>/[^'\"`]*)(?P=q)"
)
_JS_MOUNT = re.compile(
    r"\b(?P<obj>app|router|server|\w*[Rr]outer)\s*\.\s*use\s*\(\s*(?P<q>['\"`])(?P<route>/[^'\"`]*)(?P=q)"
)
_FB_V1 = re.compile(
    r"exports\.(?P<name>\w+)\s*=\s*functions\b[\w\s.()'\"/{}:,-]*?\.(?P<trigger>onRequest|onCall|onCreate|onUpdate|"
    r"onDelete|onWrite|onFinalize|onRun)\b"
)
_FB_V2 = re.compile(
    r"(?:exports\.|export\s+const\s+)(?P<name>\w+)\s*=\s*(?:\w+\.)?(?P<trigger>onRequest|onCall|onDocument\w+|"
    r"onValue\w+|onObject\w+|onSchedule|onMessagePublished|beforeUserCreated|beforeUserSignedIn)\s*\("
)
_HANDLER_EXPORT = re.compile(
    r"(?:exports\.handler\s*=|export\s+(?:const|async\s+function|function)\s+handler\b|export\s+default\b)"
)
_NEXT_APP_METHOD = re.compile(
    r"export\s+(?:async\s+)?(?:function|const)\s+(?P<method>GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b"
)
_FORM_JS = re.compile(
    r"addEventListener\(\s*['\"]submit['\"]|\bonSubmit\s*=|\bonsubmit\s*=|\.submit\s*\(\s*(?:async\s*)?\("
)
_FORM_HTML = re.compile(r"<form\b[^>]*>", re.I)
_MESSAGE_LISTENER = re.compile(r"addEventListener\(\s*['\"]message['\"]|\bonmessage\s*=")
_URL_PARAM_JS = re.compile(
    r"\b(?:(?:window\.|document\.)?location\.(?:search|hash|href)|new\s+URLSearchParams\s*\(|useSearchParams\s*\(|"
    r"useParams\s*\(|searchParams\.get\s*\(|\$route\.(?:query|params)|router\.query|req\.(?:query|params))"
)
_URL_PARAM_PY = re.compile(r"\brequest\.(?:args|query_params|path_params|GET)\b")
_FLASK_ROUTE = re.compile(r"@(?P<obj>\w+)\.route\(\s*['\"](?P<route>[^'\"]+)['\"](?P<rest>[^)]*)\)")
_FASTAPI_ROUTE = re.compile(
    r"@(?P<obj>\w+)\.(?P<method>get|post|put|patch|delete|api_route|websocket)\(\s*['\"](?P<route>[^'\"]*)['\"]"
)
_DJANGO_PATH = re.compile(r"\b(?:re_)?path\(\s*r?['\"](?P<route>[^'\"]*)['\"]\s*,\s*(?P<view>[\w.]+)")
_JS_IMPORT = re.compile(
    r"(?:\brequire\s*\(\s*|\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)['\"](?P<mod>[^'\"./][^'\"]*)['\"]"
)
_PY_IMPORT = re.compile(r"^\s*(?:from\s+(?P<a>[A-Za-z_][\w.]*)\s+import|import\s+(?P<b>[A-Za-z_][\w.]*))", re.M)


class EntryPoint(BaseModel):
    kind: str  # http-route | http-mount | cloud-function | netlify-function | nextjs-api | form-handler |
    #           url-param-reader | message-listener
    file: str
    line: int
    method: str | None = None
    route: str | None = None
    framework: str | None = None
    detail: str = ""


class LanguageStats(BaseModel):
    files: int = 0
    loc: int = 0


class Inventory(BaseModel):
    root: str
    repo: str
    generated_at: str
    languages: dict[str, LanguageStats] = Field(default_factory=dict)
    total_files: int = 0
    total_loc: int = 0
    package_managers: list[str] = Field(default_factory=list)
    manifests: list[str] = Field(default_factory=list)
    lockfiles: list[str] = Field(default_factory=list)
    frameworks: list[str] = Field(default_factory=list)
    security_libraries: list[str] = Field(default_factory=list)
    firebase: dict[str, Any] = Field(default_factory=dict)
    netlify: dict[str, Any] = Field(default_factory=dict)
    entrypoints: list[EntryPoint] = Field(default_factory=list)
    entrypoints_truncated: bool = False
    imported_packages: dict[str, list[str]] = Field(default_factory=dict)
    skipped_large_files: list[str] = Field(default_factory=list)

    @property
    def code_languages(self) -> set[str]:
        return {lang for lang in self.languages if lang in CODE_LANGS}

    def imported_sets(self) -> dict[str, set[str]]:
        return {k: set(v) for k, v in self.imported_packages.items()}


def iter_files(root: Path, exclude_dirs: tuple[str, ...] = EXCLUDE_DIRS) -> list[Path]:
    excluded = set(exclude_dirs)
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in excluded and not d.endswith(".egg-info"))
        base = Path(dirpath)
        out.extend(base / f for f in sorted(filenames))
    return out


def _line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _is_minified(text: str) -> bool:
    lines = text.count("\n") + 1
    return len(text) > 20_000 and len(text) / lines > 400


def _npm_root(mod: str) -> str | None:
    if mod.startswith("node:"):
        return None
    parts = mod.split("/")
    if mod.startswith("@"):
        return "/".join(parts[:2]).lower() if len(parts) >= 2 else None
    return parts[0].lower()


def _load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _python_deps(path: Path) -> set[str]:
    names: set[str] = set()
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return names
    if path.name == "pyproject.toml":
        try:
            data = tomllib.loads(text)
        except tomllib.TOMLDecodeError:
            return names
        deps = list((data.get("project") or {}).get("dependencies", []) or [])
        poetry = ((data.get("tool") or {}).get("poetry") or {}).get("dependencies", {}) or {}
        deps.extend(poetry.keys())
        for d in deps:
            m = re.match(r"\s*([A-Za-z0-9_.-]+)", str(d))
            if m:
                names.add(m.group(1).lower())
        return names
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        m = re.match(r"([A-Za-z0-9_.-]+)", line)
        if m:
            names.add(m.group(1).lower())
    return names


def _rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _scan_firebase(root: Path, files: list[Path]) -> dict[str, Any]:
    info: dict[str, Any] = {}
    fb_json = root / "firebase.json"
    names = {p.name: p for p in files}
    if fb_json.is_file():
        cfg = _load_json(fb_json)
        info["firebase_json"] = "firebase.json"
        fs = cfg.get("firestore")
        fs_list = fs if isinstance(fs, list) else [fs] if isinstance(fs, dict) else []
        info["firestore_rules"] = [str(f.get("rules")) for f in fs_list if isinstance(f, dict) and f.get("rules")]
        st = cfg.get("storage")
        st_list = st if isinstance(st, list) else [st] if isinstance(st, dict) else []
        info["storage_rules"] = [str(s.get("rules")) for s in st_list if isinstance(s, dict) and s.get("rules")]
        db = cfg.get("database")
        db_list = db if isinstance(db, list) else [db] if isinstance(db, dict) else []
        info["database_rules"] = [str(d.get("rules")) for d in db_list if isinstance(d, dict) and d.get("rules")]
        fn = cfg.get("functions")
        fn_list = fn if isinstance(fn, list) else [fn] if isinstance(fn, dict) else []
        info["functions_source"] = [str(f.get("source", "functions")) for f in fn_list if isinstance(f, dict)]
        info["hosting"] = bool(cfg.get("hosting"))
        emulators = cfg.get("emulators") or {}
        info["emulators"] = {
            k: {"host": v.get("host", "127.0.0.1"), "port": v.get("port")}
            for k, v in emulators.items()
            if isinstance(v, dict) and v.get("port")
        }
    for fname in ("firestore.rules", "storage.rules", "database.rules.json", ".firebaserc"):
        if fname in names:
            info.setdefault("files", []).append(_rel(names[fname], root))
    return info


def _scan_netlify(root: Path, files: list[Path]) -> dict[str, Any]:
    info: dict[str, Any] = {}
    toml_path = root / "netlify.toml"
    fn_dir = "netlify/functions"
    if toml_path.is_file():
        info["netlify_toml"] = "netlify.toml"
        try:
            data = tomllib.loads(toml_path.read_text(encoding="utf-8", errors="replace"))
            fn_dir = str(
                (data.get("functions") or {}).get("directory") or (data.get("build") or {}).get("functions") or fn_dir
            )
            info["redirects"] = len(data.get("redirects", []) or [])
            info["headers"] = len(data.get("headers", []) or [])
        except tomllib.TOMLDecodeError:
            info["parse_error"] = True
    info["functions_dir"] = fn_dir.strip("/")
    return info


def build_inventory(root: Path, repo: str) -> Inventory:
    root = root.resolve()
    files = iter_files(root)
    inv = Inventory(root=str(root), repo=repo, generated_at=utcnow_iso())
    langs: dict[str, LanguageStats] = defaultdict(LanguageStats)
    npm_deps: set[str] = set()
    py_deps: set[str] = set()
    imported: dict[str, set[str]] = {"npm": set(), "pypi": set()}
    entrypoints: list[EntryPoint] = []
    pms: set[str] = set()

    inv.firebase = _scan_firebase(root, files)
    inv.netlify = _scan_netlify(root, files)
    netlify_fn_prefix = inv.netlify["functions_dir"] + "/"

    def add(ep: EntryPoint) -> None:
        if len(entrypoints) < MAX_ENTRYPOINTS:
            entrypoints.append(ep)
        else:
            inv.entrypoints_truncated = True

    for path in files:
        rel = _rel(path, root)
        name = path.name
        if name in LOCKFILES:
            inv.lockfiles.append(rel)
            pms.add(LOCKFILES[name])
        if name in MANIFESTS or (name.startswith("requirements") and name.endswith(".txt")):
            inv.manifests.append(rel)
            if name == "package.json":
                pms.add("npm")
                pkg = _load_json(path)
                for sect in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
                    deps = pkg.get(sect) or {}
                    if isinstance(deps, dict):
                        npm_deps.update(str(k).lower() for k in deps)
            else:
                pms.add("pip" if name.endswith(".txt") else MANIFESTS.get(name, "python"))
                py_deps |= _python_deps(path)
        lang = LANG_BY_EXT.get(path.suffix.lower())
        if lang is None:
            continue
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if size > MAX_SCAN_BYTES:
            inv.skipped_large_files.append(rel)
            langs[lang].files += 1
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        langs[lang].files += 1
        langs[lang].loc += sum(1 for ln in text.splitlines() if ln.strip())
        if lang not in CODE_LANGS or _is_minified(text):
            continue

        if lang in {"javascript", "typescript", "vue", "svelte", "html"}:
            for m in _JS_IMPORT.finditer(text):
                root_mod = _npm_root(m.group("mod"))
                if root_mod:
                    imported["npm"].add(root_mod)
            for m in _JS_ROUTE.finditer(text):
                add(
                    EntryPoint(
                        kind="http-route",
                        file=rel,
                        line=_line_of(text, m.start()),
                        method=m.group("method").upper(),
                        route=m.group("route"),
                        framework="express-like",
                        detail=m.group("obj"),
                    )
                )
            for m in _JS_MOUNT.finditer(text):
                add(EntryPoint(kind="http-mount", file=rel, line=_line_of(text, m.start()), route=m.group("route")))
            for rx in (_FB_V1, _FB_V2):
                for m in rx.finditer(text):
                    add(
                        EntryPoint(
                            kind="cloud-function",
                            file=rel,
                            line=_line_of(text, m.start()),
                            route=m.group("name"),
                            framework="firebase-functions",
                            detail=m.group("trigger"),
                        )
                    )
            if rel.startswith(netlify_fn_prefix) and lang in {"javascript", "typescript"}:
                hm = _HANDLER_EXPORT.search(text)
                if hm:
                    fn_name = rel[len(netlify_fn_prefix) :].split("/")[0].rsplit(".", 1)[0]
                    add(
                        EntryPoint(
                            kind="netlify-function",
                            file=rel,
                            line=_line_of(text, hm.start()),
                            route=f"/.netlify/functions/{fn_name}",
                            framework="netlify",
                        )
                    )
            api_match = re.search(r"(?:^|/)pages/api/(.+)\.(?:js|jsx|ts|tsx)$", rel)
            if api_match:
                route = "/api/" + re.sub(r"/?index$", "", api_match.group(1))
                add(EntryPoint(kind="nextjs-api", file=rel, line=1, route=route, framework="next"))
            app_match = re.search(r"(?:^|/)app/(.*)/?route\.(?:js|ts)$", rel)
            if app_match:
                for m in _NEXT_APP_METHOD.finditer(text):
                    add(
                        EntryPoint(
                            kind="nextjs-api",
                            file=rel,
                            line=_line_of(text, m.start()),
                            method=m.group("method"),
                            route="/" + app_match.group(1).rstrip("/"),
                            framework="next",
                        )
                    )
            for m in _FORM_JS.finditer(text):
                add(EntryPoint(kind="form-handler", file=rel, line=_line_of(text, m.start()), detail=m.group(0)[:60]))
            if lang == "html":
                for m in _FORM_HTML.finditer(text):
                    add(
                        EntryPoint(
                            kind="form-handler",
                            file=rel,
                            line=_line_of(text, m.start()),
                            detail=m.group(0)[:120],
                        )
                    )
            for m in _MESSAGE_LISTENER.finditer(text):
                add(
                    EntryPoint(
                        kind="message-listener",
                        file=rel,
                        line=_line_of(text, m.start()),
                        detail=m.group(0)[:60],
                    )
                )
            for m in _URL_PARAM_JS.finditer(text):
                add(
                    EntryPoint(
                        kind="url-param-reader",
                        file=rel,
                        line=_line_of(text, m.start()),
                        detail=m.group(0)[:60],
                    )
                )
        elif lang == "python":
            for m in _PY_IMPORT.finditer(text):
                mod = (m.group("a") or m.group("b") or "").split(".")[0].lower()
                if mod:
                    imported["pypi"].add(mod)
            for m in _FLASK_ROUTE.finditer(text):
                methods = re.findall(r"['\"](GET|POST|PUT|PATCH|DELETE)['\"]", m.group("rest"), re.I)
                add(
                    EntryPoint(
                        kind="http-route",
                        file=rel,
                        line=_line_of(text, m.start()),
                        method=",".join(x.upper() for x in methods) or "GET",
                        route=m.group("route"),
                        framework="flask",
                    )
                )
            for m in _FASTAPI_ROUTE.finditer(text):
                add(
                    EntryPoint(
                        kind="http-route",
                        file=rel,
                        line=_line_of(text, m.start()),
                        method=m.group("method").upper(),
                        route=m.group("route"),
                        framework="fastapi",
                    )
                )
            if path.name == "urls.py":
                for m in _DJANGO_PATH.finditer(text):
                    add(
                        EntryPoint(
                            kind="http-route",
                            file=rel,
                            line=_line_of(text, m.start()),
                            route="/" + m.group("route"),
                            framework="django",
                            detail=m.group("view"),
                        )
                    )
            for m in _URL_PARAM_PY.finditer(text):
                add(EntryPoint(kind="url-param-reader", file=rel, line=_line_of(text, m.start()), detail=m.group(0)))

    frameworks = [label for dep, label in NPM_FRAMEWORKS.items() if dep in npm_deps]
    frameworks += [label for dep, label in PY_FRAMEWORKS.items() if dep in py_deps]
    if inv.netlify.get("netlify_toml") or any(e.kind == "netlify-function" for e in entrypoints):
        frameworks.append("Netlify")
    if inv.firebase.get("firebase_json"):
        frameworks.append("Firebase project")
    servers = {
        "Express",
        "Koa",
        "Fastify",
        "hapi",
        "Next.js",
        "Nuxt",
        "Flask",
        "FastAPI",
        "Django",
        "SvelteKit",
    }
    has_html = any(_rel(p, root) in {"index.html", "public/index.html"} for p in files)
    if has_html and not servers.intersection(frameworks):
        frameworks.append("Static site / SPA")

    inv.languages = dict(sorted(langs.items(), key=lambda kv: -kv[1].loc))
    inv.total_files = len(files)
    inv.total_loc = sum(s.loc for s in langs.values())
    inv.package_managers = sorted(pms)
    inv.frameworks = list(dict.fromkeys(frameworks))
    inv.security_libraries = sorted((npm_deps & NPM_SECURITY_LIBS) | (py_deps & PY_SECURITY_LIBS))
    inv.entrypoints = entrypoints
    inv.imported_packages = {k: sorted(v) for k, v in imported.items()}
    return inv


def write_inventory(inv: Inventory, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(inv.model_dump_json(indent=2), encoding="utf-8")


def auto_profile(inv: Inventory) -> str:
    langs = inv.code_languages
    web = bool(langs & {"javascript", "typescript", "html", "vue", "svelte"})
    py = "python" in langs
    if web and py:
        return "mixed"
    if py:
        return "python"
    return "web"

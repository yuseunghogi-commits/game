from __future__ import annotations

import json
from pathlib import Path

from sentry.inventory import auto_profile, build_inventory

FILES = {
    "package.json": json.dumps(
        {"dependencies": {"express": "4", "firebase": "10", "jsonwebtoken": "9", "@netlify/functions": "2"}}
    ),
    "server.js": """const express = require('express');
const admin = require('./admin');
import { initializeApp } from 'firebase/app';
import x from '@scope/pkg/sub';
const app = express();
const router = express.Router();
app.get('/api/users/:id', auth, (req, res) => res.json(db[req.params.id]));
router.post("/login", login);
app.use('/admin', adminRouter);
""",
    "functions/index.js": """const functions = require('firebase-functions');
exports.addMessage = functions.https.onCall(async (data, ctx) => {});
exports.onUser = functions.firestore.document('users/{id}').onCreate(() => {});
export const api = onRequest((req, res) => {});
""",
    "netlify/functions/hello.js": "exports.handler = async (event) => ({ statusCode: 200 });\n",
    "pages/api/user/index.ts": "export default function handler(req, res) {}\n",
    "app/api/items/route.ts": "export async function GET() {}\nexport async function POST() {}\n",
    "public/index.html": '<html><form action="/subscribe" method="post"></form></html>\n',
    "public/app.js": "const h = location.hash.slice(1);\nwindow.addEventListener('message', (e) => {});\n"
    "form.addEventListener('submit', save);\n",
    "app.py": """from flask import Flask, request
import yaml
app = Flask(__name__)
@app.route('/items', methods=['POST', 'GET'])
def items():
    return request.args.get('q')
@router.get("/u/{uid}")
def user(uid): ...
""",
    "requirements.txt": "flask==2.0.0\nPyYAML>=5  # yaml\n-r other.txt\n",
    "firebase.json": json.dumps(
        {
            "firestore": {"rules": "firestore.rules"},
            "storage": {"rules": "storage.rules"},
            "functions": {"source": "functions"},
            "hosting": {"public": "dist"},
            "emulators": {"firestore": {"port": 8080}, "auth": {"host": "127.0.0.1", "port": 9099}},
        }
    ),
    "firestore.rules": "rules_version = '2';\n",
    "netlify.toml": '[build]\npublish = "dist"\n[[redirects]]\nfrom = "/*"\nto = "/index.html"\n',
    "node_modules/evil/index.js": "app.get('/should-not-appear', h);\n",
    "dist/bundle.js": "app.get('/also-excluded', h);\n",
}


def make(root: Path) -> Path:
    for rel, text in FILES.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    (root / "big.min.js").write_text("var a=1;" * 5000)  # minified: counted, not regex-scanned
    return root


def test_inventory_detects_stack_and_entrypoints(tmp_path: Path) -> None:
    inv = build_inventory(make(tmp_path / "app"), "o/app")
    for fw in ("Express", "Firebase JS SDK", "Netlify Functions", "Flask", "Netlify", "Firebase project"):
        assert fw in inv.frameworks
    assert "Static site / SPA" not in inv.frameworks
    assert "jsonwebtoken" in inv.security_libraries and "pyyaml" in inv.security_libraries
    assert set(inv.package_managers) >= {"npm", "pip"}
    assert inv.languages["javascript"].files >= 4 and inv.languages["python"].loc > 0

    routes = {(e.kind, e.method, e.route) for e in inv.entrypoints}
    assert ("http-route", "GET", "/api/users/:id") in routes
    assert ("http-route", "POST", "/login") in routes
    assert ("http-mount", None, "/admin") in routes
    assert ("http-route", "POST,GET", "/items") in routes
    assert ("http-route", "GET", "/u/{uid}") in routes
    assert ("netlify-function", None, "/.netlify/functions/hello") in routes
    assert ("nextjs-api", None, "/api/user") in routes
    assert ("nextjs-api", "POST", "/api/items") in routes
    fns = {(e.route, e.detail) for e in inv.entrypoints if e.kind == "cloud-function"}
    assert {("addMessage", "onCall"), ("onUser", "onCreate"), ("api", "onRequest")} <= fns
    kinds = {e.kind for e in inv.entrypoints}
    assert {"form-handler", "message-listener", "url-param-reader"} <= kinds
    assert all("node_modules" not in e.file and "dist/" not in e.file for e in inv.entrypoints)
    assert not any(e.file == "big.min.js" for e in inv.entrypoints)

    assert {"express", "firebase", "@scope/pkg"} <= set(inv.imported_packages["npm"])
    assert {"flask", "yaml"} <= set(inv.imported_packages["pypi"])
    assert inv.firebase["firestore_rules"] == ["firestore.rules"]
    assert inv.firebase["emulators"]["auth"] == {"host": "127.0.0.1", "port": 9099}
    assert inv.netlify["redirects"] == 1
    assert auto_profile(inv) == "mixed"


def test_static_site_profile(tmp_path: Path) -> None:
    root = tmp_path / "site"
    (root / "js").mkdir(parents=True)
    (root / "index.html").write_text("<script src=js/a.js></script>")
    (root / "js/a.js").write_text("document.write(location.search)")
    inv = build_inventory(root, "o/site")
    assert inv.frameworks == ["Static site / SPA"] and auto_profile(inv) == "web"


def test_python_profile(tmp_path: Path) -> None:
    root = tmp_path / "py"
    root.mkdir()
    (root / "main.py").write_text("from fastapi import FastAPI\napp = FastAPI()\n@app.post('/x')\ndef x(): ...\n")
    (root / "pyproject.toml").write_text('[project]\nname="x"\ndependencies=["fastapi>=0.100"]\n')
    inv = build_inventory(root, "o/py")
    assert "FastAPI" in inv.frameworks and auto_profile(inv) == "python"
    assert inv.entrypoints[0].route == "/x"

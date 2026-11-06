"""Tool output (semgrep JSON, gitleaks JSON, osv-scanner JSON, generic SARIF) → common Finding schema.

Fingerprints are ``sha1(rule_id + normalized path + normalized snippet)``: whitespace-insensitive and
independent of line numbers, so findings survive unrelated edits that shift code up or down.
"""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from collections.abc import Callable, Iterable
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlparse

from .models import DataflowStep, Finding, Severity

FileReader = Callable[[str], str | None]

_CWE_RE = re.compile(r"CWE[-_ ]?0*(\d+)", re.IGNORECASE)
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+|\n")

#: Front-end build tools inline env vars with these prefixes into the public JS bundle.
CLIENT_ENV_PREFIXES: tuple[str, ...] = (
    "VITE_",
    "NEXT_PUBLIC_",
    "REACT_APP_",
    "PUBLIC_",
    "EXPO_PUBLIC_",
    "GATSBY_",
    "NUXT_PUBLIC_",
    "VUE_APP_",
)


# --------------------------------------------------------------------------- fingerprints & helpers


def normalize_snippet(text: str) -> str:
    return " ".join(text.split())


def normalize_rel_path(rel: str) -> str:
    s = rel.replace("\\", "/")
    while s.startswith("./"):
        s = s[2:]
    return PurePosixPath(s).as_posix() if s else s


def normalize_path(repo: str, rel: str) -> str:
    rel_n = normalize_rel_path(rel)
    return f"{repo}/{rel_n}" if repo else rel_n


def fingerprint(rule_id: str, repo: str, rel_path: str, basis: str, occurrence: int = 0) -> str:
    """Stable finding id. ``occurrence`` disambiguates identical snippets in one file (0 = first)."""
    parts = [rule_id, normalize_path(repo, rel_path), normalize_snippet(basis)]
    if occurrence:
        parts.append(f"#{occurrence}")
    return hashlib.sha1("\x1f".join(parts).encode("utf-8"), usedforsecurity=False).hexdigest()


def to_rel(path: str, root: Path) -> str:
    """Convert a tool-reported path (absolute or relative to ``root``) into a repo-relative posix path."""
    p = Path(path)
    if p.is_absolute():
        try:
            return normalize_rel_path(p.resolve().relative_to(root.resolve()).as_posix())
        except (ValueError, OSError):
            return normalize_rel_path(path)
    return normalize_rel_path(path)


def make_file_reader(root: Path, max_bytes: int = 2_000_000) -> FileReader:
    cache: dict[str, str | None] = {}
    root_resolved = root.resolve()

    def read(rel: str) -> str | None:
        if rel in cache:
            return cache[rel]
        text: str | None = None
        try:
            target = (root_resolved / rel).resolve()
            target.relative_to(root_resolved)  # never read outside the scanned repo
            if target.is_file() and target.stat().st_size <= max_bytes:
                text = target.read_text(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            text = None
        cache[rel] = text
        return text

    return read


def read_snippet(reader: FileReader, rel: str, start: int, end: int, max_lines: int = 12, max_chars: int = 1500) -> str:
    text = reader(rel)
    if text is None:
        return ""
    lines = text.splitlines()
    start = max(1, start)
    end = max(start, min(end, start + max_lines - 1))
    snippet = "\n".join(lines[start - 1 : end])
    return snippet[:max_chars]


def extract_cwes(value: Any) -> list[str]:
    found: list[str] = []
    items: Iterable[Any] = value if isinstance(value, list) else [value]
    for item in items:
        if item is None:
            continue
        for m in _CWE_RE.finditer(str(item)):
            cwe = f"CWE-{int(m.group(1))}"
            if cwe not in found:
                found.append(cwe)
    return found


def title_from(message: str, rule_id: str, limit: int = 120) -> str:
    msg = message.strip()
    if msg:
        first = _SENTENCE_RE.split(msg, maxsplit=1)[0].strip()
        if first:
            return first if len(first) <= limit else first[: limit - 1] + "…"
    tail = rule_id.rsplit(".", 1)[-1]
    return tail.replace("-", " ").replace("_", " ").strip() or rule_id


def severity_from_score(score: float) -> Severity:
    if score >= 9.0:
        return Severity.critical
    if score >= 7.0:
        return Severity.high
    if score >= 4.0:
        return Severity.medium
    if score > 0.0:
        return Severity.low
    return Severity.info


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def finalize(items: list[tuple[Finding, str]]) -> list[Finding]:
    """Assign fingerprint ids. Identical (rule, path, basis) occurrences get an occurrence index by line."""
    groups: dict[tuple[str, str, str], list[Finding]] = defaultdict(list)
    for finding, basis in items:
        groups[(finding.rule_id, normalize_rel_path(finding.file), normalize_snippet(basis))].append(finding)
    out: list[Finding] = []
    for (rule_id, rel, basis), members in groups.items():
        members.sort(key=lambda f: (f.start_line, f.end_line))
        seen_lines: set[tuple[int, int]] = set()
        occurrence = 0
        for f in members:
            if (f.start_line, f.end_line) in seen_lines:
                continue  # exact duplicate report of the same location
            seen_lines.add((f.start_line, f.end_line))
            f.file = rel
            f.id = fingerprint(rule_id, f.repo, rel, basis, occurrence)
            occurrence += 1
            out.append(f)
    out.sort(key=lambda f: (-f.severity.rank, f.file, f.start_line))
    return out


# --------------------------------------------------------------------------- semgrep

_SEMGREP_SEVERITY = {
    "CRITICAL": Severity.critical,
    "ERROR": Severity.high,
    "HIGH": Severity.high,
    "WARNING": Severity.medium,
    "MEDIUM": Severity.medium,
    "INFO": Severity.low,
    "LOW": Severity.low,
    "INVENTORY": Severity.info,
    "EXPERIMENT": Severity.info,
}
_RULE_CONFIDENCE_PRIOR = {"HIGH": 0.5, "MEDIUM": 0.35, "LOW": 0.2}


def _trace_steps(trace: Any, root: Path) -> list[DataflowStep]:
    steps: list[DataflowStep] = []

    def add(loc: dict[str, Any], content: str, label: str) -> None:
        start = loc.get("start") or {}
        step = DataflowStep(
            file=to_rel(str(loc.get("path", "")), root),
            line=int(start.get("line", 1) or 1),
            note=f"{label}: {normalize_snippet(content)[:160]}",
        )
        if not steps or (steps[-1].file, steps[-1].line) != (step.file, step.line):
            steps.append(step)

    def walk(node: Any, label: str) -> None:
        if isinstance(node, list):
            if len(node) == 2 and isinstance(node[0], dict) and "path" in node[0] and isinstance(node[1], str):
                add(node[0], node[1], label)
                return
            for item in node:
                walk(item, label)
        elif isinstance(node, dict):
            if isinstance(node.get("location"), dict) and "content" in node:
                add(node["location"], str(node["content"]), label)
                return
            for value in node.values():
                walk(value, label)

    if isinstance(trace, dict):
        walk(trace.get("taint_source"), "source")
        walk(trace.get("intermediate_vars"), "via")
        walk(trace.get("taint_sink"), "sink")
    return steps


def canonical_rule_id(check_id: str, local_rule_ids: Iterable[str]) -> str:
    """Strip the path prefix semgrep adds to rules loaded from local files.

    ``--config C:/Users/me/sentry-lite/rules`` turns rule ``sentry.dom-xss`` into
    ``C.Users.me.sentry-lite.rules.sentry.dom-xss``; fingerprints must not depend on install location.
    """
    best = ""
    for rid in local_rule_ids:
        if (check_id == rid or check_id.endswith("." + rid)) and len(rid) > len(best):
            best = rid
    return best or check_id


def semgrep_to_findings(
    data: dict[str, Any],
    *,
    root: Path,
    repo: str,
    reader: FileReader | None = None,
    local_rule_ids: Iterable[str] = (),
) -> tuple[list[Finding], set[str]]:
    """Parse ``semgrep --json`` output. Returns (findings, files that semgrep failed on)."""
    reader = reader or make_file_reader(root)
    local_ids = list(local_rule_ids)
    items: list[tuple[Finding, str]] = []
    for r in data.get("results", []) or []:
        extra: dict[str, Any] = r.get("extra", {}) or {}
        meta: dict[str, Any] = extra.get("metadata", {}) or {}
        rel = to_rel(str(r.get("path", "")), root)
        start = int((r.get("start") or {}).get("line", 1) or 1)
        end = int((r.get("end") or {}).get("line", start) or start)
        snippet = read_snippet(reader, rel, start, end)
        lines = str(extra.get("lines", "") or "")
        if not snippet and lines and lines.strip() != "requires login":
            snippet = lines
        rule_id = canonical_rule_id(str(r.get("check_id", "semgrep.unknown")), local_ids)
        message = str(extra.get("message", "") or "")
        sev_raw = str(extra.get("severity", "WARNING")).upper()
        conf_raw = str(meta.get("confidence", "")).upper()
        refs = [str(x) for x in _as_list(meta.get("references"))]
        for key in ("source", "shortlink"):
            if meta.get(key):
                refs.append(str(meta[key]))
        fix = extra.get("fix")
        finding = Finding(
            id="",
            repo=repo,
            source_tool="semgrep",
            rule_id=rule_id,
            cwe=extract_cwes(meta.get("cwe")),
            title=title_from(message, rule_id),
            message=message,
            file=rel,
            start_line=start,
            end_line=end,
            snippet=snippet,
            severity=_SEMGREP_SEVERITY.get(sev_raw, Severity.medium),
            confidence=_RULE_CONFIDENCE_PRIOR.get(conf_raw, 0.3),
            dataflow=_trace_steps(extra.get("dataflow_trace"), root),
            fix_suggestion=f"Semgrep 자동 수정 제안: {fix}" if fix else None,
            references=list(dict.fromkeys(refs)),
            metadata={
                k: meta[k]
                for k in (
                    "category",
                    "subcategory",
                    "likelihood",
                    "impact",
                    "owasp",
                    "technology",
                    "vulnerability_class",
                )
                if k in meta
            }
            | {"semgrep_severity": sev_raw, "rule_confidence": conf_raw or None},
        )
        items.append((finding, snippet or f"{rule_id}@{start}"))

    failed: set[str] = set()
    for err in data.get("errors", []) or []:
        level = str(err.get("level", "error")).lower()
        if level not in {"error", "warn", "warning"}:
            continue
        if err.get("path"):
            failed.add(to_rel(str(err["path"]), root))
        for span in err.get("spans", []) or []:
            if isinstance(span, dict) and span.get("file"):
                failed.add(to_rel(str(span["file"]), root))
    return finalize(items), failed


# --------------------------------------------------------------------------- gitleaks


def redact(secret: str) -> str:
    if len(secret) >= 20:
        return f"{secret[:4]}…[REDACTED {len(secret)} chars]"
    return "[REDACTED]"


def _env_var_name(match: str) -> str | None:
    m = re.match(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[:=]", match)
    return m.group(1) if m else None


def gitleaks_to_findings(
    records: list[dict[str, Any]],
    *,
    root: Path,
    repo: str,
    tracked: set[str],
    ignored: set[str],
    reader: FileReader | None = None,
    path_map: Callable[[str], str | None] | None = None,
) -> list[Finding]:
    """Parse gitleaks JSON. Secrets are hashed for the fingerprint and redacted everywhere else.

    ``path_map`` converts git-toplevel-relative history paths to scan-root-relative ones (None = drop).
    """
    reader = reader or make_file_reader(root)
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for rec in records:
        secret = str(rec.get("Secret", "") or "")
        raw_file = str(rec.get("File", "") or "")
        rel = path_map(raw_file) if (path_map and rec.get("Commit")) else to_rel(raw_file, root)
        if rel is None:
            continue
        digest = hashlib.sha256(secret.encode("utf-8")).hexdigest()
        grouped[(str(rec.get("RuleID", "unknown")), rel, digest)].append(rec)

    items: list[tuple[Finding, str]] = []
    for (rule, rel, digest), recs in grouped.items():
        secret = str(recs[0].get("Secret", "") or "")
        wt = [r for r in recs if not r.get("Commit")]
        hist = [r for r in recs if r.get("Commit")]
        primary = wt[0] if wt else hist[0]
        match = str(primary.get("Match", "") or "")
        snippet = match.replace(secret, redact(secret)) if secret else match
        snippet = snippet[:300]
        commits = sorted({(str(r.get("Commit", ""))[:12], str(r.get("Date", ""))) for r in hist}, key=lambda c: c[1])
        is_tracked = rel in tracked
        is_ignored = rel in ignored
        env_name = _env_var_name(match)
        client_env = bool(env_name and env_name.upper().startswith(CLIENT_ENV_PREFIXES))
        top = rel.split("/", 1)[0]
        in_bundle = top in {"dist", "build", "out", "public"} and rel.endswith((".js", ".mjs", ".map"))
        file_text = reader(rel) or ""
        firebase_web_key = rule == "gcp-api-key" and (
            "firebaseapp.com" in file_text or "authDomain" in file_text or "authDomain" in match
        )

        if firebase_web_key:
            severity, exposure = Severity.info, "firebase-web-config"
        elif hist or is_tracked:
            severity, exposure = Severity.high, "committed"
        elif client_env or in_bundle:
            severity, exposure = Severity.high, "client-bundle"
        elif not is_ignored:
            severity, exposure = Severity.medium, "untracked-not-ignored"
        else:
            severity, exposure = Severity.low, "local-ignored-file"

        labels = {
            "committed": "git에 커밋됨",
            "client-bundle": "프런트엔드 번들에 노출",
            "untracked-not-ignored": "커밋 직전(.gitignore 미등록)",
            "local-ignored-file": "로컬 전용 파일",
            "firebase-web-config": "Firebase 웹 설정 키(공개 전제)",
        }
        description = str(primary.get("Description", "") or rule)
        if firebase_web_key:
            fix = (
                "Firebase 웹 API 키는 비밀이 아니며 클라이언트에 공개되는 것이 정상입니다. 실제 보안 경계는 "
                "Firestore/Storage 보안 규칙과 App Check입니다. 규칙을 점검하고 App Check를 켜고, Google Cloud "
                "콘솔에서 키의 API/HTTP referrer 제한을 설정하세요."
            )
        else:
            fix = (
                "1) 지금 즉시 해당 서비스에서 이 자격 증명을 폐기(rotate/revoke)하세요. 한 번이라도 push되었다면 "
                "유출된 것으로 간주합니다. 2) 코드에서 제거하고 환경 변수/시크릿 매니저(서버 측)로 옮기세요. "
                "3) git 기록 정리(git filter-repo)는 이미 유출된 키를 되돌리지 못하므로 폐기가 먼저입니다. "
                "Sentry-Lite는 발견된 키를 실제로 사용해 검증하지 않습니다."
            )
        line = int(primary.get("StartLine", 1) or 1)
        finding = Finding(
            id="",
            repo=repo,
            source_tool="gitleaks",
            rule_id=f"gitleaks.{rule}",
            cwe=["CWE-798"],
            title=f"하드코딩된 비밀값 [{rule}] — {labels[exposure]}",
            message=f"gitleaks rule {rule}: {description}",
            file=rel,
            start_line=line,
            end_line=int(primary.get("EndLine", line) or line),
            snippet=snippet,
            severity=severity,
            confidence=0.3 if rule == "generic-api-key" else 0.6,
            dataflow=[
                DataflowStep(file=rel, line=int(r.get("StartLine", 1) or 1), note=f"commit {c[:12]}")
                for r in hist[:10]
                for c in [str(r.get("Commit", ""))]
            ],
            fix_suggestion=fix,
            references=[
                "https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html",
                "https://cwe.mitre.org/data/definitions/798.html",
            ],
            metadata={
                "exposure": exposure,
                "in_working_tree": bool(wt),
                "tracked": is_tracked,
                "ignored": is_ignored,
                "commits": [{"commit": c, "date": d} for c, d in commits][:50],
                "env_var": env_name,
                "secret_length": len(secret),
                "entropy": primary.get("Entropy"),
                "gitleaks_rule": rule,
            },
        )
        items.append((finding, f"secret-sha256:{digest}"))
    return finalize(items)


# --------------------------------------------------------------------------- osv-scanner

_DB_SEVERITY = {
    "CRITICAL": Severity.critical,
    "HIGH": Severity.high,
    "MODERATE": Severity.medium,
    "MEDIUM": Severity.medium,
    "LOW": Severity.low,
}

_PYPI_IMPORT_NAMES = {
    "pyyaml": "yaml",
    "pillow": "pil",
    "beautifulsoup4": "bs4",
    "python_jose": "jose",
    "pyjwt": "jwt",
    "scikit_learn": "sklearn",
    "opencv_python": "cv2",
    "protobuf": "google",
    "python_dateutil": "dateutil",
    "pycryptodome": "crypto",
    "python_multipart": "multipart",
    "msgpack_python": "msgpack",
}


def normalize_pkg_name(name: str, ecosystem: str) -> str:
    n = name.strip().lower()
    if ecosystem.lower() == "pypi":
        n = re.sub(r"[-.]+", "_", n)
        return _PYPI_IMPORT_NAMES.get(n, n)
    return n


def _version_key(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:4]) or (0,)


def _pick_fix(current: str, fixed: list[str]) -> str | None:
    if not fixed:
        return None
    cur = _version_key(current)
    newer = sorted((f for f in fixed if _version_key(f) > cur), key=_version_key)
    return newer[0] if newer else sorted(fixed, key=_version_key)[-1]


def _lockfile_line(text: str | None, name: str) -> int:
    if not text:
        return 1
    patterns = [f'"node_modules/{name}"', f'"{name}"', f"{name}@", f'name = "{name}"', f"{name}=="]
    lines = text.splitlines()
    for pat in patterns:
        for i, line in enumerate(lines, 1):
            if pat in line:
                return i
    return 1


def osv_to_findings(
    data: dict[str, Any],
    *,
    root: Path,
    repo: str,
    imported: dict[str, set[str]],
    reader: FileReader | None = None,
) -> tuple[list[Finding], dict[str, int]]:
    """Parse osv-scanner JSON. Keeps only vulns that have a fixed version or a reachable package.

    ``imported`` maps ecosystem ("npm"/"pypi") → normalized names directly imported by the source code.
    """
    reader = reader or make_file_reader(root)
    stats = {"vulns_total": 0, "kept": 0, "dropped_no_fix_unreachable": 0}
    items: list[tuple[Finding, str]] = []
    for result in data.get("results", []) or []:
        rel = to_rel(str((result.get("source") or {}).get("path", "")), root)
        for pkg in result.get("packages", []) or []:
            pinfo = pkg.get("package", {}) or {}
            name = str(pinfo.get("name", ""))
            version = str(pinfo.get("version", ""))
            eco = str(pinfo.get("ecosystem", ""))
            vulns = {str(v.get("id")): v for v in pkg.get("vulnerabilities", []) or []}
            groups = pkg.get("groups") or [{"ids": [vid], "aliases": [vid]} for vid in vulns]
            for group in groups:
                ids = [str(i) for i in group.get("ids", []) if str(i) in vulns] or [
                    str(i) for i in group.get("ids", [])
                ]
                if not ids:
                    continue
                stats["vulns_total"] += 1
                primary = next((i for i in ids if i.startswith("GHSA-")), None) or next(
                    (i for i in ids if i.startswith("CVE-")), ids[0]
                )
                group_vulns = [vulns[i] for i in ids if i in vulns]
                fixed: set[str] = set()
                cwes: list[str] = []
                db_sev: Severity | None = None
                refs: list[str] = []
                for v in group_vulns:
                    for aff in v.get("affected", []) or []:
                        ap = aff.get("package", {}) or {}
                        if str(ap.get("name", "")).lower() != name.lower():
                            continue
                        for rng in aff.get("ranges", []) or []:
                            for ev in rng.get("events", []) or []:
                                if ev.get("fixed"):
                                    fixed.add(str(ev["fixed"]))
                    dbs = v.get("database_specific", {}) or {}
                    for c in extract_cwes(dbs.get("cwe_ids")):
                        if c not in cwes:
                            cwes.append(c)
                    sev = _DB_SEVERITY.get(str(dbs.get("severity", "")).upper())
                    if sev and (db_sev is None or sev.rank > db_sev.rank):
                        db_sev = sev
                    refs.extend(
                        str(r.get("url"))
                        for r in sorted(v.get("references", []) or [], key=lambda r: r.get("type") != "ADVISORY")
                        if r.get("url")
                    )
                analysis = group.get("experimentalAnalysis") or group.get("experimental_analysis") or {}
                called_flags = [bool(a.get("called")) for a in analysis.values() if isinstance(a, dict)]
                called: bool | None = any(called_flags) if called_flags else None
                is_imported = normalize_pkg_name(name, eco) in imported.get(eco.lower(), set())
                reachable = called if called is not None else is_imported
                if not fixed and not reachable:
                    stats["dropped_no_fix_unreachable"] += 1
                    continue
                stats["kept"] += 1
                try:
                    score = float(group.get("max_severity") or 0)
                except (TypeError, ValueError):
                    score = 0.0
                severity = severity_from_score(score) if score > 0 else (db_sev or Severity.medium)
                summary = ""
                if group_vulns:
                    pv = vulns.get(primary, group_vulns[0])
                    summary = str(pv.get("summary") or str(pv.get("details", "")).split("\n", 1)[0])
                fix_to = _pick_fix(version, sorted(fixed))
                fix_text = (
                    f"{name}을(를) {fix_to} 이상으로 업그레이드하세요 (lockfile 갱신 후 테스트)."
                    if fix_to
                    else "아직 수정 버전이 없습니다. 해당 기능 사용을 피하거나 대체 패키지를 검토하세요."
                )
                line = _lockfile_line(reader(rel), name)
                finding = Finding(
                    id="",
                    repo=repo,
                    source_tool="osv-scanner",
                    rule_id=f"osv.{primary}",
                    cwe=cwes,
                    title=f"{name}@{version}: {summary}".strip().rstrip(":")[:160],
                    message=summary,
                    file=rel,
                    start_line=line,
                    end_line=line,
                    snippet=f"{name}@{version} ({eco})",
                    severity=severity,
                    confidence=0.6 if reachable else 0.3,
                    fix_suggestion=fix_text,
                    references=list(dict.fromkeys([f"https://osv.dev/vulnerability/{primary}", *refs]))[:6],
                    metadata={
                        "package": name,
                        "version": version,
                        "ecosystem": eco,
                        "ids": ids,
                        "aliases": [str(a) for a in group.get("aliases", [])],
                        "fixed_versions": sorted(fixed, key=_version_key),
                        "imported": is_imported,
                        "called": called,
                        "reachable": reachable,
                        "max_severity": group.get("max_severity"),
                    },
                )
                items.append((finding, f"{eco.lower()}:{name.lower()}"))
    return finalize(items), stats


# --------------------------------------------------------------------------- SARIF (generic import)

_SARIF_LEVEL = {
    "error": Severity.high,
    "warning": Severity.medium,
    "note": Severity.low,
    "none": Severity.info,
}


def _sarif_uri_to_rel(uri: str, root: Path) -> str:
    if uri.startswith("file:"):
        parsed = urlparse(uri)
        path = unquote(parsed.path)
        if re.match(r"^/[A-Za-z]:/", path):  # file:///C:/x on Windows
            path = path[1:]
        return to_rel(path, root)
    return to_rel(unquote(uri), root)


def sarif_to_findings(
    data: dict[str, Any],
    *,
    root: Path,
    repo: str,
    tool_name: str | None = None,
    reader: FileReader | None = None,
) -> list[Finding]:
    reader = reader or make_file_reader(root)
    items: list[tuple[Finding, str]] = []
    for run in data.get("runs", []) or []:
        driver = ((run.get("tool") or {}).get("driver")) or {}
        tool = tool_name or str(driver.get("name", "sarif")).lower()
        rules = {str(r.get("id")): r for r in driver.get("rules", []) or []}
        for res in run.get("results", []) or []:
            rule_id = str(res.get("ruleId") or (res.get("rule") or {}).get("id") or "sarif.unknown")
            rule = rules.get(rule_id, {})
            props = rule.get("properties", {}) or {}
            message = str((res.get("message") or {}).get("text", "") or "")
            locs = res.get("locations") or [{}]
            phys = (locs[0] or {}).get("physicalLocation", {}) or {}
            rel = _sarif_uri_to_rel(str((phys.get("artifactLocation") or {}).get("uri", "")), root)
            region = phys.get("region", {}) or {}
            start = int(region.get("startLine", 1) or 1)
            end = int(region.get("endLine", start) or start)
            snippet = read_snippet(reader, rel, start, end) or str((region.get("snippet") or {}).get("text", ""))
            sec = props.get("security-severity")
            try:
                severity = severity_from_score(float(sec)) if sec is not None else None
            except (TypeError, ValueError):
                severity = None
            level = str(res.get("level") or (rule.get("defaultConfiguration") or {}).get("level") or "warning")
            steps: list[DataflowStep] = []
            for flow in res.get("codeFlows", []) or []:
                for tf in flow.get("threadFlows", []) or []:
                    for tfl in tf.get("locations", []) or []:
                        loc = (tfl.get("location") or {}).get("physicalLocation", {}) or {}
                        steps.append(
                            DataflowStep(
                                file=_sarif_uri_to_rel(str((loc.get("artifactLocation") or {}).get("uri", "")), root),
                                line=int((loc.get("region") or {}).get("startLine", 1) or 1),
                                note=str(((tfl.get("location") or {}).get("message") or {}).get("text", "")),
                            )
                        )
                break
            short = str((rule.get("shortDescription") or {}).get("text", "") or "")
            finding = Finding(
                id="",
                repo=repo,
                source_tool=tool,
                rule_id=rule_id,
                cwe=extract_cwes([*_as_list(props.get("tags")), props.get("cwe"), rule_id]),
                title=title_from(message or short, rule_id),
                message=message,
                file=rel,
                start_line=start,
                end_line=end,
                snippet=snippet,
                severity=severity or _SARIF_LEVEL.get(level, Severity.medium),
                confidence=0.3,
                dataflow=steps,
                references=[str(rule["helpUri"])] if rule.get("helpUri") else [],
                metadata={"sarif_level": level},
            )
            items.append((finding, snippet or f"{rule_id}@{start}"))
    return finalize(items)

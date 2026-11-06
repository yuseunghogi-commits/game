"""`sentry` command-line interface (Typer).

The Claude Code slash commands use only this CLI (with ``--json``) to read and write findings.
Exit codes: 0 ok · 1 error · 2 scope refused · 3 blocking findings (see ``--fail-on``).
"""

from __future__ import annotations

import contextlib
import json
import platform
import sys
from pathlib import Path
from typing import Annotated, Any

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from . import __version__
from .config import DEFAULT_MEM_CAP_MB, Paths, find_tool
from .gitutil import GitError
from .inventory import build_inventory, write_inventory
from .models import Finding, Severity, Status
from .normalize import make_file_reader, sarif_to_findings
from .pipeline import PROFILES, ScanOutcome, run_scan
from .scope import ScopeError, check_scope
from .store import Store, StoreError
from .toolrun import ToolNotFoundError, tool_version

app = typer.Typer(add_completion=False, no_args_is_help=True, help="Sentry-Lite: scan repositories you own.")
findings_app = typer.Typer(no_args_is_help=True, help="List, inspect and update findings (used by /triage etc.).")
scans_app = typer.Typer(no_args_is_help=True, help="Scan history.")
app.add_typer(findings_app, name="findings")
app.add_typer(scans_app, name="scans")

console = Console(highlight=False)
err_console = Console(stderr=True, highlight=False)

SEV_STYLE = {
    "critical": "bold white on red",
    "high": "bold red",
    "medium": "yellow",
    "low": "cyan",
    "info": "dim",
}
STATUS_ORDER = ["confirmed", "likely", "candidate", "fixed", "triaged_fp", "wont_fix"]


def _utf8_stdout() -> None:
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(AttributeError, ValueError):
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]


def _paths() -> Paths:
    return Paths.default()


def _emit_json(data: Any) -> None:
    sys.stdout.write(json.dumps(data, ensure_ascii=False, indent=2, default=str) + "\n")


def _fail(msg: str, code: int = 1) -> typer.Exit:
    err_console.print(f"[bold red]error:[/] {msg}")
    return typer.Exit(code)


def _csv(values: list[str] | None) -> list[str]:
    out: list[str] = []
    for v in values or []:
        out += [x.strip() for x in v.split(",") if x.strip()]
    return out


# ---------------------------------------------------------------------------------------------- scan


def _print_summary(o: ScanOutcome) -> None:
    inv = o.inventory
    console.print(
        Panel.fit(
            f"[bold]{o.repo}[/]  ({o.root})\n"
            f"scope: {o.scope.message}\n"
            f"profile: {o.profile} · {inv.total_loc:,} LOC in {inv.total_files:,} files · "
            f"{len(inv.entrypoints)} entrypoints\n"
            f"frameworks: {', '.join(inv.frameworks) or '-'}\n"
            f"scan id: {o.scan_id} · total {o.duration_s:.1f}s",
            title="Sentry-Lite scan",
        )
    )
    t = Table(title="Tools", show_lines=False)
    for col in ("tool", "version", "status", "time", "peak RAM", "findings", "notes"):
        t.add_column(col, overflow="fold")
    for out in o.outputs:
        status = "[dim]skipped[/]" if out.skipped else ("[green]ok[/]" if out.ok else "[red]failed[/]")
        notes = "; ".join([*([out.error] if out.error else []), *out.notes])
        t.add_row(
            out.tool,
            out.version,
            status,
            f"{out.duration_s:.1f}s",
            f"{out.peak_rss_mb:.0f} MB" if out.peak_rss_mb else "-",
            str(len(out.findings)),
            notes,
        )
    console.print(t)
    ing = o.ingest
    console.print(
        f"new: [bold]{len(ing.new)}[/] · seen again: {len(ing.seen_again)} · reopened: {len(ing.reopened)} · "
        f"auto-fixed (pending verification): {len(ing.auto_fixed)}"
    )
    matrix = Table(title="Open findings (severity × status)")
    matrix.add_column("severity")
    for st in ("confirmed", "likely", "candidate"):
        matrix.add_column(st, justify="right")
    for sev in Severity:
        row = [
            sum(1 for f in o.open_findings if f.severity == sev and f.status.value == st)
            for st in ("confirmed", "likely", "candidate")
        ]
        matrix.add_row(f"[{SEV_STYLE[sev.value]}]{sev.value}[/]", *[str(n) if n else "·" for n in row])
    console.print(matrix)
    if o.open_findings:
        _print_findings_table(o.open_findings[:15], title="Top open findings")
    if o.blocking:
        console.print(f"[bold red]{len(o.blocking)} blocking critical/high finding(s) → exit code 3[/]")
    console.print("next: open Claude Code in this folder and run [bold]/triage[/] (M3)")


@app.command()
def scan(
    path: Annotated[Path, typer.Argument(help="Local repository folder to scan (must be yours).")],
    profile: Annotated[str, typer.Option(help=f"Rule profile: {'|'.join(PROFILES)}")] = "auto",
    since: Annotated[str | None, typer.Option(help="Diff-aware: only files changed since this git ref.")] = None,
    i_own_this: Annotated[
        bool,
        typer.Option("--i-own-this", help="Confirm ownership when the git remote owner is not allowlisted."),
    ] = False,
    scope_note: Annotated[str | None, typer.Option(help="Why you may scan this repo (logged).")] = None,
    offline: Annotated[bool, typer.Option(help="No registry rules / online vuln DB; local rules only.")] = False,
    tools: Annotated[list[str] | None, typer.Option("--tools", help="Subset, e.g. --tools semgrep,gitleaks")] = None,
    config: Annotated[list[str] | None, typer.Option("--config", help="Extra semgrep --config value(s).")] = None,
    fail_on: Annotated[
        str,
        typer.Option(
            help="Exit 3 if critical/high findings with status ≥ this exist: confirmed|likely|candidate|never"
        ),
    ] = "confirmed",
    mem_cap_mb: Annotated[float, typer.Option(help="Kill any tool whose process tree exceeds this RAM.")] = (
        DEFAULT_MEM_CAP_MB
    ),
    as_json: Annotated[bool, typer.Option("--json", help="Print machine-readable summary.")] = False,
) -> None:
    """Run inventory + semgrep + gitleaks + osv-scanner on PATH and store normalized findings."""
    _utf8_stdout()
    tool_names = [{"osv-scanner": "osv"}.get(t, t) for t in _csv(tools)] or None
    try:
        outcome = run_scan(
            path,
            paths=_paths(),
            profile=profile,
            since=since,
            i_own_this=i_own_this,
            scope_note=scope_note,
            offline=offline,
            tools=tool_names,
            fail_on=fail_on,
            mem_cap_mb=mem_cap_mb,
            extra_semgrep_configs=config,
            progress=None if as_json else (lambda m: err_console.print(f"[dim]· {m}[/]")),
        )
    except ScopeError as exc:
        raise _fail(f"scope check refused: {exc}", 2) from exc
    except (GitError, ValueError, StoreError) as exc:
        raise _fail(str(exc)) from exc
    if as_json:
        _emit_json(outcome.summary())
    else:
        _print_summary(outcome)
    raise typer.Exit(outcome.exit_code)


@app.command()
def inventory(
    path: Annotated[Path, typer.Argument(help="Local repository folder.")],
    i_own_this: Annotated[bool, typer.Option("--i-own-this")] = False,
    out: Annotated[Path | None, typer.Option(help="Write inventory.json here (default: data/repos/<repo>/).")] = None,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Detect languages, frameworks and entrypoints without running scanners."""
    _utf8_stdout()
    paths = _paths()
    paths.ensure()
    try:
        with Store(paths.db) as store:
            scope = check_scope(path, paths=paths, store=store, i_own_this=i_own_this)
    except ScopeError as exc:
        raise _fail(f"scope check refused: {exc}", 2) from exc
    inv = build_inventory(scope.root, scope.repo_key)
    target = out or paths.repo_dir(scope.repo_key) / "inventory.json"
    write_inventory(inv, target)
    if as_json:
        _emit_json(inv.model_dump())
        return
    console.print(f"[bold]{inv.repo}[/] → {target}")
    langs = ", ".join(f"{k} {v.loc:,}" for k, v in inv.languages.items())
    console.print(f"languages (LOC): {langs}")
    console.print(f"package managers: {', '.join(inv.package_managers) or '-'}")
    console.print(f"frameworks: {', '.join(inv.frameworks) or '-'}")
    console.print(f"security-relevant libs: {', '.join(inv.security_libraries) or '-'}")
    kinds: dict[str, int] = {}
    for ep in inv.entrypoints:
        kinds[ep.kind] = kinds.get(ep.kind, 0) + 1
    console.print(f"entrypoints: {kinds or '-'}")


# ------------------------------------------------------------------------------------------ findings


def _print_findings_table(items: list[Finding], title: str = "Findings") -> None:
    t = Table(title=title)
    for col in ("id", "sev", "status", "conf", "tool", "location", "title"):
        t.add_column(col, overflow="fold")
    for f in items:
        t.add_row(
            f.short_id,
            f"[{SEV_STYLE[f.severity.value]}]{f.severity.value}[/]",
            f.status.value,
            f"{f.confidence:.2f}",
            f.source_tool,
            f.location,
            f.title[:90],
        )
    console.print(t)


@findings_app.command("list")
def findings_list(
    repo: Annotated[str | None, typer.Option(help="Repo key, e.g. yuseunghogi-commits/game")] = None,
    status: Annotated[list[str] | None, typer.Option(help="Filter, comma separated (e.g. candidate,likely)")] = None,
    severity: Annotated[list[str] | None, typer.Option(help="Filter, comma separated")] = None,
    tool: Annotated[str | None, typer.Option(help="semgrep|gitleaks|osv-scanner|claude-hunt|...")] = None,
    file: Annotated[str | None, typer.Option(help="Path prefix filter")] = None,
    limit: Annotated[int | None, typer.Option(help="Max rows")] = None,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """List findings (highest severity first)."""
    _utf8_stdout()
    statuses = _csv(status)
    severities = _csv(severity)
    for s in statuses:
        if s not in Status.__members__:
            raise _fail(f"unknown status {s!r}")
    for s in severities:
        if s not in Severity.__members__:
            raise _fail(f"unknown severity {s!r}")
    with Store(_paths().db) as store:
        items = store.list_findings(
            repo=repo, statuses=statuses, severities=severities, tool=tool, file_prefix=file, limit=limit
        )
    if as_json:
        _emit_json([f.model_dump(mode="json") for f in items])
    else:
        _print_findings_table(items)


@findings_app.command("show")
def findings_show(
    finding_id: Annotated[str, typer.Argument(help="Finding id or unique prefix (≥4 hex chars)")],
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Show one finding with its full history."""
    _utf8_stdout()
    try:
        with Store(_paths().db) as store:
            f = store.get(finding_id)
            hist = store.history(f.id)
            repo = store.get_repo(f.repo)
    except StoreError as exc:
        raise _fail(str(exc)) from exc
    if as_json:
        _emit_json({**f.model_dump(mode="json"), "repo_root": repo["root"] if repo else None, "history": hist})
        return
    body = [
        f"[bold]{f.title}[/]",
        f"id: {f.id}  repo: {f.repo}  root: {repo['root'] if repo else '?'}",
        f"tool: {f.source_tool}  rule: {f.rule_id}  cwe: {', '.join(f.cwe) or '-'}",
        f"severity: {f.severity.value}  status: {f.status.value}  confidence: {f.confidence}"
        + ("  (fix verified)" if f.fix_verified else ""),
        f"location: {f.location}",
        "",
        f.snippet or "(no snippet)",
    ]
    if f.message and f.message != f.title:
        body += ["", f"message: {f.message}"]
    if f.dataflow:
        body += ["", "dataflow:"] + [f"  {d.file}:{d.line}  {d.note}" for d in f.dataflow]
    for label, val in (
        ("justification", f.justification),
        ("poc", f.poc_path),
        ("repro", f.repro_steps),
        ("evidence", f.evidence),
        ("fix", f.fix_suggestion),
    ):
        if val:
            body += ["", f"{label}: {val}"]
    if f.references:
        body += ["", "references: " + " ".join(f.references[:5])]
    console.print(Panel("\n".join(body), title=f.short_id, expand=False))
    t = Table(title="history")
    for col in ("ts", "actor", "kind", "note"):
        t.add_column(col, overflow="fold")
    for h in hist:
        t.add_row(h["ts"], h["actor"], h["kind"], (h["note"] or "") + (f" {h['data']}" if h["data"] else ""))
    console.print(t)


def _load_json_arg(value: str) -> Any:
    if value == "-":
        return json.loads(sys.stdin.read())
    if value.startswith("@"):
        return json.loads(Path(value[1:]).read_text(encoding="utf-8"))
    return json.loads(value)


@findings_app.command("update")
def findings_update(
    finding_id: Annotated[str, typer.Argument(help="Finding id or unique prefix")],
    status: Annotated[str | None, typer.Option(help="|".join(Status.__members__))] = None,
    severity: Annotated[str | None, typer.Option(help="|".join(Severity.__members__))] = None,
    confidence: Annotated[float | None, typer.Option(min=0.0, max=1.0)] = None,
    title: Annotated[str | None, typer.Option()] = None,
    cwe: Annotated[str | None, typer.Option(help="Comma separated, e.g. CWE-79,CWE-116")] = None,
    dataflow: Annotated[str | None, typer.Option(help='JSON list of {"file","line","note"}; or @file.json')] = None,
    justification: Annotated[str | None, typer.Option()] = None,
    poc_path: Annotated[str | None, typer.Option()] = None,
    repro_steps: Annotated[str | None, typer.Option()] = None,
    fix_suggestion: Annotated[str | None, typer.Option()] = None,
    evidence: Annotated[str | None, typer.Option()] = None,
    fix_verified: Annotated[bool | None, typer.Option("--fix-verified/--no-fix-verified")] = None,
    from_json: Annotated[str | None, typer.Option(help="JSON object of fields; '-' = stdin, '@file.json'")] = None,
    actor: Annotated[str, typer.Option(help="Who made the change (human|claude-triage|claude-verify|...)")] = "human",
    note: Annotated[str | None, typer.Option(help="Free-text note for the audit trail")] = None,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Update verdict fields of a finding. Every change is recorded in the finding's history."""
    _utf8_stdout()
    changes: dict[str, Any] = {}
    if from_json:
        try:
            loaded = _load_json_arg(from_json)
        except (OSError, ValueError) as exc:
            raise _fail(f"--from-json: {exc}") from exc
        if not isinstance(loaded, dict):
            raise _fail("--from-json must be a JSON object")
        note = note or loaded.pop("note", None)
        changes.update(loaded)
    simple = {
        "status": status,
        "severity": severity,
        "confidence": confidence,
        "title": title,
        "justification": justification,
        "poc_path": poc_path,
        "repro_steps": repro_steps,
        "fix_suggestion": fix_suggestion,
        "evidence": evidence,
        "fix_verified": fix_verified,
    }
    changes.update({k: v for k, v in simple.items() if v is not None})
    if cwe is not None:
        changes["cwe"] = _csv([cwe])
    if dataflow is not None:
        try:
            changes["dataflow"] = _load_json_arg(dataflow)
        except (OSError, ValueError) as exc:
            raise _fail(f"--dataflow: {exc}") from exc
    if not changes:
        raise _fail("nothing to update")
    try:
        with Store(_paths().db) as store:
            updated = store.update(finding_id, changes, actor=actor, note=note)
    except (StoreError, ValueError) as exc:
        raise _fail(str(exc)) from exc
    if as_json:
        _emit_json(updated.model_dump(mode="json"))
    else:
        console.print(f"updated {updated.short_id}: {', '.join(sorted(changes))}")


@findings_app.command("history")
def findings_history(
    finding_id: Annotated[str, typer.Argument()],
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Audit trail of one finding."""
    _utf8_stdout()
    try:
        with Store(_paths().db) as store:
            hist = store.history(finding_id)
    except StoreError as exc:
        raise _fail(str(exc)) from exc
    if as_json:
        _emit_json(hist)
        return
    for h in hist:
        console.print(f"{h['ts']}  {h['actor']:<14} {h['kind']:<11} {h['note'] or ''} {h['data'] or ''}")


# --------------------------------------------------------------------------------------- scans/repos


@scans_app.command("list")
def scans_list(
    repo: Annotated[str | None, typer.Option()] = None,
    limit: Annotated[int, typer.Option()] = 20,
    as_json: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Recent scans with per-tool runtime and peak RAM."""
    _utf8_stdout()
    with Store(_paths().db) as store:
        scans = store.list_scans(repo, limit)
        for s in scans:
            s["tool_runs"] = store.tool_runs(s["id"])
    if as_json:
        _emit_json(scans)
        return
    t = Table(title="Scans")
    for col in ("scan id", "repo", "profile", "since", "status", "duration", "tools (time / peak RAM)"):
        t.add_column(col, overflow="fold")
    for s in scans:
        tools = "; ".join(
            f"{x['tool']} {x['duration_s']}s/{x['peak_rss_mb'] or 0:.0f}MB" for x in (s["summary"].get("tools") or [])
        )
        t.add_row(
            s["id"],
            s["repo"],
            s["profile"] or "",
            s["since_ref"] or "",
            s["status"],
            f"{s['summary'].get('duration_s', '-')}s",
            tools,
        )
    console.print(t)


@app.command()
def repos(as_json: Annotated[bool, typer.Option("--json")] = False) -> None:
    """Repositories known to the findings database."""
    _utf8_stdout()
    with Store(_paths().db) as store:
        rows = store.list_repos()
        for r in rows:
            r["counts"] = store.counts(r["key"])
    if as_json:
        _emit_json(rows)
        return
    for r in rows:
        console.print(f"[bold]{r['key']}[/]  {r['root']}  last scan {r['last_scan_at']}  {r['counts']}")


@app.command("import-sarif")
def import_sarif(
    sarif: Annotated[Path, typer.Argument(help="SARIF file produced by another tool")],
    path: Annotated[Path, typer.Option("--path", help="Repository folder the SARIF refers to")],
    tool: Annotated[str | None, typer.Option(help="Override source_tool name")] = None,
    i_own_this: Annotated[bool, typer.Option("--i-own-this")] = False,
) -> None:
    """Import findings from any SARIF producer (never auto-fixes existing findings)."""
    _utf8_stdout()
    paths = _paths()
    paths.ensure()
    try:
        with Store(paths.db) as store:
            scope = check_scope(path, paths=paths, store=store, i_own_this=i_own_this)
            data = json.loads(sarif.read_text(encoding="utf-8"))
            items = sarif_to_findings(
                data,
                root=scope.root,
                repo=scope.repo_key,
                tool_name=tool,
                reader=make_file_reader(scope.root),
            )
            store.upsert_repo(scope.repo_key, str(scope.root), [f"{r.name} {r.url}" for r in scope.remotes])
            scan_id = store.create_scan(
                repo=scope.repo_key,
                root=str(scope.root),
                profile="sarif-import",
                since_ref=None,
                offline=True,
                git_head=None,
                scope_method=scope.method,
            )
            res = store.ingest(scan_id, scope.repo_key, items, coverages=[])
            store.finish_scan(scan_id, "ok", {"ingest": res.as_dict(), "source": str(sarif)})
    except ScopeError as exc:
        raise _fail(f"scope check refused: {exc}", 2) from exc
    except (OSError, ValueError, StoreError) as exc:
        raise _fail(str(exc)) from exc
    console.print(f"imported {len(items)} finding(s): {res.as_dict()}")


@app.command()
def doctor() -> None:
    """Show paths and the versions of every external tool Sentry-Lite uses."""
    _utf8_stdout()
    paths = _paths()
    console.print(f"sentry-lite {__version__} · Python {platform.python_version()} · {platform.platform()}")
    console.print(f"home: {paths.home}\ndb:   {paths.db}\nbin:  {paths.bin}")
    t = Table(title="External tools")
    for col in ("tool", "path", "version", "needed for"):
        t.add_column(col, overflow="fold")
    needs = {
        "semgrep": "scan (M1)",
        "gitleaks": "scan (M1)",
        "osv-scanner": "scan (M1)",
        "git": "scope check, history, --since",
        "node": "Firebase emulator (M3)",
        "java": "Firebase emulator, JDK 21 (M3)",
        "firebase": "Firebase emulator CLI (M3)",
    }
    missing = 0
    for name, purpose in needs.items():
        exe = find_tool(name, paths)
        if exe is None:
            missing += name in {"semgrep", "gitleaks", "osv-scanner", "git"}
            t.add_row(name, "[red]not found[/]", "-", purpose)
            continue
        try:
            ver = tool_version(name, exe)
        except ToolNotFoundError:
            ver = "?"
        t.add_row(name, str(exe), ver, purpose)
    console.print(t)
    if missing:
        raise typer.Exit(1)


def main() -> None:  # pragma: no cover
    app()


if __name__ == "__main__":  # pragma: no cover
    main()

"""``hermes lsp`` CLI subcommand.

Subcommands:

- ``status`` — show service state, configured servers, install status.
- ``install <server_id>`` — eagerly install one server's binary.
- ``install-all`` — try to install every server with a known recipe.
- ``restart`` — tear down running clients so the next edit re-spawns.
- ``which <server_id>`` — print the resolved binary path for one server.
- ``list`` — print the registry of supported servers.

The handlers are kept here (rather than in
``hermes_cli/main.py``) so the LSP module ships self-contained.
"""
from __future__ import annotations

import argparse
import sys
from typing import Optional


def register_subparser(subparsers: argparse._SubParsersAction) -> None:
    """Wire the ``hermes lsp`` subcommand tree into the main argparse."""
    parser = subparsers.add_parser(
        "lsp",
        help="Language Server Protocol management",
        description=(
            "Manage the LSP layer that powers post-write semantic "
            "diagnostics in write_file/patch."
        ),
    )
    sub = parser.add_subparsers(dest="lsp_command")

    sub_status = sub.add_parser("status", help="Show LSP service status")
    sub_status.add_argument(
        "--json", action="store_true", help="Emit machine-readable JSON"
    )

    sub_list = sub.add_parser("list", help="List supported language servers")
    sub_list.add_argument(
        "--installed-only",
        action="store_true",
        help="Only show servers whose binary is currently available",
    )

    sub_install = sub.add_parser("install", help="Install a server binary")
    sub_install.add_argument("server", help="Server id (e.g. pyright, gopls)")

    sub_install_all = sub.add_parser(
        "install-all",
        help="Install every server with a known auto-install recipe",
    )
    sub_install_all.add_argument(
        "--include-manual",
        action="store_true",
        help="Even attempt servers marked manual-install (best effort)",
    )

    sub.add_parser(
        "restart",
        help="Tear down running LSP clients (next edit re-spawns)",
    )

    sub_which = sub.add_parser("which", help="Print binary path for a server")
    sub_which.add_argument("server", help="Server id")

    # Symbol-level queries (definition / references / document symbols).
    sub_query = sub.add_parser(
        "query",
        help="Query symbol-level info from the LSP server",
        description=(
            "Ask the language server for a symbol's definition, references, "
            "or the document outline. Backs the codegraph-style navigation "
            "for Hermes (definitions / references / symbols)."
        ),
    )
    sub_query.add_argument(
        "file", help="Path to the source file containing the symbol"
    )
    sub_query.add_argument(
        "--kind",
        choices=["definition", "references", "symbols"],
        default="definition",
        help="What to ask the language server (default: definition)",
    )
    sub_query.add_argument(
        "--line",
        type=int,
        default=None,
        help="0-based line of the symbol (required for definition/references)",
    )
    sub_query.add_argument(
        "--character",
        type=int,
        default=None,
        help="0-based character offset in the line (required for definition/references)",
    )
    sub_query.add_argument(
        "--json", action="store_true", help="Emit machine-readable JSON"
    )

    parser.set_defaults(func=run_lsp_command)


def run_lsp_command(args: argparse.Namespace) -> int:
    """Top-level dispatcher for ``hermes lsp <subcommand>``."""
    sub = getattr(args, "lsp_command", None) or "status"
    try:
        if sub == "status":
            return _cmd_status(getattr(args, "json", False))
        if sub == "list":
            return _cmd_list(getattr(args, "installed_only", False))
        if sub == "install":
            return _cmd_install(args.server)
        if sub == "install-all":
            return _cmd_install_all(getattr(args, "include_manual", False))
        if sub == "restart":
            return _cmd_restart()
        if sub == "which":
            return _cmd_which(args.server)
        if sub == "query":
            return _cmd_query(
                args.file,
                kind=getattr(args, "kind", "definition"),
                line=getattr(args, "line", None),
                character=getattr(args, "character", None),
                emit_json=getattr(args, "json", False),
            )
        sys.stderr.write(f"unknown lsp subcommand: {sub}\n")
        return 2
    except KeyboardInterrupt:
        return 130


def _cmd_status(emit_json: bool) -> int:
    from agent.lsp import get_service
    from agent.lsp.servers import SERVERS
    from agent.lsp.install import detect_status

    svc = get_service()
    service_active = svc is not None
    info = svc.get_status() if svc is not None else {"enabled": False}

    if emit_json:
        import json
        payload = {
            "service": info,
            "registry": [
                {
                    "server_id": s.server_id,
                    "extensions": list(s.extensions),
                    "description": s.description,
                    "binary_status": detect_status(_recipe_pkg_for(s.server_id)),
                }
                for s in SERVERS
            ],
        }
        sys.stdout.write(json.dumps(payload, indent=2) + "\n")
        return 0

    out = []
    out.append("LSP Service")
    out.append("===========")
    out.append(f"  enabled:         {info.get('enabled', False)}")
    if service_active:
        out.append(f"  wait_mode:       {info.get('wait_mode')}")
        out.append(f"  wait_timeout:    {info.get('wait_timeout')}s")
        out.append(f"  install_strategy:{info.get('install_strategy')}")
        clients = info.get("clients") or []
        if clients:
            out.append(f"  active clients:  {len(clients)}")
            for c in clients:
                out.append(
                    f"    - {c['server_id']:20s} state={c['state']:10s} root={c['workspace_root']}"
                )
        else:
            out.append("  active clients:  none")
        broken = info.get("broken") or []
        if broken:
            out.append(f"  broken pairs:    {len(broken)}")
            for b in broken:
                out.append(f"    - {b}")
        disabled = info.get("disabled_servers") or []
        if disabled:
            out.append(f"  disabled in cfg: {', '.join(disabled)}")

    # Surface backend-tool gaps that aren't visible in the registry table:
    # some servers spawn fine but emit no diagnostics without a sidecar
    # binary (bash-language-server -> shellcheck).
    backend_warnings = _backend_warnings()
    if backend_warnings:
        out.append("")
        out.append("Backend warnings")
        out.append("================")
        for line in backend_warnings:
            out.append(f"  ! {line}")
    out.append("")
    out.append("Registered Servers")
    out.append("==================")
    for s in SERVERS:
        pkg = _recipe_pkg_for(s.server_id)
        status = detect_status(pkg)
        marker = {
            "installed": "✓",
            "missing": "·",
            "manual-only": "?",
        }.get(status, " ")
        ext_summary = ", ".join(list(s.extensions)[:5])
        if len(s.extensions) > 5:
            ext_summary += f", … (+{len(s.extensions) - 5})"
        out.append(
            f"  {marker} {s.server_id:24s} [{status:11s}] {ext_summary}"
        )
        if s.description:
            out.append(f"      {s.description}")
    sys.stdout.write("\n".join(out) + "\n")
    return 0


def _cmd_list(installed_only: bool) -> int:
    from agent.lsp.servers import SERVERS
    from agent.lsp.install import detect_status

    for s in SERVERS:
        pkg = _recipe_pkg_for(s.server_id)
        status = detect_status(pkg)
        if installed_only and status != "installed":
            continue
        sys.stdout.write(
            f"{s.server_id:24s} [{status:11s}] {','.join(s.extensions)}\n"
        )
    return 0


def _cmd_install(server_id: str) -> int:
    from agent.lsp.install import try_install, INSTALL_RECIPES, detect_status
    pkg = _recipe_pkg_for(server_id)
    pre_status = detect_status(pkg)
    if pre_status == "installed":
        sys.stdout.write(f"{server_id} already installed\n")
        return 0
    sys.stdout.write(f"installing {server_id} (pkg={pkg}) ...\n")
    sys.stdout.flush()
    bin_path = try_install(pkg, "auto")
    if bin_path is None:
        recipe = INSTALL_RECIPES.get(pkg)
        if recipe and recipe.get("strategy") == "manual":
            sys.stderr.write(
                f"{server_id}: this server requires a manual install. "
                f"See documentation.\n"
            )
        else:
            sys.stderr.write(f"{server_id}: install failed (see logs).\n")
        return 1
    sys.stdout.write(f"installed: {bin_path}\n")
    return 0


def _cmd_install_all(include_manual: bool) -> int:
    from agent.lsp.servers import SERVERS
    from agent.lsp.install import try_install, INSTALL_RECIPES, detect_status

    rc = 0
    for s in SERVERS:
        pkg = _recipe_pkg_for(s.server_id)
        recipe = INSTALL_RECIPES.get(pkg)
        if recipe is None:
            continue
        if recipe.get("strategy") == "manual" and not include_manual:
            continue
        if detect_status(pkg) == "installed":
            sys.stdout.write(f"  {s.server_id:24s} already installed\n")
            continue
        sys.stdout.write(f"  installing {s.server_id} (pkg={pkg}) ... ")
        sys.stdout.flush()
        path = try_install(pkg, "auto")
        if path:
            sys.stdout.write(f"ok ({path})\n")
        else:
            sys.stdout.write("FAILED\n")
            rc = 1
    return rc


def _cmd_restart() -> int:
    from agent.lsp import shutdown_service

    shutdown_service()
    sys.stdout.write("LSP service shut down. Next edit will respawn clients.\n")
    return 0


def _cmd_which(server_id: str) -> int:
    from agent.lsp.install import INSTALL_RECIPES, _existing_binary

    pkg = _recipe_pkg_for(server_id)
    recipe = INSTALL_RECIPES.get(pkg)
    bin_name = (recipe or {}).get("bin", pkg)
    resolved = _existing_binary(bin_name)
    if resolved:
        sys.stdout.write(resolved + "\n")
        return 0
    sys.stderr.write(f"{server_id}: not installed\n")
    return 1


def _cmd_query(
    file_path: str,
    *,
    kind: str,
    line: Optional[int],
    character: Optional[int],
    emit_json: bool,
) -> int:
    """``hermes lsp query <file> --kind ...`` — symbol-level LSP lookup."""
    from agent.lsp import get_service

    svc = get_service()
    if svc is None:
        sys.stderr.write("LSP service not enabled\n")
        return 2
    if not svc.is_active():
        sys.stderr.write("LSP service not active (no enabled servers?)\n")
        return 2

    import json as _json

    if kind in ("definition", "references") and (line is None or character is None):
        sys.stderr.write(
            f"hermes lsp query: --kind {kind} requires --line and --character "
            "(0-based)\n"
        )
        return 2

    result = svc.query_symbol(
        file_path, kind=kind, line=line, character=character
    )
    if emit_json:
        sys.stdout.write(_json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        return 0 if result.get("ok") else 1

    if not result.get("ok"):
        sys.stderr.write(f"query failed: {result.get('error', 'unknown')}\n")
        return 1

    payload = result.get("result")
    if kind == "symbols":
        if not payload:
            sys.stdout.write("(no symbols found)\n")
            return 0
        for sym in payload if isinstance(payload, list) else []:
            name = sym.get("name", "?")
            s_kind = sym.get("kind", "")
            rng = sym.get("selectionRange", {}).get("start", {})
            sys.stdout.write(
                f"{name}\t{kind}\t{s_kind}\t"
                f"{rng.get('line', 0)}:{rng.get('character', 0)}\n"
            )
        return 0

    locations = payload if isinstance(payload, list) else ([payload] if payload else [])
    if not locations:
        sys.stdout.write("(no locations found)\n")
        return 0
    for loc in locations:
        rng = (loc.get("range") or {}).get("start", {})
        uri = loc.get("uri", "?")
        sys.stdout.write(
            f"{uri}\t{kind}\t"
            f"{rng.get('line', 0)}:{rng.get('character', 0)}\n"
        )
    return 0


def _recipe_pkg_for(server_id: str) -> str:
    """Map a registry ``server_id`` to its install-recipe package key."""
    # The mapping lives here (not in install.py) because it's a CLI
    # convenience layer.  Most server_ids are also their own recipe
    # key, but a few differ (e.g. ``vue-language-server`` →
    # ``@vue/language-server``).
    aliases = {
        "vue-language-server": "@vue/language-server",
        "astro-language-server": "@astrojs/language-server",
        "dockerfile-ls": "dockerfile-language-server-nodejs",
        "typescript": "typescript-language-server",
    }
    return aliases.get(server_id, server_id)


def _backend_warnings() -> list:
    """Return human-readable notes about LSP backend tools that are missing
    in a way that won't surface elsewhere.

    Some language servers ship as thin wrappers around an external CLI for
    actual diagnostics — they spawn cleanly but never emit any errors when
    the sidecar binary isn't on PATH.  bash-language-server / shellcheck
    is the load-bearing example.

    Returned strings are short, actionable, and include the install
    suggestion across common platforms.
    """
    import shutil as _shutil
    from agent.lsp.install import _existing_binary
    notes: list = []
    bash_installed = _existing_binary("bash-language-server") is not None
    if bash_installed and _shutil.which("shellcheck") is None:
        notes.append(
            "bash-language-server is installed but shellcheck is missing — "
            "diagnostics will be empty (apt: shellcheck, brew: shellcheck, "
            "scoop: shellcheck)."
        )
    return notes

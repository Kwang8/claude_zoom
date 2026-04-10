"""CLI entry point for claude_zoom."""

from __future__ import annotations

import json
import logging
import time

import click
from dotenv import load_dotenv
from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax

from .pr import ChangeContext, fetch_commit, fetch_pr, parse_ref
from .qa import answer as qa_answer
from .snippets import SnippetWalkthrough, generate_walkthrough

console = Console()

LISTEN_SECONDS = 6.0


@click.group()
def main() -> None:
    """Claude walks through a PR as a series of narrated code snippets."""
    load_dotenv()


@main.command()
@click.option(
    "--cwd",
    type=click.Path(exists=True, file_okay=False),
    default=None,
    help="Working directory for the Claude subprocess.",
)
@click.option("--model", default="opus", show_default=True)
@click.option(
    "--permission-mode",
    default="acceptEdits",
    show_default=True,
    type=click.Choice(
        ["default", "acceptEdits", "bypassPermissions", "dontAsk", "plan"]
    ),
)
@click.option("--port", default=8765, show_default=True, help="WebSocket port.")
@click.option("--host", default="localhost", show_default=True)
@click.option("--fresh", is_flag=True, default=False)
@click.option("--log-file", default=None, type=click.Path())
@click.option(
    "--repo",
    default=None,
    help="Default GitHub repo (org/name) for remote sub-agents to clone.",
)
@click.option(
    "--auth",
    type=click.Choice(["oauth", "api-key"]),
    default="oauth",
    show_default=True,
    help=(
        "Default auth mode for remote sub-agents. "
        "'oauth' uses CLAUDE_CODE_OAUTH_TOKEN from the Modal Secret "
        "'claude-auth-token'. "
        "'api-key' uses ANTHROPIC_API_KEY from the Modal Secret "
        "'anthropic-api-key'."
    ),
)
def serve(cwd, model, permission_mode, port, host, fresh, log_file, repo, auth) -> None:
    """Start the WebSocket server for the Electron frontend."""
    import asyncio

    if log_file:
        logging.basicConfig(
            filename=log_file,
            level=logging.DEBUG,
            format="%(asctime)s %(name)s %(levelname)s %(message)s",
        )

    if fresh:
        from .state import clear_state
        clear_state(cwd or ".")

    from .chat import ClaudeSession
    from .server import run_server

    session = ClaudeSession(
        cwd=cwd,
        model=model,
        permission_mode=permission_mode,
        tools="",
    )
    asyncio.run(run_server(
        session, host=host, port=port, resume=not fresh,
        remote_repo=repo, remote_auth=auth,
    ))


@main.group()
def snapshot() -> None:
    """Manage Modal volume repo snapshots for fast sandbox startup."""


@snapshot.command("refresh")
@click.argument("repo")
def snapshot_refresh(repo: str) -> None:
    """Clone or pull REPO (org/name) into the Modal volume snapshot.

    This pre-populates the volume so future --remote sandboxes start instantly
    instead of cloning from scratch.
    """
    try:
        from .snapshots import refresh_snapshot_local
    except ImportError as e:
        raise click.ClickException(
            f"Remote deps not installed. Run: pip install -e '.[remote]'\n  ({e})"
        ) from e

    click.echo(f"Refreshing snapshot for {repo}...")
    refresh_snapshot_local(repo)
    click.echo("  Done.")


@snapshot.command("list")
def snapshot_list() -> None:
    """List repos currently snapshotted in the Modal volume."""
    try:
        from .snapshots import list_snapshots
    except ImportError as e:
        raise click.ClickException(
            f"Remote deps not installed. Run: pip install -e '.[remote]'\n  ({e})"
        ) from e

    repos = list_snapshots()
    if not repos:
        click.echo("No snapshots found.")
        return
    for r in repos:
        click.echo(f"  {r}")


def _fetch_change(ref: str) -> ChangeContext:
    """Resolve a user ref (PR #, SHA, or GitHub URL) to a ChangeContext."""
    kind, payload = parse_ref(ref)
    if kind == "pr":
        return fetch_pr(payload["number"], repo=payload["repo"])
    return fetch_commit(payload["sha"], repo=payload["repo"])


@main.command()
@click.argument("ref")
@click.option(
    "--dry-run",
    is_flag=True,
    help="Print the walkthrough as JSON instead of a formatted view.",
)
def generate(ref: str, dry_run: bool) -> None:
    """Generate a walkthrough for REF (PR number, commit SHA, or GitHub URL)."""
    click.echo(f"Fetching {ref}...")
    change = _fetch_change(ref)
    click.echo(f"  {change.ref}: {change.title}")
    click.echo(f"  {len(change.files)} files changed, diff is {len(change.diff)} chars")

    click.echo("Asking Claude to extract snippets...")
    walkthrough = generate_walkthrough(change)
    click.echo(f"  Got {len(walkthrough.snippets)} snippets\n")

    if dry_run:
        click.echo(json.dumps(walkthrough.to_dict(), indent=2))
        return

    _render_walkthrough(walkthrough)


@main.command()
@click.argument("ref")
@click.option(
    "--listen/--no-listen",
    default=True,
    help="Listen for a spoken question after each snippet (default on).",
)
def present(ref: str, listen: bool) -> None:
    """Present REF interactively: print, narrate, and optionally Q&A.

    REF can be a PR number (42), a commit SHA (885fbd6), or a GitHub URL
    (https://github.com/owner/repo/pull/42 or .../commit/<sha>).
    """
    try:
        from .voice import warm_up
    except ImportError as e:
        raise click.ClickException(
            f"Voice deps not installed. Run: pip install -e '.[voice]'\n  ({e})"
        ) from e

    click.echo(f"Fetching {ref}...")
    change = _fetch_change(ref)
    click.echo(f"  {change.ref}: {change.title}")

    click.echo("Asking Claude to extract snippets...")
    walkthrough = generate_walkthrough(change)
    click.echo(f"  Got {len(walkthrough.snippets)} snippets")

    if listen:
        click.echo("Loading Parakeet (first run downloads ~600MB)...")
        warm_up()
        click.echo("  Ready.\n")

    _plain_present(change, walkthrough, listen=listen)


def _plain_present(change, walkthrough, *, listen: bool) -> None:  # type: ignore[no-untyped-def]
    """Original linear renderer: print snippets + narrate top-to-bottom."""
    from .voice import listen_once, speak

    _render_header(walkthrough)
    _speak_and_print_narration(speak, walkthrough.intro_narration)

    for idx, snippet in enumerate(walkthrough.snippets):
        _render_snippet(idx, len(walkthrough.snippets), snippet)
        _speak_and_print_narration(speak, snippet.narration)

        if not listen:
            continue

        console.print(
            f"[dim]🎤 listening for {LISTEN_SECONDS:.0f}s — "
            "ask a question or stay silent to continue...[/dim]"
        )
        # Tiny beat so the user can orient before recording starts.
        time.sleep(0.3)
        question = listen_once(seconds=LISTEN_SECONDS)
        if not question:
            continue

        console.print(f"[bold magenta]🎤 heard:[/bold magenta] {question}")
        try:
            reply = qa_answer(
                question=question,
                walkthrough=walkthrough,
                change=change,
                current_idx=idx,
            )
        except Exception as e:  # noqa: BLE001
            reply = f"Sorry, I hit an error answering that: {e}"
        console.print(f"[bold green]💬[/bold green] {reply}\n")
        speak(reply)

    _speak_and_print_narration(speak, walkthrough.outro_narration)


def _render_header(walkthrough: SnippetWalkthrough) -> None:
    console.print(
        Panel.fit(
            f"[bold]{walkthrough.title}[/bold]\n"
            f"[dim]{walkthrough.ref} · {walkthrough.url}[/dim]",
            border_style="cyan",
        )
    )


def _render_snippet(idx: int, total: int, snippet) -> None:  # type: ignore[no-untyped-def]
    console.print(
        f"\n[bold yellow]{idx + 1}/{total}. {snippet.title}[/bold yellow]  "
        f"[dim]{snippet.file_path}[/dim]"
    )
    console.print(
        Syntax(
            snippet.code,
            snippet.language or "text",
            theme="monokai",
            line_numbers=False,
            word_wrap=True,
        )
    )
    console.print(f"[white]{snippet.explanation}[/white]")


def _speak_and_print_narration(speak_fn, text: str) -> None:  # type: ignore[no-untyped-def]
    console.print(f"[italic cyan]🎙  {text}[/italic cyan]")
    speak_fn(text)


def _render_walkthrough(walkthrough: SnippetWalkthrough) -> None:
    _render_header(walkthrough)
    console.print(f"\n[italic cyan]🎙  {walkthrough.intro_narration}[/italic cyan]\n")

    for i, snippet in enumerate(walkthrough.snippets):
        _render_snippet(i, len(walkthrough.snippets), snippet)
        console.print(f"[italic cyan]🎙  {snippet.narration}[/italic cyan]\n")

    console.print(f"[italic cyan]🎙  {walkthrough.outro_narration}[/italic cyan]")


if __name__ == "__main__":
    main()

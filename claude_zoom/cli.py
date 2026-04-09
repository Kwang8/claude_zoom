"""CLI entry point for claude_zoom."""

from __future__ import annotations

import json
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
@click.option(
    "--plain",
    is_flag=True,
    help="Use the linear non-TUI renderer (no animated character).",
)
def present(ref: str, listen: bool, plain: bool) -> None:
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

    if plain:
        _plain_present(change, walkthrough, listen=listen)
        return

    try:
        from .tui import PresentApp
    except ImportError as e:
        raise click.ClickException(
            f"TUI deps not installed. Run: pip install -e '.[voice]'\n  ({e})"
        ) from e

    PresentApp(change, walkthrough).run()


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

"""Interactive Textual TUI for `claude-zoom present`.

Left side: a little animated ASCII character (claude) that reacts to state
  idle / talking / listening / thinking.
Right side: the code snippet currently being described with syntax highlighting.
Bottom: a status bar (listening countdown, heard transcript, etc.).

The heavy lifting (macOS `say`, sounddevice mic capture, parakeet transcription,
`claude -p` Q&A) runs in a single worker thread via `@work(thread=True)` so the
UI animations keep running.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Literal

from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.reactive import reactive
from textual.widgets import Header, Label, RichLog, Static, TextArea

if TYPE_CHECKING:
    from .chat import ClaudeSession
    from .pr import ChangeContext
    from .snippets import CodeSnippet, SnippetWalkthrough


LISTEN_SECONDS = 5.0
CHAT_LISTEN_SECONDS = 6.0
TICK_INTERVAL = 0.35

State = Literal["idle", "talking", "listening", "thinking", "working"]


# ─── ASCII character frames ────────────────────────────────────────────────
#
# Five lines tall, ~9 columns. Kept to pure ASCII so it renders in any terminal.
# Each state is a list of frames cycled at TICK_INTERVAL.

_IDLE = [
    "   ___   \n"
    "  |o o|  \n"
    "  |===|  \n"
    "  /| |\\  \n"
    "  /_|_\\  ",
    "   ___   \n"
    "  |- -|  \n"
    "  |===|  \n"
    "  /| |\\  \n"
    "  /_|_\\  ",
]

_TALKING = [
    "   ___   \n"
    "  |o o|  \n"
    "  | - |  \n"
    "  /| |\\  \n"
    "  /_|_\\  ",
    "   ___   \n"
    "  |o o|  \n"
    "  | o |  \n"
    "  /| |\\  \n"
    "  /_|_\\  ",
    "   ___   \n"
    "  |o o|  \n"
    "  |-=-|  \n"
    "  /| |\\  \n"
    "  /_|_\\  ",
]

_LISTENING = [
    "   ___     \n"
    "  |O O|    \n"
    "  |___| )) \n"
    "  /| |\\    \n"
    "  /_|_\\    ",
    "   ___     \n"
    "  |O O|  ))\n"
    "  |___|    \n"
    "  /| |\\    \n"
    "  /_|_\\    ",
]

_THINKING = [
    "   ___     \n"
    "  |- -|  . \n"
    "  |=_=|    \n"
    "  /| |\\    \n"
    "  /_|_\\    ",
    "   ___     \n"
    "  |- -| .. \n"
    "  |=_=|    \n"
    "  /| |\\    \n"
    "  /_|_\\    ",
    "   ___     \n"
    "  |- -| ...\n"
    "  |=_=|    \n"
    "  /| |\\    \n"
    "  /_|_\\    ",
]

# "Working" is the state while Claude's subprocess is running real tools —
# we reuse the thinking frame layout but with a cog instead of dots.
_WORKING = [
    "   ___     \n"
    "  |o o|  * \n"
    "  |===|    \n"
    "  /| |\\    \n"
    "  /_|_\\    ",
    "   ___     \n"
    "  |o o| *  \n"
    "  |===|    \n"
    "  /| |\\    \n"
    "  /_|_\\    ",
    "   ___     \n"
    "  |o o|*   \n"
    "  |===|    \n"
    "  /| |\\    \n"
    "  /_|_\\    ",
]


CHARACTER_FRAMES: dict[State, list[str]] = {
    "idle": _IDLE,
    "talking": _TALKING,
    "listening": _LISTENING,
    "thinking": _THINKING,
    "working": _WORKING,
}

STATE_LABELS: dict[State, str] = {
    "idle": "[ idle ]",
    "talking": "[ talking... ]",
    "listening": "[ listening ]",
    "thinking": "[ thinking... ]",
    "working": "[ working... ]",
}


# Tree-sitter languages that ship with Textual's TextArea.code_editor.
# TypeScript/TSX aren't bundled so we fall back to javascript for those.
_SUPPORTED_LANGS = {
    "python",
    "javascript",
    "rust",
    "go",
    "java",
    "json",
    "markdown",
    "yaml",
    "toml",
    "bash",
    "css",
    "html",
    "xml",
    "sql",
    "regex",
    "kotlin",
}

_LANG_ALIASES = {
    "py": "python",
    "js": "javascript",
    "jsx": "javascript",
    "ts": "javascript",
    "tsx": "javascript",
    "typescript": "javascript",
    "rs": "rust",
    "md": "markdown",
    "yml": "yaml",
    "sh": "bash",
    "shell": "bash",
}


def _normalize_language(lang: str | None) -> str | None:
    if not lang:
        return None
    key = lang.lower().strip()
    key = _LANG_ALIASES.get(key, key)
    return key if key in _SUPPORTED_LANGS else None


# ─── Widgets ───────────────────────────────────────────────────────────────


class CharacterPanel(Vertical):
    """Left panel: animated ASCII character + state label + narration text."""

    DEFAULT_CSS = """
    CharacterPanel {
        width: 34;
        border: round $accent;
        padding: 1 2;
    }
    CharacterPanel #art {
        content-align: center middle;
        height: 5;
        color: $accent;
    }
    CharacterPanel #name {
        content-align: center middle;
        height: 1;
        color: $text-muted;
        margin-top: 1;
    }
    CharacterPanel #state-label {
        content-align: center middle;
        height: 1;
        color: $warning;
    }
    CharacterPanel #narration {
        margin-top: 1;
        color: $text;
    }
    """

    state: reactive[State] = reactive[State]("idle")
    frame: reactive[int] = reactive(0)
    narration: reactive[str] = reactive("")

    def compose(self) -> ComposeResult:
        yield Static("", id="art")
        yield Static("claude", id="name")
        yield Static(STATE_LABELS["idle"], id="state-label")
        yield Static("", id="narration")

    def on_mount(self) -> None:
        self._render_art()
        self.set_interval(TICK_INTERVAL, self._tick)

    def _tick(self) -> None:
        frames = CHARACTER_FRAMES[self.state]
        self.frame = (self.frame + 1) % len(frames)

    def watch_state(self, new_state: State) -> None:
        self.frame = 0
        self._render_art()
        self.query_one("#state-label", Static).update(STATE_LABELS[new_state])

    def watch_frame(self, _new_frame: int) -> None:
        self._render_art()

    def watch_narration(self, new_text: str) -> None:
        self.query_one("#narration", Static).update(new_text)

    def _render_art(self) -> None:
        frames = CHARACTER_FRAMES[self.state]
        art = frames[self.frame % len(frames)]
        try:
            self.query_one("#art", Static).update(art)
        except Exception:
            # Not yet mounted — on_mount will render.
            pass


class CodePanel(Vertical):
    """Right panel: snippet title, file path, syntax-highlighted code, explanation."""

    DEFAULT_CSS = """
    CodePanel {
        width: 1fr;
        padding: 1 2;
    }
    CodePanel #snippet-title {
        text-style: bold;
        color: $warning;
    }
    CodePanel #file-path {
        color: $text-muted;
        margin-bottom: 1;
    }
    CodePanel #code {
        border: round $accent;
        height: 1fr;
    }
    CodePanel #explanation {
        margin-top: 1;
        color: $text;
    }
    """

    def compose(self) -> ComposeResult:
        yield Label("waiting for walkthrough...", id="snippet-title")
        yield Label("", id="file-path")
        code = TextArea.code_editor(
            "",
            language=None,
            theme="monokai",
            read_only=True,
            id="code",
        )
        code.show_line_numbers = False
        yield code
        yield Static("", id="explanation")

    def show_snippet(self, idx: int, total: int, snippet: "CodeSnippet") -> None:
        self.query_one("#snippet-title", Label).update(
            f"{idx + 1}/{total}  {snippet.title}"
        )
        self.query_one("#file-path", Label).update(snippet.file_path)

        code_widget = self.query_one("#code", TextArea)
        code_widget.load_text(snippet.code)
        lang = _normalize_language(snippet.language)
        try:
            code_widget.language = lang
        except Exception:
            code_widget.language = None

        self.query_one("#explanation", Static).update(snippet.explanation)


class StatusBar(Static):
    """Bottom status line: progress, current action, and key hints."""

    DEFAULT_CSS = """
    StatusBar {
        dock: bottom;
        height: 1;
        background: $primary 20%;
        color: $text;
        padding: 0 1;
    }
    """

    progress: reactive[str] = reactive("")
    action: reactive[str] = reactive("ready")

    def on_mount(self) -> None:
        self._render_line()

    def watch_progress(self, _new: str) -> None:
        self._render_line()

    def watch_action(self, _new: str) -> None:
        self._render_line()

    def _render_line(self) -> None:
        hint = "q quit · → skip · r replay"
        left = f"{self.progress}  ·  {self.action}" if self.progress else self.action
        self.update(f"{left}   [{hint}]")


# ─── App ───────────────────────────────────────────────────────────────────


class PresentApp(App):
    """Textual app that presents a SnippetWalkthrough with live voice Q&A."""

    CSS = """
    Screen {
        layout: vertical;
    }
    #body {
        layout: horizontal;
        height: 1fr;
    }
    """

    BINDINGS = [
        Binding("q", "quit", "quit"),
        Binding("right,n", "skip", "skip"),
        Binding("r", "replay", "replay"),
    ]

    def __init__(
        self,
        change: "ChangeContext",
        walkthrough: "SnippetWalkthrough",
    ) -> None:
        super().__init__()
        self.change = change
        self.walkthrough = walkthrough
        self._skip_event = threading.Event()
        self._replay_event = threading.Event()
        self._countdown_timer = None
        self._countdown_remaining = 0

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal(id="body"):
            yield CharacterPanel(id="character")
            yield CodePanel(id="code-panel")
        yield StatusBar(id="status")

    def on_mount(self) -> None:
        self.title = f"claude_zoom · {self.walkthrough.ref}"
        self.sub_title = self.walkthrough.title
        self._run_walkthrough()

    # ─── Key actions ───────────────────────────────────────────────────────

    def action_skip(self) -> None:
        self._skip_event.set()
        self._action("skip requested — finishing current step")

    def action_replay(self) -> None:
        self._replay_event.set()
        self._action("replay requested")

    # ─── Main worker: orchestration loop ───────────────────────────────────

    @work(thread=True, exclusive=True)
    def _run_walkthrough(self) -> None:
        # Imports are deferred so `from claude_zoom.tui import PresentApp` stays
        # cheap and doesn't load Parakeet at import time.
        from .qa import answer as qa_answer
        from .voice import listen_once, speak

        wt = self.walkthrough
        total = len(wt.snippets)

        # Intro
        self._progress("intro")
        self._action("speaking intro")
        self._set_state("talking", wt.intro_narration)
        speak(wt.intro_narration)

        for idx, snippet in enumerate(wt.snippets):
            self._progress(f"{idx + 1}/{total} · {snippet.title}")
            self._call(self._show_snippet_main, idx, total, snippet)

            # Talk through the snippet, handling replay requests.
            self._action("speaking")
            self._set_state("talking", snippet.narration)
            speak(snippet.narration)
            while self._replay_event.is_set():
                self._replay_event.clear()
                self._action("replaying")
                speak(snippet.narration)

            if self._skip_event.is_set():
                self._skip_event.clear()
                self._action("skipped")
                continue

            # Listen for a question.
            self._set_state("listening", "")
            self._call(self._start_countdown, int(LISTEN_SECONDS))
            question = listen_once(seconds=LISTEN_SECONDS)
            self._call(self._stop_countdown)

            if not question:
                self._action("no question — moving on")
                continue

            self._action(f"heard: {question}")
            self._set_state("thinking", f"Q: {question}")

            try:
                reply = qa_answer(
                    question=question,
                    walkthrough=wt,
                    change=self.change,
                    current_idx=idx,
                )
            except Exception as e:  # noqa: BLE001
                reply = f"Sorry, I hit an error answering that: {e}"

            self._action("answering")
            self._set_state("talking", reply)
            speak(reply)

        # Outro
        self._progress("outro")
        self._action("wrapping up")
        self._set_state("talking", wt.outro_narration)
        speak(wt.outro_narration)
        self._set_state("idle", "done — press q to quit")
        self._action("done")

    # ─── Main-thread helpers (called via call_from_thread) ─────────────────

    def _call(self, fn, *args, **kwargs) -> None:
        """Shortcut for running a callable on the main thread.

        Deliberately NOT catching exceptions — silent failures here would hide
        real bugs. Textual will surface any errors through its normal crash path.
        """
        self.call_from_thread(fn, *args, **kwargs)

    def _set_state(self, state: State, narration: str = "") -> None:
        def _apply() -> None:
            char = self.query_one(CharacterPanel)
            char.state = state
            char.narration = narration

        self._call(_apply)

    def _show_snippet_main(
        self, idx: int, total: int, snippet: "CodeSnippet"
    ) -> None:
        self.query_one(CodePanel).show_snippet(idx, total, snippet)

    def _progress(self, text: str) -> None:
        """Update the left side of the status bar. Thread-safe."""
        self._call(lambda: setattr(self.query_one(StatusBar), "progress", text))

    def _action(self, text: str) -> None:
        """Update the right side of the status bar. Thread-safe."""
        self._call(lambda: setattr(self.query_one(StatusBar), "action", text))

    def _start_countdown(self, seconds: int) -> None:
        self._countdown_remaining = seconds
        self._update_countdown_label()
        if self._countdown_timer is not None:
            self._countdown_timer.stop()
        self._countdown_timer = self.set_interval(1.0, self._countdown_tick)

    def _countdown_tick(self) -> None:
        self._countdown_remaining -= 1
        if self._countdown_remaining <= 0:
            self._stop_countdown()
        else:
            self._update_countdown_label()

    def _stop_countdown(self) -> None:
        if self._countdown_timer is not None:
            self._countdown_timer.stop()
            self._countdown_timer = None

    def _update_countdown_label(self) -> None:
        # Running on the main thread already (scheduled via set_interval).
        self.query_one(StatusBar).action = (
            f"🎙 listening... {self._countdown_remaining}s"
        )


# ─── ChatApp: voice interface to a live Claude Code instance ─────────────


class ActivityLog(RichLog):
    """Right-side scrollable log of Claude's activity (tool calls, results,
    assistant messages). Worker thread pushes formatted lines in via
    `call_from_thread`.
    """

    DEFAULT_CSS = """
    ActivityLog {
        width: 1fr;
        border: round $accent;
        padding: 0 1;
    }
    """


class ChatApp(App):
    """Voice-first Textual app that lets the user interact with a live
    Claude Code instance via ClaudeSession. Auto-cycles:
    listen → claude -p → log events → summarize → speak → repeat.
    """

    CSS = """
    Screen {
        layout: vertical;
    }
    #body {
        layout: horizontal;
        height: 1fr;
    }
    """

    BINDINGS = [
        Binding("q", "quit", "quit"),
        Binding("escape", "cancel_turn", "cancel turn"),
    ]

    def __init__(self, session: "ClaudeSession") -> None:
        super().__init__()
        self.session = session
        self._stop_flag = threading.Event()

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal(id="body"):
            yield CharacterPanel(id="character")
            yield ActivityLog(
                id="activity-log",
                wrap=True,
                markup=True,
                highlight=False,
            )
        yield StatusBar(id="status")

    def on_mount(self) -> None:
        self.title = "claude_zoom · chat"
        self.sub_title = f"cwd: {self.session.cwd or '.'}"
        self.query_one(StatusBar).progress = "booting"
        self.query_one(StatusBar).action = "warming up"
        self.query_one(ActivityLog).write(
            "[dim]🎙 say something after the intro — I'll listen for "
            f"{int(CHAT_LISTEN_SECONDS)} seconds after every reply.[/dim]"
        )
        self._run_chat_loop()

    # ─── Key actions ───────────────────────────────────────────────────────

    def action_cancel_turn(self) -> None:
        self.session.cancel()
        self.query_one(StatusBar).action = "cancel sent"

    async def action_quit(self) -> None:  # type: ignore[override]
        self._stop_flag.set()
        self.session.cancel()
        self.exit()

    # ─── Main worker: voice loop ───────────────────────────────────────────

    @work(thread=True, exclusive=True)
    def _run_chat_loop(self) -> None:
        # Deferred imports so `from claude_zoom.tui import ChatApp` is cheap.
        from .narrator import summarize_turn
        from .voice import listen_once, speak

        self._set_state("talking", "hey! what can I do for you?")
        self._append_log("[italic cyan]🎙 hey! what can I do for you?[/italic cyan]")
        self._set_progress("ready")
        self._set_action("")
        speak("Hey! What can I do for you?")

        turn = 0
        while not self._stop_flag.is_set():
            turn += 1
            # ── LISTEN ──
            self._set_state("listening", "")
            self._set_progress(f"turn {turn}")
            self._set_action(f"🎙 listening {int(CHAT_LISTEN_SECONDS)}s...")
            transcript = listen_once(seconds=CHAT_LISTEN_SECONDS)
            if self._stop_flag.is_set():
                break
            if not transcript:
                # Silence — go back to idle briefly then listen again.
                self._set_state("idle", "")
                self._set_action("(silence — listening again)")
                continue

            self._append_log(f"[bold magenta]🎤 you:[/bold magenta] {_escape(transcript)}")
            self._set_action(f"heard: {transcript[:60]}")

            # ── WORK ──
            self._set_state("working", "")
            self._set_action("claude is working...")
            events: list[dict] = []
            try:
                for event in self.session.send(transcript):
                    events.append(event)
                    for line in _chat_event_lines(event):
                        self._append_log(line)
            except Exception as e:  # noqa: BLE001
                self._append_log(f"[red]✗ claude error: {_escape(str(e))}[/red]")
                self._set_state("idle", "")
                self._set_action(f"error: {str(e)[:60]}")
                continue

            if self._stop_flag.is_set():
                break

            # ── SUMMARIZE + SPEAK ──
            self._set_state("thinking", "")
            self._set_action("summarizing...")
            try:
                summary = summarize_turn(transcript, events)
            except Exception as e:  # noqa: BLE001
                summary = f"Hit an error while summarizing: {e}"

            if not summary:
                summary = "Done."
            self._append_log(f"[italic cyan]🎙 {_escape(summary)}[/italic cyan]")
            self._set_state("talking", summary)
            self._set_action("speaking")
            speak(summary)

            self._set_state("idle", "")

        self._set_action("bye")

    # ─── Main-thread helpers ───────────────────────────────────────────────

    def _call(self, fn, *args, **kwargs) -> None:
        # Same pattern as PresentApp: let exceptions propagate via Textual.
        try:
            self.call_from_thread(fn, *args, **kwargs)
        except Exception:  # pragma: no cover — app shutting down
            pass

    def _set_state(self, state: State, narration: str = "") -> None:
        def _apply() -> None:
            char = self.query_one(CharacterPanel)
            char.state = state
            char.narration = narration

        self._call(_apply)

    def _set_progress(self, text: str) -> None:
        self._call(lambda: setattr(self.query_one(StatusBar), "progress", text))

    def _set_action(self, text: str) -> None:
        self._call(lambda: setattr(self.query_one(StatusBar), "action", text))

    def _append_log(self, line: str) -> None:
        self._call(lambda: self.query_one(ActivityLog).write(line))


def _chat_event_lines(event: dict) -> list[str]:
    # Local import to avoid a top-of-module circular reference with chat.py.
    from .chat import event_to_log_lines

    return event_to_log_lines(event)


def _escape(text: str) -> str:
    return text.replace("[", r"\[").replace("]", r"\]")


# ─── Standalone demo: cycle through character states ─────────────────────


class _CharacterDemoApp(App):
    """Tiny app that rotates the character through all states on a timer.

    Useful for eyeballing the ASCII art without wiring up audio. Run with:
        python -m claude_zoom.tui
    """

    CSS = """
    Screen {
        align: center middle;
    }
    """

    _STATES: list[State] = ["idle", "talking", "listening", "thinking", "working"]

    def compose(self) -> ComposeResult:
        yield CharacterPanel(id="character")

    def on_mount(self) -> None:
        self._idx = 0
        char = self.query_one(CharacterPanel)
        char.narration = "demo: cycling through every state"
        self.set_interval(3.0, self._rotate)

    def _rotate(self) -> None:
        self._idx = (self._idx + 1) % len(self._STATES)
        self.query_one(CharacterPanel).state = self._STATES[self._idx]


if __name__ == "__main__":
    _CharacterDemoApp().run()

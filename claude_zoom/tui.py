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
import time
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.message import Message
from textual.reactive import reactive
from textual.widgets import Header, Label, Static, TextArea

if TYPE_CHECKING:
    from .chat import ClaudeSession
    from .pr import ChangeContext
    from .snippets import CodeSnippet, SnippetWalkthrough


LISTEN_SECONDS = 5.0
TICK_INTERVAL = 0.35

State = Literal["idle", "talking", "listening", "thinking", "working"]


# ─── ASCII character frames ────────────────────────────────────────────────
#
# Five lines tall, ~9 columns. Kept to pure ASCII so it renders in any terminal.
# Each state is a list of frames cycled at TICK_INTERVAL.

_IDLE = [
    "  ,---,  \n"
    " ( o o ) \n"
    "  ( ~ )  \n"
    "  (   )  \n"
    "  '---'  ",
    "  ,---,  \n"
    " ( - - ) \n"
    "  ( ~ )  \n"
    "  (   )  \n"
    "  '---'  ",
]

_TALKING = [
    "  ,---,  \n"
    " ( o o ) \n"
    "  ( - )  \n"
    "  (   )  \n"
    "  '---'  ",
    "  ,---,  \n"
    " ( o o ) \n"
    "  ( o )  \n"
    "  (   )  \n"
    "  '---'  ",
    "  ,---,  \n"
    " ( o o ) \n"
    "  (===)  \n"
    "  (   )  \n"
    "  '---'  ",
]

_LISTENING = [
    "  ,---,   \n"
    " ( O O )) \n"
    "  ( ~ )   \n"
    "  (   )   \n"
    "  '---'   ",
    "  ,---,    \n"
    " ( O O ))) \n"
    "  ( ~ )    \n"
    "  (   )    \n"
    "  '---'    ",
]

_THINKING = [
    "  ,---,  \n"
    " ( - - ).\n"
    "  ( .. ) \n"
    "  (   )  \n"
    "  '---'  ",
    "  ,---,   \n"
    " ( - - )..\n"
    "  ( .. )  \n"
    "  (   )   \n"
    "  '---'   ",
    "  ,---,    \n"
    " ( - - )...\n"
    "  ( .. )   \n"
    "  (   )    \n"
    "  '---'    ",
]

# "Working" is the state while Claude's subprocess is running real tools —
# we reuse the thinking frame layout but with a spinning star instead of dots.
_WORKING = [
    "  ,---,   \n"
    " ( o o ) *\n"
    "  ( == )  \n"
    "  (   )   \n"
    "  '---'   ",
    "  ,---,  \n"
    " ( o o )*\n"
    "  ( == ) \n"
    "  (   )  \n"
    "  '---'  ",
    "  ,---,  \n"
    "*( o o ) \n"
    "  ( == ) \n"
    "  (   )  \n"
    "  '---'  ",
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
    hint: reactive[str] = reactive("q quit · → skip · r replay")

    def on_mount(self) -> None:
        self._render_line()

    def watch_progress(self, _new: str) -> None:
        self._render_line()

    def watch_action(self, _new: str) -> None:
        self._render_line()

    def watch_hint(self, _new: str) -> None:
        self._render_line()

    def _render_line(self) -> None:
        left = f"{self.progress}  ·  {self.action}" if self.progress else self.action
        self.update(f"{left}   [{self.hint}]")


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


@dataclass
class ChatMessage:
    role: Literal["user", "claude", "claude_error", "sub_agent", "system"]
    text: str
    timestamp: str  # "HH:MM"
    agent_name: str = ""  # filled for sub_agent messages


class TranscriptEntry(Static):
    """One message entry in the transcript: header + indented body."""

    DEFAULT_CSS = """
    TranscriptEntry {
        padding: 0 0 1 0;
        width: 1fr;
        height: auto;
    }
    """

    def __init__(self, message: ChatMessage) -> None:
        super().__init__()
        self.message = message

    def on_mount(self) -> None:
        self._render_message()

    def _render_message(self) -> None:
        role = self.message.role
        ts = self.message.timestamp
        # Indent body lines with 4 spaces so messages read like chat bubbles.
        body = "\n".join("    " + line for line in self.message.text.splitlines())
        if not body.strip():
            body = "    "

        if role == "user":
            header = f"[bold magenta]you[/bold magenta]  [dim]{ts}[/dim]"
            body_markup = f"[white]{_escape(self.message.text)}[/white]"
        elif role == "claude":
            header = f"[bold cyan]claude[/bold cyan]  [dim]{ts}[/dim]"
            body_markup = f"[white]{_escape(self.message.text)}[/white]"
        elif role == "sub_agent":
            name = self.message.agent_name or "agent"
            header = f"[bold green]{_escape(name)}[/bold green]  [dim]{ts}[/dim]"
            body_markup = f"[white]{_escape(self.message.text)}[/white]"
        elif role == "system":
            header = ""
            body_markup = f"[dim]{_escape(self.message.text)}[/dim]"
        else:  # claude_error
            header = f"[bold red]claude (error)[/bold red]  [dim]{ts}[/dim]"
            body_markup = f"[red]{_escape(self.message.text)}[/red]"

        body_indented = "\n".join(
            "    " + line for line in body_markup.splitlines()
        )
        self.update(f"{header}\n{body_indented}")


class TranscriptView(VerticalScroll):
    """Scrollable conversation view. Only user + claude messages go here —
    never tool calls, tool results, or intermediate events.
    """

    DEFAULT_CSS = """
    TranscriptView {
        width: 1fr;
        height: 1fr;
        padding: 1 2;
        border: round $accent;
    }
    """

    def append_message(self, message: ChatMessage) -> None:
        self.mount(TranscriptEntry(message))
        self.scroll_end(animate=False)


class ActivityTicker(Static):
    """Single-line 'now doing' indicator for the in-flight turn.

    Only the most recent tool call is shown; updated via `set_activity` from
    the worker thread and wiped with `clear` between turns.
    """

    DEFAULT_CSS = """
    ActivityTicker {
        width: 1fr;
        height: 3;
        padding: 0 2;
        color: $text-muted;
        border: round $accent-darken-1;
    }
    """

    activity: reactive[str] = reactive("")

    def on_mount(self) -> None:
        self._render_line()

    def watch_activity(self, _new: str) -> None:
        self._render_line()

    def _render_line(self) -> None:
        if self.activity:
            self.update(f"[cyan]→[/cyan] {_escape(self.activity)}")
        else:
            self.update("[dim](idle)[/dim]")


class MiniAgentPanel(Static):
    """Compact card for one sub-agent in the sidebar."""

    class DeleteRequest(Message):
        """Posted when the user clicks the delete button."""

        def __init__(self, agent_id: str) -> None:
            super().__init__()
            self.agent_id = agent_id

    DEFAULT_CSS = """
    MiniAgentPanel {
        height: auto;
        padding: 0 1;
        margin: 0 0 1 0;
        border: round $accent-darken-1;
    }
    """

    agent_state: reactive[str] = reactive("working")
    ticker: reactive[str] = reactive("")

    _STATE_ICONS = {
        "working": "[cyan]*[/cyan]",
        "done": "[green]✓[/green]",
        "error": "[red]✗[/red]",
    }

    def __init__(self, agent_id: str, name: str, **kwargs: Any) -> None:
        super().__init__("", **kwargs)
        self.agent_id = agent_id
        self.agent_name = name
        # Set initial content so Textual can lay out before on_mount.
        self._refresh_content()

    def on_mount(self) -> None:
        self._refresh_content()

    def watch_agent_state(self, _new: str) -> None:
        self._refresh_content()

    def watch_ticker(self, _new: str) -> None:
        self._refresh_content()

    def _refresh_content(self) -> None:
        icon = self._STATE_ICONS.get(self.agent_state, "?")
        delete_btn = " [red][b]\\[x][/b][/red]"
        line1 = f"{icon} [bold]{_escape(self.agent_name)}[/bold]{delete_btn}"
        line2 = ""
        if self.ticker:
            line2 = f"\n  [dim]{_escape(self.ticker[:40])}[/dim]"
        self.update(f"{line1}{line2}")

    def on_click(self) -> None:
        self.post_message(self.DeleteRequest(self.agent_id))


class AgentSidebar(VerticalScroll):
    """Left column: main agent character panel + sub-agent mini panels."""

    DEFAULT_CSS = """
    AgentSidebar {
        width: 36;
        height: 1fr;
        border: round $accent;
        padding: 0 1;
    }
    AgentSidebar #sub-agents-header {
        color: $text-muted;
        text-align: center;
        margin: 1 0 0 0;
    }
    """

    def compose(self) -> ComposeResult:
        yield CharacterPanel(id="character")
        yield Static("[dim]── sub agents ──[/dim]", id="sub-agents-header")


_STOP_WORDS: set[str] = {
    "the", "a", "an", "this", "that", "and", "or", "for", "in", "on", "to",
    "with", "of", "is", "are", "was", "were", "be", "been", "do", "does",
    "did", "will", "would", "could", "should", "can", "may", "might",
    "shall", "has", "have", "had", "it", "its", "my", "your", "our",
    "their", "all", "some", "any", "each", "every", "very", "just", "also",
    "so", "if", "but", "not", "no", "at", "by", "from", "up", "out",
    "about", "into", "over", "after", "before", "between", "under",
    "through", "during", "without", "within", "along", "following",
    "across", "behind", "beyond", "plus", "except", "since", "toward",
    "towards", "upon", "whether", "while", "although", "though", "because",
    "unless", "until", "that", "which", "who", "whom", "whose", "where",
    "when", "how", "what", "why", "let", "me", "us", "them", "him", "her",
    "please", "go", "look", "make", "take", "get", "give", "come", "know",
    "think", "see", "want", "use",
}


def _extract_agent_name(task: str) -> str:
    """Best-effort short name from the most meaningful 2-3 words of a task."""
    words = task.split()
    meaningful = [
        w.lower().strip(".,!?;:\"'()[]{}") for w in words
        if w.lower().strip(".,!?;:\"'()[]{}") and
        w.lower().strip(".,!?;:\"'()[]{}") not in _STOP_WORDS
    ]
    chosen = meaningful[:3] if meaningful else ["task"]
    name = "-".join(chosen)
    return name[:24] if name else "task"


class ChatApp(App):
    """Multi-agent voice chat with push-to-talk. The user talks to a main
    Claude agent; sub-agents can be spawned by voice trigger or by the main
    agent's SPAWN markers, running in isolated git worktrees. Sub-agent
    summaries are spoken via a polite queue after the current speaker.
    """

    CSS = """
    Screen {
        layout: vertical;
    }
    #body {
        layout: horizontal;
        height: 1fr;
    }
    #main-area {
        width: 1fr;
        height: 1fr;
    }
    """

    BINDINGS = [
        Binding("q", "quit", "quit"),
        Binding("space", "toggle_mic", "mic", priority=True),
        Binding("escape", "cancel_turn", "cancel turn"),
    ]

    def __init__(self, session: "ClaudeSession") -> None:
        super().__init__()
        self.session = session
        self._stop_flag = threading.Event()
        self._mic_event = threading.Event()
        # Set by escape during the recording phase so the worker can abort
        # transcription instead of sending the captured audio to Claude.
        self._cancel_recording = threading.Event()
        # Set when the main input loop is idle (waiting for mic press).
        # The speech consumer only plays sub-agent summaries when this is set.
        self._main_idle = threading.Event()

        from .agents import AgentManager, SpeechQueue

        self._speech_queue = SpeechQueue()
        self._agent_manager = AgentManager(self._speech_queue)

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal(id="body"):
            yield AgentSidebar(id="sidebar")
            with Vertical(id="main-area"):
                yield TranscriptView(id="transcript")
                yield ActivityTicker(id="ticker")
        yield StatusBar(id="status")

    def on_mount(self) -> None:
        self.title = "claude_zoom · chat"
        self.sub_title = f"cwd: {self.session.cwd or '.'}"
        status = self.query_one(StatusBar)
        status.hint = "q quit · space talk · esc cancel"
        status.progress = "booting"
        status.action = "warming up"
        # Start the speech consumer that plays sub-agent summaries.
        self._speech_thread = threading.Thread(
            target=self._speech_consumer, daemon=True, name="speech-consumer"
        )
        self._speech_thread.start()
        self._run_chat_loop()

    # ─── Key actions ───────────────────────────────────────────────────────

    def action_toggle_mic(self) -> None:
        self._mic_event.set()

    def action_cancel_turn(self) -> None:
        self.session.cancel()
        # Unblock _wait_for_mic_press if we're stuck in the recording phase,
        # and signal the worker to discard the recording rather than send it.
        self._cancel_recording.set()
        self._mic_event.set()
        self.query_one(StatusBar).action = "cancel sent"

    async def action_quit(self) -> None:  # type: ignore[override]
        self._stop_flag.set()
        self._mic_event.set()
        self.session.cancel()
        self._agent_manager.kill_all()
        self.exit()

    # ─── Main worker: push-to-talk voice loop ─────────────────────────────

    @work(thread=True, exclusive=True)
    def _run_chat_loop(self) -> None:
        from .agents import parse_spawn_markers, parse_voice_trigger
        from .chat import summarize_tool_args
        from .narrator import summarize_turn
        from .voice import Recorder

        intro = (
            "Hey! Press space whenever you want to talk to me. "
            "You can also ask me to spin off sub-agents for parallel work."
        )
        self._append_message("claude", intro)
        self._set_progress("ready")
        self._speak_main(intro)
        self._mic_event.clear()

        turn = 0
        while not self._stop_flag.is_set():
            # ── IDLE: wait for the user to press space ──
            self._set_ticker("")
            self._set_state("idle", "")
            self._set_progress(f"turn {turn}" if turn else "ready")
            self._set_action("press SPACE to talk")
            self._main_idle.set()
            if not self._wait_for_mic_press():
                break
            self._main_idle.clear()

            # ── LISTEN ──
            turn += 1
            self._cancel_recording.clear()
            self._set_state("listening", "")
            self._set_progress(f"turn {turn}")
            self._set_action("recording — press SPACE to send")
            recorder = Recorder()

            def _on_partial(text: str) -> None:
                """Called from the partial-transcription thread."""
                self._set_state("listening", f"[dim](heard so far)[/dim] {text}")
                self._set_action(f"recording — {text[:50]}")

            try:
                recorder.start(on_partial_transcript=_on_partial)
            except Exception as e:  # noqa: BLE001
                self._set_action(f"mic error: {str(e)[:60]}")
                self._set_state("idle", "")
                continue

            if not self._wait_for_mic_press():
                recorder.close()
                break

            # Escape was pressed during recording — discard audio, do not send.
            if self._cancel_recording.is_set():
                self._cancel_recording.clear()
                recorder.close()
                self._set_state("idle", "")
                self._set_action("cancelled")
                continue

            self._set_state("thinking", "")
            self._set_action("transcribing...")
            try:
                transcript = recorder.stop_and_transcribe()
            except Exception as e:  # noqa: BLE001
                self._set_action(f"transcribe error: {str(e)[:60]}")
                self._set_state("idle", "")
                continue

            if not transcript:
                self._set_action("(no speech detected)")
                self._set_state("idle", "")
                continue

            self._append_message("user", transcript)
            self._set_action(f"heard: {transcript[:60]}")

            # ── CHECK VOICE TRIGGER (direct sub-agent spawn) ──
            trigger_task = parse_voice_trigger(transcript)
            if trigger_task:
                name = _extract_agent_name(trigger_task)
                try:
                    self._spawn_sub(name, trigger_task)
                    # Instant spoken acknowledgment so user doesn't wait.
                    ack = f"On it! Kicked off agent {name}."
                    self._append_message("claude", ack)
                    self._set_state("talking", ack)
                    self._speak_main(ack)
                except Exception as e:  # noqa: BLE001
                    self._append_message("claude_error", f"spawn failed: {e}")
                continue

            # ── WORK (main agent) ──
            # Speak Claude's first text response immediately while tool
            # calls keep streaming, so the user doesn't wait.
            self._set_state("working", "")
            self._set_action("claude is working...")
            events: list[dict] = []
            early_speech_thread: threading.Thread | None = None
            early_text: str = ""
            has_tool_calls = False
            try:
                for event in self.session.send(transcript):
                    events.append(event)
                    if event.get("type") == "assistant":
                        content = (event.get("message") or {}).get("content") or []
                        for item in content:
                            if item.get("type") == "tool_use":
                                has_tool_calls = True
                                tname = item.get("name", "?")
                                short = summarize_tool_args(
                                    tname, item.get("input") or {}
                                )
                                self._set_ticker(f"{tname}({short})")
                            elif item.get("type") == "text":
                                text = item.get("text") or ""
                                for sname, stask in parse_spawn_markers(text):
                                    try:
                                        self._spawn_sub(sname, stask)
                                    except Exception:  # noqa: BLE001
                                        pass
                                # Speak the first text immediately in
                                # background so the user hears something
                                # while tools keep running.
                                cleaned = _strip_spawn_markers(text).strip()
                                if not early_text and cleaned:
                                    early_text = cleaned
                                    self._append_message("claude", early_text)
                                    self._set_state("talking", early_text)
                                    early_speech_thread = threading.Thread(
                                        target=self._speak_main,
                                        args=(early_text,),
                                        daemon=True,
                                    )
                                    early_speech_thread.start()
            except Exception as e:  # noqa: BLE001
                self._append_message("claude_error", f"{e}")
                self._set_state("idle", "")
                self._set_action(f"error: {str(e)[:60]}")
                self._set_ticker("")
                continue

            if self._stop_flag.is_set():
                break

            # Wait for early speech to finish before deciding next step.
            if early_speech_thread is not None:
                early_speech_thread.join(timeout=30)

            # ── SUMMARIZE + SPEAK (only if tools ran) ──
            self._set_ticker("")
            if has_tool_calls:
                self._set_state("thinking", "")
                self._set_action("summarizing results...")
                try:
                    summary = summarize_turn(transcript, events)
                except Exception as e:  # noqa: BLE001
                    summary = f"Hit an error while summarizing: {e}"
                if summary:
                    self._append_message("claude", summary)
                    self._set_state("talking", summary)
                    self._set_action("speaking (press SPACE to interrupt)")
                    self._speak_main(summary)
            elif not early_text:
                # No text and no tools — fallback.
                self._append_message("claude", "Done.")
                self._set_state("talking", "Done.")
                self._set_action("speaking (press SPACE to interrupt)")
                self._speak_main("Done.")

        self._set_action("bye")

    # ─── Speech helpers ───────────────────────────────────────────────────

    def _speak_main(self, text: str) -> None:
        """Speak on behalf of the main agent, with barge-in support.

        When interrupted, ``_mic_event`` is deliberately left *set* so the
        next ``_wait_for_mic_press`` immediately fires.
        """
        from .voice import speak_async

        proc = speak_async(text)
        if proc is None:
            return
        try:
            while proc.poll() is None:
                if self._stop_flag.is_set():
                    proc.terminate()
                    break
                if self._mic_event.is_set():
                    proc.terminate()
                    break
                time.sleep(0.05)
        finally:
            try:
                proc.wait(timeout=1.0)
            except Exception:  # noqa: BLE001
                pass

    def _speech_consumer(self) -> None:
        """Dedicated thread: drains SpeechQueue when main is idle.

        Politely waits until the main input loop is idle before playing a
        sub-agent's summary. Supports barge-in: if the user presses space
        during sub speech, the speech is terminated and the queue drained.
        """
        from .voice import speak_async

        while not self._stop_flag.is_set():
            item = self._speech_queue.get(timeout=0.2)
            if item is None:
                continue

            # Wait until main is idle before speaking.
            while not self._main_idle.is_set() and not self._stop_flag.is_set():
                time.sleep(0.1)
            if self._stop_flag.is_set():
                break

            self._append_message("sub_agent", item.text, agent_name=item.label)
            self._set_state("talking", item.text)
            self._set_action(f"speaking: {item.label}")
            spoken_text = f"{item.label} says: {item.text}"
            proc = speak_async(spoken_text)
            if proc is not None:
                try:
                    while proc.poll() is None:
                        if self._stop_flag.is_set():
                            proc.terminate()
                            break
                        if self._mic_event.is_set():
                            # Barge-in: stop speech, drain queue.
                            proc.terminate()
                            self._speech_queue.drain()
                            break
                        time.sleep(0.05)
                finally:
                    try:
                        proc.wait(timeout=1.0)
                    except Exception:  # noqa: BLE001
                        pass
            self._set_state("idle", "")
            self._set_action("press SPACE to talk")

    # ─── Push-to-talk helpers ─────────────────────────────────────────────

    def _wait_for_mic_press(self) -> bool:
        """Block until ``_mic_event`` fires or the app is stopping."""
        while not self._stop_flag.is_set():
            if self._mic_event.is_set():
                self._mic_event.clear()
                return True
            time.sleep(0.05)
        return False

    # ─── Sub-agent helpers ────────────────────────────────────────────────

    def _spawn_sub(self, name: str, task: str) -> None:
        """Create a sub-agent and add its panel to the sidebar."""
        base_cwd = self.session.cwd or "."
        agent = self._agent_manager.spawn(
            task=task,
            name=name,
            base_cwd=base_cwd,
            model="sonnet",
            permission_mode=self.session.permission_mode,
            on_event=self._on_sub_event,
            on_done=self._on_sub_done,
        )

        def _mount() -> None:
            panel = MiniAgentPanel(agent.id, agent.name, id=f"agent-{agent.id}")
            try:
                self.query_one(AgentSidebar).mount(panel)
            except Exception:  # noqa: BLE001
                pass

        self._call(_mount)
        self._append_message("system", f"spawned agent \"{name}\"")

    def _on_sub_event(self, agent_id: str, event: dict) -> None:
        """Called from a sub-agent thread on each stream-json event."""
        from .chat import summarize_tool_args

        if event.get("type") != "assistant":
            return
        content = (event.get("message") or {}).get("content") or []
        for item in content:
            if item.get("type") == "tool_use":
                tname = item.get("name", "?")
                short = summarize_tool_args(tname, item.get("input") or {})
                ticker_text = f"{tname}({short})"

                def _update(t: str = ticker_text) -> None:
                    try:
                        panel = self.query_one(
                            f"#agent-{agent_id}", MiniAgentPanel
                        )
                        panel.ticker = t
                    except Exception:  # noqa: BLE001
                        pass

                self._call(_update)

    def _on_sub_done(self, agent_id: str) -> None:
        """Called when a sub-agent finishes or errors."""

        def _update() -> None:
            try:
                panel = self.query_one(f"#agent-{agent_id}", MiniAgentPanel)
                agent = self._agent_manager.agents.get(agent_id)
                panel.agent_state = agent.status if agent else "done"
                panel.ticker = ""
            except Exception:  # noqa: BLE001
                pass

        self._call(_update)

    def on_mini_agent_panel_delete_request(
        self, event: MiniAgentPanel.DeleteRequest
    ) -> None:
        """Handle delete button click on a sub-agent panel."""
        agent_id = event.agent_id
        self._agent_manager.kill(agent_id)
        self._agent_manager.remove(agent_id)
        try:
            panel = self.query_one(f"#agent-{agent_id}", MiniAgentPanel)
            panel.remove()
        except Exception:  # noqa: BLE001
            pass

    # ─── Main-thread helpers ───────────────────────────────────────────────

    def _call(self, fn, *args, **kwargs) -> None:
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

    def _set_ticker(self, text: str) -> None:
        self._call(lambda: setattr(self.query_one(ActivityTicker), "activity", text))

    def _append_message(
        self, role: str, text: str, agent_name: str = ""
    ) -> None:
        msg = ChatMessage(
            role=role,  # type: ignore[arg-type]
            text=text,
            timestamp=datetime.now().strftime("%H:%M"),
            agent_name=agent_name,
        )
        self._call(lambda: self.query_one(TranscriptView).append_message(msg))


def _escape(text: str) -> str:
    return text.replace("[", r"\[").replace("]", r"\]")


def _strip_spawn_markers(text: str) -> str:
    """Remove ``<SPAWN ...>...</SPAWN>`` blocks so they aren't spoken aloud."""
    import re

    return re.sub(
        r"<SPAWN\s+name=[\"'][^\"']+[\"']\s*>.*?</SPAWN>",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    ).strip()


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

"""Live streaming wrapper around `claude -p` for multi-turn voice chat.

Each call to `ClaudeSession.send(prompt)` spawns a fresh `claude -p` subprocess
with `--output-format stream-json --verbose`, pipes the user prompt to stdin,
and yields parsed JSONL events as they arrive from stdout. The first turn
captures a `session_id` from the initial `system.init` event; subsequent turns
are passed `--resume <id>` so the conversation context is preserved.
"""

from __future__ import annotations

import json
import signal
import subprocess
import textwrap
from dataclasses import dataclass, field
from typing import Any, Iterator

DEFAULT_APPEND_SYSTEM_PROMPT = """\
You are being invoked via a voice interface. A fast model will summarize your \
work for the user at the end of each turn, so keep your own assistant messages \
short and direct — under two sentences when possible. Do not narrate your tool \
calls ("I'll read the file…") — just use the tools. Do not emit code blocks in \
prose. When you finish a task, state the outcome in one crisp sentence.
"""


@dataclass
class ClaudeSession:
    """Multi-turn wrapper around `claude -p` with session resumption."""

    cwd: str | None = None
    model: str = "opus"
    permission_mode: str = "acceptEdits"
    append_system_prompt: str = DEFAULT_APPEND_SYSTEM_PROMPT
    session_id: str | None = None

    # Track the live subprocess so `cancel()` can terminate it.
    _proc: subprocess.Popen[str] | None = field(default=None, repr=False)

    def send(self, prompt: str) -> Iterator[dict[str, Any]]:
        """Run one turn: send `prompt` to Claude, yield stream-json events.

        First turn captures the session_id; subsequent turns pass --resume.
        Raises RuntimeError if the subprocess exits non-zero or never emits
        an init event.
        """
        cmd: list[str] = [
            "claude",
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            self.model,
            "--permission-mode",
            self.permission_mode,
            "--append-system-prompt",
            self.append_system_prompt,
        ]
        if self.session_id is not None:
            cmd.extend(["--resume", self.session_id])

        self._proc = subprocess.Popen(
            cmd,
            cwd=self.cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # line-buffered so events stream as they arrive
        )

        # Pipe the prompt in and close stdin so Claude knows the request is
        # complete. We do this BEFORE reading stdout to avoid any deadlocks.
        assert self._proc.stdin is not None
        try:
            self._proc.stdin.write(prompt)
            self._proc.stdin.close()
        except BrokenPipeError:
            pass

        captured_init = False
        assert self._proc.stdout is not None
        try:
            for line in self._proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    # Non-JSON lines from claude are almost certainly log
                    # noise; skip them.
                    continue

                # Grab the session id from the first init we see on the very
                # first turn. On resumed turns this still shows the ORIGINAL
                # session id (confirmed behavior), so we only set it once.
                if (
                    self.session_id is None
                    and event.get("type") == "system"
                    and event.get("subtype") == "init"
                    and event.get("session_id")
                ):
                    self.session_id = event["session_id"]
                    captured_init = True
                elif event.get("type") == "system" and event.get("subtype") == "init":
                    captured_init = True

                yield event

            rc = self._proc.wait()
            stderr_tail = ""
            if self._proc.stderr is not None:
                stderr_tail = self._proc.stderr.read() or ""
            if rc != 0:
                raise RuntimeError(
                    f"claude -p exited {rc}: {stderr_tail.strip()[-400:]}"
                )
            if not captured_init:
                raise RuntimeError(
                    f"claude -p emitted no init event: {stderr_tail.strip()[-400:]}"
                )
        finally:
            self._proc = None

    def cancel(self) -> None:
        """Terminate the in-flight subprocess, if any."""
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.send_signal(signal.SIGTERM)
        except ProcessLookupError:
            pass


# ─── Event → log line formatting ───────────────────────────────────────────


def events_to_log_lines(events: list[dict[str, Any]]) -> list[str]:
    """Turn a raw event stream into rich-markup strings for the TUI log."""
    lines: list[str] = []
    for event in events:
        lines.extend(_event_to_lines(event))
    return lines


def event_to_log_lines(event: dict[str, Any]) -> list[str]:
    """Single-event convenience wrapper (for streaming into the TUI live)."""
    return _event_to_lines(event)


def _event_to_lines(event: dict[str, Any]) -> list[str]:
    etype = event.get("type")
    if etype == "system":
        if event.get("subtype") == "init":
            sid = (event.get("session_id") or "")[:8]
            model = event.get("model", "?")
            return [f"[dim]⚙ session {sid} · model {model}[/dim]"]
        return []

    if etype == "assistant":
        msg = event.get("message") or {}
        content = msg.get("content") or []
        out: list[str] = []
        for item in content:
            t = item.get("type")
            if t == "text":
                text = (item.get("text") or "").strip()
                if text:
                    out.append(f"[white]💬 {_escape(text)}[/white]")
            elif t == "tool_use":
                name = item.get("name", "?")
                short = _summarize_tool_args(name, item.get("input") or {})
                out.append(f"[cyan]→ {name}({short})[/cyan]")
            elif t == "thinking":
                # Noisy; skip by default.
                pass
        return out

    if etype == "user":
        msg = event.get("message") or {}
        content = msg.get("content") or []
        out = []
        for item in content:
            if item.get("type") != "tool_result":
                continue
            result = item.get("content")
            text = _stringify_tool_result(result)
            if not text:
                out.append("[dim]← (empty)[/dim]")
            else:
                first_line = text.splitlines()[0]
                line_count = text.count("\n") + 1
                if line_count > 1:
                    out.append(
                        f"[dim]← {_escape(first_line[:80])} ({line_count} lines)[/dim]"
                    )
                else:
                    out.append(f"[dim]← {_escape(first_line[:120])}[/dim]")
        return out

    if etype == "result":
        is_err = event.get("is_error")
        dur_ms = event.get("duration_ms") or 0
        dur_s = dur_ms / 1000.0
        if is_err:
            return [
                f"[red]✗ error ({dur_s:.1f}s): "
                f"{_escape((event.get('result') or '')[:200])}[/red]"
            ]
        return [f"[green]✓ done ({dur_s:.1f}s)[/green]"]

    if etype == "rate_limit_event":
        info = event.get("rate_limit_info") or {}
        if info.get("status") != "allowed":
            return [f"[yellow]⚠ rate limited: {info.get('rateLimitType', '?')}[/yellow]"]
        return []

    return []


def _summarize_tool_args(tool: str, args: dict[str, Any]) -> str:
    """Best-effort one-line summary of a tool_use `input` block."""
    if tool in ("Read", "Edit", "Write", "NotebookRead", "NotebookEdit"):
        path = args.get("file_path") or args.get("notebook_path") or ""
        return _shorten(path, 60)
    if tool == "Bash":
        return _shorten(args.get("command") or "", 60)
    if tool in ("Grep", "Glob"):
        return _shorten(args.get("pattern") or args.get("query") or "", 60)
    if tool == "WebFetch":
        return _shorten(args.get("url") or "", 60)
    if tool == "WebSearch":
        return _shorten(args.get("query") or "", 60)
    if tool == "Task":
        return _shorten(args.get("description") or args.get("subagent_type") or "", 60)
    # Fallback: first 60 chars of the JSON dump.
    try:
        dumped = json.dumps(args, separators=(",", ":"), default=str)
    except TypeError:
        dumped = str(args)
    return _shorten(dumped, 60)


def _stringify_tool_result(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if isinstance(result, list):
        parts: list[str] = []
        for item in result:
            if isinstance(item, dict) and "text" in item:
                parts.append(str(item["text"]))
            else:
                parts.append(str(item))
        return "\n".join(parts)
    return str(result)


def _shorten(text: str, n: int) -> str:
    text = text.replace("\n", " ").strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def _escape(text: str) -> str:
    """Escape rich-markup specials so user text doesn't break formatting."""
    return text.replace("[", r"\[").replace("]", r"\]")


# ─── Plain transcript for feeding the narrator ────────────────────────────


def events_to_transcript(events: list[dict[str, Any]]) -> str:
    """Compact plaintext transcript of a turn, for Haiku summarization."""
    lines: list[str] = []
    for event in events:
        etype = event.get("type")
        if etype == "assistant":
            msg = event.get("message") or {}
            for item in msg.get("content") or []:
                t = item.get("type")
                if t == "text":
                    text = (item.get("text") or "").strip()
                    if text:
                        lines.append(f"assistant: {text}")
                elif t == "tool_use":
                    name = item.get("name", "?")
                    short = _summarize_tool_args(name, item.get("input") or {})
                    lines.append(f"tool_use: {name}({short})")
        elif etype == "user":
            msg = event.get("message") or {}
            for item in msg.get("content") or []:
                if item.get("type") != "tool_result":
                    continue
                text = _stringify_tool_result(item.get("content"))
                if text:
                    # Truncate long results to keep the transcript compact.
                    truncated = textwrap.shorten(
                        text, width=400, placeholder=" …(truncated)"
                    )
                    lines.append(f"tool_result: {truncated}")
        elif etype == "result":
            if event.get("is_error"):
                lines.append(f"error: {event.get('result', '')}")
    return "\n".join(lines)

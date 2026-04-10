"""Coordinator agent for claude_zoom chat.

A hidden background agent (powered by Opus) that tracks all active sub-agents
and provides routing suggestions to the main agent loop.  The coordinator
maintains a persistent Claude session (via ``--resume``) so it accumulates
context about agent history across the entire chat session.

Routing protocol
----------------
The coordinator receives two kinds of messages:

1. **LIFECYCLE UPDATES** — queued non-blocking notifications sent when
   sub-agents are spawned, complete, or error.  Flushed in batch at the
   start of the next ``advise()`` call.

2. **ROUTING QUERY** — sent by ``advise()`` before each user message is
   processed.  The coordinator responds with a structured ROUTE/ADVICE
   block that the Python layer parses into a ``CoordinatorSuggestion``.

The caller (``ChatEngine._run_chat_loop``) interprets the suggestion:
- ``agent_id`` set → route the user message directly to that sub-agent
- ``advice`` non-empty → inject as context into the main Claude prompt
- timeout or error → fall through silently (suggestion stays "main")
"""

from __future__ import annotations

import json
import queue
import subprocess
import threading
from dataclasses import dataclass


# ─── System prompt ────────────────────────────────────────────────────────────

COORDINATOR_SYSTEM_PROMPT = """\
You are a hidden routing coordinator for a multi-agent voice assistant. \
Your ONLY job is to track active sub-agents and advise on message routing.

You receive two types of input:

LIFECYCLE UPDATES — one or more lines describing agent spawns, completions, \
and errors. Acknowledge with exactly one word: ACK

ROUTING QUERY — a user utterance plus a list of current agents. \
Reply in EXACTLY this two-line format (no other text, no preamble):
ROUTE: main
ADVICE: <one short sentence of context for the main agent>

or, when the user message clearly continues / follows up on a specific agent:
ROUTE: agent:<agent_id>
ADVICE: <one short sentence explaining why that agent should handle it>

Rules:
- Suggest "agent:<id>" ONLY when the user message clearly relates to that \
  agent's specific task (same code area, direct follow-up, continuation).
- Default to "main" when you are unsure, when the message is a new request, \
  or when no agents match well.
- Keep ADVICE under 20 words.
- Never add greetings, apologies, or any text outside the two-line format.
"""


# ─── Data model ──────────────────────────────────────────────────────────────


@dataclass
class CoordinatorSuggestion:
    """Parsed routing suggestion from the coordinator."""

    route: str = "main"  # "main" or "agent:<agent_id>"
    advice: str = ""  # short context to inject into the main agent's prompt
    agent_id: str | None = None  # populated when route starts with "agent:"


# ─── Parsing ─────────────────────────────────────────────────────────────────


def _parse_suggestion(raw: str) -> CoordinatorSuggestion:
    """Parse the coordinator's structured ROUTE/ADVICE response."""
    if not raw:
        return CoordinatorSuggestion()

    route = "main"
    advice = ""

    for line in raw.splitlines():
        stripped = line.strip()
        upper = stripped.upper()
        if upper.startswith("ROUTE:"):
            route_val = stripped[6:].strip().lower()
            route = route_val if route_val.startswith("agent:") else "main"
        elif upper.startswith("ADVICE:"):
            advice = stripped[7:].strip()

    agent_id: str | None = None
    if route.startswith("agent:"):
        agent_id = route[6:].strip() or None
        if not agent_id:
            route = "main"

    return CoordinatorSuggestion(route=route, advice=advice, agent_id=agent_id)


# ─── Coordinator agent ────────────────────────────────────────────────────────


class CoordinatorAgent:
    """Hidden Opus agent that tracks sub-agents and advises on routing.

    Thread-safety
    -------------
    - ``notify_*`` methods are non-blocking and safe to call from any thread.
      They push notifications onto an internal queue.
    - ``advise()`` acquires ``_lock`` and is therefore serialized.  Pending
      lifecycle notifications are flushed as a batch at the start of each
      ``advise()`` call, so callers never block on lifecycle delivery.
    """

    def __init__(self, cwd: str, model: str = "opus") -> None:
        self._cwd = cwd
        self._model = model
        self._session_id: str | None = None
        self._lock = threading.Lock()
        self._notifications: queue.Queue[str] = queue.Queue()

    # ── Public API ────────────────────────────────────────────────────────────

    def notify_spawn(self, agent_id: str, name: str, task: str) -> None:
        """Queue a spawn notification (non-blocking)."""
        self._notifications.put(
            f"LIFECYCLE: agent '{name}' (id={agent_id}) SPAWNED to work on: {task[:120]}"
        )

    def notify_done(
        self, agent_id: str, name: str, task: str, status: str
    ) -> None:
        """Queue a completion or error notification (non-blocking)."""
        self._notifications.put(
            f"LIFECYCLE: agent '{name}' (id={agent_id}) {status.upper()}."
            f" Task was: {task[:100]}"
        )

    def advise(
        self,
        transcript: str,
        agents: list,  # list[AgentInstance] — avoid circular import
        timeout: float = 5.0,
    ) -> CoordinatorSuggestion:
        """Consult the coordinator for routing advice (blocks up to *timeout* s).

        1. Flushes all pending lifecycle notifications.
        2. Builds a ROUTING QUERY with the current transcript and agent state.
        3. Sends the combined message to the Opus session via ``subprocess.run``.
        4. Parses and returns the response as a ``CoordinatorSuggestion``.

        Returns ``CoordinatorSuggestion(route="main")`` on timeout or error.
        """
        with self._lock:
            # Drain pending lifecycle notifications.
            notifications: list[str] = []
            while True:
                try:
                    notifications.append(self._notifications.get_nowait())
                except queue.Empty:
                    break

            # Build agent state summary.
            agents_text = (
                "\n".join(
                    f"- {a.name} (id={a.id}): {a.status} — {a.task[:80]}"
                    for a in agents
                )
                or "(none)"
            )

            # Compose the message to the coordinator.
            parts: list[str] = []
            if notifications:
                parts.append("LIFECYCLE UPDATES:\n" + "\n".join(notifications))
            parts.append(
                f"ROUTING QUERY:\n"
                f"User said: {transcript}\n\n"
                f"Current agents:\n{agents_text}"
            )
            message = "\n\n".join(parts)

            raw = self._query(message, timeout=timeout)
            return _parse_suggestion(raw)

    # ── Internal ──────────────────────────────────────────────────────────────

    def _query(self, message: str, timeout: float = 5.0) -> str:
        """Send *message* to the coordinator's persistent Opus session.

        Uses ``--output-format json`` (non-streaming) so the entire response
        arrives in one shot.  Session continuity is maintained via
        ``--resume <session_id>`` on subsequent calls.
        """
        cmd: list[str] = [
            "claude",
            "-p",
            "--output-format",
            "json",
            "--model",
            self._model,
            "--append-system-prompt",
            COORDINATOR_SYSTEM_PROMPT,
        ]
        if self._session_id is not None:
            cmd.extend(["--resume", self._session_id])

        try:
            result = subprocess.run(
                cmd,
                input=message,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=self._cwd,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return ""

        if result.returncode != 0:
            return ""

        try:
            data = json.loads(result.stdout)
            # Capture session_id from the first successful call so subsequent
            # calls resume the same conversation context.
            if self._session_id is None:
                sid = data.get("session_id")
                if sid:
                    self._session_id = sid
            return (data.get("result") or "").strip()
        except (json.JSONDecodeError, AttributeError):
            return ""

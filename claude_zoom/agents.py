"""Multi-agent infrastructure for claude_zoom chat.

Manages sub-agents that run in parallel to the main ClaudeSession, each in
its own git worktree.  A shared SpeechQueue serializes TTS output so agents
"pop in" politely after the current speaker finishes.

Spawn triggers
--------------
1. **Voice trigger**: the user says "spin off an agent to …" or "in the
   background, …".  `parse_voice_trigger` extracts the task.
2. **Main-agent marker**: the main Claude emits ``<SPAWN name="…">task</SPAWN>``
   in its assistant text.  `parse_spawn_markers` extracts them.
"""

from __future__ import annotations

import queue
import re
import subprocess
import threading
from dataclasses import dataclass, field
from typing import Any, Literal

from .chat import ClaudeSession

# ─── Voice trigger detection ──────────────────────────────────────────────

_VOICE_TRIGGERS: list[re.Pattern[str]] = [
    # "spin off an agent to …", "spawn an agent to …", "launch an agent to …"
    re.compile(
        r"(?:spin\s+off|spawn|launch|start|kick\s+off)\s+"
        r"(?:a\s+)?(?:new\s+)?(?:sub[- ]?)?agent\s+(?:to\s+)?(.+)",
        re.IGNORECASE,
    ),
    # "in the background, …"
    re.compile(r"in\s+the\s+background[,:]?\s+(.+)", re.IGNORECASE),
    # "send an agent to …"
    re.compile(
        r"(?:send|dispatch)\s+(?:a\s+)?(?:new\s+)?agent\s+(?:to\s+)?(.+)",
        re.IGNORECASE,
    ),
]

# Common filler that voice transcription prepends ("yeah let's", "ok can you",
# "sure go ahead and", etc.).  Stripped before trigger matching.
_FILLER_RE = re.compile(
    r"^(?:(?:yeah|yes|yep|ok|okay|sure|hey|please|so|um|uh|well|"
    r"let's|let\s+us|can\s+you|go\s+ahead\s+and|I\s+want\s+to|"
    r"could\s+you|I'd\s+like\s+to)\s*,?\s*)+",
    re.IGNORECASE,
)


def parse_voice_trigger(transcript: str) -> str | None:
    """If *transcript* matches a voice-trigger phrase, return the task.

    Returns ``None`` when the transcript is a normal message for the main
    agent.
    """
    text = transcript.strip()
    # Strip conversational filler so "yeah let's spin off an agent" works.
    text = _FILLER_RE.sub("", text).strip()
    for pattern in _VOICE_TRIGGERS:
        m = pattern.search(text)
        if m:
            task = m.group(1).strip()
            return task if task else None
    return None


# ─── Main-agent SPAWN marker parsing ──────────────────────────────────────

_SPAWN_RE = re.compile(
    r"<SPAWN\s+name=[\"']([^\"']+)[\"']\s*>(.*?)</SPAWN>",
    re.DOTALL | re.IGNORECASE,
)


def parse_spawn_markers(text: str) -> list[tuple[str, str]]:
    """Extract ``(name, task)`` pairs from ``<SPAWN>`` blocks in *text*."""
    return [(m.group(1).strip(), m.group(2).strip()) for m in _SPAWN_RE.finditer(text)]


# ─── Git worktree helpers ─────────────────────────────────────────────────

_WORKTREE_DIR = ".claude_zoom_agents"


def setup_worktree(base_cwd: str, agent_id: str) -> str:
    """Create an isolated git worktree for a sub-agent.

    Returns the absolute path to the new worktree directory.
    Raises ``RuntimeError`` if the cwd is not a git repo or worktree
    creation fails.
    """
    import os

    worktree_path = os.path.join(base_cwd, _WORKTREE_DIR, agent_id)
    result = subprocess.run(
        ["git", "worktree", "add", "--detach", worktree_path],
        cwd=base_cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"git worktree add failed: {result.stderr.strip()[-300:]}"
        )
    return worktree_path


def cleanup_worktree(base_cwd: str, worktree_path: str) -> None:
    """Remove a git worktree created by `setup_worktree`."""
    subprocess.run(
        ["git", "worktree", "remove", "--force", worktree_path],
        cwd=base_cwd,
        capture_output=True,
        text=True,
        check=False,
    )


def is_git_repo(path: str) -> bool:
    """Return True if *path* is inside a git repository."""
    result = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=path,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


# ─── Speech queue ─────────────────────────────────────────────────────────


@dataclass
class SpeechItem:
    label: str  # e.g. "claude" or "agent todo-search"
    text: str


class SpeechQueue:
    """Thread-safe FIFO of speech items with drain support."""

    def __init__(self) -> None:
        self._q: queue.Queue[SpeechItem] = queue.Queue()

    def put(self, label: str, text: str) -> None:
        self._q.put(SpeechItem(label=label, text=text))

    def get(self, timeout: float = 0.2) -> SpeechItem | None:
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            return None

    def drain(self) -> None:
        """Discard all pending items (e.g. on user barge-in)."""
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                break


# ─── Agent instance & manager ─────────────────────────────────────────────

SUB_AGENT_SYSTEM_PROMPT = """\
You are a sub-agent given one focused task. Complete it and state the outcome \
in 1-2 sentences. Do not ask follow-up questions. Do not narrate your tool \
calls. Just do the work and report the result.
"""


@dataclass
class AgentInstance:
    id: str
    name: str
    session: ClaudeSession
    worktree_path: str | None
    task: str
    status: Literal["working", "done", "error"] = "working"
    events: list[dict[str, Any]] = field(default_factory=list)
    thread: threading.Thread | None = field(default=None, repr=False)


class AgentManager:
    """Manages the pool of sub-agents running alongside the main session."""

    def __init__(self, speech_queue: SpeechQueue, max_agents: int = 5) -> None:
        self.agents: dict[str, AgentInstance] = {}
        self.speech_queue = speech_queue
        self.max_agents = max_agents
        self._counter = 0
        self._lock = threading.Lock()

    def spawn(
        self,
        task: str,
        name: str,
        base_cwd: str,
        model: str = "sonnet",
        permission_mode: str = "acceptEdits",
        *,
        on_event: Any | None = None,
        on_done: Any | None = None,
    ) -> AgentInstance:
        """Create and start a new sub-agent.

        *on_event(agent_id, event)* is called from the sub's thread on each
        stream-json event (for updating the TUI ticker).

        *on_done(agent_id)* is called when the sub finishes or errors (for
        updating the TUI panel state).
        """
        with self._lock:
            if len(self.agents) >= self.max_agents:
                raise RuntimeError(
                    f"max {self.max_agents} concurrent sub-agents reached"
                )
            self._counter += 1
            agent_id = f"sub-{self._counter}"

        # Set up isolated worktree if possible.
        worktree_path: str | None = None
        cwd = base_cwd
        if is_git_repo(base_cwd):
            try:
                worktree_path = setup_worktree(base_cwd, agent_id)
                cwd = worktree_path
            except RuntimeError:
                pass  # fall back to shared cwd

        session = ClaudeSession(
            cwd=cwd,
            model=model,
            permission_mode=permission_mode,
            append_system_prompt=SUB_AGENT_SYSTEM_PROMPT,
        )

        agent = AgentInstance(
            id=agent_id,
            name=name,
            session=session,
            worktree_path=worktree_path,
            task=task,
        )

        def _worker() -> None:
            from .chat import summarize_tool_args
            from .narrator import summarize_turn

            try:
                for event in agent.session.send(agent.task):
                    agent.events.append(event)
                    if on_event is not None:
                        try:
                            on_event(agent_id, event)
                        except Exception:  # noqa: BLE001
                            pass
                agent.status = "done"

                # Summarize and queue speech.
                try:
                    summary = summarize_turn(agent.task, agent.events)
                except Exception as e:  # noqa: BLE001
                    summary = f"Agent {agent.name} hit a summarize error: {e}"
                if not summary:
                    summary = "Done."
                self.speech_queue.put(f"agent {agent.name}", summary)
            except Exception as e:  # noqa: BLE001
                agent.status = "error"
                self.speech_queue.put(
                    f"agent {agent.name}", f"Error: {e}"
                )
            finally:
                if on_done is not None:
                    try:
                        on_done(agent_id)
                    except Exception:  # noqa: BLE001
                        pass
                # Clean up worktree.
                if worktree_path is not None:
                    cleanup_worktree(base_cwd, worktree_path)

        thread = threading.Thread(target=_worker, daemon=True, name=agent_id)
        agent.thread = thread
        with self._lock:
            self.agents[agent_id] = agent
        thread.start()
        return agent

    def kill(self, agent_id: str) -> None:
        """Cancel a sub-agent's in-flight subprocess."""
        with self._lock:
            agent = self.agents.get(agent_id)
        if agent is not None:
            agent.session.cancel()

    def kill_all(self) -> None:
        """Cancel all running sub-agents."""
        with self._lock:
            ids = list(self.agents.keys())
        for aid in ids:
            self.kill(aid)

    def remove(self, agent_id: str) -> None:
        """Remove a finished agent from the pool."""
        with self._lock:
            self.agents.pop(agent_id, None)

    @property
    def active_agents(self) -> list[AgentInstance]:
        with self._lock:
            return [a for a in self.agents.values() if a.status == "working"]

    @property
    def all_agents(self) -> list[AgentInstance]:
        with self._lock:
            return list(self.agents.values())

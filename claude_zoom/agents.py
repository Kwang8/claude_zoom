"""Multi-agent infrastructure for claude_zoom chat.

Manages sub-agents that run in parallel to the main ClaudeSession, each in
its own git worktree.  A shared SpeechQueue serializes TTS output so agents
"pop in" politely after the current speaker finishes.

Sub-agents that make file changes can auto-commit, push a branch, and
optionally open a PR via ``gh pr create``.

Spawn triggers
--------------
1. **Voice trigger**: the user says "spin off an agent to …" or "in the
   background, …".  `parse_voice_trigger` extracts the task.
2. **Main-agent marker**: the main Claude emits ``<SPAWN name="…">task</SPAWN>``
   in its assistant text.  `parse_spawn_markers` extracts them.
3. **Agent targeting**: the user says "agent researcher, also check tests".
   `parse_agent_target` routes the message to a specific sub.
"""

from __future__ import annotations

import os
import queue
import re
import subprocess
import threading
from dataclasses import dataclass, field
from typing import Any, Literal

from .chat import ClaudeSession

# ─── Voice trigger detection ──────────────────────────────────────────────

_VOICE_TRIGGERS: list[re.Pattern[str]] = [
    re.compile(
        r"(?:spin\s+off|spawn|launch|start|kick\s+off)\s+"
        r"(?:a\s+)?(?:new\s+)?(?:sub[- ]?)?agent\s+(?:to\s+)?(.+)",
        re.IGNORECASE,
    ),
    re.compile(r"in\s+the\s+background[,:]?\s+(.+)", re.IGNORECASE),
    re.compile(
        r"(?:send|dispatch)\s+(?:a\s+)?(?:new\s+)?agent\s+(?:to\s+)?(.+)",
        re.IGNORECASE,
    ),
]

_FILLER_RE = re.compile(
    r"^(?:(?:yeah|yes|yep|ok|okay|sure|hey|please|so|um|uh|well|"
    r"let's|let\s+us|can\s+you|go\s+ahead\s+and|I\s+want\s+to|"
    r"could\s+you|I'd\s+like\s+to)\s*,?\s*)+",
    re.IGNORECASE,
)


def parse_voice_trigger(transcript: str) -> str | None:
    """If *transcript* matches a voice-trigger phrase, return the task."""
    text = _FILLER_RE.sub("", transcript.strip()).strip()
    for pattern in _VOICE_TRIGGERS:
        m = pattern.search(text)
        if m:
            task = m.group(1).strip()
            return task if task else None
    return None


# ─── Agent targeting ──────────────────────────────────────────────────────

_AGENT_TARGET_RE = re.compile(
    r"(?:hey\s+)?agent\s+([\w][\w-]*)[,:]?\s+(.+)",
    re.IGNORECASE,
)


def parse_agent_target(transcript: str) -> tuple[str, str] | None:
    """Detect "agent <name-or-number>, <message>" in *transcript*.

    Returns ``(agent_ref, message)`` where *agent_ref* is a name like
    "researcher" or a number like "2".  Returns ``None`` if no target found.
    """
    text = _FILLER_RE.sub("", transcript.strip()).strip()
    m = _AGENT_TARGET_RE.search(text)
    if m:
        ref = m.group(1).strip()
        msg = m.group(2).strip()
        return (ref, msg) if msg else None
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
    subprocess.run(
        ["git", "worktree", "remove", "--force", worktree_path],
        cwd=base_cwd,
        capture_output=True,
        text=True,
        check=False,
    )


def is_git_repo(path: str) -> bool:
    result = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=path,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


# ─── Auto-PR helpers ─────────────────────────────────────────────────────


def sanitize_branch_name(task: str) -> str:
    """Turn a task description into a git-safe branch name."""
    slug = re.sub(r"[^\w\s-]", "", task.lower())
    slug = re.sub(r"[\s_]+", "-", slug).strip("-")
    return f"claude-zoom/{slug[:50]}" if slug else "claude-zoom/agent-work"


def _has_changes(cwd: str) -> int:
    """Return the number of changed files in *cwd* (staged + unstaged)."""
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    lines = [l for l in result.stdout.splitlines() if l.strip()]
    return len(lines)


def commit_and_push(agent: "AgentInstance") -> str | None:
    """Stage, commit, create branch, push. Returns branch name or None."""
    cwd = agent.worktree_path
    if cwd is None:
        return None
    n_changed = _has_changes(cwd)
    if n_changed == 0:
        return None

    branch = sanitize_branch_name(agent.task)
    # Create and checkout branch.
    subprocess.run(
        ["git", "checkout", "-b", branch],
        cwd=cwd, capture_output=True, text=True, check=False,
    )
    # Stage all.
    subprocess.run(
        ["git", "add", "-A"],
        cwd=cwd, capture_output=True, text=True, check=False,
    )
    # Commit.
    msg = f"{agent.name}: {agent.task[:100]}"
    subprocess.run(
        ["git", "commit", "-m", msg],
        cwd=cwd, capture_output=True, text=True, check=False,
    )
    # Push.
    result = subprocess.run(
        ["git", "push", "-u", "origin", branch],
        cwd=cwd, capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        return None
    return branch


def create_pr(agent: "AgentInstance", branch: str) -> str | None:
    """Create a GitHub PR via ``gh`` and return the PR URL, or None."""
    cwd = agent.worktree_path or "."
    title = f"[claude-zoom] {agent.name}: {agent.task[:60]}"
    body = (
        f"## Summary\n"
        f"Auto-generated by claude-zoom sub-agent **{agent.name}**.\n\n"
        f"**Task:** {agent.task}\n\n"
        f"---\n"
        f"Generated with [claude-zoom](https://github.com/Kwang8/claude_zoom)"
    )
    result = subprocess.run(
        ["gh", "pr", "create", "--title", title, "--body", body, "--head", branch],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    # gh prints the PR URL on stdout.
    return result.stdout.strip() or None


# ─── Speech queue ─────────────────────────────────────────────────────────


@dataclass
class SpeechItem:
    label: str  # e.g. "claude" or "agent todo-search"
    text: str
    requires_response: bool = False  # True → next user input is routed back to agent
    agent_id: str = ""  # set when requires_response is True
    question_type: str = ""  # "pr" | "agent_question" | ""


class SpeechQueue:
    """Thread-safe FIFO of speech items with drain support."""

    def __init__(self) -> None:
        self._q: queue.Queue[SpeechItem] = queue.Queue()

    def put(
        self,
        label: str,
        text: str,
        *,
        requires_response: bool = False,
        agent_id: str = "",
        question_type: str = "",
    ) -> None:
        self._q.put(SpeechItem(
            label=label, text=text,
            requires_response=requires_response, agent_id=agent_id,
            question_type=question_type,
        ))

    def get(self, timeout: float = 0.2) -> SpeechItem | None:
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            return None

    def drain(self) -> None:
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                break


# ─── Agent instance & manager ─────────────────────────────────────────────

SUB_AGENT_SYSTEM_PROMPT = """\
You are a sub-agent given one focused task. Complete it and state the outcome \
in 1-2 sentences. Do not narrate your tool calls. Just do the work and report \
the result.

If you reach a decision point where you genuinely need user input before \
continuing — e.g. permission to delete files, a choice between two approaches, \
or critical missing information — emit exactly one block anywhere in your \
response:

<QUESTION>Your specific question here?</QUESTION>

Then stop working. The user will be notified and their answer forwarded to you \
in the next message. After receiving the answer, continue your task.

Only use <QUESTION> when truly blocked. Most tasks should complete without it.
"""

AgentStatus = Literal["working", "done", "error", "pr_pending", "needs_input"]

_QUESTION_RE = re.compile(r"<QUESTION>(.*?)</QUESTION>", re.DOTALL | re.IGNORECASE)


def _extract_question(events: list[dict]) -> str | None:
    """Return the first <QUESTION> text from the last assistant message, or None."""
    for event in reversed(events):
        if event.get("type") != "assistant":
            continue
        content = (event.get("message") or {}).get("content") or []
        for item in reversed(content):
            if item.get("type") != "text":
                continue
            m = _QUESTION_RE.search(item.get("text") or "")
            if m:
                return m.group(1).strip()
    return None


@dataclass
class AgentInstance:
    id: str
    name: str
    session: ClaudeSession
    worktree_path: str | None
    base_cwd: str
    task: str
    status: AgentStatus = "working"
    events: list[dict[str, Any]] = field(default_factory=list)
    thread: threading.Thread | None = field(default=None, repr=False)
    task_queue: list[str] = field(default_factory=list)
    branch: str | None = None  # set after commit_and_push
    number: int = 0  # 1-indexed display number
    pending_question: str | None = None  # set when status == "needs_input"


class AgentManager:
    """Manages the pool of sub-agents running alongside the main session."""

    def __init__(self, speech_queue: SpeechQueue, max_agents: int = 10) -> None:
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
        with self._lock:
            if len([a for a in self.agents.values() if a.status == "working"]) >= self.max_agents:
                raise RuntimeError(
                    f"max {self.max_agents} concurrent sub-agents reached"
                )
            self._counter += 1
            agent_id = f"sub-{self._counter}"

        worktree_path: str | None = None
        cwd = base_cwd
        if is_git_repo(base_cwd):
            try:
                worktree_path = setup_worktree(base_cwd, agent_id)
                cwd = worktree_path
            except RuntimeError:
                pass

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
            base_cwd=base_cwd,
            task=task,
            number=self._counter,
        )

        def _worker() -> None:
            self._run_agent_task(agent, on_event=on_event, on_done=on_done)

        thread = threading.Thread(target=_worker, daemon=True, name=agent_id)
        agent.thread = thread
        with self._lock:
            self.agents[agent_id] = agent
        thread.start()
        return agent

    def _run_agent_task(
        self,
        agent: AgentInstance,
        *,
        on_event: Any | None = None,
        on_done: Any | None = None,
    ) -> None:
        """Run the agent's current task and process queued follow-ups."""
        from .narrator import summarize_turn

        try:
            for event in agent.session.send(agent.task):
                agent.events.append(event)
                if on_event is not None:
                    try:
                        on_event(agent.id, event)
                    except Exception:  # noqa: BLE001
                        pass

            # Check for a pending question — agent needs user input before continuing.
            question = _extract_question(agent.events)
            if question:
                agent.pending_question = question
                agent.status = "needs_input"
                self.speech_queue.put(
                    f"agent {agent.name}",
                    f"I have a question: {question}",
                    requires_response=True,
                    agent_id=agent.id,
                    question_type="agent_question",
                )
            else:
                # Check for file changes → auto-PR flow.
                branch = None
                if agent.worktree_path and _has_changes(agent.worktree_path):
                    branch = commit_and_push(agent)
                    agent.branch = branch

                # Summarize.
                try:
                    summary = summarize_turn(agent.task, agent.events)
                except Exception as e:  # noqa: BLE001
                    summary = f"Agent {agent.name} hit a summarize error: {e}"
                if not summary:
                    summary = "Done."

                if branch:
                    # PR flow: speak summary + ask about PR.
                    agent.status = "pr_pending"
                    self.speech_queue.put(
                        f"agent {agent.name}",
                        f"{summary} I made changes and pushed branch {branch}. "
                        f"Want me to open a PR?",
                        requires_response=True,
                        agent_id=agent.id,
                        question_type="pr",
                    )
                else:
                    agent.status = "done"
                    self.speech_queue.put(f"agent {agent.name}", summary, agent_id=agent.id)

        except Exception as e:  # noqa: BLE001
            agent.status = "error"
            self.speech_queue.put(f"agent {agent.name}", f"Error: {e}", agent_id=agent.id)
        finally:
            if on_done is not None:
                try:
                    on_done(agent.id)
                except Exception:  # noqa: BLE001
                    pass
            # Keep worktree alive if we're waiting for user input or a PR decision.
            if agent.status not in ("pr_pending", "needs_input") and agent.worktree_path is not None:
                cleanup_worktree(agent.base_cwd, agent.worktree_path)

        # Process queued follow-up tasks.
        while agent.task_queue and agent.status in ("done", "pr_pending"):
            next_task = agent.task_queue.pop(0)
            agent.task = next_task
            agent.status = "working"
            agent.events.clear()
            if on_done is not None:
                try:
                    on_done(agent.id)
                except Exception:  # noqa: BLE001
                    pass
            try:
                for event in agent.session.send(next_task):
                    agent.events.append(event)
                    if on_event is not None:
                        try:
                            on_event(agent.id, event)
                        except Exception:  # noqa: BLE001
                            pass
                agent.status = "done"
                try:
                    summary = summarize_turn(next_task, agent.events)
                except Exception as e:  # noqa: BLE001
                    summary = f"Agent {agent.name} hit a summarize error: {e}"
                if not summary:
                    summary = "Done."
                self.speech_queue.put(f"agent {agent.name}", summary, agent_id=agent.id)
            except Exception as e:  # noqa: BLE001
                agent.status = "error"
                self.speech_queue.put(f"agent {agent.name}", f"Error: {e}", agent_id=agent.id)
            finally:
                if on_done is not None:
                    try:
                        on_done(agent.id)
                    except Exception:  # noqa: BLE001
                        pass

    def handle_pr_decision(self, agent_id: str, approved: bool) -> str | None:
        """Handle user's yes/no response to the PR prompt.

        Returns the PR URL if approved and created, else None.
        """
        with self._lock:
            agent = self.agents.get(agent_id)
        if agent is None or agent.status != "pr_pending":
            return None

        pr_url: str | None = None
        if approved and agent.branch:
            pr_url = create_pr(agent, agent.branch)

        agent.status = "done"
        if agent.worktree_path is not None:
            cleanup_worktree(agent.base_cwd, agent.worktree_path)
        return pr_url

    def handle_agent_question(
        self,
        agent_id: str,
        user_response: str,
        *,
        on_event: Any | None = None,
        on_done: Any | None = None,
    ) -> None:
        """Forward the user's answer to an agent waiting for input.

        The agent's session context is preserved (via ``--resume``), so it
        remembers its task.  We prepend the user's answer and ask it to
        continue.
        """
        with self._lock:
            agent = self.agents.get(agent_id)
        if agent is None or agent.status != "needs_input":
            return
        question = agent.pending_question or "your question"
        agent.pending_question = None
        message = (
            f"The user answered your question.\n"
            f"Question: {question}\n"
            f"Answer: {user_response}\n\n"
            f"Continue your task using this information."
        )
        self.send_to_agent(agent, message, on_event=on_event, on_done=on_done)

    def resolve_agent_ref(self, ref: str) -> AgentInstance | None:
        """Find an agent by name or number (e.g. "2" → sub-2, "researcher" → name match)."""
        with self._lock:
            # Try number first.
            if ref.isdigit():
                num = int(ref)
                for a in self.agents.values():
                    if a.number == num:
                        return a
            # Try by name.
            ref_lower = ref.lower()
            for a in self.agents.values():
                if a.name.lower() == ref_lower:
                    return a
            # Try by id suffix.
            for a in self.agents.values():
                if a.id.endswith(ref):
                    return a
        return None

    def send_to_agent(
        self,
        agent: AgentInstance,
        message: str,
        *,
        on_event: Any | None = None,
        on_done: Any | None = None,
    ) -> None:
        """Send a follow-up message to an existing agent.

        If the agent is working, queues the message. If done, restarts it.
        """
        if agent.status == "working":
            agent.task_queue.append(message)
            return

        # Agent is idle — restart it with the new task.
        agent.task = message
        agent.status = "working"
        agent.events.clear()

        def _worker() -> None:
            self._run_agent_task(agent, on_event=on_event, on_done=on_done)

        thread = threading.Thread(target=_worker, daemon=True, name=agent.id)
        agent.thread = thread
        thread.start()

    def kill(self, agent_id: str) -> None:
        with self._lock:
            agent = self.agents.get(agent_id)
        if agent is not None:
            agent.session.cancel()

    def kill_all(self) -> None:
        with self._lock:
            ids = list(self.agents.keys())
        for aid in ids:
            self.kill(aid)

    def remove(self, agent_id: str) -> None:
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

    def _sub_system_prompt(self) -> str:
        return SUB_AGENT_SYSTEM_PROMPT


# ─── Smart message routing ───────────────────────────────────────────────

def classify_message_target(
    transcript: str,
    last_speaker_name: str,
    last_speaker_task: str,
) -> str:
    """Decide if the user is replying to a sub-agent or talking to main.

    Uses a fast Haiku call. Returns ``"agent"`` or ``"main"``.
    """
    import json

    prompt = (
        f'Sub-agent "{last_speaker_name}" just finished and reported on its '
        f'task: "{last_speaker_task}"\n'
        f'The user then said: "{transcript}"\n\n'
        f"Is the user directing this at the sub-agent (giving it follow-up "
        f"work, responding to its report, or continuing the conversation with "
        f"it), or is the user talking to the main assistant about something "
        f"unrelated?\n"
        f"Reply with exactly one word: AGENT or MAIN"
    )

    result = subprocess.run(
        ["claude", "-p", "--output-format", "json", "--model", "haiku"],
        input=prompt,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return "main"

    try:
        envelope = json.loads(result.stdout)
        answer = (envelope.get("result") or "").strip().upper()
    except (json.JSONDecodeError, AttributeError):
        return "main"

    return "agent" if "AGENT" in answer else "main"

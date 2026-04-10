"""Persist and restore session state across runs.

Saves the main Claude session ID and sub-agent metadata to a JSON file
so that ``claude-zoom chat`` can resume where it left off.

State file location: ``<cwd>/.claude_zoom_agents/state.json``
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass, field
from typing import Any

log = logging.getLogger("claude_zoom")

_STATE_DIR = ".claude_zoom_agents"
_STATE_FILE = "state.json"


@dataclass
class AgentState:
    """Serializable snapshot of one sub-agent."""

    id: str
    name: str
    session_id: str | None
    worktree_path: str | None
    base_cwd: str
    task: str
    status: str
    number: int
    branch: str | None = None


@dataclass
class AppState:
    """Serializable snapshot of the full app."""

    main_session_id: str | None = None
    main_model: str = "opus"
    main_cwd: str | None = None
    agents: list[AgentState] = field(default_factory=list)
    agent_counter: int = 0


def _state_path(cwd: str) -> str:
    return os.path.join(cwd, _STATE_DIR, _STATE_FILE)


def save_state(state: AppState, cwd: str) -> None:
    """Write state to disk."""
    path = _state_path(cwd)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = {
        "main_session_id": state.main_session_id,
        "main_model": state.main_model,
        "main_cwd": state.main_cwd,
        "agent_counter": state.agent_counter,
        "agents": [asdict(a) for a in state.agents],
    }
    try:
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
        log.debug("state saved to %s", path)
    except OSError as e:
        log.warning("failed to save state: %s", e)


def load_state(cwd: str) -> AppState | None:
    """Load state from disk, or None if no state file exists."""
    path = _state_path(cwd)
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            data = json.load(f)
        agents = [AgentState(**a) for a in data.get("agents", [])]
        state = AppState(
            main_session_id=data.get("main_session_id"),
            main_model=data.get("main_model", "opus"),
            main_cwd=data.get("main_cwd"),
            agents=agents,
            agent_counter=data.get("agent_counter", 0),
        )
        log.debug("state loaded from %s", path)
        return state
    except (OSError, json.JSONDecodeError, TypeError) as e:
        log.warning("failed to load state: %s", e)
        return None


def clear_state(cwd: str) -> None:
    """Remove the state file."""
    path = _state_path(cwd)
    try:
        os.unlink(path)
    except OSError:
        pass

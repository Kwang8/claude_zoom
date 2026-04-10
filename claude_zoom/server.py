"""WebSocket server for the Electron frontend.

Contains the ``ChatEngine`` class with all chat orchestration logic,
exposed over a WebSocket so the Electron renderer can drive the UI.

Usage::

    claude-zoom serve [--port 8765] [--cwd .]

The protocol is JSON messages over WebSocket. See the plan file for the
full message spec.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from .agents import (
    AgentInstance,
    AgentManager,
    SpeechQueue,
    classify_message_target,
    parse_agent_target,
    parse_spawn_markers,
    parse_voice_trigger,
)
from .chat import ClaudeSession, summarize_tool_args
from .coordinator import CoordinatorAgent
from .narrator import summarize_turn

log = logging.getLogger("claude_zoom.server")

# ─── Helpers ─────────────────────────────────────────────────────────────


def _build_prompt_with_images(prompt: str, images: list[str]) -> str:
    if not images:
        return prompt
    paths = "\n".join(f"  - {p}" for p in images)
    return (
        f"{prompt}\n\n"
        f"[The user has attached the following image files as context. "
        f"Use the Read tool to view them as needed.]\n{paths}"
    )


def _strip_spawn_markers(text: str) -> str:
    return re.sub(
        r"<SPAWN\s+name=[\"'][^\"']+[\"']\s*>.*?</SPAWN>",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    ).strip()


# Agent naming
_KEYWORD_CATEGORIES = [
    ({"search", "find", "look", "grep", "locate"}, "search"),
    ({"test", "spec", "check", "verify", "validate"}, "test"),
    ({"fix", "bug", "debug", "repair", "patch"}, "fix"),
    ({"code", "write", "implement", "build", "create", "add"}, "code"),
    ({"review", "read", "analyze", "inspect", "audit"}, "review"),
    ({"refactor", "clean", "simplify", "reorganize"}, "refactor"),
    ({"deploy", "release", "ship", "publish"}, "deploy"),
    ({"doc", "document", "readme", "comment"}, "docs"),
]
_CATEGORY_NAMES = {
    "search": ["hermes", "argus", "scout"],
    "test": ["athena", "oracle", "sentinel"],
    "fix": ["asclepius", "phoenix", "medic"],
    "code": ["hephaestus", "daedalus", "forge"],
    "review": ["minerva", "sage", "critic"],
    "refactor": ["theseus", "sculptor", "prism"],
    "deploy": ["apollo", "herald", "mercury"],
    "docs": ["calliope", "scribe", "muse"],
}
_DEFAULT_NAMES = [
    "aether", "zephyr", "nova", "spark", "echo",
    "atlas", "clio", "iris", "selene", "orion",
]


def _extract_agent_name(task: str) -> str:
    import random

    words = set(task.lower().split())
    for keywords, category in _KEYWORD_CATEGORIES:
        if any(kw in words for kw in keywords):
            return random.choice(_CATEGORY_NAMES[category])
    return random.choice(_DEFAULT_NAMES)


# ─── ChatEngine: transport-agnostic orchestration ────────────────────────


class ChatEngine:
    """Core chat loop, emitting events via callbacks.

    The engine runs its main loop in a background thread. The caller wires
    up ``on_emit`` to forward events over WebSocket (or any other transport).
    """

    def __init__(
        self,
        session: ClaudeSession,
        *,
        on_emit: Callable[[dict[str, Any]], None],
        resume: bool = True,
    ) -> None:
        self.session = session
        self._emit = on_emit
        self._resume = resume

        self._speech_queue = SpeechQueue()
        self._agent_manager = AgentManager(self._speech_queue)
        self._coordinator = CoordinatorAgent(session.cwd or ".")

        # Threading events
        self._stop_flag = threading.Event()
        self._mic_event = threading.Event()
        self._cancel_recording = threading.Event()
        self._main_idle = threading.Event()

        # Transcript log (persisted across restarts)
        self._transcript_log: list[dict[str, Any]] = []

        # Routing state
        self._awaiting_pr_agent_id: str | None = None
        self._awaiting_question_agent_id: str | None = None
        self._last_sub_speaker_id: str | None = None
        self._image_context: list[str] = []

        # Main loop thread
        self._loop_thread: threading.Thread | None = None
        # Speech consumer thread
        self._speech_thread: threading.Thread | None = None

    # ── Emit helpers ─────────────────────────────────────────────────────

    def _send(self, msg_type: str, **kwargs: Any) -> None:
        self._emit({"type": msg_type, **kwargs})

    def _send_state(self, state: str, narration: str = "") -> None:
        self._send("state_change", state=state, narration=narration)

    def _send_transcript(
        self, role: str, text: str, agent_name: str = ""
    ) -> None:
        msg = {
            "type": "transcript_message",
            "role": role,
            "text": text,
            "agent_name": agent_name,
            "timestamp": datetime.now().strftime("%H:%M"),
        }
        self._transcript_log.append(msg)
        self._emit(msg)

    def _send_ticker(self, activity: str) -> None:
        self._send("ticker_update", activity=activity)

    def _send_progress(self, text: str) -> None:
        self._send("progress", text=text)

    def _send_action(self, text: str) -> None:
        self._send("action", text=text)

    # ── Public API (called from WS handler) ──────────────────────────────

    def start(self) -> None:
        """Start the chat engine in background threads."""
        self._speech_thread = threading.Thread(
            target=self._speech_consumer, daemon=True, name="speech-consumer"
        )
        self._speech_thread.start()

        self._loop_thread = threading.Thread(
            target=self._run_chat_loop, daemon=True, name="chat-loop"
        )
        self._loop_thread.start()

    def stop(self) -> None:
        """Gracefully stop the engine."""
        self._save_state()
        self._stop_flag.set()
        self._mic_event.set()
        self.session.cancel()
        self._agent_manager.kill_all()

    def mic_start(self) -> None:
        """User pressed space — start recording."""
        self._mic_event.set()

    def mic_stop(self) -> None:
        """User released space — same as mic_start for toggle mode."""
        self._mic_event.set()

    def cancel_turn(self) -> None:
        """User pressed escape."""
        self.session.cancel()
        self._cancel_recording.set()
        self._mic_event.set()
        self._send_action("cancel sent")

    def send_text(self, text: str) -> None:
        """User typed text directly (future keyboard mode)."""
        self._pending_text = text
        self._mic_event.set()

    def pr_decision(self, agent_id: str, approved: bool) -> None:
        """Handle PR yes/no."""
        pr_url = self._agent_manager.handle_pr_decision(agent_id, approved)
        if approved and pr_url:
            ack = f"PR created: {pr_url}"
        elif approved:
            ack = "Failed to create PR. Branch is still pushed."
        else:
            ack = "OK, branch is pushed if you want it later."
        self._send_transcript("claude", ack)
        self._speak(ack)
        self._awaiting_pr_agent_id = None

    def agent_answer(self, agent_id: str, text: str) -> None:
        """Forward user answer to agent question."""
        agent = self._agent_manager.agents.get(agent_id)
        if agent and agent.status == "needs_input":
            self._agent_manager.handle_agent_question(
                agent_id, text,
                on_event=self._on_sub_event,
                on_done=self._on_sub_done,
            )
            self._send(
                "agent_status", agent_id=agent_id,
                status="working", name=agent.name
            )
            ack = f"Got it, forwarding your answer to agent {agent.name}."
            self._send_transcript("claude", ack)
            self._speak(ack)
        self._awaiting_question_agent_id = None

    def kill_agent(self, agent_id: str) -> None:
        """Kill a sub-agent."""
        self._agent_manager.kill(agent_id)
        self._send("agent_removed", agent_id=agent_id)

    def attach_image(self, path: str) -> None:
        """Add image to context."""
        self._image_context.append(path)
        self._send_transcript("system", f"image attached: {path}")

    def clear_images(self) -> None:
        """Clear image context."""
        n = len(self._image_context)
        self._image_context.clear()
        if n:
            self._send_transcript("system", f"cleared {n} image(s)")

    # ── Main chat loop ───────────────────────────────────────────────────

    def _run_chat_loop(self) -> None:
        try:
            self._run_chat_loop_inner()
        except Exception as e:  # noqa: BLE001
            log.error("chat loop crashed: %s", e, exc_info=True)
            self._send("action", text=f"chat loop error: {e}")
            import traceback
            traceback.print_exc()

    def _run_chat_loop_inner(self) -> None:
        from .voice import Recorder, play_sound

        # Try restore.
        intro: str | None = None
        if self._resume:
            intro = self._restore_state()
        if not intro:
            intro = (
                "Hey! Press space to talk. "
                "You can spin off sub-agents and talk to them by name or number."
            )
        self._send_transcript("claude", intro)
        self._send_progress("ready")
        self._speak(intro)
        self._mic_event.clear()

        turn = 0
        while not self._stop_flag.is_set():
            # ── IDLE ──
            self._send_ticker("")
            self._send_state("idle")
            self._send_progress(f"turn {turn}" if turn else "ready")
            self._send_action("press SPACE to talk")
            self._main_idle.set()
            if not self._wait_for_input():
                break
            self._main_idle.clear()

            # ── LISTEN ──
            turn += 1
            self._cancel_recording.clear()
            self._send_state("listening")
            self._send_progress(f"turn {turn}")
            self._send_action("recording — press SPACE to send")
            play_sound("ready")
            recorder = Recorder()

            try:
                recorder.start()
            except Exception as e:  # noqa: BLE001
                self._send_action(f"mic error: {str(e)[:60]}")
                self._send_state("idle")
                continue

            if not self._wait_for_input():
                recorder.close()
                break

            if self._cancel_recording.is_set():
                self._cancel_recording.clear()
                recorder.close()
                self._send_state("idle")
                self._send_action("cancelled")
                continue

            # ── TRANSCRIBE ──
            self._send_state("thinking")
            self._send_action("transcribing...")

            _result: list[str | None] = [None]
            _error: list[Exception | None] = [None]
            _cancelled = False

            def _do_transcribe() -> None:
                try:
                    _result[0] = recorder.stop_and_transcribe()
                except Exception as e:  # noqa: BLE001
                    _error[0] = e

            t = threading.Thread(target=_do_transcribe, daemon=True)
            t.start()
            while t.is_alive():
                if self._cancel_recording.is_set():
                    self._cancel_recording.clear()
                    _cancelled = True
                    recorder.close()
                    self._send_state("idle")
                    self._send_action("cancelled")
                    break
                if self._stop_flag.is_set():
                    recorder.close()
                    break
                t.join(timeout=0.1)

            if _cancelled or self._stop_flag.is_set():
                self._mic_event.clear()
                continue
            if not t.is_alive():
                t.join()
            if _error[0] is not None:
                self._send_action(f"transcribe error: {str(_error[0])[:60]}")
                self._send_state("idle")
                continue
            transcript = _result[0]

            if not transcript:
                self._send_action("(no input)")
                self._send_state("idle")
                continue

            if turn == 0:
                turn += 1
            self._send_transcript("user", transcript)
            self._send_action(f"heard: {transcript[:60]}")

            # Consume last-sub-speaker.
            last_sub_id = self._last_sub_speaker_id
            self._last_sub_speaker_id = None

            # ── PR DECISION ROUTING ──
            if self._awaiting_pr_agent_id:
                agent_id = self._awaiting_pr_agent_id
                self._awaiting_pr_agent_id = None
                lower = transcript.lower()
                approved = any(
                    w in lower
                    for w in ("yes", "yeah", "yep", "sure", "do it", "open")
                )
                self.pr_decision(agent_id, approved)
                continue

            # ── AGENT QUESTION ROUTING ──
            if self._awaiting_question_agent_id:
                agent_id = self._awaiting_question_agent_id
                self.agent_answer(agent_id, transcript)
                continue

            # ── VOICE TRIGGER ──
            trigger_task = parse_voice_trigger(transcript)
            if trigger_task:
                name = _extract_agent_name(trigger_task)
                try:
                    self._spawn_sub(name, trigger_task)
                    ack = f"On it! Kicked off agent {name}."
                    self._send_transcript("claude", ack)
                    self._send_state("talking", ack)
                    self._speak(ack)
                except Exception as e:  # noqa: BLE001
                    self._send_transcript("claude_error", f"spawn failed: {e}")
                continue

            # ── AGENT TARGETING ──
            target = parse_agent_target(transcript)
            if target:
                ref, msg = target
                agent = self._agent_manager.resolve_agent_ref(ref)
                if agent:
                    self._route_to_agent(agent, msg)
                    continue

            # ── COORDINATOR ──
            coordinator_context = ""
            if self._agent_manager.all_agents:
                self._send_action("consulting coordinator...")
                suggestion = self._coordinator.advise(
                    transcript, self._agent_manager.all_agents
                )
                coordinator_context = suggestion.advice
                if suggestion.agent_id:
                    coord_agent = self._agent_manager.agents.get(
                        suggestion.agent_id
                    )
                    if coord_agent:
                        self._route_to_agent(coord_agent, transcript, "(coordinator)")
                        continue

            # ── SMART ROUTING ──
            if last_sub_id:
                agent = self._agent_manager.agents.get(last_sub_id)
                if agent and agent.status != "error":
                    self._send_action("routing...")
                    route = classify_message_target(
                        transcript, agent.name, agent.task
                    )
                    if route == "agent":
                        self._route_to_agent(agent, transcript)
                        continue

            # ── MAIN AGENT ──
            _prompt = transcript
            if coordinator_context:
                _prompt = f"[Coordinator context: {coordinator_context}]\n{transcript}"
            self._send_state("working")
            self._send_action("claude is working...")
            events: list[dict] = []
            early_text = ""
            has_tool_calls = False
            early_speech_thread: threading.Thread | None = None

            try:
                prompt = _build_prompt_with_images(_prompt, self._image_context)
                for event in self.session.send(prompt):
                    events.append(event)
                    if event.get("type") == "assistant":
                        content = (
                            (event.get("message") or {}).get("content") or []
                        )
                        for item in content:
                            if item.get("type") == "tool_use":
                                has_tool_calls = True
                                tname = item.get("name", "?")
                                short = summarize_tool_args(
                                    tname, item.get("input") or {}
                                )
                                self._send_ticker(f"{tname}({short})")
                            elif item.get("type") == "text":
                                text = item.get("text") or ""
                                for sname, stask in parse_spawn_markers(text):
                                    try:
                                        self._spawn_sub(sname, stask)
                                    except Exception:  # noqa: BLE001
                                        pass
                                cleaned = _strip_spawn_markers(text).strip()
                                if not early_text and cleaned:
                                    early_text = cleaned
                                    self._send_transcript("claude", early_text)
                                    self._send_state("talking", early_text)
                                    early_speech_thread = threading.Thread(
                                        target=self._speak,
                                        args=(early_text,),
                                        daemon=True,
                                    )
                                    early_speech_thread.start()
            except Exception as e:  # noqa: BLE001
                self._send_transcript("claude_error", str(e))
                self._send_state("idle")
                self._send_action(f"error: {str(e)[:60]}")
                self._send_ticker("")
                continue

            if self._stop_flag.is_set():
                break

            if early_speech_thread is not None:
                early_speech_thread.join(timeout=30)

            # ── SUMMARIZE + SPEAK ──
            self._send_ticker("")
            if has_tool_calls:
                self._send_state("thinking")
                self._send_action("summarizing results...")
                try:
                    summary = summarize_turn(transcript, events)
                except Exception as e:  # noqa: BLE001
                    summary = f"Hit an error while summarizing: {e}"
                if summary:
                    self._send_transcript("claude", summary)
                    self._send_state("talking", summary)
                    self._send_action("speaking (press SPACE to interrupt)")
                    self._speak(summary)
            elif not early_text:
                self._send_transcript("claude", "Done.")
                self._send_state("talking", "Done.")
                self._speak("Done.")

        self._send_action("bye")

    # ── Routing helper ───────────────────────────────────────────────────

    def _route_to_agent(
        self, agent: AgentInstance, msg: str, suffix: str = ""
    ) -> None:
        if agent.status == "working":
            agent.task_queue.append(msg)
            ack = f"Queued that for agent {agent.name}."
        else:
            self._agent_manager.send_to_agent(
                agent, msg,
                on_event=self._on_sub_event,
                on_done=self._on_sub_done,
            )
            self._send(
                "agent_status", agent_id=agent.id,
                status="working", name=agent.name
            )
            ack = f"Sent to agent {agent.name}."
        if suffix:
            ack = f"{ack} {suffix}"
        self._send_transcript("claude", ack)
        self._speak(ack)

    # ── Voice helpers ────────────────────────────────────────────────────

    def _speak(self, text: str) -> None:
        from .voice import speak_async

        self._send("tts_start", text=text, speaker="claude")
        proc = speak_async(text)
        if proc is None:
            self._send("tts_end")
            return
        try:
            while proc.poll() is None:
                if self._stop_flag.is_set() or self._mic_event.is_set():
                    proc.terminate()
                    break
                time.sleep(0.05)
        finally:
            try:
                proc.wait(timeout=1.0)
            except Exception:  # noqa: BLE001
                pass
            self._send("tts_end")

    def _speech_consumer(self) -> None:
        from .voice import play_sound, speak_async

        while not self._stop_flag.is_set():
            item = self._speech_queue.get(timeout=0.2)
            if item is None:
                continue

            while not self._main_idle.is_set() and not self._stop_flag.is_set():
                time.sleep(0.1)
            if self._stop_flag.is_set():
                break

            play_sound("done")
            self._send_transcript("sub_agent", item.text, agent_name=item.label)
            self._send_state("talking", item.text)
            self._send_action(f"speaking: {item.label}")

            self._send("tts_start", text=item.text, speaker=item.label)
            spoken_text = f"{item.label} says: {item.text}"
            proc = speak_async(spoken_text)
            if proc is not None:
                try:
                    while proc.poll() is None:
                        if self._stop_flag.is_set() or self._mic_event.is_set():
                            proc.terminate()
                            self._speech_queue.drain()
                            break
                        time.sleep(0.05)
                finally:
                    try:
                        proc.wait(timeout=1.0)
                    except Exception:  # noqa: BLE001
                        pass
            self._send("tts_end")

            if item.agent_id:
                self._last_sub_speaker_id = item.agent_id

            if item.requires_response and item.agent_id:
                if getattr(item, "question_type", None) == "agent_question":
                    self._awaiting_question_agent_id = item.agent_id
                    self._send(
                        "agent_status", agent_id=item.agent_id,
                        status="needs_input", name=item.label,
                    )
                else:
                    self._awaiting_pr_agent_id = item.agent_id

            self._send_state("idle")
            self._send_action("press SPACE to talk")

    def _wait_for_input(self) -> bool:
        while not self._stop_flag.is_set():
            if self._mic_event.is_set():
                self._mic_event.clear()
                return True
            time.sleep(0.05)
        return False

    # ── Sub-agent helpers ────────────────────────────────────────────────

    def _spawn_sub(self, name: str, task: str) -> None:
        base_cwd = self.session.cwd or "."
        agent = self._agent_manager.spawn(
            task=_build_prompt_with_images(task, self._image_context),
            name=name,
            base_cwd=base_cwd,
            model="sonnet",
            permission_mode=self.session.permission_mode,
            on_event=self._on_sub_event,
            on_done=self._on_sub_done,
        )
        self._send(
            "agent_spawned",
            agent_id=agent.id,
            name=agent.name,
            number=agent.number,
            task=task,
        )
        self._send_transcript("system", f'spawned agent "{name}"')
        self._coordinator.notify_spawn(agent.id, agent.name, task)

    def _on_sub_event(self, agent_id: str, event: dict) -> None:
        if event.get("type") != "assistant":
            return
        content = (event.get("message") or {}).get("content") or []
        for item in content:
            if item.get("type") == "tool_use":
                tname = item.get("name", "?")
                short = summarize_tool_args(tname, item.get("input") or {})
                self._send(
                    "agent_status", agent_id=agent_id,
                    status="working", ticker=f"{tname}({short})",
                )

    def _on_sub_done(self, agent_id: str) -> None:
        agent = self._agent_manager.agents.get(agent_id)
        if agent:
            self._coordinator.notify_done(
                agent_id, agent.name, agent.task, agent.status
            )
            self._send(
                "agent_status", agent_id=agent_id,
                status=agent.status, name=agent.name,
            )

    # ── State persistence ────────────────────────────────────────────────

    def _save_state(self) -> None:
        from .state import AgentState, AppState, save_state

        cwd = self.session.cwd or "."
        agent_states = []
        for a in self._agent_manager.all_agents:
            agent_states.append(AgentState(
                id=a.id,
                name=a.name,
                session_id=a.session.session_id,
                worktree_path=a.worktree_path,
                base_cwd=a.base_cwd,
                task=a.task,
                status=a.status if a.status != "working" else "done",
                number=a.number,
                branch=a.branch,
            ))
        state = AppState(
            main_session_id=self.session.session_id,
            main_model=self.session.model,
            main_cwd=cwd,
            agents=agent_states,
            agent_counter=self._agent_manager._counter,
            messages=self._transcript_log[-200:],
        )
        save_state(state, cwd)

    def _restore_state(self) -> str | None:
        from .state import load_state

        cwd = self.session.cwd or "."
        state = load_state(cwd)
        if state is None or state.main_session_id is None:
            return None

        self.session.session_id = state.main_session_id
        self._agent_manager._counter = state.agent_counter

        # Replay persisted transcript messages to the client.
        if state.messages:
            self._transcript_log = list(state.messages)
            for msg in state.messages:
                self._emit(msg)

        for a in state.agents:
            session = ClaudeSession(
                cwd=a.worktree_path or a.base_cwd,
                model="sonnet",
                permission_mode=self.session.permission_mode,
                append_system_prompt=self._agent_manager._sub_system_prompt(),
            )
            session.session_id = a.session_id
            agent = AgentInstance(
                id=a.id,
                name=a.name,
                session=session,
                worktree_path=a.worktree_path,
                base_cwd=a.base_cwd,
                task=a.task,
                status=a.status,
                number=a.number,
                branch=a.branch,
            )
            self._agent_manager.agents[a.id] = agent
            self._send(
                "agent_spawned",
                agent_id=a.id,
                name=a.name,
                number=a.number,
                task=a.task,
                status=a.status,
            )
            # Restore routing state for agents awaiting a response.
            if a.status == "needs_input" and self._awaiting_question_agent_id is None:
                self._awaiting_question_agent_id = a.id
            elif a.status == "pr_pending" and self._awaiting_pr_agent_id is None:
                self._awaiting_pr_agent_id = a.id

        n = len(state.agents)
        names = ", ".join(a.name for a in state.agents)
        if n:
            return (
                f"Welcome back! Resumed previous session with {n} "
                f"agent{'s' if n != 1 else ''}: {names}. Press space to talk."
            )
        return "Welcome back! Resumed previous session. Press space to talk."


# ─── WebSocket server ────────────────────────────────────────────────────


async def _handle_client(
    websocket: Any,
    engine: ChatEngine,
) -> None:
    """Handle one WebSocket client connection."""
    log.info("client connected")

    # Wire engine events to WebSocket sends.
    loop = asyncio.get_event_loop()

    def _on_emit(msg: dict) -> None:
        try:
            asyncio.run_coroutine_threadsafe(
                websocket.send(json.dumps(msg)), loop
            )
        except Exception:  # noqa: BLE001
            pass

    engine._emit = _on_emit
    engine.start()

    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")

            if msg_type == "mic_start":
                engine.mic_start()
            elif msg_type == "mic_stop":
                engine.mic_stop()
            elif msg_type == "cancel_turn":
                engine.cancel_turn()
            elif msg_type == "send_text":
                engine.send_text(msg.get("text", ""))
            elif msg_type == "pr_decision":
                engine.pr_decision(
                    msg.get("agent_id", ""), msg.get("approved", False)
                )
            elif msg_type == "agent_answer":
                engine.agent_answer(
                    msg.get("agent_id", ""), msg.get("text", "")
                )
            elif msg_type == "kill_agent":
                engine.kill_agent(msg.get("agent_id", ""))
            elif msg_type == "attach_image":
                engine.attach_image(msg.get("path", ""))
            elif msg_type == "clear_images":
                engine.clear_images()
            elif msg_type == "quit":
                engine.stop()
                break
    except Exception as e:  # noqa: BLE001
        log.warning("client disconnected: %s", e)
    finally:
        engine.stop()
        log.info("client disconnected")


async def run_server(
    session: ClaudeSession,
    *,
    host: str = "localhost",
    port: int = 8765,
    resume: bool = True,
) -> None:
    """Start the WebSocket server."""
    try:
        import websockets  # type: ignore[import-not-found]
    except ImportError as e:
        raise RuntimeError(
            "websockets not installed. Run: pip install websockets"
        ) from e

    engine = ChatEngine(session, on_emit=lambda msg: None, resume=resume)

    async def handler(websocket: Any) -> None:
        await _handle_client(websocket, engine)

    log.info("starting WebSocket server on %s:%d", host, port)
    async with websockets.serve(handler, host, port, origins=None):
        print(f"claude-zoom server running on ws://{host}:{port}")
        await asyncio.Future()  # run forever

# claude_zoom

A voice-first interface to Claude Code with multi-agent support. Talk to Claude, spawn sub-agents that work in parallel, and see everything in a live UI.

Two interfaces:

- **Electron desktop app** — modern dark UI with animated avatar, agent sidebar, and transcript view
- **Terminal TUI** — lightweight Textual-based fallback

All local on macOS: Parakeet (speech-to-text), macOS `say` (text-to-speech, auto-detects premium voices), and `claude -p` (subprocess, reuses your Claude Code subscription — no API key).

## Quickstart

Requirements: **Apple Silicon Mac**, Python 3.11+, and the `claude` and `gh` CLIs already logged in.

```bash
git clone https://github.com/Kwang8/claude_zoom.git
cd claude_zoom
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e '.[voice]'
```

Or just run `./run.sh` — it creates the venv and installs deps automatically.

**No API key required** — `claude_zoom` shells out to `claude -p` in headless mode, which reuses your existing Claude Code subscription auth.

Grant your terminal microphone permission in System Settings > Privacy & Security > Microphone.

## Usage

### Electron Desktop App

```bash
# Terminal 1: Start the Python backend
source .venv/bin/activate
claude-zoom serve --cwd ~/some/repo

# Terminal 2: Launch the Electron app
cd electron
npm install   # first time only
CLAUDE_ZOOM_CWD=~/some/repo npm run dev
```

You can also launch Electron directly with a target repo:

```bash
cd electron
electron . --cwd ~/some/repo
```

The desktop app connects to the Python WebSocket server and gives you:

- Animated avatar orb that reacts to state (idle, listening, thinking, working, talking)
- Scrollable transcript with color-coded messages
- Agent sidebar showing sub-agent status and live tool calls
- Push-to-talk via spacebar, cancel via escape
- Session persistence — quit and resume where you left off

### Terminal TUI

```bash
claude-zoom chat
```

Same features in the terminal via Textual. Push-to-talk with spacebar.

### Chat Mode Features

1. Press **space** to start recording, **space** again to send.
2. Claude processes your request — you see tool calls in the ticker as they happen.
3. A spoken summary plays when done. Press **space** to interrupt and talk again.

**Multi-agent support:**

- Say "spin off an agent to..." or "in the background, ..." to spawn a sub-agent
- Sub-agents work in isolated git worktrees and report back via voice
- Say "agent selene, ..." to talk to a specific agent, or just reply naturally — smart routing detects who you're talking to
- Agents that make changes can auto-commit, push, and open PRs

**Key bindings:**

| Key | Action |
| --- | --- |
| `space` | Push-to-talk (toggle) |
| `esc` | Cancel current turn |
| `q` | Quit |

**Flags:**

```bash
claude-zoom chat --cwd ~/some/repo               # start in a specific dir
claude-zoom chat --model sonnet                   # swap the model (default: opus)
claude-zoom chat --permission-mode bypassPermissions  # full-trust mode
claude-zoom chat --fresh                          # ignore saved session, start new
claude-zoom chat --log-file debug.log             # write debug logs to file
```

### WebSocket Server

```bash
claude-zoom serve --port 8765 --host localhost
claude-zoom serve --cwd ~/some/repo
claude-zoom serve --fresh          # start new session
claude-zoom serve --log-file s.log # debug logging
```

Starts a WebSocket server that the Electron app (or any client) connects to. The server manages all voice I/O, Claude sessions, agent orchestration, and state persistence.

### Walkthrough Mode

```bash
claude-zoom generate 42                                 # PR number
claude-zoom generate 885fbd6                            # commit SHA
claude-zoom present 42                                  # interactive TUI walkthrough
```

Generates narrated code walkthroughs of PRs and commits with voice Q&A.

## Architecture

```
Electron (React/TS)  <-- WebSocket -->  Python server (server.py)
                                            |
                                            +-- ClaudeSession (claude -p subprocess)
                                            +-- AgentManager (sub-agents in worktrees)
                                            +-- Recorder (mic + Parakeet STT)
                                            +-- CoordinatorAgent (smart routing)
                                            +-- voice.py (TTS via macOS say)
```

- **Python backend** handles all voice I/O, Claude subprocess management, agent orchestration, and routing logic
- **Electron frontend** is a pure presentation layer connected via WebSocket
- **Terminal TUI** runs everything in-process via Textual

### Model routing

| Stage | Model | Why |
| --- | --- | --- |
| Main chat agent | Opus | Full reasoning for complex tasks |
| Sub-agents | Sonnet | Fast parallel workers |
| Turn summarization | Haiku (fast path: use Claude's own text) | Minimize latency |
| Coordinator (routing) | Opus | Accurate agent-routing decisions |
| Smart routing classifier | Haiku | Fast binary classification |

All models reuse your Claude Code subscription — no API key needed.

## Tweaking the voice

By default `claude_zoom` auto-picks the best installed voice:

1. Siri Voices (if downloaded)
2. Premium voices (e.g. `Ava (Premium)`)
3. Enhanced voices
4. `Samantha` (always installed)

**For a dramatic quality jump**, download a premium voice:

> System Settings > Accessibility > Spoken Content > System Voice > Manage Voices > download a Siri Voice or any voice marked (Premium).

Override with environment variables:

```bash
export CLAUDE_ZOOM_SAY_VOICE="Ava (Premium)"
export CLAUDE_ZOOM_SAY_RATE=200              # words per minute (default 190)
```

## Known limits

- Apple Silicon only (MLX requirement for Parakeet STT)
- macOS only (uses `say` for TTS, system sounds for notifications)
- Silence detection is a simple RMS threshold — noisy mics may cause spurious transcriptions
- Audio capped at 30 seconds per recording to prevent transcription hangs

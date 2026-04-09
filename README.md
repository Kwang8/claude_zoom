# claude_zoom

A voice interface to Claude Code, with a little animated ASCII character and a live activity log. Two modes:

- **`claude-zoom chat`** — voice-chat with a live Claude Code instance. Ask anything; Claude reads files, edits, runs bash, etc.; you hear a short spoken summary of each turn.
- **`claude-zoom present <ref>`** — voice walkthrough of a specific PR or commit. Claude picks the important hunks and narrates each one, with voice Q&A between snippets.

All local on macOS: Parakeet (speech-to-text), macOS `say` (text-to-speech, auto-detects premium voices), and `claude -p` (subprocess, reuses your Claude Code subscription — no API key).

![demo](docs/demo.png)
<!-- no screenshot checked in yet — run `claude-zoom present <ref>` to see it -->

## Quickstart

Requirements: **Apple Silicon Mac**, Python 3.11+, and the `claude` and `gh` CLIs already logged in.

```bash
git clone https://github.com/Kwang8/claude_zoom.git
cd claude_zoom
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[voice]'
```

**No API key required** — `claude_zoom` shells out to `claude -p` in headless mode, which reuses your existing Claude Code subscription auth.

Grant your terminal microphone permission in System Settings → Privacy & Security → Microphone (macOS will prompt the first time `sounddevice` tries to record).

## Usage

### Phase 1: generate a walkthrough (no voice)

```bash
cd /path/to/your/repo
claude-zoom generate 42                                 # PR number
claude-zoom generate 885fbd6                            # commit SHA
claude-zoom generate https://github.com/o/r/pull/42     # URL (works from anywhere)
```

Pretty-prints the walkthrough to your terminal with syntax highlighting. Pass `--dry-run` to print the raw JSON instead.

### Phase 2: interactive TUI with voice Q&A

```bash
cd /path/to/your/repo
claude-zoom present 42
```

The TUI:

1. Shows each snippet with syntax highlighting on the right side.
2. Speaks the narration using macOS `say`, with the character in `[talking]` state.
3. Listens on your mic for ~5 seconds (character in `[listening]` state, countdown in the status bar).
4. If it hears a question, transcribes it locally with Parakeet, asks `claude -p` for a short spoken-style answer (character in `[thinking]`), and speaks the reply.
5. Advances to the next snippet. The status bar at the bottom always shows where you are (`2/4 · Phone/email tab switcher · speaking`) so you can see it's alive during long steps.

Key bindings inside the TUI:

| Key | Action |
| --- | --- |
| `q` | Quit |
| `→` or `n` | Skip to next snippet (after current narration finishes — can't interrupt `say`) |
| `r` | Replay current narration |

Pass `--plain` to fall back to a linear printer (no TUI, no character) — useful for small terminals or when stdout is being piped. Pass `--no-listen` to narrate without the Q&A loop.

### Phase 3: chat mode — voice interface to a live Claude Code instance

```bash
cd /path/to/your/repo
claude-zoom chat
```

This opens the same TUI but with an activity log panel on the right (instead of a code snippet) and an auto-cycling turn-based voice loop:

1. Character goes to `listening`, records 6 seconds of your mic.
2. Parakeet transcribes → the transcript shows in the log as `🎤 you: …`.
3. Character goes to `working` and spawns `claude -p --output-format stream-json --verbose --resume <id>` under the hood.
4. Every tool call, tool result, and assistant message streams into the activity log as it happens (`→ Read(login.tsx)`, `← 420 lines`, `💬 "I found the issue"`, `✓ done (3.4s)`).
5. When Claude finishes, a fast-model (Haiku) layer summarizes the turn into one spoken sentence. If Claude's own final text is already crisp and short, it gets spoken verbatim (fast path, zero extra latency); otherwise Haiku rewrites it.
6. Character flips to `talking`, speaks the summary, then back to `listening` for the next turn.

Session memory is preserved across turns by capturing the session UUID from the first turn's `system.init` event and passing `--resume <uuid>` on every subsequent turn, so Claude remembers what you talked about a minute ago.

| Key | Action |
| --- | --- |
| `q` | Quit |
| `esc` | Cancel the current Claude turn (SIGTERM the subprocess) |

Flags:

```bash
claude-zoom chat --cwd ~/some/repo               # start Claude in a specific dir
claude-zoom chat --model sonnet                  # swap the slow model (default: opus)
claude-zoom chat --permission-mode bypassPermissions   # full-trust YOLO mode
```

`--permission-mode acceptEdits` (the default) lets Claude edit files without prompting but may still gate destructive bash. `--permission-mode bypassPermissions` turns that off for a frictionless voice session — **only use it in a cwd you trust**, since there's no way to respond to permission prompts mid-turn.

### Character demo (no audio, no network)

Eyeball the animated character without setting up a walkthrough:

```bash
python -m claude_zoom.tui
```

Rotates through idle / talking / listening / thinking every 3 seconds.

### Tweaking the voice

By default `claude_zoom` auto-picks the best installed voice in this order:

1. `Siri Voice 1-5` (if you've downloaded any)
2. Any voice tagged `(Premium)` (e.g. `Ava (Premium)`, `Zoe (Premium)`)
3. Any voice tagged `(Enhanced)`
4. `Ava`, `Zoe`, `Evan`
5. `Samantha` (always installed, safe fallback)
6. `Daniel` (British fallback)

It runs at 190 wpm (vs macOS default of ~175) for a snappier conversational feel.

**For a dramatic quality jump**, download a premium voice:

> System Settings → Accessibility → Spoken Content → System Voice →
> **Manage Voices** → scroll to English → download a **Siri Voice** or
> any voice marked **(Premium)**.

Once installed, `claude_zoom` picks it up automatically the next time you run `present`. You can also pin a specific voice:

```bash
export CLAUDE_ZOOM_SAY_VOICE="Ava (Premium)"
export CLAUDE_ZOOM_SAY_RATE=200              # words per minute (default 190)
```

List all installed voices with `say -v '?'`.

### Model routing

Two different Claude models are used via the local `claude -p` CLI, picked for the job:

| Stage | Model | Why |
| --- | --- | --- |
| Walkthrough extraction (one-time, up front) | Opus 4.6 | Reasoning-heavy: pick the 3-4 most important hunks from a diff, write narrations. Runs once per `present`, latency doesn't matter. |
| Q&A answers (during conversation) | Haiku 4.5 | Short, fast, conversational. Drops turn-taking latency from ~10s to ~2s. |

Both reuse your Claude Code subscription auth — no API key, no cost beyond your normal subscription usage.

## Testing instructions

Since this is mac/mic/audio heavy, most of the verification is manual. There are a few deterministic checks you can run before any audio work.

### 1. Import + CLI smoke test (fast, no audio)

```bash
source .venv/bin/activate
python -c "from claude_zoom import cli, pr, snippets, qa, voice, tui; print('ok')"
claude-zoom --help
claude-zoom generate --help
claude-zoom present --help
```

### 2. Ref parser unit-ish test

```bash
python -c "
from claude_zoom.pr import parse_ref
assert parse_ref('42') == ('pr', {'number': 42, 'repo': None})
assert parse_ref('885fbd6')[0] == 'commit'
assert parse_ref('https://github.com/o/r/pull/7')[0] == 'pr'
assert parse_ref('https://github.com/o/r/commit/deadbeef')[0] == 'commit'
print('ok')
"
```

### 3. Headless TUI end-to-end (no audio, no network)

Runs the full `PresentApp` worker loop against a fake walkthrough with `speak` and `listen_once` patched out:

```bash
python <<'PY'
import asyncio
from unittest.mock import patch
from claude_zoom.pr import ChangeContext, ChangeFile
from claude_zoom.snippets import CodeSnippet, SnippetWalkthrough
from claude_zoom.tui import PresentApp, StatusBar

change = ChangeContext(kind="commit", ref="abc1234", title="fake", body="",
                       author="t", url="https://x",
                       files=[ChangeFile("a.py", 1, 0)], diff="")
snippets = [CodeSnippet(title=f"s{i}", file_path="a.py", language="python",
                        code=f"x={i}", explanation=f"e{i}", narration=f"n{i}")
            for i in range(3)]
wt = SnippetWalkthrough(ref="abc1234", title="fake", url="https://x",
                        intro_narration="intro", snippets=snippets,
                        outro_narration="outro")

calls = []
async def main():
    with patch("claude_zoom.voice.speak", lambda t: calls.append(t)), \
         patch("claude_zoom.voice.listen_once", lambda seconds=5.0: None):
        app = PresentApp(change, wt)
        async with app.run_test() as pilot:
            await pilot.pause(1.5)
            s = app.query_one(StatusBar)
            assert s.progress == "outro"
            assert s.action == "done"
            assert calls == ["intro", "n0", "n1", "n2", "outro"]
asyncio.run(main())
print("ok")
PY
```

### 4. Character demo visually

```bash
python -m claude_zoom.tui
```

Should launch Textual, show an ASCII robot, cycle through 4 states every 3 seconds. Press `Ctrl+C` to exit.

### 5. Live end-to-end (audio, mic, network)

```bash
cd ~/some/repo
claude-zoom present <pr# or sha>
```

First run downloads Parakeet (~600 MB). You should hear the intro narration, see the first snippet, hear its narration, see the listening countdown, speak a question, see the transcript in the status bar, hear the answer, and then progress to the next snippet. Press `q` to quit at any time.

## Known limits

- Only accepts questions **between** snippets, not mid-narration (turn-based).
- No interrupt: pressing `→` or `r` during `say` waits for it to finish — `say` is an opaque blocking subprocess.
- Silence detection is a simple RMS threshold. If your mic is noisy you may get spurious transcriptions.
- TypeScript/TSX snippets render with JavaScript syntax highlighting (tree-sitter-languages doesn't bundle TS).
- Apple Silicon only (MLX requirement). Intel Macs and non-macOS systems won't work without swapping out `parakeet-mlx` and `say`.

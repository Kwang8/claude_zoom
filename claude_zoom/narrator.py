"""Fast-model layer that produces the spoken summary for each turn.

Two paths:

1. **Fast path (no extra LLM call):** pick off Claude's own final assistant
   text from the event stream. If it's short and crisp (fits in ~30 words,
   no markdown), we just speak it verbatim. The append-system-prompt on the
   slow model already nudges Claude toward this shape, so the fast path hits
   on most turns. Latency: zero extra.

2. **Slow path (Haiku summarizer):** if Claude's final text is missing,
   empty, multi-paragraph, or markdown-heavy, fall back to a Haiku call
   that rewrites the events into one spoken sentence. Latency: ~5-10s.

The second path is the "intermediate fast model interpreting slower model"
layer from the design — it just doesn't need to run every turn because we
already shaped Claude's output for voice.
"""

from __future__ import annotations

import json
import re
import subprocess
from typing import Any

from .chat import events_to_transcript

MODEL = "haiku"
MAX_TRANSCRIPT_CHARS = 8_000
MAX_FAST_PATH_WORDS = 30

# Tight system prompt — every token here adds latency. No examples.
NARRATOR_SYSTEM_PROMPT = """\
Rewrite the events below as ONE spoken sentence, under 25 words, first-person \
past tense, describing the OUTCOME. No filler, no markdown, no code.
USER ASKED: {user_message}
EVENTS:
{transcript}
"""

_MARKDOWN_RE = re.compile(r"[`*#>\[\]]|```")


def extract_final_text(events: list[dict[str, Any]]) -> str:
    """Return Claude's final spoken-style answer from the event stream.

    We look at the LAST assistant event's text blocks, joining them. Falls
    back to `result.result` if the last assistant message had no text (e.g.
    it was purely tool_use).
    """
    last_text = ""
    for event in events:
        if event.get("type") != "assistant":
            continue
        content = (event.get("message") or {}).get("content") or []
        text_parts = [
            (c.get("text") or "").strip()
            for c in content
            if c.get("type") == "text"
        ]
        text = " ".join(p for p in text_parts if p).strip()
        if text:
            last_text = text  # keep overwriting; loop ends with final one

    if last_text:
        return last_text

    for event in reversed(events):
        if event.get("type") == "result" and not event.get("is_error"):
            return (event.get("result") or "").strip()
    return ""


def _is_voice_friendly(text: str) -> bool:
    """Heuristic: is this text already short and clean enough to speak as-is?"""
    if not text:
        return False
    words = text.split()
    if len(words) > MAX_FAST_PATH_WORDS:
        return False
    if _MARKDOWN_RE.search(text):
        return False
    # Multi-paragraph usually means not a crisp one-liner.
    if text.count("\n\n") > 0:
        return False
    return True


def summarize_turn(user_message: str, events: list[dict[str, Any]]) -> str:
    """Return a spoken summary of the turn's events.

    Fast path: speak Claude's own final assistant text if it's already
    voice-friendly (short + no markdown). Slow path: call Haiku to rewrite.
    """
    final_text = extract_final_text(events)
    if _is_voice_friendly(final_text):
        return final_text

    return _haiku_summarize(user_message, events)


def _haiku_summarize(user_message: str, events: list[dict[str, Any]]) -> str:
    transcript = events_to_transcript(events)
    if not transcript.strip():
        return "Nothing happened that turn."
    if len(transcript) > MAX_TRANSCRIPT_CHARS:
        transcript = transcript[:MAX_TRANSCRIPT_CHARS] + "\n…(truncated)"

    system_prompt = NARRATOR_SYSTEM_PROMPT.format(
        user_message=user_message or "(silent)",
        transcript=transcript,
    )

    result = subprocess.run(
        [
            "claude",
            "-p",
            "--output-format",
            "json",
            "--model",
            MODEL,
            "--system-prompt",
            system_prompt,
        ],
        input="Summarize.",
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"narrator claude call failed ({result.returncode}): "
            f"{result.stderr.strip()[-400:]}"
        )
    envelope = json.loads(result.stdout)
    if envelope.get("is_error"):
        raise RuntimeError(f"narrator error: {envelope.get('result')}")
    return (envelope.get("result") or "").strip()

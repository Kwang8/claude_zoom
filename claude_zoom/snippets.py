"""Ask Claude (via the `claude` CLI) to extract code snippets from a PR.

Uses `claude -p --output-format json --json-schema ...` so it reuses the user's
existing Claude Code subscription auth — no ANTHROPIC_API_KEY required.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import asdict, dataclass

from .pr import ChangeContext

MODEL = "sonnet"  # alias resolved by the claude CLI to latest Sonnet
MAX_DIFF_CHARS = 60_000


@dataclass
class CodeSnippet:
    title: str
    file_path: str
    language: str
    code: str
    explanation: str
    narration: str


@dataclass
class SnippetWalkthrough:
    ref: str          # "PR #42" or short commit SHA
    title: str
    url: str
    intro_narration: str
    snippets: list[CodeSnippet]
    outro_narration: str

    def to_dict(self) -> dict:
        return {
            "ref": self.ref,
            "title": self.title,
            "url": self.url,
            "intro_narration": self.intro_narration,
            "snippets": [asdict(s) for s in self.snippets],
            "outro_narration": self.outro_narration,
        }


SYSTEM_PROMPT = """\
You're the engineer who just shipped this change. You're on a quick 1-on-1 call \
with a teammate, walking them through the diff. Every narration will be spoken \
aloud by a text-to-speech voice, so keep it SHORT and SPOKEN.

Pick the 3 to 4 most important code chunks from the diff. For each, extract a \
clean, self-contained snippet — 5 to 15 lines — showing the final (post-change) \
code. No +/- markers. Skip trivial stuff (renames, import reshuffles, \
whitespace). Order them in the narrative order you'd actually explain things, \
not file order.

VOICE AND LENGTH RULES (critical — these are what make or break the experience):

- Each `narration`: ONE or TWO short sentences. Under 25 words total. If it \
  can't be said out loud in ~5 seconds, it's too long.
- `intro_narration`: ONE sentence. Under 15 words.
- `outro_narration`: ONE sentence. Under 12 words.
- Talk like a person, not a document. Contractions, active voice, first person. \
  "I added" not "This code adds".
- No filler: no "basically", "so", "alright", "essentially", "you can see that", \
  "in this snippet", "here we have", "what I did was", "let me walk you through".
- No "great question" style throat-clearing.
- Don't read the code out loud — describe what it does and *why*.

GOOD narrations:
  "Added a `pendingEmailVerification` flag so we don't bounce users back to the \
  verify screen after they finish. Fixes a race I hit in testing."
  "New tab switcher on the login screen so people can pick phone or email \
  instead of jumping between routes."
  "Reviewer account skips verification — App Store review team can't get \
  a real email in time."

BAD narrations (too long, too formal, reads the code):
  "In this code snippet, we can see that I have implemented a new state \
  variable called pendingEmailVerification which is used throughout the \
  authentication context to ensure that the email verification screen is not \
  displayed multiple times when the user has already completed verification."

For each snippet also provide:
  - title: imperative headline, max 6 words
  - file_path: path from the diff
  - language: fence hint (python, typescript, tsx, go, rust, ...)
  - code: snippet, no line numbers, no diff markers
  - explanation: 1-2 sentence written prose (this is shown on screen, so can be \
    slightly more complete than the narration but still tight)

Return structured output matching the provided JSON schema exactly.
"""


# JSON schema used by `claude --json-schema` to force a well-formed response.
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "intro_narration": {"type": "string"},
        "snippets": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "file_path": {"type": "string"},
                    "language": {"type": "string"},
                    "code": {"type": "string"},
                    "explanation": {"type": "string"},
                    "narration": {"type": "string"},
                },
                "required": [
                    "title",
                    "file_path",
                    "language",
                    "code",
                    "explanation",
                    "narration",
                ],
            },
        },
        "outro_narration": {"type": "string"},
    },
    "required": ["intro_narration", "snippets", "outro_narration"],
}


def _call_claude(user_message: str) -> dict:
    """Invoke the `claude` CLI in headless mode and return the parsed envelope."""
    cmd = [
        "claude",
        "-p",
        "--output-format",
        "json",
        "--model",
        MODEL,
        "--system-prompt",
        SYSTEM_PROMPT,
        "--json-schema",
        json.dumps(OUTPUT_SCHEMA),
    ]
    result = subprocess.run(
        cmd,
        input=user_message,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"claude CLI failed (exit {result.returncode}): "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )

    try:
        envelope = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"claude CLI returned non-JSON output: {result.stdout[:500]}"
        ) from e

    if envelope.get("is_error"):
        raise RuntimeError(
            f"claude CLI returned an error envelope: {envelope.get('result') or envelope}"
        )

    return envelope


def generate_walkthrough(change: ChangeContext) -> SnippetWalkthrough:
    """Ask Claude to build a snippet walkthrough from a PR or commit."""
    diff = change.diff
    if len(diff) > MAX_DIFF_CHARS:
        diff = diff[:MAX_DIFF_CHARS] + "\n\n[... diff truncated ...]"

    user_message = (
        f"{change.summary_for_prompt()}\n"
        f"Full diff:\n```diff\n{diff}\n```\n\n"
        "Generate the walkthrough as structured output matching the JSON schema."
    )

    envelope = _call_claude(user_message)

    # With --json-schema, the validated object lands in `structured_output`.
    # Fall back to parsing `result` as JSON if an older CLI puts it there instead.
    data = envelope.get("structured_output")
    if data is None:
        raw = envelope.get("result", "")
        if not raw:
            raise RuntimeError(
                "claude CLI returned no structured_output and no result text"
            )
        data = json.loads(raw)

    snippets = [
        CodeSnippet(
            title=s["title"],
            file_path=s["file_path"],
            language=s["language"],
            code=s["code"],
            explanation=s["explanation"],
            narration=s["narration"],
        )
        for s in data["snippets"]
    ]

    return SnippetWalkthrough(
        ref=change.ref,
        title=change.title,
        url=change.url,
        intro_narration=data["intro_narration"],
        snippets=snippets,
        outro_narration=data["outro_narration"],
    )

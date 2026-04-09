"""Claude-backed Q&A over a PR walkthrough, using the `claude -p` subprocess."""

from __future__ import annotations

import json
import subprocess

from .pr import ChangeContext
from .snippets import MAX_DIFF_CHARS, SnippetWalkthrough

MODEL = "opus"


SYSTEM_PROMPT_TEMPLATE = """\
You're the engineer who just shipped this change, on a quick voice call with a \
teammate. You just finished talking through a snippet and they asked a question. \
The answer will be spoken aloud by a TTS voice, so keep it SHORT and SPOKEN.

RULES:
- ONE or TWO sentences. Under 30 words. If it can't be said in ~6 seconds, it's \
  too long.
- Talk like a person. Contractions, first person, active voice.
- No filler: no "great question", no "let me think", no "so basically", no \
  "that's a good point", no repeating the question back.
- Don't describe the code structure; answer the actual question directly.
- If the answer isn't in the context, say "honestly not sure, that's outside \
  what I touched" — don't make stuff up.

Examples of the vibe:
  Q: "Why email verification?"
  A: "App Store requires it for the email sign-up path. Phone auth already has \
      its own OTP flow so we don't need it there."

  Q: "What happens if the verification email bounces?"
  A: "Right now it silently fails — no retry. On the list but didn't make this PR."

Context for this call:

{ref}: {title}
URL: {url}

Walkthrough snippets (you just narrated snippet #{current_idx_1based}):
{snippets_block}

Full diff for reference:
```diff
{diff}
```
"""


def _format_snippets(walkthrough: SnippetWalkthrough, current_idx: int) -> str:
    lines: list[str] = []
    for i, snippet in enumerate(walkthrough.snippets):
        marker = " ← CURRENT" if i == current_idx else ""
        lines.append(f"\n[#{i + 1}{marker}] {snippet.title} ({snippet.file_path})")
        lines.append(f"```{snippet.language}")
        lines.append(snippet.code)
        lines.append("```")
        lines.append(f"Explanation: {snippet.explanation}")
    return "\n".join(lines)


def answer(
    question: str,
    walkthrough: SnippetWalkthrough,
    change: ChangeContext,
    current_idx: int,
) -> str:
    """Return a short spoken-style answer to the user's question."""
    diff = change.diff
    if len(diff) > MAX_DIFF_CHARS:
        diff = diff[:MAX_DIFF_CHARS] + "\n\n[... diff truncated ...]"

    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
        ref=walkthrough.ref,
        title=walkthrough.title,
        url=walkthrough.url,
        current_idx_1based=current_idx + 1,
        snippets_block=_format_snippets(walkthrough, current_idx),
        diff=diff,
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
        input=question,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"claude CLI failed (exit {result.returncode}): "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    envelope = json.loads(result.stdout)
    if envelope.get("is_error"):
        raise RuntimeError(f"claude returned error: {envelope.get('result')}")
    return (envelope.get("result") or "").strip()

"""Local TTS and STT for the terminal walkthrough.

TTS: macOS `say`. We auto-pick the best installed voice — prefer premium /
enhanced / Siri neural voices, fall back to Samantha, then system default.
The user can override with CLAUDE_ZOOM_SAY_VOICE. Speech rate is bumped
slightly above the macOS default for a more conversational pace.

For a dramatic quality upgrade, download a premium voice in:
  System Settings → Accessibility → Spoken Content → System Voice → Manage
  Voices → look for "Siri Voice 1-5" or entries marked (Premium).

STT: parakeet-mlx (NVIDIA Parakeet ported to Apple Silicon MLX). Runs
locally; first call downloads the model (~600MB) from Hugging Face and
caches it in ~/.cache/huggingface.

Mic capture: sounddevice → int16 PCM → soundfile WAV → parakeet.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from functools import lru_cache
from typing import Any

# Module-level lazy cache for the parakeet model. Loading takes a few
# seconds (model weights + mlx graph), so we only want to pay that once
# per session.
_parakeet_model: Any | None = None

PARAKEET_MODEL_ID = "mlx-community/parakeet-tdt-0.6b-v3"
SAMPLE_RATE = 16000
DEFAULT_SAY_RATE = "190"  # words per minute; macOS default is ~175

# Preference order for the default voice when CLAUDE_ZOOM_SAY_VOICE is unset.
# We search `say -v '?'` output for each pattern in order and use the first
# match. Premium / enhanced / Siri voices sound dramatically better than the
# stock ones, so they rank first. Samantha is the safe last-resort fallback
# that's installed on every macOS.
_VOICE_PREFERENCES: list[re.Pattern[str]] = [
    re.compile(r"^Siri Voice \d", re.IGNORECASE),
    re.compile(r"\(Premium\)", re.IGNORECASE),
    re.compile(r"\(Enhanced\)", re.IGNORECASE),
    re.compile(r"^Ava\b", re.IGNORECASE),
    re.compile(r"^Zoe\b", re.IGNORECASE),
    re.compile(r"^Evan\b", re.IGNORECASE),
    re.compile(r"^Samantha\b", re.IGNORECASE),
    re.compile(r"^Daniel\b", re.IGNORECASE),
]


@lru_cache(maxsize=1)
def _autodetect_voice() -> str | None:
    """Return the best installed English `say` voice, or None if detection fails.

    Cached at module level so we only shell out to `say -v '?'` once per run.
    """
    try:
        out = subprocess.run(
            ["say", "-v", "?"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout
    except OSError:
        return None

    # Parse lines like:
    #   "Samantha            en_US    # Hello! My name is Samantha."
    #   "Ava (Premium)       en_US    # Hello! My name is Ava."
    english: list[str] = []
    for line in out.splitlines():
        if " en_" not in line:
            continue
        # Voice name is everything before the locale code.
        name = re.split(r"\s{2,}", line, maxsplit=1)[0].strip()
        if name:
            english.append(name)

    for pattern in _VOICE_PREFERENCES:
        for name in english:
            if pattern.search(name):
                return name
    return english[0] if english else None


def _resolve_voice() -> str | None:
    """Look up the voice to use at call time (honors env var overrides)."""
    env = os.environ.get("CLAUDE_ZOOM_SAY_VOICE")
    if env:
        return env
    return _autodetect_voice()


def _resolve_rate() -> str:
    return os.environ.get("CLAUDE_ZOOM_SAY_RATE") or DEFAULT_SAY_RATE


def speak(text: str) -> None:
    """Speak `text` through the default audio output via macOS `say`.

    Blocks until playback finishes. Honors CLAUDE_ZOOM_SAY_VOICE and
    CLAUDE_ZOOM_SAY_RATE; otherwise auto-picks the best installed voice
    and uses a slightly snappier default rate.
    """
    if not text.strip():
        return
    cmd = ["say", "-r", _resolve_rate()]
    voice = _resolve_voice()
    if voice:
        cmd.extend(["-v", voice])
    cmd.append(text)
    subprocess.run(cmd, check=False)


def _load_parakeet() -> Any:
    global _parakeet_model
    if _parakeet_model is not None:
        return _parakeet_model
    try:
        from parakeet_mlx import from_pretrained  # type: ignore[import-not-found]
    except ImportError as e:
        raise RuntimeError(
            "parakeet-mlx not installed. Run: pip install -e '.[voice]'"
        ) from e
    _parakeet_model = from_pretrained(PARAKEET_MODEL_ID)
    return _parakeet_model


def warm_up() -> None:
    """Eagerly load the parakeet model so the first `listen_once` isn't slow."""
    _load_parakeet()


def listen_once(seconds: float = 6.0) -> str | None:
    """Record `seconds` of audio from the default mic, transcribe with parakeet.

    Returns the transcript text, or None if silence / empty transcription.
    """
    try:
        import numpy as np  # type: ignore[import-not-found]
        import sounddevice as sd  # type: ignore[import-not-found]
        import soundfile as sf  # type: ignore[import-not-found]
    except ImportError as e:
        raise RuntimeError(
            "voice deps not installed. Run: pip install -e '.[voice]'"
        ) from e

    frames = int(seconds * SAMPLE_RATE)
    recording = sd.rec(frames, samplerate=SAMPLE_RATE, channels=1, dtype="float32")
    sd.wait()
    audio = recording.flatten()

    # Treat as silence if the whole buffer is very quiet. RMS threshold is
    # coarse but catches "user didn't say anything".
    rms = float(np.sqrt(np.mean(audio**2))) if audio.size else 0.0
    if rms < 0.005:
        return None

    model = _load_parakeet()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        sf.write(tmp_path, audio, SAMPLE_RATE, subtype="PCM_16")
        result = model.transcribe(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    text = (getattr(result, "text", "") or "").strip()
    return text or None

"""Local TTS and STT for the terminal walkthrough.

TTS: macOS `say` — zero deps, offline, free. Quality is meh but fine for
dev tooling.

STT: parakeet-mlx (NVIDIA Parakeet ported to Apple Silicon MLX). Runs
locally; first call downloads the model (~600MB) from Hugging Face and
caches it in ~/.cache/huggingface.

Mic capture: sounddevice → int16 PCM → soundfile WAV → parakeet.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from typing import Any

# Module-level lazy cache for the parakeet model. Loading takes a few
# seconds (model weights + mlx graph), so we only want to pay that once
# per session.
_parakeet_model: Any | None = None

PARAKEET_MODEL_ID = "mlx-community/parakeet-tdt-0.6b-v3"
SAMPLE_RATE = 16000
SAY_VOICE = os.environ.get("CLAUDE_ZOOM_SAY_VOICE")  # e.g. "Samantha", "Daniel"
SAY_RATE = os.environ.get("CLAUDE_ZOOM_SAY_RATE")  # words per minute, default ~175


def speak(text: str) -> None:
    """Speak `text` through the default audio output via macOS `say`.

    Blocks until playback finishes. Uses `CLAUDE_ZOOM_SAY_VOICE` and
    `CLAUDE_ZOOM_SAY_RATE` env vars if set.
    """
    if not text.strip():
        return
    cmd = ["say"]
    if SAY_VOICE:
        cmd.extend(["-v", SAY_VOICE])
    if SAY_RATE:
        cmd.extend(["-r", SAY_RATE])
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

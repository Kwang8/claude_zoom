"""Local TTS and STT for the terminal walkthrough.

TTS: edge-tts (Microsoft Edge neural voices, requires internet). Defaults to
en-US-AriaNeural. Override with CLAUDE_ZOOM_VOICE env var (any edge-tts voice
name). Audio is streamed to a temp MP3 and played via `afplay`.

STT: parakeet-mlx (NVIDIA Parakeet ported to Apple Silicon MLX). Runs
locally; first call downloads the model (~600MB) from Hugging Face and
caches it in ~/.cache/huggingface.

Mic capture: sounddevice → int16 PCM → soundfile WAV → parakeet.
"""

from __future__ import annotations

import asyncio
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
DEFAULT_EDGE_VOICE = "en-US-AriaNeural"


def _resolve_voice() -> str:
    return os.environ.get("CLAUDE_ZOOM_VOICE") or DEFAULT_EDGE_VOICE


async def _speak_async(text: str) -> None:
    try:
        import edge_tts  # type: ignore[import-not-found]
    except ImportError as e:
        raise RuntimeError(
            "edge-tts not installed. Run: pip install -e '.[voice]'"
        ) from e

    voice = _resolve_voice()
    communicate = edge_tts.Communicate(text, voice)
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        await communicate.save(tmp_path)
        subprocess.run(["afplay", tmp_path], check=False)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def speak(text: str) -> None:
    """Speak `text` via edge-tts. Blocks until playback finishes.

    Honors CLAUDE_ZOOM_VOICE (any edge-tts voice name, e.g. en-US-GuyNeural).
    Requires internet access.
    """
    if not text.strip():
        return
    asyncio.run(_speak_async(text))


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

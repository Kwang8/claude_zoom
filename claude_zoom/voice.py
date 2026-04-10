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
import threading
import time
from functools import lru_cache
from typing import Any, Callable

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


def play_sound(name: str) -> None:
    """Play a short notification sound via macOS ``afplay`` (non-blocking).

    Built-in system sounds live in /System/Library/Sounds/.
    Mapping: "ready" → Tink, "done" → Glass, "error" → Basso.
    """
    sounds = {
        "ready": "/System/Library/Sounds/Tink.aiff",
        "done": "/System/Library/Sounds/Glass.aiff",
        "error": "/System/Library/Sounds/Basso.aiff",
    }
    path = sounds.get(name)
    if path and os.path.exists(path):
        subprocess.Popen(
            ["afplay", path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def _build_say_cmd(text: str) -> list[str]:
    cmd = ["say", "-r", _resolve_rate()]
    voice = _resolve_voice()
    if voice:
        cmd.extend(["-v", voice])
    cmd.append(text)
    return cmd


def speak(text: str) -> None:
    """Speak `text` through the default audio output via macOS `say`.

    Blocks until playback finishes. Honors CLAUDE_ZOOM_SAY_VOICE and
    CLAUDE_ZOOM_SAY_RATE; otherwise auto-picks the best installed voice
    and uses a slightly snappier default rate.
    """
    if not text.strip():
        return
    subprocess.run(_build_say_cmd(text), check=False)


def speak_async(text: str) -> subprocess.Popen[bytes] | None:
    """Start a non-blocking `say` subprocess and return the Popen handle.

    The caller is responsible for polling `.poll()` and calling `.terminate()`
    to interrupt playback (e.g. for push-to-talk barge-in). Returns None if
    `text` is empty.
    """
    if not text.strip():
        return None
    return subprocess.Popen(
        _build_say_cmd(text),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


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


def _transcribe_audio(audio: Any) -> str | None:
    """Transcribe a numpy float32 audio array with parakeet.

    Returns the transcript text, or None for silence / empty transcription.
    Shared helper used by ``listen_once``, ``Recorder.stop_and_transcribe``,
    and the streaming partial-transcription thread.
    """
    import numpy as np  # type: ignore[import-not-found]
    import soundfile as sf  # type: ignore[import-not-found]

    rms = float(np.sqrt(np.mean(audio**2))) if audio.size else 0.0
    if rms < 0.005:
        return None

    # Cap audio at 30 seconds to prevent long transcription hangs.
    max_samples = int(SAMPLE_RATE * 30)
    if audio.size > max_samples:
        audio = audio[:max_samples]

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


def listen_once(seconds: float = 6.0) -> str | None:
    """Record `seconds` of audio from the default mic, transcribe with parakeet.

    Returns the transcript text, or None if silence / empty transcription.
    """
    try:
        import numpy as np  # type: ignore[import-not-found]
        import sounddevice as sd  # type: ignore[import-not-found]
    except ImportError as e:
        raise RuntimeError(
            "voice deps not installed. Run: pip install -e '.[voice]'"
        ) from e

    frames = int(seconds * SAMPLE_RATE)
    recording = sd.rec(frames, samplerate=SAMPLE_RATE, channels=1, dtype="float32")
    sd.wait()
    audio = recording.flatten()

    return _transcribe_audio(audio)


class Recorder:
    """Manually-controlled mic recorder for push-to-talk UX.

    Use `start()` to open the mic and begin buffering audio in a background
    stream, then `stop_and_transcribe()` on another thread to close the stream
    and run parakeet over what was captured. Unlike `listen_once`, this does
    not impose a fixed duration — the user controls it via a toggle key.

    **Streaming transcription**: call ``start(on_partial_transcript=cb)`` to
    receive partial transcripts while recording.  A background thread will
    periodically snapshot the audio captured so far, run parakeet on it, and
    invoke ``cb(text)`` with the (possibly incomplete) transcript.  The final
    authoritative transcript is still returned by ``stop_and_transcribe()``.
    """

    # How often (seconds) the streaming thread snapshots + transcribes.
    PARTIAL_INTERVAL: float = 2.0

    def __init__(self) -> None:
        self._frames: list = []
        self._stream: Any = None
        self._lock = threading.Lock()
        self._partial_thread: threading.Thread | None = None
        self._partial_stop = threading.Event()

    def start(
        self,
        on_partial_transcript: Callable[[str], None] | None = None,
    ) -> None:
        """Open the mic and start buffering.

        Parameters
        ----------
        on_partial_transcript:
            If provided, a background thread will periodically transcribe the
            audio captured *so far* and call this function with the partial
            text.  The callback is invoked from the background thread — callers
            should schedule UI updates accordingly.
        """
        try:
            import sounddevice as sd  # type: ignore[import-not-found]
        except ImportError as e:
            raise RuntimeError(
                "voice deps not installed. Run: pip install -e '.[voice]'"
            ) from e

        self._frames = []
        self._partial_stop.clear()

        def _callback(indata, _frames, _time_info, _status) -> None:
            # Copy so we don't keep a reference to the PortAudio buffer.
            with self._lock:
                self._frames.append(indata.copy())

        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            callback=_callback,
        )
        self._stream.start()

        # Kick off the partial-transcription background thread if requested.
        if on_partial_transcript is not None:
            self._partial_thread = threading.Thread(
                target=self._partial_loop,
                args=(on_partial_transcript,),
                daemon=True,
                name="partial-transcriber",
            )
            self._partial_thread.start()

    def _partial_loop(
        self,
        callback: Callable[[str], None],
    ) -> None:
        """Background loop: snapshot frames, transcribe, invoke callback."""
        import numpy as np  # type: ignore[import-not-found]

        while not self._partial_stop.wait(timeout=self.PARTIAL_INTERVAL):
            # Take a snapshot of current frames under the lock.
            with self._lock:
                if not self._frames:
                    continue
                snapshot = list(self._frames)

            audio = np.concatenate(snapshot).flatten()
            try:
                text = _transcribe_audio(audio)
            except Exception:  # noqa: BLE001
                continue

            if text:
                callback(text)

    def stop_and_transcribe(self) -> str | None:
        """Close the stream and return a transcript, or None for silence."""
        try:
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as e:
            raise RuntimeError(
                "voice deps not installed. Run: pip install -e '.[voice]'"
            ) from e

        # Signal the partial thread to stop, then wait for it to finish.
        self._partial_stop.set()
        if self._partial_thread is not None:
            self._partial_thread.join(timeout=5.0)
            self._partial_thread = None

        stream = self._stream
        if stream is None:
            return None
        try:
            stream.stop()
            stream.close()
        finally:
            self._stream = None

        with self._lock:
            if not self._frames:
                return None
            audio = np.concatenate(self._frames).flatten()
            self._frames = []

        return _transcribe_audio(audio)

    def close(self) -> None:
        """Best-effort cleanup of the stream without running transcription."""
        self._partial_stop.set()
        if self._partial_thread is not None:
            self._partial_thread.join(timeout=2.0)
            self._partial_thread = None
        stream = self._stream
        if stream is None:
            return
        try:
            stream.stop()
            stream.close()
        except Exception:  # noqa: BLE001
            pass
        finally:
            self._stream = None
            with self._lock:
                self._frames = []

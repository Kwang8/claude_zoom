import { ChildProcess, execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const DEFAULT_SAY_RATE = "190";

const VOICE_PREFERENCES = [
  /^Siri Voice \d/i,
  /\(Premium\)/i,
  /\(Enhanced\)/i,
  /^Ava\b/i,
  /^Zoe\b/i,
  /^Evan\b/i,
  /^Samantha\b/i,
  /^Daniel\b/i,
];

let cachedVoice: string | null | undefined;

function autodetectVoice(): string | null {
  if (cachedVoice !== undefined) return cachedVoice;
  try {
    const out = execFileSync("say", ["-v", "?"], { encoding: "utf-8", timeout: 5000 });
    const english: string[] = [];
    for (const line of out.split("\n")) {
      if (!line.includes(" en_")) continue;
      const name = line.split(/\s{2,}/)[0].trim();
      if (name) english.push(name);
    }
    for (const pattern of VOICE_PREFERENCES) {
      for (const name of english) {
        if (pattern.test(name)) {
          cachedVoice = name;
          return name;
        }
      }
    }
    cachedVoice = english[0] || null;
    return cachedVoice;
  } catch {
    cachedVoice = null;
    return null;
  }
}

function resolveVoice(): string | null {
  return process.env.CLAUDE_ZOOM_SAY_VOICE || autodetectVoice();
}

function resolveRate(): string {
  return process.env.CLAUDE_ZOOM_SAY_RATE || DEFAULT_SAY_RATE;
}

function buildSayCmd(text: string): string[] {
  const cmd = ["say", "-r", resolveRate()];
  const voice = resolveVoice();
  if (voice) cmd.push("-v", voice);
  cmd.push(text);
  return cmd;
}

export function playSound(name: string): void {
  const sounds: Record<string, string> = {
    ready: "/System/Library/Sounds/Tink.aiff",
    done: "/System/Library/Sounds/Glass.aiff",
    error: "/System/Library/Sounds/Basso.aiff",
  };
  const soundPath = sounds[name];
  if (soundPath && fs.existsSync(soundPath)) {
    spawn("afplay", [soundPath], {
      stdio: "ignore",
      detached: true,
    }).unref();
  }
}

export function speakAsync(text: string): ChildProcess | null {
  if (!text.trim()) return null;
  const cmd = buildSayCmd(text);
  return spawn(cmd[0], cmd.slice(1), {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

// ── STT Recorder Bridge ──
// Spawns a long-lived Python helper for mic capture + Parakeet transcription.
// If the venv or voice deps aren't available, recording is gracefully disabled.

const RECORD_HELPER_SCRIPT = `
import sys, json, threading
try:
    from parakeet_mlx import from_pretrained
    import sounddevice as sd
    import numpy as np
    import soundfile as sf
    import tempfile, os
except ImportError as e:
    print(json.dumps({"error": str(e)}), flush=True)
    sys.exit(1)

model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
print(json.dumps({"status": "ready"}), flush=True)

frames = []
stream = None
lock = threading.Lock()

def audio_callback(indata, _frames, _time_info, _status):
    with lock:
        frames.append(indata.copy())

for line in sys.stdin:
    cmd = line.strip()
    if cmd == "start":
        frames = []
        stream = sd.InputStream(samplerate=16000, channels=1, dtype='float32', callback=audio_callback)
        stream.start()
        print(json.dumps({"status": "recording"}), flush=True)
    elif cmd == "stop":
        if stream:
            stream.stop()
            stream.close()
            stream = None
        with lock:
            if not frames:
                print(json.dumps({"transcript": ""}), flush=True)
                continue
            audio = np.concatenate(frames).flatten()
        rms = float(np.sqrt(np.mean(audio**2)))
        if rms < 0.005:
            print(json.dumps({"transcript": ""}), flush=True)
            continue
        max_samples = int(16000 * 30)
        if audio.size > max_samples:
            audio = audio[:max_samples]
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
            tmp = f.name
        sf.write(tmp, audio, 16000, subtype='PCM_16')
        result = model.transcribe(tmp)
        try:
            os.unlink(tmp)
        except:
            pass
        text = getattr(result, 'text', '').strip()
        print(json.dumps({"transcript": text}), flush=True)
    elif cmd == "quit":
        break
`;

function findPython(): string | null {
  // Look for the project venv — 3 levels up from dist/main/
  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const venvPython = path.join(projectRoot, ".venv", "bin", "python3");
  if (fs.existsSync(venvPython)) return venvPython;
  return null;
}

export class RecorderBridge {
  private proc: ChildProcess | null = null;
  private _ready = false;
  private _buffer = "";
  private _onTranscript: ((text: string | null) => void) | null = null;

  async start(): Promise<boolean> {
    const pythonPath = findPython();
    if (!pythonPath) {
      console.log("[stt] no venv found — voice recording disabled");
      return false;
    }

    return new Promise((resolve) => {
      this.proc = spawn(pythonPath, ["-c", RECORD_HELPER_SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.proc.stdout?.on("data", (data: Buffer) => {
        this._buffer += data.toString();
        const lines = this._buffer.split("\n");
        this._buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.status === "ready") {
              this._ready = true;
              resolve(true);
            } else if (msg.status === "recording") {
              // ack
            } else if ("transcript" in msg) {
              if (this._onTranscript) {
                this._onTranscript(msg.transcript || null);
                this._onTranscript = null;
              }
            } else if (msg.error) {
              console.error("[stt] error:", msg.error);
              resolve(false);
            }
          } catch {}
        }
      });

      this.proc.stderr?.on("data", (data: Buffer) => {
        // Parakeet prints download progress to stderr — ignore
      });

      this.proc.on("exit", () => {
        this._ready = false;
        this.proc = null;
        resolve(false);
      });

      // 120s timeout for model download on first run
      setTimeout(() => {
        if (!this._ready) {
          console.log("[stt] timeout waiting for model load");
          resolve(false);
        }
      }, 120_000);
    });
  }

  get ready(): boolean {
    return this._ready;
  }

  startRecording(): void {
    this.proc?.stdin?.write("start\n");
  }

  stopAndTranscribe(): Promise<string | null> {
    return new Promise((resolve) => {
      this._onTranscript = resolve;
      this.proc?.stdin?.write("stop\n");
      setTimeout(() => {
        if (this._onTranscript === resolve) {
          this._onTranscript = null;
          resolve(null);
        }
      }, 30_000);
    });
  }

  close(): void {
    try {
      this.proc?.stdin?.write("quit\n");
    } catch {}
    try {
      this.proc?.kill();
    } catch {}
    this.proc = null;
    this._ready = false;
  }
}

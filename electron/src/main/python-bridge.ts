import { ChildProcess, spawn } from "child_process";
import path from "path";
import fs from "fs";

/**
 * Finds the Python executable, preferring the project venv.
 */
function findPython(): string {
  // Look for venv relative to the project root (one level up from electron/)
  const projectRoot = path.resolve(__dirname, "..", "..");
  const venvPython = path.join(projectRoot, ".venv", "bin", "python3");
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  // Fall back to system python
  return "python3.12";
}

export interface PythonBridgeOptions {
  port: number;
  host: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  logFile?: string;
}

export class PythonBridge {
  private proc: ChildProcess | null = null;
  private _port: number;
  private _host: string;
  private opts: PythonBridgeOptions;

  constructor(opts: PythonBridgeOptions) {
    this.opts = opts;
    this._port = opts.port;
    this._host = opts.host;
  }

  get url(): string {
    return `ws://${this._host}:${this._port}`;
  }

  /**
   * Spawn the Python WebSocket server as a child process.
   * Returns a promise that resolves once the server prints its ready line.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const python = findPython();
      const args = [
        "-m",
        "claude_zoom.cli",
        "serve",
        "--port",
        String(this._port),
        "--host",
        this._host,
      ];

      if (this.opts.cwd) {
        args.push("--cwd", this.opts.cwd);
      }
      if (this.opts.model) {
        args.push("--model", this.opts.model);
      }
      if (this.opts.permissionMode) {
        args.push("--permission-mode", this.opts.permissionMode);
      }
      if (this.opts.logFile) {
        args.push("--log-file", this.opts.logFile);
      }

      console.log(`[python-bridge] spawning: ${python} ${args.join(" ")}`);

      // Spawn from the project root so Python can find the package
      const projectRoot = path.resolve(__dirname, "..", "..");
      this.proc = spawn(python, args, {
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let resolved = false;

      this.proc.stdout?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        console.log(`[python] ${line}`);
        if (!resolved && line.includes("server running")) {
          resolved = true;
          resolve();
        }
      });

      this.proc.stderr?.on("data", (data: Buffer) => {
        console.error(`[python:err] ${data.toString().trim()}`);
      });

      this.proc.on("error", (err) => {
        console.error("[python-bridge] spawn error:", err);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      this.proc.on("exit", (code) => {
        console.log(`[python-bridge] exited with code ${code}`);
        if (!resolved) {
          resolved = true;
          reject(new Error(`Python server exited with code ${code}`));
        }
        this.proc = null;
      });

      // Timeout: if server doesn't start within 30s, reject
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(); // resolve anyway — server might be loading Parakeet
        }
      }, 30000);
    });
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }
}

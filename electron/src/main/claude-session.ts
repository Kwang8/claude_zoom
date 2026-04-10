import { ChildProcess, execFileSync, spawn } from "child_process";
import readline from "readline";

// Resolve the absolute path to `claude` once at startup so spawn never
// gets ENOENT inside Electron (which has a stripped-down PATH).
let _claudePath: string | null = null;
export function getClaudePath(): string {
  if (_claudePath) return _claudePath;
  try {
    _claudePath = execFileSync("which", ["claude"], { encoding: "utf-8" }).trim();
  } catch {
    // Fallback common locations
    const candidates = [
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      `${process.env.HOME}/.npm-global/bin/claude`,
    ];
    const fs = require("fs");
    for (const c of candidates) {
      if (fs.existsSync(c)) { _claudePath = c; break; }
    }
  }
  if (!_claudePath) _claudePath = "claude"; // last resort
  return _claudePath;
}

export const DEFAULT_APPEND_SYSTEM_PROMPT = `\
You are being invoked via a voice interface. A fast model will summarize your \
work for the user at the end of each turn, so keep your own assistant messages \
short and direct — under two sentences when possible. Do not narrate your tool \
calls ("I'll read the file...") — just use the tools. Do not emit code blocks in \
prose. When you finish a task, state the outcome in one crisp sentence.

IMPORTANT — sub-agent spawning: You can spawn sub-agents that run in parallel \
in isolated git worktrees. To spawn one, emit this block in your response:
<SPAWN name="short-name">detailed task description for the sub-agent</SPAWN>

Spawn sub-agents for substantial, time-consuming, or parallelizable work:
- Exploring a large codebase or doing multi-file research
- Implementing a feature or making significant code changes
- Running a full test suite or doing a long investigation
- Work that naturally splits into independent parallel tasks (e.g. "look into X and Y")

Do NOT spawn sub-agents for quick, single-step operations — handle these directly:
- Simple git commands (git pull, git fetch, git merge, git status, git log)
- Reading a single file or running one shell command
- Answering a factual question about the codebase
- Any task completable in one or two tool calls

For quick tasks: just do them directly and report the result. \
For substantial work: spawn FIRST, keep your text response SHORT. \
You may spawn multiple per turn. The sub-agent reports back via voice when done.`;

export class ClaudeSession {
  cwd: string | null;
  model: string;
  permissionMode: string;
  appendSystemPrompt: string;
  tools: string | null;
  sessionId: string | null = null;
  private _proc: ChildProcess | null = null;
  private _cancelled = false;

  constructor(opts: {
    cwd?: string | null;
    model?: string;
    permissionMode?: string;
    appendSystemPrompt?: string;
    tools?: string | null;
  } = {}) {
    this.cwd = opts.cwd ?? null;
    this.model = opts.model ?? "opus";
    this.permissionMode = opts.permissionMode ?? "acceptEdits";
    this.appendSystemPrompt = opts.appendSystemPrompt ?? DEFAULT_APPEND_SYSTEM_PROMPT;
    this.tools = opts.tools ?? null;
  }

  async *send(prompt: string): AsyncGenerator<Record<string, any>> {
    const args: string[] = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--model", this.model,
      "--permission-mode", this.permissionMode,
      "--append-system-prompt", this.appendSystemPrompt,
    ];
    if (this.tools !== null) {
      args.push("--tools", this.tools);
    }
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    this._cancelled = false;
    this._proc = spawn(getClaudePath(), args, {
      cwd: this.cwd || undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const proc = this._proc;

    // Prevent uncaught ENOENT from crashing the process
    proc.on("error", (err) => {
      console.error("[claude-session] spawn error:", err.message);
    });

    // Collect stderr from the start
    const stderrChunks: Buffer[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // Register exit listener before reading stdout
    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on("exit", (code) => resolve(code));
    });

    // Write prompt and close stdin
    try {
      proc.stdin!.write(prompt);
      proc.stdin!.end();
    } catch {
      // broken pipe — process died immediately
    }

    const rl = readline.createInterface({ input: proc.stdout! });
    let capturedInit = false;

    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: Record<string, any>;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (
          this.sessionId === null &&
          event.type === "system" &&
          event.subtype === "init" &&
          event.session_id
        ) {
          this.sessionId = event.session_id;
          capturedInit = true;
        } else if (event.type === "system" && event.subtype === "init") {
          capturedInit = true;
        }

        yield event;
      }

      const exitCode = await exitPromise;
      const stderrTail = Buffer.concat(stderrChunks).toString().trim().slice(-400);

      if (exitCode !== 0 && !this._cancelled) {
        throw new Error(`claude -p exited ${exitCode}: ${stderrTail}`);
      }
      if (!capturedInit && !this._cancelled) {
        throw new Error(`claude -p emitted no init event: ${stderrTail}`);
      }
    } finally {
      this._proc = null;
    }
  }

  cancel(): void {
    this._cancelled = true;
    const proc = this._proc;
    if (!proc || proc.exitCode !== null) return;
    try {
      proc.kill("SIGTERM");
    } catch {}
  }
}

// ── Helpers ──

export function summarizeToolArgs(tool: string, args: Record<string, any>): string {
  if (["Read", "Edit", "Write", "NotebookRead", "NotebookEdit"].includes(tool)) {
    return shorten(args.file_path || args.notebook_path || "", 60);
  }
  if (tool === "Bash") return shorten(args.command || "", 60);
  if (tool === "Grep" || tool === "Glob") return shorten(args.pattern || args.query || "", 60);
  if (tool === "WebFetch") return shorten(args.url || "", 60);
  if (tool === "WebSearch") return shorten(args.query || "", 60);
  if (tool === "Task") return shorten(args.description || args.subagent_type || "", 60);
  try {
    return shorten(JSON.stringify(args), 60);
  } catch {
    return shorten(String(args), 60);
  }
}

export function eventsToTranscript(events: Record<string, any>[]): string {
  const lines: string[] = [];
  for (const event of events) {
    const etype = event.type;
    if (etype === "assistant") {
      const content = event.message?.content || [];
      for (const item of content) {
        if (item.type === "text") {
          const text = (item.text || "").trim();
          if (text) lines.push(`assistant: ${text}`);
        } else if (item.type === "tool_use") {
          const name = item.name || "?";
          const short = summarizeToolArgs(name, item.input || {});
          lines.push(`tool_use: ${name}(${short})`);
        }
      }
    } else if (etype === "user") {
      const content = event.message?.content || [];
      for (const item of content) {
        if (item.type !== "tool_result") continue;
        const text = stringifyToolResult(item.content);
        if (text) {
          const truncated = text.length > 400 ? text.slice(0, 397) + " ...(truncated)" : text;
          lines.push(`tool_result: ${truncated}`);
        }
      }
    } else if (etype === "result" && event.is_error) {
      lines.push(`error: ${event.result || ""}`);
    }
  }
  return lines.join("\n");
}

function stringifyToolResult(result: any): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((item: any) => (typeof item === "object" && item?.text ? String(item.text) : String(item)))
      .join("\n");
  }
  return String(result);
}

function shorten(text: string, n: number): string {
  text = text.replace(/\n/g, " ").trim();
  return text.length <= n ? text : text.slice(0, n - 1) + "\u2026";
}

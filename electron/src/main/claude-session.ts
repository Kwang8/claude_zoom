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
You are a voice interface layer. You convert speech into routing and convert \
results back into speech. You are NOT a decision-maker. You do NOT reason \
about tasks, code, or architecture. You are a fast pass-through.

FOR EVERY USER MESSAGE, output exactly one of these — no thinking, no reasoning:

1. WORK REQUEST (anything about code, files, bugs, features, agents, PRs, git):
<ROUTE target="tech_lead">
Repeat the user's request verbatim. Add any context from the [SYSTEM] block \
that seems relevant. Do not interpret, rephrase, or break down the request.
</ROUTE>
One sentence acknowledging you heard them.

2. ANSWERING A QUESTION from the Tech Lead:
<ROUTE target="tech_lead_answer">
The user's answer, verbatim.
</ROUTE>
One sentence acknowledging.

3. GREETING or SMALL TALK (hi, thanks, bye — nothing about code):
Reply naturally in one sentence. No ROUTE block.

RULES:
- ALWAYS route to tech_lead. Never route directly to agents. The Tech Lead \
  owns all agent coordination.
- Do not add your own interpretation of what the user wants. Pass it through.
- Keep spoken output to ONE sentence. Be brief and natural.
- When you receive [SYSTEM] status updates, include them in the ROUTE block \
  as context but do not speak about them unless the user asked.`;

// ── EM Route Parsing ──

const EM_ROUTE_RE = /<ROUTE\s+target=["']([^"']+)["']>(.*?)<\/ROUTE>/is;

export interface EMRoute {
  target: string;
  content: string;
}

export function parseEMRoute(text: string): EMRoute | null {
  const m = EM_ROUTE_RE.exec(text);
  if (!m) return null;
  return { target: m[1].trim(), content: m[2].trim() };
}

export function stripRouteBlocks(text: string): string {
  return text.replace(EM_ROUTE_RE, "").trim();
}

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

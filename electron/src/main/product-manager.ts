import fs from "fs";
import path from "path";
import { execFileSync, spawn as spawnProcess, ChildProcess } from "child_process";
import { OllamaSession } from "./ollama-session";
import { extractFinalText } from "./narrator";

// ── Ollama Auto-Setup ──

async function ensureOllama(model: string, log: (msg: string) => void): Promise<boolean> {
  // 1. Check if ollama binary exists
  let ollamaPath: string | null = null;
  try {
    ollamaPath = execFileSync("which", ["ollama"], { encoding: "utf-8" }).trim();
  } catch {
    // Check common paths
    for (const p of ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"]) {
      if (fs.existsSync(p)) { ollamaPath = p; break; }
    }
  }

  if (!ollamaPath) {
    log("Ollama not found — attempting install via brew...");
    try {
      execFileSync("brew", ["install", "ollama"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 300_000, // 5 min timeout
      });
      ollamaPath = execFileSync("which", ["ollama"], { encoding: "utf-8" }).trim();
      log("Ollama installed successfully");
    } catch (e) {
      log(`Failed to install Ollama: ${e}. Install manually: brew install ollama`);
      return false;
    }
  }

  // 2. Check if server is running
  const isRunning = await OllamaSession.isAvailable();
  if (!isRunning) {
    log("Starting Ollama server...");
    // Spawn detached so it survives app exit
    const proc = spawnProcess(ollamaPath, ["serve"], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    // Wait for server to be ready
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await OllamaSession.isAvailable()) {
        log("Ollama server started");
        break;
      }
    }
    if (!(await OllamaSession.isAvailable())) {
      log("Ollama server failed to start");
      return false;
    }
  }

  // 3. Check if model is available
  try {
    const list = execFileSync(ollamaPath, ["list"], { encoding: "utf-8" });
    const modelBase = model.split(":")[0];
    if (!list.toLowerCase().includes(modelBase.toLowerCase())) {
      log(`Pulling model ${model}... (this may take a while on first run)`);
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawnProcess(ollamaPath!, ["pull", model], {
            stdio: ["pipe", "pipe", "pipe"],
          });
          let lastPct = "";
          proc.stderr?.on("data", (chunk: Buffer) => {
            const line = chunk.toString().trim();
            // Ollama outputs progress like "pulling abc123... 45%"
            const pctMatch = /(\d+)%/.exec(line);
            if (pctMatch && pctMatch[1] !== lastPct) {
              lastPct = pctMatch[1];
              log(`downloading ${model}: ${lastPct}%`);
            }
          });
          proc.stdout?.on("data", (chunk: Buffer) => {
            const line = chunk.toString().trim();
            const pctMatch = /(\d+)%/.exec(line);
            if (pctMatch && pctMatch[1] !== lastPct) {
              lastPct = pctMatch[1];
              log(`downloading ${model}: ${lastPct}%`);
            }
          });
          proc.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ollama pull exited ${code}`));
          });
          proc.on("error", reject);
          // 10 min timeout
          setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 600_000);
        });
        log(`Model ${model} pulled successfully`);
      } catch (e) {
        log(`Failed to pull model ${model}: ${e}`);
        return false;
      }
    }
  } catch (e) {
    log(`Failed to check models: ${e}`);
    return false;
  }

  return true;
}

// ── Types ──

export interface PMIdea {
  id: string;
  title: string;
  problem: string;
  proposal: string;
  priority: "high" | "medium" | "low";
  source: "codebase" | "conversation" | "pattern";
  createdAt: string;
  score: number;        // 0-10, refined over time
  vetted: boolean;      // has TL reviewed it?
}

export interface PMProposal {
  idea: PMIdea;
  tlFeedback: string;   // TL's technical assessment
  fullProposal: string; // polished proposal text
}

interface PMState {
  ideas: PMIdea[];
  observations: string[];
  lastScanAt: string | null;
  proposalHistory: string[];  // idea IDs already proposed
}

// ── System Prompts ──

const PM_SYSTEM_PROMPT = `\
You are a Product Manager. You think about the product, not the code.
Your job is to observe the codebase structure and user behavior patterns,
then propose features that would make the product better.

You DO NOT write code. You DO NOT think about implementation details.
You think about: user needs, product gaps, feature opportunities,
UX improvements, missing capabilities.

When given observations about the codebase and past conversations,
generate feature ideas. For each idea, output a JSON block:

<IDEA>
{
  "title": "Short feature name",
  "problem": "What problem does this solve?",
  "proposal": "What would the user experience look like?",
  "priority": "high|medium|low",
  "source": "codebase|conversation|pattern"
}
</IDEA>

Output 1-3 ideas per cycle. Be specific and actionable.
Skip ideas that are too vague or too small (typo fixes, etc.).
Focus on features that would meaningfully improve the product.`;

const IDEA_RE = /<IDEA>\s*(\{[\s\S]*?\})\s*<\/IDEA>/gi;

// ── State Persistence ──

const STATE_DIR = ".claude_zoom_agents";
const PM_STATE_FILE = "pm_state.json";

function pmStatePath(cwd: string): string {
  return path.join(cwd, STATE_DIR, PM_STATE_FILE);
}

function savePMState(state: PMState, cwd: string): void {
  const p = pmStatePath(cwd);
  const tmp = `${p}.tmp`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.warn("[pm] failed to save state:", e);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function loadPMState(cwd: string): PMState {
  const p = pmStatePath(cwd);
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      return {
        ideas: data.ideas ?? [],
        observations: data.observations ?? [],
        lastScanAt: data.lastScanAt ?? null,
        proposalHistory: data.proposalHistory ?? [],
      };
    }
  } catch (e) {
    console.warn("[pm] failed to load state:", e);
  }
  return { ideas: [], observations: [], lastScanAt: null, proposalHistory: [] };
}

// ── Codebase Scanner ──

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".json", ".md"]);
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".claude_zoom_agents"]);
const MAX_FILE_SIZE = 50_000; // 50KB

function scanCodebase(cwd: string): string[] {
  const observations: string[] = [];
  const files: { path: string; size: number }[] = [];
  const todos: string[] = [];

  function walk(dir: string, depth = 0): void {
    if (depth > 5) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (!SCAN_EXTENSIONS.has(ext)) continue;
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > MAX_FILE_SIZE) continue;
            files.push({ path: path.relative(cwd, fullPath), size: stat.size });

            // Quick scan for TODOs and FIXMEs
            const content = fs.readFileSync(fullPath, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (/\b(TODO|FIXME|HACK|XXX)\b/i.test(line)) {
                todos.push(`${path.relative(cwd, fullPath)}:${i + 1}: ${line.trim().slice(0, 100)}`);
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  walk(cwd);

  observations.push(`Project has ${files.length} source files`);

  // File structure summary
  const dirs = new Set(files.map((f) => f.path.split("/").slice(0, 2).join("/")));
  observations.push(`Top-level structure: ${Array.from(dirs).sort().join(", ")}`);

  // TODOs
  if (todos.length > 0) {
    observations.push(`Found ${todos.length} TODOs/FIXMEs:`);
    for (const todo of todos.slice(0, 10)) {
      observations.push(`  ${todo}`);
    }
  }

  // Look for missing patterns
  const hasTests = files.some((f) => f.path.includes("test") || f.path.includes("spec"));
  if (!hasTests) observations.push("No test files detected — testing infrastructure missing");

  const hasReadme = files.some((f) => f.path.toLowerCase() === "readme.md");
  if (!hasReadme) observations.push("No README.md found");

  return observations;
}

// ── Conversation Scanner ──

function scanConversations(cwd: string): string[] {
  const observations: string[] = [];
  const convDir = path.join(cwd, STATE_DIR, "conversations");
  if (!fs.existsSync(convDir)) return observations;

  const userRequests: string[] = [];
  const errors: string[] = [];

  try {
    const dirs = fs.readdirSync(convDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const stateFile = path.join(convDir, dir.name, "state.json");
      try {
        if (!fs.existsSync(stateFile)) continue;
        const data = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
        const messages = data.messages ?? [];
        for (const msg of messages) {
          if (msg.role === "user" && msg.text) {
            userRequests.push(msg.text.slice(0, 100));
          }
          if (msg.role === "claude_error" && msg.text) {
            errors.push(msg.text.slice(0, 100));
          }
        }
      } catch {}
    }
  } catch {}

  if (userRequests.length > 0) {
    observations.push(`User has made ${userRequests.length} requests across conversations`);
    // Find repeated themes
    const words = userRequests.join(" ").toLowerCase().split(/\s+/);
    const freq = new Map<string, number>();
    for (const w of words) {
      if (w.length < 4) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
    const topWords = Array.from(freq.entries())
      .filter(([, c]) => c > 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([w, c]) => `${w}(${c})`);
    if (topWords.length > 0) {
      observations.push(`Frequent topics: ${topWords.join(", ")}`);
    }
  }

  if (errors.length > 0) {
    observations.push(`Found ${errors.length} errors in past conversations`);
  }

  return observations;
}

// ── Product Manager ──

export interface PMStatusUpdate {
  status: string;
  idea_count: number;
  last_activity: string | null;
}

export interface ProductManagerOpts {
  onProposal: (proposal: PMProposal) => void;
  onStatusUpdate?: (update: PMStatusUpdate) => void;
  onLog?: (msg: string) => void;
  scanIntervalMs?: number;
  ollamaModel?: string;
  ollamaBaseUrl?: string;
}

export class ProductManager {
  private _cwd: string;
  private _session: OllamaSession;
  private _state: PMState;
  private _opts: ProductManagerOpts;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _log: (msg: string) => void;

  constructor(cwd: string, opts: ProductManagerOpts) {
    this._cwd = cwd;
    this._opts = opts;
    this._log = opts.onLog ?? ((msg) => console.log(`[pm] ${msg}`));
    this._session = new OllamaSession({
      model: opts.ollamaModel ?? "qwen2.5:14b",
      baseUrl: opts.ollamaBaseUrl,
      systemPrompt: PM_SYSTEM_PROMPT,
    });
    this._state = loadPMState(cwd);
  }

  private _emitStatus(status: string): void {
    this._opts.onStatusUpdate?.({
      status,
      idea_count: this._state.ideas.length,
      last_activity: this._state.lastScanAt,
    });
  }

  async start(): Promise<void> {
    this._emitStatus("setting up");
    const model = this._session.model;
    const ready = await ensureOllama(model, (msg) => {
      this._log(msg);
      // Forward download progress to sidebar
      const pctMatch = /(\d+)%/.exec(msg);
      if (pctMatch) {
        this._emitStatus(`downloading ${pctMatch[1]}%`);
      } else if (msg.includes("install")) {
        this._emitStatus("installing");
      } else if (msg.includes("Starting")) {
        this._emitStatus("starting server");
      }
    });
    if (!ready) {
      this._log("Ollama setup failed — PM agent disabled");
      this._emitStatus("disabled");
      return;
    }
    this._log(`PM agent started (model: ${this._session.model}, interval: ${(this._opts.scanIntervalMs ?? 300_000) / 1000}s)`);
    this._running = true;
    this._emitStatus("idle");

    // Run first cycle after a short delay
    setTimeout(() => this._cycle(), 10_000);

    // Then on interval
    this._timer = setInterval(
      () => this._cycle(),
      this._opts.scanIntervalMs ?? 300_000 // 5 min default
    );
  }

  stop(): void {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._session.cancel();
    savePMState(this._state, this._cwd);
  }

  getIdeas(): PMIdea[] {
    return this._state.ideas;
  }

  private async _cycle(): Promise<void> {
    if (!this._running) return;
    try {
      this._log("starting scan cycle...");
      this._emitStatus("scanning");

      // Step 1: Scan codebase
      const codeObs = scanCodebase(this._cwd);
      this._log(`codebase scan: ${codeObs.length} observations`);

      // Step 2: Scan conversations
      const convObs = scanConversations(this._cwd);
      this._log(`conversation scan: ${convObs.length} observations`);

      // Merge observations
      const allObs = [...codeObs, ...convObs];
      this._state.observations = allObs.slice(-100); // cap at 100
      this._state.lastScanAt = new Date().toISOString();

      // Step 3: Generate ideas via local model
      this._emitStatus("thinking");
      await this._generateIdeas(allObs);

      // Step 4: Check if any high-priority ideas are ready to propose
      const readyIdea = this._state.ideas.find(
        (i) => i.priority === "high" && i.score >= 7 && !this._state.proposalHistory.includes(i.id)
      );
      if (readyIdea) {
        this._log(`proposing: ${readyIdea.title}`);
        this._state.proposalHistory.push(readyIdea.id);
        this._opts.onProposal({
          idea: readyIdea,
          tlFeedback: "",
          fullProposal: `## ${readyIdea.title}\n\n**Problem:** ${readyIdea.problem}\n\n**Proposal:** ${readyIdea.proposal}\n\n**Priority:** ${readyIdea.priority}`,
        });
      }

      savePMState(this._state, this._cwd);
      this._emitStatus("idle");
      this._log("scan cycle complete");
    } catch (e) {
      this._log(`scan cycle error: ${e}`);
    }
  }

  private async _generateIdeas(observations: string[]): Promise<void> {
    const existingTitles = this._state.ideas.map((i) => i.title.toLowerCase());
    const prompt =
      `Here are my observations about the current state of the project:\n\n` +
      observations.map((o) => `- ${o}`).join("\n") +
      `\n\nExisting ideas (don't repeat): ${existingTitles.join(", ") || "(none)"}\n\n` +
      `Generate 1-3 NEW feature ideas based on these observations. Use <IDEA> blocks.`;

    let fullText = "";
    try {
      for await (const event of this._session.send(prompt)) {
        if (event.type === "assistant") {
          const content = event.message?.content || [];
          for (const item of content) {
            if (item.type === "text") fullText += item.text;
          }
        }
      }
    } catch (e) {
      this._log(`idea generation failed: ${e}`);
      return;
    }

    // Parse ideas
    for (const match of fullText.matchAll(IDEA_RE)) {
      try {
        const data = JSON.parse(match[1]);
        if (!data.title || !data.problem) continue;
        // Skip if duplicate
        if (existingTitles.includes(data.title.toLowerCase())) continue;

        const idea: PMIdea = {
          id: `idea_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          title: data.title,
          problem: data.problem,
          proposal: data.proposal ?? "",
          priority: ["high", "medium", "low"].includes(data.priority) ? data.priority : "medium",
          source: ["codebase", "conversation", "pattern"].includes(data.source) ? data.source : "codebase",
          createdAt: new Date().toISOString(),
          score: data.priority === "high" ? 8 : data.priority === "medium" ? 5 : 3,
          vetted: false,
        };
        this._state.ideas.push(idea);
        this._log(`new idea: ${idea.title} (${idea.priority})`);
      } catch {}
    }

    // Cap ideas at 50
    if (this._state.ideas.length > 50) {
      this._state.ideas = this._state.ideas
        .sort((a, b) => b.score - a.score)
        .slice(0, 50);
    }
  }
}

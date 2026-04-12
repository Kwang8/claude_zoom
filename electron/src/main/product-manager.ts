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
  cyclesSeen: number;   // how many cycles this idea has survived
  dismissed: boolean;   // user dismissed this idea
  tlAssessment: string | null; // TL's technical review
}

export interface PMProposal {
  idea: PMIdea;
  tlAssessment: string;
}

interface PMState {
  ideas: PMIdea[];
  observations: string[];
  lastScanAt: string | null;
  proposedIds: string[];      // idea IDs already proposed (avoid repeats)
  dismissedIds: string[];     // idea IDs user dismissed (PM learns)
  userAnswers: string[];      // answers from "needs direction" conversations
}

// ── System Prompts ──

const PM_SYSTEM_PROMPT = `\
You are a Product Manager embedded inside a software project. Your job is to \
deeply understand what this product does, who it's for, and then propose \
innovative features that would make it significantly more valuable.

STEP 1 — UNDERSTAND THE PRODUCT:
Read the codebase observations carefully. Figure out:
- What does this application actually do?
- Who are the users? What are they trying to accomplish?
- What's the core value proposition?
- What adjacent problems could this product solve?

STEP 2 — THINK BIG:
Go beyond reliability improvements (tests, linting, docs). Those are table stakes.
Think about NET NEW features — capabilities that don't exist yet and would be \
genuinely exciting. Think about what would make a user say "wow, I didn't know \
it could do that." Think about competitive advantages, novel workflows, and \
10x improvements.

STEP 3 — OUTPUT:
For each idea, output a JSON block:

<IDEA>
{
  "title": "Short feature name",
  "problem": "What user problem does this solve? Be specific.",
  "proposal": "Describe the user experience. What would they see, do, feel?",
  "priority": "high|medium|low",
  "source": "codebase|conversation|pattern"
}
</IDEA>

If you DON'T understand the product well enough to propose meaningful features, \
output an <ASK> block instead:

<ASK>
Your question for the user about the product vision, target users, or priorities.
</ASK>

RULES:
- Be SPECIFIC to THIS product. No generic suggestions like "add tests" or "add docs."
- Each idea should be a concrete feature a user would interact with.
- Think about what's MISSING, not what's BROKEN.
- 1-3 ideas per cycle, or 1-2 questions if you need direction.`;

const ASK_RE = /<ASK>([\s\S]*?)<\/ASK>/gi;

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
        proposedIds: data.proposedIds ?? data.proposalHistory ?? [],
        dismissedIds: data.dismissedIds ?? [],
        userAnswers: data.userAnswers ?? [],
      };
    }
  } catch (e) {
    console.warn("[pm] failed to load state:", e);
  }
  return { ideas: [], observations: [], lastScanAt: null, proposedIds: [], dismissedIds: [], userAnswers: [] };
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

  // List key files with their roles (inferred from name/path)
  const keyFiles = files
    .filter((f) => {
      const name = f.path.toLowerCase();
      return name.includes("app.") || name.includes("index.") ||
             name.includes("main.") || name.endsWith("package.json") ||
             name.includes("readme") || name.includes("manager") ||
             name.includes("engine") || name.includes("session") ||
             name.includes("agent");
    })
    .slice(0, 15);
  if (keyFiles.length > 0) {
    observations.push(`Key files: ${keyFiles.map((f) => f.path).join(", ")}`);
  }

  // Read package.json for project description
  const pkgFile = files.find((f) => f.path === "package.json" || f.path === "electron/package.json");
  if (pkgFile) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, pkgFile.path), "utf-8"));
      if (pkg.description) observations.push(`Project description: ${pkg.description}`);
      if (pkg.name) observations.push(`Project name: ${pkg.name}`);
      const deps = Object.keys(pkg.dependencies ?? {}).concat(Object.keys(pkg.devDependencies ?? {}));
      if (deps.length > 0) observations.push(`Dependencies: ${deps.slice(0, 20).join(", ")}`);
    } catch {}
  }

  // Read first 30 lines of key source files to understand what the app does
  const contentFiles = files
    .filter((f) => {
      const name = path.basename(f.path);
      return name === "App.tsx" || name === "index.ts" || name === "chat-engine.ts" ||
             name === "tech-lead.ts" || name === "product-manager.ts" ||
             name === "conversation-manager.ts";
    })
    .slice(0, 5);
  for (const cf of contentFiles) {
    try {
      const content = fs.readFileSync(path.join(cwd, cf.path), "utf-8");
      const preview = content.split("\n").slice(0, 30).join("\n").slice(0, 500);
      observations.push(`[${cf.path} preview]:\n${preview}`);
    } catch {}
  }

  // Component names (understand UI surface)
  const components = files
    .filter((f) => f.path.includes("components/") && f.path.endsWith(".tsx"))
    .map((f) => path.basename(f.path, ".tsx"));
  if (components.length > 0) {
    observations.push(`UI components: ${components.join(", ")}`);
  }

  // TODOs
  if (todos.length > 0) {
    observations.push(`Found ${todos.length} TODOs/FIXMEs:`);
    for (const todo of todos.slice(0, 10)) {
      observations.push(`  ${todo}`);
    }
  }

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
  onQuestion: (question: string) => void;
  vetWithTL: (idea: PMIdea) => Promise<string>; // returns TL assessment
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
      model: opts.ollamaModel ?? "qwen2.5:7b",
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

  /** Check if Ollama is ready without installing. Emits not_configured or idle. */
  async checkStatus(): Promise<void> {
    const available = await OllamaSession.isAvailable(this._session.baseUrl);
    if (available) {
      this._emitStatus("idle");
    } else {
      this._emitStatus("not_configured");
    }
  }

  /** User-triggered install: sets up Ollama, pulls model, starts PM loop. */
  async install(): Promise<void> {
    this._emitStatus("installing");
    const model = this._session.model;
    const ready = await ensureOllama(model, (msg) => {
      this._log(msg);
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
      this._log("Ollama setup failed");
      this._emitStatus("disabled");
      return;
    }
    this._startLoop();
  }

  /** Start the PM if Ollama is already available. No auto-install. */
  async start(): Promise<void> {
    const available = await OllamaSession.isAvailable(this._session.baseUrl);
    if (!available) {
      this._emitStatus("not_configured");
      return;
    }
    this._startLoop();
  }

  private _startLoop(): void {
    this._log(`PM agent started (model: ${this._session.model}, interval: ${(this._opts.scanIntervalMs ?? 900_000) / 1000}s)`);
    this._running = true;
    this._emitStatus("idle");

    // Run first cycle after a short delay
    setTimeout(() => this._cycle(), 30_000);

    // Then on interval
    this._timer = setInterval(
      () => this._cycle(),
      this._opts.scanIntervalMs ?? 900_000 // 15 min default
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

  getObservations(): string[] {
    return this._state.observations;
  }

  /** Mark an idea as dismissed — PM learns to avoid similar ideas. */
  dismissIdea(ideaId: string): void {
    this._state.dismissedIds.push(ideaId);
    const idea = this._state.ideas.find((i) => i.id === ideaId);
    if (idea) idea.dismissed = true;
    savePMState(this._state, this._cwd);
    this._log(`idea dismissed: ${idea?.title ?? ideaId}`);
  }

  private async _cycle(): Promise<void> {
    if (!this._running) return;
    try {
      this._log("starting scan cycle...");
      this._emitStatus("scanning");

      // Step 1: Scan codebase + conversations
      const codeObs = scanCodebase(this._cwd);
      const convObs = scanConversations(this._cwd);
      const allObs = [...codeObs, ...convObs];
      this._state.observations = allObs.slice(-100);
      this._state.lastScanAt = new Date().toISOString();
      this._log(`scan: ${codeObs.length} code + ${convObs.length} conversation observations`);

      // Step 1.5: If PM has no product context yet, use the local model to ask smart questions
      if (this._state.userAnswers.length === 0) {
        this._log("no product context yet — generating questions from scan");
        this._emitStatus("thinking");
        const question = await this._generateQuestions(allObs);
        if (question) {
          this._opts.onQuestion(question);
        }
        savePMState(this._state, this._cwd);
        this._emitStatus("idle");
        this._log("scan cycle complete (waiting for user context)");
        return;
      }

      // Step 2: Generate new ideas via local model
      this._emitStatus("thinking");
      await this._generateIdeas(allObs);

      // Step 3: Age existing ideas — bump score for ideas that survive cycles
      for (const idea of this._state.ideas) {
        if (!idea.dismissed) {
          idea.cyclesSeen = (idea.cyclesSeen ?? 0) + 1;
          // Ideas that persist get a small score bump (max 10)
          if (idea.cyclesSeen >= 3 && idea.score < 10) {
            idea.score = Math.min(10, idea.score + 0.5);
          }
        }
      }

      // Step 4: Find the best unvetted idea to send to TL
      const candidate = this._state.ideas
        .filter((i) =>
          !i.dismissed &&
          !i.tlAssessment &&
          !this._state.proposedIds.includes(i.id) &&
          i.cyclesSeen >= 2 && // must survive at least 2 cycles
          i.score >= 6
        )
        .sort((a, b) => b.score - a.score)[0];

      if (candidate) {
        this._log(`vetting with TL: ${candidate.title}`);
        this._emitStatus("vetting");
        try {
          const assessment = await this._opts.vetWithTL(candidate);
          candidate.tlAssessment = assessment;
          this._log(`TL assessment received for: ${candidate.title}`);

          // If TL says it's feasible, propose
          if (assessment && !assessment.toLowerCase().includes("not feasible")) {
            this._state.proposedIds.push(candidate.id);
            this._opts.onProposal({ idea: candidate, tlAssessment: assessment });
            this._log(`proposed: ${candidate.title}`);
          }
        } catch (e) {
          this._log(`TL vetting failed: ${e}`);
        }
      }

      savePMState(this._state, this._cwd);
      this._emitStatus("idle");
      this._log("scan cycle complete");
    } catch (e) {
      this._log(`scan cycle error: ${e}`);
    }
  }

  /** Use the local model to generate project-specific questions based on scan results. */
  private async _generateQuestions(observations: string[]): Promise<string | null> {
    const prompt =
      `I just scanned a software project. Here's what I found:\n\n` +
      observations.map((o) => `- ${o}`).join("\n") +
      `\n\nBased on what you can see about this project, write 3-4 specific questions ` +
      `to ask the developer to help you understand the product vision and generate ` +
      `innovative feature ideas. Your questions should reference specific things you ` +
      `noticed in the codebase — file names, components, architecture patterns. ` +
      `Don't ask generic questions. Ask questions that show you understand what this ` +
      `project is and want to go deeper.\n\n` +
      `Format: just the questions as a numbered list, nothing else.`;

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
      this._log(`question generation failed: ${e}`);
      return null;
    }

    return fullText.trim() || null;
  }

  /** Record an answer from the user (from a "needs direction" conversation). */
  addUserAnswer(answer: string): void {
    this._state.userAnswers.push(answer);
    savePMState(this._state, this._cwd);
  }

  private async _generateIdeas(observations: string[]): Promise<void> {
    const existingTitles = this._state.ideas.map((i) => i.title.toLowerCase());

    // Build context with product understanding
    const parts: string[] = [];
    parts.push(`Here are my observations about the current state of the project:\n`);
    parts.push(observations.map((o) => `- ${o}`).join("\n"));

    if (this._state.userAnswers.length > 0) {
      parts.push(`\n\nProduct context from the user:`);
      for (const answer of this._state.userAnswers) {
        parts.push(`- ${answer}`);
      }
    }

    parts.push(`\n\nExisting ideas (don't repeat): ${existingTitles.join(", ") || "(none)"}`);

    const dismissedTitles = this._state.ideas.filter((i) => i.dismissed).map((i) => i.title);
    if (dismissedTitles.length > 0) {
      parts.push(`Dismissed by user (AVOID these topics): ${dismissedTitles.join(", ")}`);
    }

    parts.push(`\nGenerate 1-3 NEW innovative feature ideas. Focus on net-new capabilities, not reliability improvements. If you don't understand what this product does or who it's for, use <ASK> to ask the user.`);

    const prompt = parts.join("\n");

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
          score: data.priority === "high" ? 7 : data.priority === "medium" ? 4 : 2,
          cyclesSeen: 0,
          dismissed: false,
          tlAssessment: null,
        };
        this._state.ideas.push(idea);
        this._log(`new idea: ${idea.title} (${idea.priority})`);
      } catch {}
    }

    // Handle <ASK> blocks — PM needs direction from user
    for (const match of fullText.matchAll(ASK_RE)) {
      const question = match[1].trim();
      if (question) {
        this._log(`PM needs direction: ${question.slice(0, 80)}`);
        this._opts.onQuestion(question);
      }
    }

    // Cap ideas at 50
    if (this._state.ideas.length > 50) {
      this._state.ideas = this._state.ideas
        .sort((a, b) => b.score - a.score)
        .slice(0, 50);
    }
  }
}

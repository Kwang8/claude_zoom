import { execFile, execFileSync } from "child_process";
import path from "path";
import { ClaudeSession } from "./claude-session";
import { RemoteClaudeSession } from "./remote-session";
import { summarizeTurn } from "./narrator";

// ── Voice trigger detection ──

const VOICE_TRIGGERS = [
  /(?:spin\s+(?:off|up)|spawn|launch|start|kick\s+off|fire\s+up)\s+(?:a\s+)?(?:new\s+)?(?:(remote)\s+)?(?:sub[- ]?)?agent\s+(?:to\s+)?(.+)/i,
  /in\s+the\s+background[,:]?\s+(.+)/i,
  /(?:send|dispatch)\s+(?:a\s+)?(?:new\s+)?agent\s+(?:to\s+)?(.+)/i,
];

const REMOTE_TASK_PREFIX_RE =
  /^(?:(?:a|an)\s+)?remote\s+(?:sub[- ]?)?agent\s+(?:to\s+)?/i;

const FILLER_RE =
  /^(?:(?:yeah|yes|yep|ok|okay|sure|hey|please|so|um|uh|well|let's|let\s+us|can\s+you|go\s+ahead\s+and|I\s+want\s+to|could\s+you|I'd\s+like\s+to)\s*,?\s*)+/i;

export function parseVoiceTrigger(transcript: string): [string, boolean] | null {
  const text = transcript.trim().replace(FILLER_RE, "").trim();
  for (const pattern of VOICE_TRIGGERS) {
    const m = pattern.exec(text);
    if (m) {
      const remoteHint = Boolean(m[1] && m.length > 2);
      const taskIndex = m.length > 2 ? 2 : 1;
      const normalized = normalizeSpawnRequest(m[taskIndex].trim(), remoteHint);
      return normalized[0] ? normalized : null;
    }
  }
  return null;
}

// ── Agent targeting ──

const AGENT_TARGET_RE = /(?:hey\s+)?agent\s+([\w][\w-]*)[,:]?\s+(.+)/i;

export function parseAgentTarget(
  transcript: string
): [string, string] | null {
  const text = transcript.trim().replace(FILLER_RE, "").trim();
  const m = AGENT_TARGET_RE.exec(text);
  if (m) {
    const ref = m[1].trim();
    const msg = m[2].trim();
    return msg ? [ref, msg] : null;
  }
  return null;
}

// ── SPAWN marker parsing ──

const SPAWN_RE = /<SPAWN(?<attrs>[^>]*)>(?<body>.*?)<\/SPAWN>/gis;
const SPAWN_NAME_RE = /\bname=["']([^"']+)["']/i;
const SPAWN_REMOTE_RE = /\bremote=["']?(?:true|1|yes|remote)["']?/i;

export function parseSpawnMarkers(text: string): [string, string, boolean][] {
  const results: [string, string, boolean][] = [];
  let m: RegExpExecArray | null;
  SPAWN_RE.lastIndex = 0;
  while ((m = SPAWN_RE.exec(text)) !== null) {
    const attrs = m.groups?.attrs || "";
    const body = (m.groups?.body || "").trim();
    const nameMatch = SPAWN_NAME_RE.exec(attrs);
    if (!nameMatch) continue;
    const remoteHint = SPAWN_REMOTE_RE.test(attrs);
    const [task, remote] = normalizeSpawnRequest(body, remoteHint);
    if (task) results.push([nameMatch[1].trim(), task, remote]);
  }
  return results;
}

function normalizeSpawnRequest(task: string, remoteHint: boolean): [string, boolean] {
  let text = task.trim();
  let remote = remoteHint;
  const prefix = REMOTE_TASK_PREFIX_RE.exec(text);
  if (prefix) {
    remote = true;
    text = text.slice(prefix[0].length).trim();
  }
  return [text, remote];
}

// ── Git worktree helpers ──

const WORKTREE_DIR = ".claude_zoom_agents";

export function setupWorktree(baseCwd: string, agentId: string): string {
  const worktreePath = path.join(baseCwd, WORKTREE_DIR, agentId);
  const result = execFileSync("git", ["worktree", "add", "--detach", worktreePath], {
    cwd: baseCwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return worktreePath;
}

export function cleanupWorktree(baseCwd: string, worktreePath: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: baseCwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {}
}

export function isGitRepo(repoPath: string): boolean {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export function inferGithubRepo(repoPath: string): string | null {
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!url) return null;
    const match = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

function sanitizeBranchName(task: string): string {
  let slug = task.toLowerCase().replace(/[^\w\s-]/g, "");
  slug = slug.replace(/[\s_]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `claude-zoom/${slug.slice(0, 50)}` : "claude-zoom/agent-work";
}

function hasChanges(cwd: string): number {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function commitAndPush(agent: AgentInstance): string | null {
  const cwd = agent.worktreePath;
  if (!cwd) return null;
  if (hasChanges(cwd) === 0) return null;

  const branch = sanitizeBranchName(agent.task);
  try {
    execFileSync("git", ["checkout", "-b", branch], { cwd, stdio: "pipe" });
  } catch {}
  try {
    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe" });
  } catch {}
  const msg = `${agent.name}: ${agent.task.slice(0, 100)}`;
  try {
    execFileSync("git", ["commit", "-m", msg], { cwd, stdio: "pipe" });
  } catch {}
  try {
    execFileSync("git", ["push", "-u", "origin", branch], { cwd, stdio: "pipe" });
  } catch {
    return null;
  }
  return branch;
}

function createPr(agent: AgentInstance, branch: string): string | null {
  const cwd = agent.worktreePath || ".";
  const title = `[claude-zoom] ${agent.name}: ${agent.task.slice(0, 60)}`;
  const body =
    `## Summary\nAuto-generated by claude-zoom sub-agent **${agent.name}**.\n\n` +
    `**Task:** ${agent.task}\n\n---\n` +
    `Generated with [claude-zoom](https://github.com/Kwang8/claude_zoom)`;

  try {
    const out = execFileSync(
      "gh",
      ["pr", "create", "--title", title, "--body", body, "--head", branch],
      { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

// ── Smart message routing ──

export function classifyMessageTarget(
  transcript: string,
  lastSpeakerName: string,
  lastSpeakerTask: string
): Promise<string> {
  const prompt =
    `Sub-agent "${lastSpeakerName}" just finished and reported on its ` +
    `task: "${lastSpeakerTask}"\n` +
    `The user then said: "${transcript}"\n\n` +
    `Is the user directing this at the sub-agent (giving it follow-up ` +
    `work, responding to its report, or continuing the conversation with ` +
    `it), or is the user talking to the main assistant about something ` +
    `unrelated?\nReply with exactly one word: AGENT or MAIN`;

  return new Promise((resolve) => {
    const proc = execFile(
      "claude",
      ["-p", "--output-format", "json", "--model", "haiku"],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) { resolve("main"); return; }
        try {
          const data = JSON.parse(stdout);
          const answer = (data.result || "").trim().toUpperCase();
          resolve(answer.includes("AGENT") ? "agent" : "main");
        } catch {
          resolve("main");
        }
      }
    );
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  });
}

// ── Speech queue ──

export interface SpeechItem {
  label: string;
  text: string;
  requiresResponse: boolean;
  agentId: string;
  questionType: string; // "pr" | "agent_question" | ""
}

export class SpeechQueue {
  private items: SpeechItem[] = [];
  private _waiter: ((item: SpeechItem) => void) | null = null;
  private _waiterTimer: ReturnType<typeof setTimeout> | null = null;

  put(
    label: string,
    text: string,
    opts: { requiresResponse?: boolean; agentId?: string; questionType?: string } = {}
  ): void {
    const item: SpeechItem = {
      label,
      text,
      requiresResponse: opts.requiresResponse ?? false,
      agentId: opts.agentId ?? "",
      questionType: opts.questionType ?? "",
    };
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      if (this._waiterTimer) { clearTimeout(this._waiterTimer); this._waiterTimer = null; }
      w(item);
    } else {
      this.items.push(item);
    }
  }

  get(timeoutMs: number): Promise<SpeechItem | null> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift()!);
    }
    return new Promise((resolve) => {
      this._waiter = (item) => resolve(item);
      this._waiterTimer = setTimeout(() => {
        this._waiter = null;
        this._waiterTimer = null;
        resolve(null);
      }, timeoutMs);
    });
  }

  drain(): void {
    this.items = [];
    this._waiter = null;
    // Timer will fire and resolve(null), which is fine
  }
}

// ── Question extraction ──

const QUESTION_RE = /<QUESTION>(.*?)<\/QUESTION>/is;

function extractQuestion(events: Record<string, any>[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "assistant") continue;
    const content = event.message?.content || [];
    for (let j = content.length - 1; j >= 0; j--) {
      const item = content[j];
      if (item.type !== "text") continue;
      const m = QUESTION_RE.exec(item.text || "");
      if (m) return m[1].trim();
    }
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteTaskPathsForWorktree(
  task: string,
  baseCwd: string,
  worktreePath: string | null
): string {
  if (!worktreePath || !task.includes(baseCwd)) return task;
  return task.replace(new RegExp(escapeRegExp(baseCwd), "g"), worktreePath);
}

// ── Agent instance ──

const SUB_AGENT_SYSTEM_PROMPT = `\
You are a sub-agent given one focused task. Complete it and state the outcome \
in 1-2 sentences. Do not narrate your tool calls. Just do the work and report \
the result.

You may be running inside an isolated git worktree that mirrors the main \
project. Treat your current working directory as the project root for your \
task. If the task mentions absolute paths from the main checkout, use the \
equivalent paths in your current workspace instead of asking for access to the \
parent checkout.

Interpret the assigned task as work for you to perform directly. If the task \
mentions your own name or says things like "ask Argus...", "tell Argus...", \
"send this to Argus...", or otherwise appears to instruct someone to contact \
you, strip that framing and do the underlying work yourself.

Never attempt to spawn, contact, trigger, authenticate, or hand off to other \
agents, sessions, or remote APIs. You do not need workspace auth or an org UUID \
to complete your assignment. Use the tools available in your environment and \
answer from your own work.

If you reach a decision point where you genuinely need user input before \
continuing — e.g. permission to delete files, a choice between two approaches, \
or critical missing information — emit exactly one block anywhere in your \
response:

<QUESTION>Your specific question here?</QUESTION>

Then stop working. The user will be notified and their answer forwarded to you \
in the next message. After receiving the answer, continue your task.

Only use <QUESTION> when truly blocked. Most tasks should complete without it.`;

export type AgentStatus = "working" | "done" | "error" | "pr_pending" | "needs_input";

export interface AgentInstance {
  id: string;
  name: string;
  session: ClaudeSession | RemoteClaudeSession;
  worktreePath: string | null;
  baseCwd: string;
  task: string;
  remote: boolean;
  repo: string | null;
  auth: string;
  status: AgentStatus;
  events: Record<string, any>[];
  taskQueue: string[];
  branch: string | null;
  number: number;
  pendingQuestion: string | null;
}

export function formatAgentDisplayName(agent: Pick<AgentInstance, "name" | "number" | "remote">): string {
  const prefix = agent.remote ? "remote agent" : "agent";
  return `${prefix} ${agent.number} (${agent.name})`;
}

function agentLabel(agent: AgentInstance): string {
  return formatAgentDisplayName(agent);
}

export type OnAgentEvent = (agentId: string, event: Record<string, any>) => void;
export type OnAgentDone = (agentId: string) => void;

// ── Agent manager ──

export class AgentManager {
  agents: Map<string, AgentInstance> = new Map();
  speechQueue: SpeechQueue;
  maxAgents: number;
  _counter = 0;

  constructor(speechQueue: SpeechQueue, maxAgents: number = 10) {
    this.speechQueue = speechQueue;
    this.maxAgents = maxAgents;
  }

  spawn(opts: {
    task: string;
    name: string;
    baseCwd: string;
    model?: string;
    permissionMode?: string;
    remote?: boolean;
    repo?: string | null;
    auth?: string;
    onEvent?: OnAgentEvent;
    onDone?: OnAgentDone;
  }): AgentInstance {
    const working = [...this.agents.values()].filter((a) => a.status === "working");
    if (working.length >= this.maxAgents) {
      throw new Error(`max ${this.maxAgents} concurrent sub-agents reached`);
    }

    this._counter++;
    const agentId = `sub-${this._counter}`;

    let worktreePath: string | null = null;
    let cwd = opts.baseCwd;
    const remote = opts.remote ?? false;
    const auth = opts.auth ?? "oauth";
    const repo = opts.repo ?? null;
    let session: ClaudeSession | RemoteClaudeSession;
    let task = opts.task;

    if (remote) {
      session = new RemoteClaudeSession({
        cwd,
        model: opts.model ?? "sonnet",
        permissionMode: "bypassPermissions",
        appendSystemPrompt: SUB_AGENT_SYSTEM_PROMPT,
        repo,
        auth,
      });
    } else {
      if (isGitRepo(opts.baseCwd)) {
        try {
          worktreePath = setupWorktree(opts.baseCwd, agentId);
          cwd = worktreePath;
          task = rewriteTaskPathsForWorktree(task, opts.baseCwd, worktreePath);
        } catch {}
      }

      session = new ClaudeSession({
        cwd,
        model: opts.model ?? "sonnet",
        permissionMode: "bypassPermissions",
        appendSystemPrompt: SUB_AGENT_SYSTEM_PROMPT,
      });
    }

    const agent: AgentInstance = {
      id: agentId,
      name: opts.name,
      session,
      worktreePath,
      baseCwd: opts.baseCwd,
      task,
      remote,
      repo,
      auth,
      status: "working",
      events: [],
      taskQueue: [],
      branch: null,
      number: this._counter,
      pendingQuestion: null,
    };

    this.agents.set(agentId, agent);

    // Fire and forget the worker
    this._runAgentTask(agent, opts.onEvent, opts.onDone).catch((err) => {
      console.error(`[agent ${agent.name}] worker error:`, err);
    });

    return agent;
  }

  private async _runAgentTask(
    agent: AgentInstance,
    onEvent?: OnAgentEvent,
    onDone?: OnAgentDone
  ): Promise<void> {
    try {
      for await (const event of agent.session.send(agent.task)) {
        agent.events.push(event);
        if (onEvent) {
          try { onEvent(agent.id, event); } catch {}
        }
      }

      const question = extractQuestion(agent.events);
      if (question) {
        agent.pendingQuestion = question;
        agent.status = "needs_input";
        this.speechQueue.put(agentLabel(agent), `I have a question: ${question}`, {
          requiresResponse: true,
          agentId: agent.id,
          questionType: "agent_question",
        });
      } else {
        let branch: string | null = null;
        if (!agent.remote && agent.worktreePath && hasChanges(agent.worktreePath)) {
          branch = commitAndPush(agent);
          agent.branch = branch;
        }

        let summary: string;
        try {
          summary = await summarizeTurn(agent.task, agent.events);
        } catch (e) {
          summary = `Agent ${agent.name} hit a summarize error: ${e}`;
        }
        if (!summary) summary = "Done.";

        if (branch) {
          agent.status = "pr_pending";
          this.speechQueue.put(
            agentLabel(agent),
            `${summary} I made changes and pushed branch ${branch}. Want me to open a PR?`,
            { requiresResponse: true, agentId: agent.id, questionType: "pr" }
          );
        } else {
          agent.status = "done";
          this.speechQueue.put(agentLabel(agent), summary, { agentId: agent.id });
        }
      }
    } catch (e) {
      agent.status = "error";
      this.speechQueue.put(agentLabel(agent), `Error: ${e}`, { agentId: agent.id });
    } finally {
      if (onDone) {
        try { onDone(agent.id); } catch {}
      }
      if (!agent.remote && !["pr_pending", "needs_input"].includes(agent.status) && agent.worktreePath) {
        cleanupWorktree(agent.baseCwd, agent.worktreePath);
      }
    }

    // Process queued follow-ups
    while (agent.taskQueue.length > 0 && ["done", "pr_pending"].includes(agent.status)) {
      const nextTask = agent.taskQueue.shift()!;
      agent.task = nextTask;
      agent.status = "working";
      agent.events = [];
      if (onDone) { try { onDone(agent.id); } catch {} }

      try {
        for await (const event of agent.session.send(nextTask)) {
          agent.events.push(event);
          if (onEvent) { try { onEvent(agent.id, event); } catch {} }
        }
        agent.status = "done";
        let summary: string;
        try {
          summary = await summarizeTurn(nextTask, agent.events);
        } catch (e) {
          summary = `Agent ${agent.name} hit a summarize error: ${e}`;
        }
        if (!summary) summary = "Done.";
        this.speechQueue.put(agentLabel(agent), summary, { agentId: agent.id });
      } catch (e) {
        agent.status = "error";
        this.speechQueue.put(agentLabel(agent), `Error: ${e}`, { agentId: agent.id });
      } finally {
        if (onDone) { try { onDone(agent.id); } catch {} }
      }
    }
  }

  handlePrDecision(agentId: string, approved: boolean): string | null {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== "pr_pending") return null;

    let prUrl: string | null = null;
    if (approved && agent.branch) {
      prUrl = createPr(agent, agent.branch);
    }
    agent.status = "done";
    if (agent.worktreePath) {
      cleanupWorktree(agent.baseCwd, agent.worktreePath);
    }
    return prUrl;
  }

  handleAgentQuestion(
    agentId: string,
    userResponse: string,
    onEvent?: OnAgentEvent,
    onDone?: OnAgentDone
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status !== "needs_input") return;

    const question = agent.pendingQuestion || "your question";
    agent.pendingQuestion = null;
    const message =
      `The user answered your question.\n` +
      `Question: ${question}\n` +
      `Answer: ${userResponse}\n\n` +
      `Continue your task using this information.`;

    this.sendToAgent(agent, message, onEvent, onDone);
  }

  resolveAgentRef(ref: string): AgentInstance | null {
    // Try number
    if (/^\d+$/.test(ref)) {
      const num = parseInt(ref, 10);
      for (const a of this.agents.values()) {
        if (a.number === num) return a;
      }
    }
    // Try name
    const lower = ref.toLowerCase();
    for (const a of this.agents.values()) {
      if (a.name.toLowerCase() === lower) return a;
    }
    // Try id suffix
    for (const a of this.agents.values()) {
      if (a.id.endsWith(ref)) return a;
    }
    return null;
  }

  sendToAgent(
    agent: AgentInstance,
    message: string,
    onEvent?: OnAgentEvent,
    onDone?: OnAgentDone
  ): void {
    const rewrittenMessage = rewriteTaskPathsForWorktree(
      message,
      agent.baseCwd,
      agent.worktreePath
    );
    if (agent.status === "working") {
      agent.taskQueue.push(rewrittenMessage);
      return;
    }
    agent.task = rewrittenMessage;
    agent.status = "working";
    agent.events = [];

    this._runAgentTask(agent, onEvent, onDone).catch((err) => {
      console.error(`[agent ${agent.name}] worker error:`, err);
    });
  }

  kill(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.session.cancel();
    if ("close" in agent.session && typeof agent.session.close === "function") {
      void agent.session.close();
    }
    this.agents.delete(agentId);
  }

  killAll(): void {
    for (const id of this.agents.keys()) {
      this.kill(id);
    }
  }

  get allAgents(): AgentInstance[] {
    return [...this.agents.values()];
  }

  get activeAgents(): AgentInstance[] {
    return [...this.agents.values()].filter((a) => a.status === "working");
  }

  subSystemPrompt(): string {
    return SUB_AGENT_SYSTEM_PROMPT;
  }
}

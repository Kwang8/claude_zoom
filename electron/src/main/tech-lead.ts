import { ClaudeSession } from "./claude-session";
import { extractFinalText } from "./narrator";
import { ContextTree, ProjectMemory, emptyMemory } from "./context-tree";

// ── TL System Prompt ──

const TL_SYSTEM_PROMPT = `\
You are the Tech Lead — the primary interface of a voice-controlled coding \
assistant. The user speaks to you directly. You coordinate sub-agents to do \
the actual coding work.

CRITICAL RULE: DO NOT USE TOOLS TO EXPLORE THE CODEBASE. You are on the \
critical path — every second you spend reading files is a second the user \
waits. Sub-agents have full tool access and will explore on their own. Your \
job is to DECOMPOSE, COORDINATE, and COMMUNICATE.

Every message you receive will start with a [CONTEXT TREE] block showing all \
active/completed tasks, agents, statuses, results, Q&A, and your accumulated \
project memory. Use this as your source of truth.

FOR USER INPUT, decide which category it falls into:

1. WORK REQUEST (code, bugs, features, refactoring, PRs, git, etc.):
   - Break it down into sub-agent assignments using <SPAWN>
   - Give each agent a clear, focused task — they find files themselves
   - Spawn multiple agents in parallel when tasks are independent
   - Include a brief <REPORT> acknowledging the request

2. STATUS QUESTION ("what's happening?", "how's it going?", "what are agents doing?"):
   - Check the context tree and summarize current state in <REPORT>
   - No spawning needed

3. GREETING or SMALL TALK ("hi", "thanks", "bye"):
   - Reply naturally in <REPORT>. No spawning needed.

4. ANSWERING YOUR QUESTION:
   - Use the answer, provide <ANSWER> for the waiting sub-agent

<SPAWN name="short-name">
Clear task description. State the goal and constraints. The agent has full \
codebase access and will find relevant files itself.
</SPAWN>

WHEN AN AGENT HAS A QUESTION:
Consult the CONTEXT TREE first. Only escalate to the user for product \
decisions or preferences.

<ANSWER>Your answer from context</ANSWER>
<ESCALATE>Question for the user (last resort)</ESCALATE>

WHEN AN AGENT FINISHES:
- Work complete? → <APPROVE> and <REPORT>
- Needs fixes? → <FIX>
- Needs follow-up? → <SPAWN> more agents
- Output relevant to another agent? → Connect the dots

<APPROVE agent="name">What was accomplished</APPROVE>
<FIX agent="name">What to fix and why</FIX>
<REPORT>Summary for the user — spoken aloud, keep it under 3 sentences</REPORT>

MEMORY: After completing a task or learning something important about the \
project, emit <INSIGHT> to record it for future conversations.

<INSIGHT>What you learned about the project, codebase, or user preferences</INSIGHT>

BE FAST. The user is waiting. Respond in seconds, not minutes.`;

// ── Response Parsing ──

const SPAWN_RE = /<SPAWN\s+name=["']([^"']+)["']>(.*?)<\/SPAWN>/gis;
const ANSWER_RE = /<ANSWER>(.*?)<\/ANSWER>/is;
const ESCALATE_RE = /<ESCALATE>(.*?)<\/ESCALATE>/is;
const APPROVE_RE = /<APPROVE\s+agent=["']([^"']+)["']>(.*?)<\/APPROVE>/gis;
const FIX_RE = /<FIX\s+agent=["']([^"']+)["']>(.*?)<\/FIX>/gis;
const REPORT_RE = /<REPORT>(.*?)<\/REPORT>/is;
const INSIGHT_RE = /<INSIGHT>(.*?)<\/INSIGHT>/gis;

export interface TLResponse {
  spawns: [string, string][];        // [name, task]
  answer: string | null;
  escalation: string | null;
  approvals: [string, string][];     // [agentName, summary]
  fixes: [string, string][];         // [agentName, instruction]
  report: string | null;
  insights: string[];
}

export function parseTLResponse(events: Record<string, any>[]): TLResponse {
  const text = extractFinalText(events);
  return parseTLText(text);
}

export function parseTLText(text: string): TLResponse {
  const spawns: [string, string][] = [];
  for (const m of text.matchAll(SPAWN_RE)) {
    spawns.push([m[1].trim(), m[2].trim()]);
  }

  const answerMatch = ANSWER_RE.exec(text);
  const escalateMatch = ESCALATE_RE.exec(text);
  const reportMatch = REPORT_RE.exec(text);

  const approvals: [string, string][] = [];
  for (const m of text.matchAll(APPROVE_RE)) {
    approvals.push([m[1].trim(), m[2].trim()]);
  }

  const fixes: [string, string][] = [];
  for (const m of text.matchAll(FIX_RE)) {
    fixes.push([m[1].trim(), m[2].trim()]);
  }

  const insights: string[] = [];
  for (const m of text.matchAll(INSIGHT_RE)) {
    insights.push(m[1].trim());
  }

  return {
    spawns,
    answer: answerMatch ? answerMatch[1].trim() : null,
    escalation: escalateMatch ? escalateMatch[1].trim() : null,
    approvals,
    fixes,
    report: reportMatch ? reportMatch[1].trim() : null,
    insights,
  };
}

// ── TechLead Class ──

export class TechLead {
  private _session: ClaudeSession;
  contextTree: ContextTree;

  constructor(cwd: string, permissionMode: string = "bypassPermissions") {
    this._session = new ClaudeSession({
      cwd,
      model: "sonnet",
      permissionMode,
      appendSystemPrompt: TL_SYSTEM_PROMPT,
      tools: "",  // No tools — TL is a fast coordinator, not a researcher
    });
    this.contextTree = new ContextTree();
  }

  get sessionId(): string | null {
    return this._session.sessionId;
  }

  restoreSession(id: string | null): void {
    this._session.sessionId = id;
  }

  /** Restore persistent memory from saved state. */
  restoreMemory(memory: ProjectMemory | null): void {
    if (memory) {
      this.contextTree.memory = memory;
    }
  }

  /** Get current memory for persistence. */
  getMemory(): ProjectMemory {
    return this.contextTree.memory;
  }

  /** Process insights from a TL response and add to memory. */
  recordInsights(response: TLResponse): void {
    for (const insight of response.insights) {
      this.contextTree.addInsight(insight);
    }
  }

  async delegateTask(
    task: string,
    onEvent?: (event: Record<string, any>) => void
  ): Promise<TLResponse> {
    this.contextTree.addTask(task);
    const prompt = this._withContext(task);
    const events = await this._collect(prompt, onEvent);
    const response = parseTLResponse(events);
    this.recordInsights(response);
    return response;
  }

  async handleAgentQuestion(
    agentName: string,
    agentId: string,
    question: string,
    taskContext: string
  ): Promise<TLResponse> {
    this.contextTree.addAgentQuestion(agentId, question);
    const prompt = this._withContext(
      `Sub-agent "${agentName}" (${agentId}) has a question while working on: ${taskContext}\n\n` +
      `Question: ${question}\n\n` +
      `Check the context tree for relevant information. Answer from your knowledge ` +
      `of the task. If you truly need user input, use <ESCALATE>.`
    );
    const events = await this._collect(prompt);
    const response = parseTLResponse(events);
    this.recordInsights(response);
    return response;
  }

  async reviewResult(
    agentName: string,
    agentId: string,
    task: string,
    summary: string
  ): Promise<TLResponse> {
    this.contextTree.setAgentResult(agentId, summary);
    this.contextTree.checkTaskCompletion();
    const prompt = this._withContext(
      `Sub-agent "${agentName}" (${agentId}) completed its task.\n` +
      `Task: ${task}\n` +
      `Result: ${summary}\n\n` +
      `Review this result. If satisfactory, <APPROVE> and <REPORT> to the user. ` +
      `If it needs fixes, use <FIX>. If follow-up work is needed, use <SPAWN>. ` +
      `If you learned something about the project, emit <INSIGHT>.`
    );
    const events = await this._collect(prompt);
    const response = parseTLResponse(events);
    this.recordInsights(response);
    return response;
  }

  async forwardUserAnswer(question: string, answer: string, agentId: string | null): Promise<TLResponse> {
    if (agentId) this.contextTree.addAgentAnswer(agentId, answer);
    const prompt = this._withContext(
      `The user answered your question.\n` +
      `Question was: ${question}\n` +
      `Answer: ${answer}\n\n` +
      `Continue with this information. Provide an <ANSWER> for the waiting sub-agent.`
    );
    const events = await this._collect(prompt);
    const response = parseTLResponse(events);
    this.recordInsights(response);
    return response;
  }

  cancel(): void {
    this._session.cancel();
  }

  /** Prepend the serialized context tree to a prompt. */
  private _withContext(prompt: string): string {
    return `[CONTEXT TREE]\n${this.contextTree.serialize()}\n[/CONTEXT TREE]\n\n${prompt}`;
  }

  private async _collect(
    prompt: string,
    onEvent?: (event: Record<string, any>) => void
  ): Promise<Record<string, any>[]> {
    console.log("[tl] sending prompt to TL session...", prompt.slice(0, 120));
    const events: Record<string, any>[] = [];
    try {
      for await (const event of this._session.send(prompt)) {
        events.push(event);
        if (onEvent) onEvent(event);
        if (event.type === "assistant") {
          const text = (event.message?.content || [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          if (text) console.log("[tl] assistant text:", text.slice(0, 200));
        }
      }
      console.log("[tl] session.send() finished, got", events.length, "events");
    } catch (e) {
      console.error("[tl] session.send() threw:", e);
      throw e;
    }
    return events;
  }
}

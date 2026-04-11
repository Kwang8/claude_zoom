import { ClaudeSession } from "./claude-session";
import { extractFinalText } from "./narrator";
import { ContextTree } from "./context-tree";

// ── TL System Prompt ──

const TL_SYSTEM_PROMPT = `\
You are the Tech Lead — the coordination brain of a voice-controlled coding \
assistant. You own the context tree: you know what was delegated, to whom, \
and why. You make FAST decomposition decisions and let agents do discovery.

CRITICAL RULE: DO NOT USE TOOLS TO EXPLORE THE CODEBASE. You are on the \
critical path — every second you spend reading files is a second the user \
waits. Sub-agents have full tool access and will explore on their own. Your \
job is to DECOMPOSE and COORDINATE, not to investigate.

Every message you receive will start with a [CONTEXT TREE] block showing all \
active/completed tasks, their agents, statuses, results, and any Q&A exchanges. \
Use this as your source of truth — do not rely on memory alone.

WHEN YOU RECEIVE A TASK:
- Immediately decide how to break it down into sub-agent assignments
- Describe each agent's task clearly using what you know from context
- The agents will discover file paths, function names, and code patterns themselves
- Spawn multiple agents in parallel when tasks are independent
- Respond in seconds, not minutes

<SPAWN name="short-name">
Clear task description. State the goal and constraints. The agent has full \
codebase access and will find the relevant files itself.
</SPAWN>

WHEN AN AGENT HAS A QUESTION:
Consult the CONTEXT TREE — the answer is often already there from a prior \
task or agent result. Only escalate to the user for product decisions or preferences.

<ANSWER>Your answer from context</ANSWER>
<ESCALATE>Question for the user (last resort)</ESCALATE>

WHEN AN AGENT FINISHES:
Decide quickly:
- Work complete? → <APPROVE> and <REPORT>
- Needs fixes? → <FIX> with what is wrong
- Needs follow-up? → <SPAWN> more agents
- Output relevant to another agent's question? → Connect the dots

<APPROVE agent="name">What was accomplished</APPROVE>
<FIX agent="name">What to fix and why</FIX>
<REPORT>Summary for the user — spoken aloud, under 3 sentences</REPORT>

BE FAST. The user is waiting. Spawn immediately, review immediately, \
answer immediately. You are a router with memory, not a researcher.`;

// ── Response Parsing ──

const SPAWN_RE = /<SPAWN\s+name=["']([^"']+)["']>(.*?)<\/SPAWN>/gis;
const ANSWER_RE = /<ANSWER>(.*?)<\/ANSWER>/is;
const ESCALATE_RE = /<ESCALATE>(.*?)<\/ESCALATE>/is;
const APPROVE_RE = /<APPROVE\s+agent=["']([^"']+)["']>(.*?)<\/APPROVE>/gis;
const FIX_RE = /<FIX\s+agent=["']([^"']+)["']>(.*?)<\/FIX>/gis;
const REPORT_RE = /<REPORT>(.*?)<\/REPORT>/is;

export interface TLResponse {
  spawns: [string, string][];        // [name, task]
  answer: string | null;
  escalation: string | null;
  approvals: [string, string][];     // [agentName, summary]
  fixes: [string, string][];         // [agentName, instruction]
  report: string | null;
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

  return {
    spawns,
    answer: answerMatch ? answerMatch[1].trim() : null,
    escalation: escalateMatch ? escalateMatch[1].trim() : null,
    approvals,
    fixes,
    report: reportMatch ? reportMatch[1].trim() : null,
  };
}

// ── TechLead Class ──

export class TechLead {
  private _session: ClaudeSession;
  contextTree: ContextTree;

  constructor(cwd: string, permissionMode: string = "bypassPermissions") {
    this._session = new ClaudeSession({
      cwd,
      model: "opus",
      permissionMode,
      appendSystemPrompt: TL_SYSTEM_PROMPT,
      tools: "",  // No tools — TL is a fast coordinator, not a researcher
    });
    this.contextTree = new ContextTree();
  }

  get sessionId(): string | null {
    return this._session.sessionId;
  }

  restoreSession(id: string): void {
    this._session.sessionId = id;
  }

  async delegateTask(
    task: string,
    onEvent?: (event: Record<string, any>) => void
  ): Promise<TLResponse> {
    this.contextTree.addTask(task);
    const prompt = this._withContext(task);
    const events = await this._collect(prompt, onEvent);
    return parseTLResponse(events);
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
    return parseTLResponse(events);
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
      `Review this result. If satisfactory, <APPROVE> and <REPORT> to the EM. ` +
      `If it needs fixes, use <FIX>. If follow-up work is needed, use <SPAWN>.`
    );
    const events = await this._collect(prompt);
    return parseTLResponse(events);
  }

  async forwardUserAnswer(question: string, answer: string, agentId: string | null): Promise<TLResponse> {
    if (agentId) this.contextTree.addAgentAnswer(agentId, answer);
    const prompt = this._withContext(
      `The user answered your escalated question.\n` +
      `Question was: ${question}\n` +
      `Answer: ${answer}\n\n` +
      `Continue with this information. Provide an <ANSWER> for the waiting sub-agent.`
    );
    const events = await this._collect(prompt);
    return parseTLResponse(events);
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

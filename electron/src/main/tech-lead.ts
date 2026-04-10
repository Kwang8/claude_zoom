import { ClaudeSession } from "./claude-session";
import { extractFinalText } from "./narrator";

// ── TL System Prompt ──

const TL_SYSTEM_PROMPT = `\
You are the Tech Lead (TL) for a voice-controlled coding assistant. You receive \
task descriptions from the Engineering Manager and break them into concrete \
sub-agent assignments.

YOUR ROLE:
- Analyze tasks and decompose them into focused sub-agent work items
- Provide each sub-agent with FULL context: file paths, function names, expected \
  behavior, relevant code patterns — so they can work independently without asking
- Answer sub-agent questions from your knowledge of the task decomposition
- Review sub-agent results for correctness and completeness
- Report outcomes back to the Engineering Manager for the user

OUTPUT FORMAT — use these XML blocks in your responses:

To spawn sub-agents (one or more per response):
<SPAWN name="short-name">
Detailed, self-contained task. Include specific file paths, function names, and \
expected outcomes. The agent should be able to complete this without further context.
</SPAWN>

To answer a sub-agent question:
<ANSWER>Your answer based on the task context you have</ANSWER>

To escalate a question to the user (ONLY when you truly cannot answer):
<ESCALATE>The specific question for the user, with brief context about why</ESCALATE>

To approve a sub-agent result:
<APPROVE agent="name">Brief summary of what was accomplished</APPROVE>

To request fixes from a sub-agent:
<FIX agent="name">What needs to be fixed and why</FIX>

To spawn follow-up work after reviewing a result:
Use <SPAWN> blocks (same as above).

To report final results to the EM (for speaking to the user):
<REPORT>Concise summary of all completed work — this will be spoken aloud, \
keep it under 3 sentences</REPORT>

RULES:
- Always try to answer sub-agent questions yourself before escalating
- When spawning, give MAXIMUM context — the agent works in an isolated worktree \
  and cannot ask you clarifying questions easily
- When reviewing results, check for completeness against the original task
- Spawn multiple agents in parallel when tasks are independent
- Keep REPORT summaries conversational — they will be read aloud to the user
- You have coding tools available — use them to gather context before spawning \
  agents (read files, search code, understand the codebase)`;

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

  constructor(cwd: string, permissionMode: string = "bypassPermissions") {
    this._session = new ClaudeSession({
      cwd,
      model: "opus",
      permissionMode,
      appendSystemPrompt: TL_SYSTEM_PROMPT,
    });
  }

  get sessionId(): string | null {
    return this._session.sessionId;
  }

  restoreSession(id: string): void {
    this._session.sessionId = id;
  }

  async delegateTask(task: string): Promise<TLResponse> {
    const events = await this._collect(task);
    return parseTLResponse(events);
  }

  async handleAgentQuestion(
    agentName: string,
    question: string,
    taskContext: string
  ): Promise<TLResponse> {
    const prompt =
      `Sub-agent "${agentName}" has a question while working on: ${taskContext}\n\n` +
      `Question: ${question}\n\n` +
      `Answer from your knowledge of the task. If you truly need user input, use <ESCALATE>.`;
    const events = await this._collect(prompt);
    return parseTLResponse(events);
  }

  async reviewResult(
    agentName: string,
    task: string,
    summary: string
  ): Promise<TLResponse> {
    const prompt =
      `Sub-agent "${agentName}" completed its task.\n` +
      `Task: ${task}\n` +
      `Result: ${summary}\n\n` +
      `Review this result. If satisfactory, <APPROVE> and <REPORT> to the EM. ` +
      `If it needs fixes, use <FIX>. If follow-up work is needed, use <SPAWN>.`;
    const events = await this._collect(prompt);
    return parseTLResponse(events);
  }

  async forwardUserAnswer(question: string, answer: string): Promise<TLResponse> {
    const prompt =
      `The user answered your escalated question.\n` +
      `Question was: ${question}\n` +
      `Answer: ${answer}\n\n` +
      `Continue with this information. Provide an <ANSWER> for the waiting sub-agent.`;
    const events = await this._collect(prompt);
    return parseTLResponse(events);
  }

  cancel(): void {
    this._session.cancel();
  }

  private async _collect(prompt: string): Promise<Record<string, any>[]> {
    const events: Record<string, any>[] = [];
    for await (const event of this._session.send(prompt)) {
      events.push(event);
    }
    return events;
  }
}

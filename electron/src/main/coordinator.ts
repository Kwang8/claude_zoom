import { execFile } from "child_process";

const COORDINATOR_SYSTEM_PROMPT = `\
You are a hidden routing coordinator for a multi-agent voice assistant. \
Your ONLY job is to track active sub-agents and advise on message routing.

You receive two types of input:

LIFECYCLE UPDATES — one or more lines describing agent spawns, completions, \
and errors. Acknowledge with exactly one word: ACK

ROUTING QUERY — a user utterance plus a list of current agents. \
Reply in EXACTLY this two-line format (no other text, no preamble):
ROUTE: main
ADVICE: <one short sentence of context for the main agent>

or, when the user message clearly continues / follows up on a specific agent:
ROUTE: agent:<agent_id>
ADVICE: <one short sentence explaining why that agent should handle it>

Rules:
- Suggest "agent:<id>" ONLY when the user message clearly relates to that \
  agent's specific task (same code area, direct follow-up, continuation).
- Default to "main" when you are unsure, when the message is a new request, \
  or when no agents match well.
- Keep ADVICE under 20 words.
- Never add greetings, apologies, or any text outside the two-line format.`;

export interface CoordinatorSuggestion {
  route: string;
  advice: string;
  agent_id: string | null;
}

function parseSuggestion(raw: string): CoordinatorSuggestion {
  if (!raw) return { route: "main", advice: "", agent_id: null };

  let route = "main";
  let advice = "";

  for (const line of raw.split("\n")) {
    const stripped = line.trim();
    const upper = stripped.toUpperCase();
    if (upper.startsWith("ROUTE:")) {
      const val = stripped.slice(6).trim().toLowerCase();
      route = val.startsWith("agent:") ? val : "main";
    } else if (upper.startsWith("ADVICE:")) {
      advice = stripped.slice(7).trim();
    }
  }

  let agent_id: string | null = null;
  if (route.startsWith("agent:")) {
    agent_id = route.slice(6).trim() || null;
    if (!agent_id) route = "main";
  }

  return { route, advice, agent_id };
}

export interface AgentSummary {
  id: string;
  name: string;
  status: string;
  task: string;
}

export class CoordinatorAgent {
  private _cwd: string;
  private _model: string;
  private _sessionId: string | null = null;
  private _notifications: string[] = [];

  constructor(cwd: string, model: string = "opus") {
    this._cwd = cwd;
    this._model = model;
  }

  notifySpawn(agentId: string, name: string, task: string): void {
    this._notifications.push(
      `LIFECYCLE: agent '${name}' (id=${agentId}) SPAWNED to work on: ${task.slice(0, 120)}`
    );
  }

  notifyDone(agentId: string, name: string, task: string, status: string): void {
    this._notifications.push(
      `LIFECYCLE: agent '${name}' (id=${agentId}) ${status.toUpperCase()}.` +
      ` Task was: ${task.slice(0, 100)}`
    );
  }

  async advise(
    transcript: string,
    agents: AgentSummary[],
    timeout: number = 5000
  ): Promise<CoordinatorSuggestion> {
    // Drain notifications
    const notifications = this._notifications.splice(0);

    const agentsText = agents.length
      ? agents.map((a) => `- ${a.name} (id=${a.id}): ${a.status} — ${a.task.slice(0, 80)}`).join("\n")
      : "(none)";

    const parts: string[] = [];
    if (notifications.length) {
      parts.push("LIFECYCLE UPDATES:\n" + notifications.join("\n"));
    }
    parts.push(
      `ROUTING QUERY:\nUser said: ${transcript}\n\nCurrent agents:\n${agentsText}`
    );
    const message = parts.join("\n\n");

    const raw = await this._query(message, timeout);
    return parseSuggestion(raw);
  }

  private _query(message: string, timeout: number): Promise<string> {
    const args: string[] = [
      "-p",
      "--output-format", "json",
      "--model", this._model,
      "--append-system-prompt", COORDINATOR_SYSTEM_PROMPT,
    ];
    if (this._sessionId) {
      args.push("--resume", this._sessionId);
    }

    return new Promise((resolve) => {
      const proc = execFile("claude", args, {
        cwd: this._cwd,
        timeout,
      }, (err, stdout) => {
        if (err) {
          resolve("");
          return;
        }
        try {
          const data = JSON.parse(stdout);
          if (!this._sessionId && data.session_id) {
            this._sessionId = data.session_id;
          }
          resolve((data.result || "").trim());
        } catch {
          resolve("");
        }
      });
      proc.stdin?.write(message);
      proc.stdin?.end();
    });
  }
}

import { execFile } from "child_process";
import { getClaudePath } from "./claude-session";

const COORDINATOR_SYSTEM_PROMPT = `\
You are a hidden router for a multi-agent voice assistant.

Your only job is to decide whether the next user message should go to the main \
assistant or to one existing sub-agent.

You will receive one of two input shapes:

1. LIFECYCLE UPDATES
- These describe agent spawns, completions, errors, or state changes.
- Reply with exactly: ACK

2. ROUTING QUERY
- This contains the latest user message and the current agents.
- Reply with exactly two lines and no extra text:
ROUTE: main
ADVICE: <brief routing note>

or

ROUTE: agent:<agent_id>
ADVICE: <brief routing note>

Route to a sub-agent only when the user is clearly continuing that agent's \
existing thread, for example:
- they address the agent by name or number
- they answer that agent's question
- they ask for a follow-up on the same task or code area
- they refer to "that", "it", or "the last thing" and only one agent fits

Route to main when:
- the user is starting a new request
- the message could apply to multiple agents
- the user is asking for coordination across agents
- the user is ambiguous in any meaningful way

Advice rules:
- Keep ADVICE under 12 words
- Describe why the route was chosen
- Do not repeat the full user message
- Do not hedge, apologize, or explain your process

If you are uncertain, choose main.`;

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
      const proc = execFile(getClaudePath(), args, {
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

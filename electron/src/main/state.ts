import fs from "fs";
import path from "path";

const STATE_DIR = ".claude_zoom_agents";
const STATE_FILE = "state.json";

export interface AgentState {
  id: string;
  name: string;
  session_id: string | null;
  worktree_path: string | null;
  base_cwd: string;
  task: string;
  status: string;
  number: number;
  branch: string | null;
  remote?: boolean;
  repo?: string | null;
  auth?: string;
}

export interface AppState {
  main_session_id: string | null;
  main_model: string;
  main_cwd: string | null;
  agents: AgentState[];
  agent_counter: number;
  messages: Record<string, any>[];
}

function statePath(cwd: string): string {
  return path.join(cwd, STATE_DIR, STATE_FILE);
}

export function saveState(state: AppState, cwd: string): void {
  const p = statePath(cwd);
  const tmp = `${p}.tmp`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.warn("[state] failed to save:", e);
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

export function loadState(cwd: string): AppState | null {
  const p = statePath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf-8");
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    return {
      main_session_id: data.main_session_id ?? null,
      main_model: data.main_model ?? "opus",
      main_cwd: data.main_cwd ?? null,
      agents: (data.agents ?? []).map((agent: any) => ({
        ...agent,
        remote: Boolean(agent.remote),
        repo: agent.repo ?? null,
        auth: agent.auth ?? "oauth",
      })),
      agent_counter: data.agent_counter ?? 0,
      messages: data.messages ?? [],
    };
  } catch (e) {
    console.warn("[state] failed to load:", e);
    return null;
  }
}

export function clearState(cwd: string): void {
  try {
    fs.unlinkSync(statePath(cwd));
  } catch {}
}

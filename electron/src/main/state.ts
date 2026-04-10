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
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn("[state] failed to save:", e);
  }
}

export function loadState(cwd: string): AppState | null {
  const p = statePath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return {
      main_session_id: data.main_session_id ?? null,
      main_model: data.main_model ?? "opus",
      main_cwd: data.main_cwd ?? null,
      agents: data.agents ?? [],
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

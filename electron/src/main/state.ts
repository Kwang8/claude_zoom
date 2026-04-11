import fs from "fs";
import path from "path";

const STATE_DIR = ".claude_zoom_agents";
const STATE_FILE = "state.json";
const REGISTRY_FILE = "conversations_registry.json";

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

export interface ConversationData {
  id: string;
  status: "active" | "compacted";
  summary: string | null;
  start_timestamp: string;
  end_timestamp: string | null;
  spawned_agent_ids: string[];
}

export interface TLMemoryState {
  insights: string[];
  decisions: { description: string; outcome: string }[];
}

export interface AppState {
  main_session_id: string | null;
  main_model: string;
  main_cwd: string | null;
  agents: AgentState[];
  agent_counter: number;
  messages: Record<string, any>[];
  conversations?: ConversationData[];
  current_conversation_id?: string | null;
  tech_lead_session_id?: string | null;
  tl_memory?: TLMemoryState | null;
}

export interface ConversationRegistryEntry {
  id: string;
  createdAt: string;
}

export interface ConversationRegistry {
  activeConversationId: string | null;
  conversations: ConversationRegistryEntry[];
}

function statePath(cwd: string, stateId?: string): string {
  if (stateId) {
    return path.join(cwd, STATE_DIR, "conversations", stateId, STATE_FILE);
  }
  return path.join(cwd, STATE_DIR, STATE_FILE);
}

function registryPath(cwd: string): string {
  return path.join(cwd, STATE_DIR, REGISTRY_FILE);
}

export function saveRegistry(registry: ConversationRegistry, cwd: string): void {
  const p = registryPath(cwd);
  const tmp = `${p}.tmp`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
    fs.renameSync(tmp, p);
  } catch (e) {
    console.warn("[state] failed to save registry:", e);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

export function loadRegistry(cwd: string): ConversationRegistry | null {
  const p = registryPath(cwd);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf-8");
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    return {
      activeConversationId: data.activeConversationId ?? null,
      conversations: (data.conversations ?? []).map((c: any) => ({
        id: c.id,
        createdAt: c.createdAt ?? new Date().toISOString(),
      })),
    };
  } catch (e) {
    console.warn("[state] failed to load registry:", e);
    return null;
  }
}

export function saveState(state: AppState, cwd: string, stateId?: string): void {
  const p = statePath(cwd, stateId);
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

export function loadState(cwd: string, stateId?: string): AppState | null {
  const p = statePath(cwd, stateId);
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
      conversations: (data.conversations ?? []).map((conv: any) => ({
        id: conv.id,
        status: conv.status === "compacted" ? "compacted" : "active",
        summary: conv.summary ?? null,
        start_timestamp: conv.start_timestamp ?? "",
        end_timestamp: conv.end_timestamp ?? null,
        spawned_agent_ids: Array.isArray(conv.spawned_agent_ids) ? conv.spawned_agent_ids : [],
      })),
      current_conversation_id: data.current_conversation_id ?? null,
    };
  } catch (e) {
    console.warn("[state] failed to load:", e);
    return null;
  }
}

export function clearState(cwd: string, stateId?: string): void {
  try {
    fs.unlinkSync(statePath(cwd, stateId));
  } catch {}
}

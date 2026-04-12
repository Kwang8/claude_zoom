// ── Client -> Server ──

export type ClientMessage =
  | { type: "mic_start" }
  | { type: "mic_stop" }
  | { type: "send_text"; text: string }
  | { type: "cancel_turn" }
  | { type: "pr_decision"; agent_id: string; approved: boolean }
  | { type: "agent_answer"; agent_id: string; text: string }
  | { type: "kill_agent"; agent_id: string }
  | { type: "attach_image"; path: string }
  | { type: "clear_images" }
  | { type: "create_conversation" }
  | { type: "switch_conversation"; conversation_id: string }
  | { type: "merge_pr" }
  | { type: "quit" };

// ── Server -> Client ──

export type AppState =
  | "idle"
  | "listening"
  | "thinking"
  | "working"
  | "talking";

export interface TranscriptMessage {
  role: "user" | "claude" | "sub_agent" | "system" | "claude_error";
  text: string;
  agent_name?: string;
  agent_id?: string;
  kind?: "tool_use";
  timestamp: string;
  conversation_id?: string;
}

export type ConversationStatus =
  | "active"
  | "working"
  | "needs_input"
  | "pr_open"
  | "completed"
  | "compacted"
  | "proposal";

export interface ConversationGroup {
  id: string;
  status: ConversationStatus;
  summary: string | null;
  detail: string | null;
  prUrl: string | null;
  startTimestamp: string;
  endTimestamp: string | null;
  messageStartIndex: number;
  messageEndIndex: number;
  spawnedAgentIds: string[];
}

export interface AgentInfo {
  agent_id: string;
  name: string;
  number: number;
  task: string;
  status: string;
  ticker?: string;
  started_at?: number;
}

export type ServerMessage =
  | { type: "state_change"; state: AppState; narration?: string }
  | ({ type: "transcript_message" } & TranscriptMessage)
  | { type: "ticker_update"; activity: string }
  | {
      type: "agent_spawned";
      agent_id: string;
      name: string;
      number: number;
      task: string;
      status?: string;
    }
  | {
      type: "agent_status";
      agent_id: string;
      status: string;
      name?: string;
      ticker?: string;
    }
  | { type: "agent_removed"; agent_id: string }
  | { type: "partial_transcript"; text: string }
  | { type: "tts_start"; text: string; speaker: string }
  | { type: "tts_end" }
  | { type: "session_restored"; agents: AgentInfo[]; message: string }
  | { type: "progress"; text: string }
  | { type: "action"; text: string }
  | { type: "repo_context"; repo: string }
  | { type: "conversation_start"; conversation_id: string; timestamp: string }
  | { type: "conversation_compacted"; conversation_id: string; summary: string; timestamp: string }
  | { type: "conversation_agent_spawned"; conversation_id: string; agent_id: string }
  | { type: "conversation_created"; conversation_id: string; timestamp: string }
  | { type: "conversation_switched"; conversation_id: string }
  | { type: "conversation_status"; conversation_id: string; status: ConversationStatus; detail?: string; pr_url?: string }
  | { type: "usage-update"; totalInputTokens: number; totalOutputTokens: number }
  | { type: "pm_status"; status: string; idea_count: number; last_activity: string | null };

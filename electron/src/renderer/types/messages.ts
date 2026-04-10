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
}

export interface AgentInfo {
  agent_id: string;
  name: string;
  number: number;
  task: string;
  status: string;
  ticker?: string;
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
  | { type: "action"; text: string };

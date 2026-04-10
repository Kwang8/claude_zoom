import type { TranscriptMessage } from "../types/messages";

interface Props {
  message: TranscriptMessage;
}

const ROLE_LABELS: Record<string, string> = {
  user: "you",
  claude: "claude",
  claude_error: "claude (error)",
};

export function TranscriptEntry({ message }: Props) {
  const { role, text, agent_name, timestamp } = message;

  if (role === "system") {
    return (
      <div className="transcript-entry system">
        <div className="transcript-body">{text}</div>
      </div>
    );
  }

  const label = role === "sub_agent" ? agent_name || "agent" : ROLE_LABELS[role] || role;

  return (
    <div className="transcript-entry">
      <div className="transcript-header">
        <span className={`transcript-role ${role}`}>{label}</span>
        <span className="transcript-time">{timestamp}</span>
      </div>
      <div className="transcript-body">{text}</div>
    </div>
  );
}

import { useEffect, useState } from "react";
import type { AgentInfo } from "../types/messages";

interface Props {
  agent: AgentInfo;
  selected?: boolean;
  onSelect: (agentId: string) => void;
  onDelete: (agentId: string) => void;
}

export function AgentCard({ agent, selected = false, onSelect, onDelete }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const showTimer = agent.status === "working" && typeof agent.started_at === "number";

  useEffect(() => {
    if (!showTimer) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [showTimer, agent.started_at]);

  const elapsedMs = showTimer ? Math.max(0, now - (agent.started_at || now)) : 0;
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  return (
    <div
      className={`agent-card ${selected ? "selected" : ""}`}
      onClick={() => onSelect(agent.agent_id)}
    >
      <div className="agent-card-header">
        <div className={`agent-status-dot ${agent.status}`} />
        <span className="agent-name">{agent.name}</span>
        {showTimer && <span className="agent-timer">{elapsedLabel}</span>}
        <button
          type="button"
          className="agent-delete"
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={(event) => {
            event.stopPropagation();
            event.currentTarget.blur();
            onDelete(agent.agent_id);
          }}
          title="Kill agent"
        >
          x
        </button>
      </div>
      {agent.ticker && <div className="agent-ticker">{agent.ticker}</div>}
    </div>
  );
}

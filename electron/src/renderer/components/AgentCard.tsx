import type { AgentInfo } from "../types/messages";

interface Props {
  agent: AgentInfo;
  selected?: boolean;
  onSelect: (agentId: string) => void;
  onDelete: (agentId: string) => void;
}

export function AgentCard({ agent, selected = false, onSelect, onDelete }: Props) {
  return (
    <div
      className={`agent-card ${selected ? "selected" : ""}`}
      onClick={() => onSelect(agent.agent_id)}
    >
      <div className="agent-card-header">
        <div className={`agent-status-dot ${agent.status}`} />
        <span className="agent-name">{agent.name}</span>
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

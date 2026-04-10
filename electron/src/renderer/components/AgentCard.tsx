import type { AgentInfo } from "../types/messages";

interface Props {
  agent: AgentInfo;
  onDelete: (agentId: string) => void;
}

export function AgentCard({ agent, onDelete }: Props) {
  return (
    <div className="agent-card">
      <div className="agent-card-header">
        <div className={`agent-status-dot ${agent.status}`} />
        <span className="agent-name">{agent.name}</span>
        <button
          className="agent-delete"
          onClick={() => onDelete(agent.agent_id)}
          title="Kill agent"
        >
          x
        </button>
      </div>
      {agent.ticker && <div className="agent-ticker">{agent.ticker}</div>}
    </div>
  );
}

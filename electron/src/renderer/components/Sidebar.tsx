import type { AgentInfo, AppState } from "../types/messages";
import { AgentCard } from "./AgentCard";
import { AvatarPanel } from "./AvatarPanel";

interface Props {
  appState: AppState;
  narration: string;
  agents: AgentInfo[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onDeleteAgent: (agentId: string) => void;
}

export function Sidebar({ appState, narration, agents, selectedAgentId, onSelectAgent, onDeleteAgent }: Props) {
  return (
    <div className="sidebar">
      <AvatarPanel state={appState} narration={narration} />
      {agents.length > 0 && (
        <>
          <div className="agents-header">sub agents</div>
          <div className="agents-list">
            {agents.map((a) => (
              <AgentCard
                key={a.agent_id}
                agent={a}
                selected={a.agent_id === selectedAgentId}
                onSelect={onSelectAgent}
                onDelete={onDeleteAgent}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

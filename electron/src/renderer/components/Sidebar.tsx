import { useEffect, useState } from "react";
import type { AgentInfo, AppState } from "../types/messages";
import { AgentCard } from "./AgentCard";
import { AvatarPanel } from "./AvatarPanel";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function UsagePanel() {
  const [input, setInput] = useState(0);
  const [output, setOutput] = useState(0);

  useEffect(() => {
    if (!window.claude) return;
    window.claude.send({ type: "get_usage" });
    const cleanup = window.claude.onEvent((msg) => {
      if (msg.type === "usage_update") {
        setInput(msg.input_tokens ?? 0);
        setOutput(msg.output_tokens ?? 0);
      }
    });
    return cleanup;
  }, []);

  return (
    <div className="usage-panel">
      <div className="agents-header">usage</div>
      <div className="usage-stats">
        <div className="usage-row">
          <span className="usage-label">input</span>
          <span className="usage-value">{fmt(input)}</span>
        </div>
        <div className="usage-row">
          <span className="usage-label">output</span>
          <span className="usage-value">{fmt(output)}</span>
        </div>
        <div className="usage-row usage-total">
          <span className="usage-label">total</span>
          <span className="usage-value">{fmt(input + output)}</span>
        </div>
      </div>
    </div>
  );
}

function PMPanel({ status, ideaCount, lastActivity, onClick }: {
  status: string;
  ideaCount: number;
  lastActivity: string | null;
  onClick: () => void;
}) {
  const isNotConfigured = status === "not_configured" || status === "starting";
  const dotClass = status === "scanning" || status === "thinking" ? "working"
    : status === "disabled" || status === "not_configured" ? "error"
    : status.startsWith("downloading") || status === "installing" ? "working"
    : "done";

  return (
    <div className="pm-panel" onClick={onClick} role="button" tabIndex={0} style={{ cursor: "pointer" }}>
      <div className="agents-header">product manager</div>
      <div className="pm-status">
        <div className="pm-status-row">
          <span className={`pm-status-dot ${dotClass}`} />
          <span className="pm-status-label">
            {isNotConfigured ? "click to set up" : status}
          </span>
        </div>
        {ideaCount > 0 && (
          <div className="pm-status-row">
            <span className="pm-idea-count">{ideaCount} idea{ideaCount !== 1 ? "s" : ""}</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface Props {
  appState: AppState;
  narration: string;
  agents: AgentInfo[];
  selectedAgentId: string | null;
  pmStatus: { status: string; ideaCount: number; lastActivity: string | null };
  onSelectAgent: (agentId: string | null) => void;
  onDeleteAgent: (agentId: string) => void;
  onClickPM: () => void;
}

export function Sidebar({ appState, narration, agents, selectedAgentId, pmStatus, onSelectAgent, onDeleteAgent, onClickPM }: Props) {
  return (
    <div className="sidebar">
      <AvatarPanel
        state={appState}
        narration={narration}
        selected={selectedAgentId === null}
        onClick={() => onSelectAgent(null)}
      />
      <UsagePanel />
      <PMPanel {...pmStatus} onClick={onClickPM} />
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

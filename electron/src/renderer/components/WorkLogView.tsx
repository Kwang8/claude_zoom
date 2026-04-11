import { useEffect, useRef } from "react";
import type { AgentInfo, ConversationGroup, TranscriptMessage } from "../types/messages";
import { GroupedTranscript } from "./GroupedTranscript";
import { TranscriptEntry } from "./TranscriptEntry";

interface Props {
  conversations: ConversationGroup[];
  transcript: TranscriptMessage[];
  agents: AgentInfo[];
  activeConversationId: string | null;
  expandedConversationIds: string[];
  onToggleExpand: (conversationId: string) => void;
  onSwitchConversation: (conversationId: string) => void;
  onNewConversation: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  working: "working",
  done: "done",
  error: "error",
  pr_pending: "pr_pending",
  needs_input: "needs_input",
};

function CompactedEntry({
  conversation,
  agents,
  messages,
  isExpanded,
  onToggle,
}: {
  conversation: ConversationGroup;
  agents: AgentInfo[];
  messages: TranscriptMessage[];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const spawnedAgents = agents.filter((a) =>
    conversation.spawnedAgentIds.includes(a.agent_id)
  );

  return (
    <div className={`worklog-entry compacted${isExpanded ? " expanded" : ""}`}>
      <button className="worklog-entry-header" onClick={onToggle} type="button">
        <span className="worklog-entry-time">{conversation.startTimestamp}</span>
        <span className="worklog-entry-summary">{conversation.summary}</span>
        <span className="worklog-expand-indicator">{isExpanded ? "▲" : "▼"}</span>
      </button>
      {spawnedAgents.length > 0 && (
        <div className="worklog-entry-agents">
          {spawnedAgents.map((a) => (
            <span
              key={a.agent_id}
              className={`worklog-agent-badge ${STATUS_COLORS[a.status] || ""}`}
            >
              {a.name}
            </span>
          ))}
        </div>
      )}
      {isExpanded && messages.length > 0 && (
        <div className="worklog-entry-inline-transcript">
          <GroupedTranscript messages={messages} githubRepo={null} hideToolCalls={true} />
        </div>
      )}
    </div>
  );
}

/** The currently focused conversation — fully expanded with messages. */
function ActiveConversation({
  conversation,
  messages,
}: {
  conversation: ConversationGroup;
  messages: TranscriptMessage[];
}) {
  return (
    <div className="worklog-entry active focused">
      <div className="worklog-entry-header">
        <span className="worklog-entry-time">{conversation.startTimestamp}</span>
        <span className="worklog-entry-live-badge">live</span>
      </div>
      {messages.length > 0 && (
        <div className="worklog-entry-transcript">
          <GroupedTranscript messages={messages} githubRepo={null} hideToolCalls={true} />
        </div>
      )}
    </div>
  );
}

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  working: { label: "working", className: "status-working" },
  needs_input: { label: "needs input", className: "status-needs-input" },
  pr_open: { label: "PR open", className: "status-pr-open" },
  completed: { label: "completed", className: "status-completed" },
  active: { label: "live", className: "status-active" },
};

/** A non-focused conversation — collapsed with status badge, clickable to switch. */
function CollapsedEntry({
  conversation,
  onClick,
}: {
  conversation: ConversationGroup;
  onClick: () => void;
}) {
  const info = STATUS_LABELS[conversation.status] ?? STATUS_LABELS.active;

  return (
    <button
      className={`worklog-entry collapsed ${info.className}`}
      onClick={onClick}
      type="button"
    >
      <div className="worklog-entry-header">
        <span className="worklog-entry-time">{conversation.startTimestamp}</span>
        <span className={`worklog-status-badge ${info.className}`}>{info.label}</span>
        {conversation.detail && (
          <span className="worklog-entry-detail">{conversation.detail}</span>
        )}
        <span className="worklog-expand-indicator">▼</span>
      </div>
    </button>
  );
}

export function WorkLogView({
  conversations,
  transcript,
  agents,
  activeConversationId,
  expandedConversationIds,
  onToggleExpand,
  onSwitchConversation,
  onNewConversation,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  const focusedConv = conversations.find((c) => c.id === activeConversationId);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    conversations.length,
    focusedConv?.messageEndIndex,
  ]);

  // Messages that exist before any conversation (intro, etc.)
  const firstConvStart = conversations.length > 0 ? conversations[0].messageStartIndex : transcript.length;
  const preConvMessages = transcript.slice(0, firstConvStart);

  return (
    <div className="worklog">
      <div className="worklog-toolbar">
        <div className="worklog-title">Conversations</div>
        <button
          className="worklog-new-btn"
          onClick={onNewConversation}
          type="button"
          title="Start a new request"
        >
          + new request
        </button>
      </div>
      {preConvMessages.length > 0 && (
        <div className="worklog-preamble">
          {preConvMessages.filter((msg) => msg.kind !== "tool_use").map((msg, i) => (
            <TranscriptEntry key={i} message={msg} githubRepo={null} />
          ))}
        </div>
      )}
      {conversations.map((conv) => {
        const messages = transcript.slice(
          conv.messageStartIndex,
          conv.messageEndIndex + 1
        );

        if (conv.status === "compacted") {
          return (
            <CompactedEntry
              key={conv.id}
              conversation={conv}
              agents={agents}
              messages={messages}
              isExpanded={expandedConversationIds.includes(conv.id)}
              onToggle={() => onToggleExpand(conv.id)}
            />
          );
        }

        // Focused conversation — fully expanded
        if (conv.id === activeConversationId && conv.status === "active") {
          return (
            <ActiveConversation
              key={conv.id}
              conversation={conv}
              messages={messages}
            />
          );
        }

        // Non-focused — collapsed with status badge
        return (
          <CollapsedEntry
            key={conv.id}
            conversation={conv}
            onClick={() => onSwitchConversation(conv.id)}
          />
        );
      })}
      {conversations.length === 0 && preConvMessages.length === 0 && (
        <div className="worklog-empty">Ready whenever you are</div>
      )}
      <div ref={endRef} />
    </div>
  );
}

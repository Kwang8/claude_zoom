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
  onMergePr: (conversationId: string) => void;
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
        {conversation.status !== "active" && (
          <span className={`worklog-status-badge ${(STATUS_LABELS[conversation.status] ?? STATUS_LABELS.active).className}`}>
            {(STATUS_LABELS[conversation.status] ?? STATUS_LABELS.active).label}
          </span>
        )}
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
  active: { label: "idle", className: "status-active" },
  proposal: { label: "proposal", className: "status-proposal" },
};

/** Derive a short summary from the first user message in a conversation. */
function deriveSummary(conversation: ConversationGroup, transcript: TranscriptMessage[]): string | null {
  if (conversation.summary) return conversation.summary;
  const firstUserMsg = transcript.find((m) => m.conversation_id === conversation.id && m.role === "user");
  if (!firstUserMsg) return null;
  const text = firstUserMsg.text.trim();
  return text.length > 80 ? text.slice(0, 77) + "..." : text;
}

/** A non-focused conversation — collapsed with status badge, clickable to switch. */
function CollapsedEntry({
  conversation,
  summary,
  messages,
  onClick,
  onMerge,
}: {
  conversation: ConversationGroup;
  summary: string | null;
  messages?: TranscriptMessage[];
  onClick: () => void;
  onMerge?: () => void;
}) {
  const info = STATUS_LABELS[conversation.status] ?? STATUS_LABELS.active;

  return (
    <div
      className={`worklog-entry collapsed ${info.className}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      <div className="worklog-entry-header">
        <span className="worklog-entry-time">{conversation.startTimestamp}</span>
        <span className={`worklog-status-badge ${info.className}`}>{info.label}</span>
        {conversation.detail && (
          <span className="worklog-entry-detail">{conversation.detail}</span>
        )}
        <span className="worklog-expand-indicator">▼</span>
      </div>
      {summary && (
        <div className="worklog-entry-summary-line">{summary}</div>
      )}
      {conversation.status === "pr_open" && conversation.prUrl && (
        <div className="worklog-pr-actions" onClick={(e) => e.stopPropagation()}>
          <a
            className="worklog-pr-link"
            href={conversation.prUrl}
            onClick={(e) => {
              e.preventDefault();
              window.claude?.send({ type: "open_external", url: conversation.prUrl });
            }}
          >
            {conversation.prUrl}
          </a>
          {onMerge && (
            <button className="worklog-merge-btn" onClick={onMerge} type="button">
              merge
            </button>
          )}
        </div>
      )}
      {messages && messages.length > 0 && (
        <div className="worklog-entry-inline-transcript" onClick={(e) => e.stopPropagation()}>
          <GroupedTranscript messages={messages} githubRepo={null} hideToolCalls={true} />
        </div>
      )}
    </div>
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
  onMergePr,
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

  // Messages not belonging to any conversation
  const convIds = new Set(conversations.map((c) => c.id));
  const preConvMessages = transcript.filter((m) => !m.conversation_id || !convIds.has(m.conversation_id));

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
        const messages = transcript.filter((m) => m.conversation_id === conv.id);

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

        // Focused conversation — fully expanded regardless of status
        if (conv.id === activeConversationId) {
          return (
            <ActiveConversation
              key={conv.id}
              conversation={conv}
              messages={messages}
            />
          );
        }

        // Non-focused — collapsed with status badge
        // Completed/pr_open: toggle expand inline. Active/working/needs_input: switch to it.
        const isFinished = conv.status === "completed" || conv.status === "pr_open" || conv.status === "proposal";
        const isExpanded = expandedConversationIds.includes(conv.id);

        return (
          <CollapsedEntry
            key={conv.id}
            conversation={conv}
            summary={deriveSummary(conv, transcript)}
            messages={isFinished && isExpanded ? messages : undefined}
            onClick={isFinished ? () => onToggleExpand(conv.id) : () => onSwitchConversation(conv.id)}
            onMerge={conv.status === "pr_open" ? () => onMergePr(conv.id) : undefined}
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

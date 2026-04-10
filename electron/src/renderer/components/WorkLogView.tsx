import { useEffect, useRef } from "react";
import type { AgentInfo, ConversationGroup, TranscriptMessage } from "../types/messages";
import { TranscriptEntry } from "./TranscriptEntry";

interface Props {
  conversations: ConversationGroup[];
  transcript: TranscriptMessage[];
  agents: AgentInfo[];
  onSelectConversation: (conversationId: string) => void;
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
  onClick,
}: {
  conversation: ConversationGroup;
  agents: AgentInfo[];
  onClick: () => void;
}) {
  const spawnedAgents = agents.filter((a) =>
    conversation.spawnedAgentIds.includes(a.agent_id)
  );

  return (
    <button className="worklog-entry compacted" onClick={onClick} type="button">
      <div className="worklog-entry-header">
        <span className="worklog-entry-time">{conversation.startTimestamp}</span>
        <span className="worklog-entry-summary">{conversation.summary}</span>
      </div>
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
    </button>
  );
}

function ActiveConversation({
  conversation,
  messages,
}: {
  conversation: ConversationGroup;
  messages: TranscriptMessage[];
}) {
  return (
    <div className="worklog-entry active">
      <div className="worklog-entry-header">
        <span className="worklog-entry-time">{conversation.startTimestamp}</span>
        <span className="worklog-entry-live-badge">live</span>
      </div>
      {messages.length > 0 && (
        <div className="worklog-entry-transcript">
          {messages.map((msg, i) => (
            <TranscriptEntry key={i} message={msg} githubRepo={null} />
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkLogView({
  conversations,
  transcript,
  agents,
  onSelectConversation,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  const activeConv = conversations.find((c) => c.status === "active");

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    conversations.length,
    activeConv?.messageEndIndex,
    activeConv?.status,
  ]);

  // Messages that exist before any conversation (intro, etc.)
  const firstConvStart = conversations.length > 0 ? conversations[0].messageStartIndex : transcript.length;
  const preConvMessages = transcript.slice(0, firstConvStart);

  return (
    <div className="worklog">
      <div className="worklog-toolbar">
        <div className="worklog-title">work log</div>
      </div>
      {preConvMessages.length > 0 && (
        <div className="worklog-preamble">
          {preConvMessages.map((msg, i) => (
            <TranscriptEntry key={i} message={msg} githubRepo={null} />
          ))}
        </div>
      )}
      {conversations.map((conv) => {
        if (conv.status === "compacted") {
          return (
            <CompactedEntry
              key={conv.id}
              conversation={conv}
              agents={agents}
              onClick={() => onSelectConversation(conv.id)}
            />
          );
        }
        const messages = transcript.slice(
          conv.messageStartIndex,
          conv.messageEndIndex + 1
        );
        return (
          <ActiveConversation
            key={conv.id}
            conversation={conv}
            messages={messages}
          />
        );
      })}
      {conversations.length === 0 && preConvMessages.length === 0 && (
        <div className="worklog-empty">Press space to start a conversation.</div>
      )}
      <div ref={endRef} />
    </div>
  );
}

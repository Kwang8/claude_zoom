import { useState } from "react";
import type { TranscriptMessage } from "../types/messages";
import { TranscriptEntry } from "./TranscriptEntry";

type TranscriptItem =
  | { type: "message"; message: TranscriptMessage }
  | { type: "tool_stack"; key: string; messages: TranscriptMessage[] };

function groupTranscript(messages: TranscriptMessage[]): TranscriptItem[] {
  const grouped: TranscriptItem[] = [];
  let toolRun: TranscriptMessage[] = [];

  function flushToolRun() {
    if (toolRun.length === 0) return;
    if (toolRun.length === 1) {
      grouped.push({ type: "message", message: toolRun[0] });
    } else {
      const latest = toolRun[toolRun.length - 1];
      grouped.push({
        type: "tool_stack",
        key: `${latest.agent_id || latest.agent_name || "agent"}-${latest.timestamp}-${toolRun.length}`,
        messages: [...toolRun],
      });
    }
    toolRun = [];
  }

  for (const message of messages) {
    const previous = toolRun[toolRun.length - 1];
    const continuesToolRun =
      message.kind === "tool_use" &&
      toolRun.length > 0 &&
      previous?.kind === "tool_use" &&
      previous.agent_id === message.agent_id;

    if (continuesToolRun) {
      toolRun.push(message);
      continue;
    }

    flushToolRun();

    if (message.kind === "tool_use") {
      toolRun.push(message);
      continue;
    }

    grouped.push({ type: "message", message });
  }

  flushToolRun();
  return grouped;
}

interface Props {
  messages: TranscriptMessage[];
  githubRepo: string | null;
  hideToolCalls?: boolean;
}

export function GroupedTranscript({ messages, githubRepo, hideToolCalls = false }: Props) {
  const [expandedStacks, setExpandedStacks] = useState<Record<string, boolean>>(
    {}
  );
  const visibleMessages = hideToolCalls ? messages.filter((m) => m.kind !== "tool_use") : messages;
  const transcriptItems = groupTranscript(visibleMessages);

  function toggleStack(key: string) {
    setExpandedStacks((current) => ({ ...current, [key]: !current[key] }));
  }

  return (
    <>
      {transcriptItems.map((item, i) => {
        if (item.type === "message") {
          return (
            <TranscriptEntry
              key={i}
              message={item.message}
              githubRepo={githubRepo}
            />
          );
        }

        const latest = item.messages[item.messages.length - 1];
        const earlier = item.messages.slice(0, -1);
        const expanded = Boolean(expandedStacks[item.key]);

        return (
          <div key={item.key} className={`tool-stack ${expanded ? "expanded" : ""}`}>
            <button
              type="button"
              className="tool-stack-toggle"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={(event) => {
                event.currentTarget.blur();
                toggleStack(item.key);
              }}
            >
              <span className="tool-stack-count">{item.messages.length} tool calls</span>
              <span className="tool-stack-chevron">{expanded ? "collapse" : "expand"}</span>
            </button>
            <div className="tool-stack-cards">
              {expanded &&
                earlier.map((message, index) => (
                  <div key={`${item.key}-older-${index}`} className="tool-stack-layer">
                    <TranscriptEntry message={message} githubRepo={githubRepo} />
                  </div>
                ))}
              <div className="tool-stack-layer latest">
                <TranscriptEntry message={latest} githubRepo={githubRepo} />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

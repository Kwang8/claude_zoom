import { useEffect, useRef } from "react";
import type { AgentInfo, TranscriptMessage } from "../types/messages";
import { GroupedTranscript } from "./GroupedTranscript";

interface Props {
  messages: TranscriptMessage[];
  selectedAgent: AgentInfo | null;
  onBackToMain: () => void;
  githubRepo?: string | null;
  title?: string;
}

export function TranscriptView({ messages, selectedAgent, onBackToMain, githubRepo, title }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="transcript">
      <div className="transcript-toolbar">
        {selectedAgent || title ? (
          <>
            <button
              type="button"
              className="transcript-back"
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={(event) => {
                event.currentTarget.blur();
                onBackToMain();
              }}
            >
              {selectedAgent ? "main chat" : "work log"}
            </button>
            <div className="transcript-title-group">
              <div className="transcript-title">{selectedAgent ? selectedAgent.name : title}</div>
              {selectedAgent && <div className="transcript-subtitle">{selectedAgent.task}</div>}
            </div>
          </>
        ) : (
          <div className="transcript-title-group">
            <div className="transcript-title">main chat</div>
          </div>
        )}
      </div>
      <GroupedTranscript messages={messages} githubRepo={githubRepo ?? null} />
      {messages.length === 0 && selectedAgent && (
        <div className="transcript-empty">No transcript entries for this sub-agent yet.</div>
      )}
      <div ref={endRef} />
    </div>
  );
}

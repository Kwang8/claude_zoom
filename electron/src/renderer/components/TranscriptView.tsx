import { useEffect, useRef } from "react";
import type { AgentInfo, TranscriptMessage } from "../types/messages";
import { TranscriptEntry } from "./TranscriptEntry";

interface Props {
  messages: TranscriptMessage[];
  selectedAgent: AgentInfo | null;
  onBackToMain: () => void;
}

export function TranscriptView({ messages, selectedAgent, onBackToMain }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="transcript">
      <div className="transcript-toolbar">
        {selectedAgent ? (
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
              main chat
            </button>
            <div className="transcript-title-group">
              <div className="transcript-title">{selectedAgent.name}</div>
              <div className="transcript-subtitle">{selectedAgent.task}</div>
            </div>
          </>
        ) : (
          <div className="transcript-title-group">
            <div className="transcript-title">main chat</div>
          </div>
        )}
      </div>
      {messages.map((msg, i) => (
        <TranscriptEntry key={i} message={msg} />
      ))}
      {messages.length === 0 && selectedAgent && (
        <div className="transcript-empty">No transcript entries for this sub-agent yet.</div>
      )}
      <div ref={endRef} />
    </div>
  );
}

import { useEffect, useRef } from "react";
import type { TranscriptMessage } from "../types/messages";
import { TranscriptEntry } from "./TranscriptEntry";

interface Props {
  messages: TranscriptMessage[];
}

export function TranscriptView({ messages }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="transcript">
      {messages.map((msg, i) => (
        <TranscriptEntry key={i} message={msg} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

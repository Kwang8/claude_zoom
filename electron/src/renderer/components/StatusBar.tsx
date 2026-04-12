import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  progress: string;
  action: string;
  connected: boolean;
  isRecording: boolean;
  onSendText: (text: string) => void;
}

export function StatusBar({ progress, action, connected, isRecording, onSendText }: Props) {
  const [showInput, setShowInput] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSendText(trimmed);
    setText("");
    setShowInput(false);
  }, [text, onSendText]);

  // Focus input when shown
  useEffect(() => {
    if (showInput) {
      inputRef.current?.focus();
    }
  }, [showInput]);

  // Global "/" key to open input
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) return;

      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShowInput(true);
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <div className={`statusbar${isRecording ? " statusbar-recording" : ""}`}>
      <div className={`statusbar-dot ${connected ? "connected" : "disconnected"}`} />

      {showInput ? (
        <div className="statusbar-input-wrapper">
          <input
            ref={inputRef}
            className="statusbar-input"
            type="text"
            value={text}
            placeholder="Type a message..."
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setShowInput(false);
                setText("");
              }
              e.stopPropagation();
            }}
            onKeyUp={(e) => e.stopPropagation()}
          />
          <button className="statusbar-send-btn" onClick={handleSubmit} type="button">
            send
          </button>
        </div>
      ) : (
        <>
          {progress && <span className="statusbar-progress">{progress}</span>}
          <span className="statusbar-action">{action}</span>
          <button
            className="statusbar-keyboard-btn"
            onClick={() => setShowInput(true)}
            title="Type instead of talking (or press /)"
            type="button"
          >
            /
          </button>
        </>
      )}

      {isRecording && (
        <span className="recording-indicator">
          <span className="recording-dot" />
          recording
        </span>
      )}
    </div>
  );
}

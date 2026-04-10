import { useCallback, useEffect, useState } from "react";
import { ActivityTicker } from "./components/ActivityTicker";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TranscriptView } from "./components/TranscriptView";
import { useAppState } from "./hooks/useAppState";
import { useIPC } from "./hooks/useIPC";
import type { ClientMessage } from "./types/messages";

export function App() {
  const { state, handleMessage } = useAppState();
  const { send, connected } = useIPC(handleMessage);
  const [isRecording, setIsRecording] = useState(false);

  // Keyboard shortcuts
  useEffect(() => {
    function isInputFocused(e: KeyboardEvent) {
      return (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      );
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isInputFocused(e)) return;

      if (e.code === "Space") {
        e.preventDefault();
        if (e.repeat) return;
        console.log("[app] space pressed, sending mic_start");
        setIsRecording(true);
        send({ type: "mic_start" });
      } else if (e.code === "Escape") {
        e.preventDefault();
        send({ type: "cancel_turn" });
      } else if (e.code === "KeyQ" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        send({ type: "quit" });
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (isInputFocused(e)) return;
      if (e.code === "Space") {
        e.preventDefault();
        console.log("[app] space released, sending mic_stop");
        setIsRecording(false);
        send({ type: "mic_stop" });
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [send]);

  const handleDeleteAgent = useCallback(
    (agentId: string) => {
      send({ type: "kill_agent", agent_id: agentId });
    },
    [send]
  );

  return (
    <div className="app">
      <div className="titlebar">claude_zoom</div>
      <div className="body">
        <Sidebar
          appState={state.appState}
          narration={state.narration}
          agents={state.agents}
          onDeleteAgent={handleDeleteAgent}
        />
        <div className="main-area">
          <TranscriptView messages={state.transcript} />
          <ActivityTicker activity={state.ticker} />
        </div>
      </div>
      <StatusBar
        progress={state.progress}
        action={state.action}
        connected={connected}
        isRecording={isRecording}
      />
    </div>
  );
}

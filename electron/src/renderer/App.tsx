import { useCallback, useEffect } from "react";
import { ActivityTicker } from "./components/ActivityTicker";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TranscriptView } from "./components/TranscriptView";
import { useAppState } from "./hooks/useAppState";
import { useWebSocket } from "./hooks/useWebSocket";
import type { ClientMessage } from "./types/messages";

export function App() {
  const { state, handleMessage } = useAppState();
  const { send, connected } = useWebSocket(handleMessage);

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Ignore if typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        send({ type: "mic_start" });
      } else if (e.code === "Escape") {
        e.preventDefault();
        send({ type: "cancel_turn" });
      } else if (e.code === "KeyQ" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        send({ type: "quit" });
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
      />
    </div>
  );
}

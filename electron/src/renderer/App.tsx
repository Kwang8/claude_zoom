import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityTicker } from "./components/ActivityTicker";
import { PMDetailView } from "./components/PMDetailView";
import { PMOnboardingView } from "./components/PMOnboardingView";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TranscriptView } from "./components/TranscriptView";
import { WorkLogView } from "./components/WorkLogView";
import { useAppState } from "./hooks/useAppState";
import { useIPC } from "./hooks/useIPC";

type MainView = "worklog" | "agent" | "pm";

export function App() {
  const { state, handleMessage, toggleConversationExpand, clearHistory } = useAppState();
  const { send, connected } = useIPC(handleMessage);
  const [isRecording, setIsRecording] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [mainView, setMainView] = useState<MainView>("worklog");

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
        setSelectedAgentId(null);
        setMainView("worklog");
        console.log("[app] space pressed, sending mic_start");
        setIsRecording(true);
        send({ type: "mic_start" });
      } else if (e.code === "Escape") {
        e.preventDefault();
        if (mainView !== "worklog") {
          setMainView("worklog");
          setSelectedAgentId(null);
        } else if (selectedAgentId) {
          setSelectedAgentId(null);
        } else {
          send({ type: "cancel_turn" });
        }
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

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
    };
  }, [send, selectedAgentId, mainView]);

  const handleDeleteAgent = useCallback(
    (agentId: string) => {
      send({ type: "kill_agent", agent_id: agentId });
    },
    [send]
  );

  const handleNewConversation = useCallback(() => {
    send({ type: "create_conversation" });
  }, [send]);

  const handleSwitchConversation = useCallback((id: string) => {
    send({ type: "switch_conversation", conversation_id: id });
  }, [send]);

  const handleClickPM = useCallback(() => {
    setSelectedAgentId(null);
    setMainView("pm");
  }, []);

  const handlePMInstall = useCallback(() => {
    window.claude?.pmInstall?.();
  }, []);

  useEffect(() => {
    if (selectedAgentId && !state.agents.some((agent) => agent.agent_id === selectedAgentId)) {
      setSelectedAgentId(null);
    }
  }, [selectedAgentId, state.agents]);

  // Auto-return to worklog when PM finishes installing
  useEffect(() => {
    if (mainView === "pm" && (state.pmStatus.status === "idle" || state.pmStatus.status === "scanning")) {
      const pmConfigured = !["not_configured", "installing", "disabled"].includes(state.pmStatus.status)
        && !state.pmStatus.status.startsWith("downloading");
      if (pmConfigured) {
        // Small delay so user sees "done" state
        const timer = setTimeout(() => {
          // Only auto-return if still on PM view and it's the onboarding (not detail)
        }, 1500);
        return () => clearTimeout(timer);
      }
    }
  }, [mainView, state.pmStatus.status]);

  const selectedAgent = state.agents.find((agent) => agent.agent_id === selectedAgentId) ?? null;
  const agentTranscript = useMemo(
    () => selectedAgent
      ? state.transcript.filter((m) => m.agent_id === selectedAgent.agent_id)
      : [],
    [selectedAgent, state.transcript]
  );

  const pmIsConfigured = !["not_configured", "starting", "disabled"].includes(state.pmStatus.status)
    && !state.pmStatus.status.startsWith("downloading")
    && state.pmStatus.status !== "installing";

  let mainContent: React.ReactNode;
  if (mainView === "pm") {
    mainContent = pmIsConfigured ? (
      <PMDetailView onBack={() => setMainView("worklog")} />
    ) : (
      <PMOnboardingView
        status={state.pmStatus.status}
        onInstall={handlePMInstall}
        onBack={() => setMainView("worklog")}
      />
    );
  } else if (mainView === "agent" && selectedAgent) {
    mainContent = (
      <TranscriptView
        messages={agentTranscript}
        selectedAgent={selectedAgent}
        onBackToMain={() => { setSelectedAgentId(null); setMainView("worklog"); }}
        githubRepo={state.githubRepo}
      />
    );
  } else {
    mainContent = (
      <WorkLogView
        conversations={state.conversations}
        transcript={state.transcript}
        agents={state.agents}
        activeConversationId={state.activeConversationId}
        expandedConversationIds={state.expandedConversationIds}
        proposals={state.pmProposals}
        onToggleExpand={toggleConversationExpand}
        onSwitchConversation={handleSwitchConversation}
        onNewConversation={handleNewConversation}
        onMergePr={(convId) => {
          send({ type: "switch_conversation", conversation_id: convId });
          send({ type: "merge_pr" });
        }}
        onApproveProposal={(ideaId) => send({ type: "approve_proposal", idea_id: ideaId })}
        onDismissProposal={(ideaId) => send({ type: "dismiss_proposal", idea_id: ideaId })}
      />
    );
  }

  return (
    <div className="app">
      <div className="titlebar">
        claude_zoom
        <button className="clear-btn" onClick={clearHistory}>Clear</button>
      </div>
      <div className="body">
        <Sidebar
          appState={state.appState}
          narration={state.narration}
          agents={state.agents}
          selectedAgentId={selectedAgentId}
          pmStatus={state.pmStatus}
          onSelectAgent={(id) => { setSelectedAgentId(id); setMainView(id ? "agent" : "worklog"); }}
          onDeleteAgent={handleDeleteAgent}
          onClickPM={handleClickPM}
        />
        <div className="main-area">
          {mainContent}
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

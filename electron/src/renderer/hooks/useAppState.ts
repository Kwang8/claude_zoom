import { useCallback, useReducer } from "react";
import type {
  AgentInfo,
  AppState,
  ConversationGroup,
  ServerMessage,
  TranscriptMessage,
} from "../types/messages";

export interface State {
  appState: AppState;
  narration: string;
  transcript: TranscriptMessage[];
  agents: AgentInfo[];
  conversations: ConversationGroup[];
  activeConversationId: string | null;
  expandedConversationIds: string[];
  ticker: string;
  progress: string;
  action: string;
  isSpeaking: boolean;
  connected: boolean;
  githubRepo: string | null;
  pmStatus: { status: string; ideaCount: number; lastActivity: string | null };
  pmProposals: { ideaId: string; title: string; problem: string; proposal: string; priority: string; tlAssessment: string; timestamp: string }[];
}

const initialState: State = {
  appState: "idle",
  narration: "",
  transcript: [],
  agents: [],
  conversations: [],
  activeConversationId: null,
  expandedConversationIds: [],
  ticker: "",
  progress: "ready",
  action: "connecting...",
  pmProposals: [],
  isSpeaking: false,
  pmStatus: { status: "starting", ideaCount: 0, lastActivity: null },
  connected: false,
  githubRepo: null,
};

type Action =
  | { type: "SERVER_MESSAGE"; msg: ServerMessage }
  | { type: "SET_CONNECTED"; connected: boolean }
  | { type: "TOGGLE_CONVERSATION_EXPAND"; conversationId: string }
  | { type: "CLEAR_HISTORY" };

function reducer(state: State, action: Action): State {
  if (action.type === "SET_CONNECTED") {
    return { ...state, connected: action.connected };
  }

  if (action.type === "CLEAR_HISTORY") {
    return { ...state, transcript: [], conversations: [], expandedConversationIds: [] };
  }

  if (action.type === "TOGGLE_CONVERSATION_EXPAND") {
    const { conversationId } = action;
    const isExpanded = state.expandedConversationIds.includes(conversationId);
    return {
      ...state,
      // Accordion: only one expanded at a time
      expandedConversationIds: isExpanded ? [] : [conversationId],
    };
  }

  const msg = action.msg;

  switch (msg.type) {
    case "state_change":
      return {
        ...state,
        appState: msg.state,
        narration: msg.narration || "",
      };

    case "transcript_message": {
      const newMessage: TranscriptMessage = {
        role: msg.role,
        text: msg.text,
        agent_name: msg.agent_name,
        agent_id: msg.agent_id,
        kind: msg.kind,
        timestamp: msg.timestamp,
        conversation_id: (msg as any).conversation_id,
      };
      const newTranscript = [...state.transcript, newMessage];
      const convId = newMessage.conversation_id;
      let newConversations = state.conversations;
      if (convId) {
        newConversations = state.conversations.map((c) =>
          c.id === convId
            ? { ...c, messageEndIndex: newTranscript.length - 1 }
            : c
        );
      }
      return { ...state, transcript: newTranscript, conversations: newConversations };
    }

    case "ticker_update":
      return { ...state, ticker: msg.activity };

    case "agent_spawned": {
      const filtered = state.agents.filter((a) => a.agent_id !== msg.agent_id);
      const status = msg.status || "working";
      return {
        ...state,
        agents: [
          ...filtered,
          {
            agent_id: msg.agent_id,
            name: msg.name,
            number: msg.number,
            task: msg.task,
            status,
            started_at: status === "working" ? Date.now() : undefined,
          },
        ],
      };
    }

    case "agent_status": {
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.agent_id === msg.agent_id
            ? {
                ...a,
                name: msg.name ?? a.name,
                status: msg.status,
                ticker: msg.ticker ?? a.ticker,
                started_at:
                  msg.status === "working"
                    ? a.status === "working"
                      ? a.started_at
                      : Date.now()
                    : undefined,
              }
            : a
        ),
      };
    }

    case "agent_removed":
      return {
        ...state,
        agents: state.agents.filter((a) => a.agent_id !== msg.agent_id),
      };

    case "tts_start":
      return { ...state, isSpeaking: true };

    case "tts_end":
      return { ...state, isSpeaking: false };

    case "progress":
      return { ...state, progress: msg.text };

    case "action":
      return { ...state, action: msg.text };

    case "repo_context":
      return { ...state, githubRepo: msg.repo };

    case "conversation_start":
    case "conversation_created": {
      if (state.conversations.some((c) => c.id === msg.conversation_id)) {
        return state;
      }
      const newConv: ConversationGroup = {
        id: msg.conversation_id,
        status: "active",
        summary: null,
        detail: null,
        prUrl: null,
        startTimestamp: msg.timestamp,
        endTimestamp: null,
        messageStartIndex: state.transcript.length,
        messageEndIndex: state.transcript.length,
        spawnedAgentIds: [],
      };
      return {
        ...state,
        conversations: [...state.conversations, newConv],
        activeConversationId: msg.conversation_id,
      };
    }

    case "conversation_switched":
      return { ...state, activeConversationId: msg.conversation_id };

    case "conversation_compacted":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === msg.conversation_id
            ? { ...c, status: "compacted" as const, summary: msg.summary, endTimestamp: msg.timestamp }
            : c
        ),
      };

    case "conversation_agent_spawned":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === msg.conversation_id
            ? { ...c, spawnedAgentIds: [...c.spawnedAgentIds, msg.agent_id] }
            : c
        ),
      };

    case "conversation_status":
      return {
        ...state,
        conversations: state.conversations.map((c) =>
          c.id === msg.conversation_id
            ? {
                ...c,
                status: msg.status,
                detail: msg.detail ?? c.detail,
                prUrl: msg.pr_url ?? c.prUrl,
              }
            : c
        ),
      };

    case "pm_status":
      return {
        ...state,
        pmStatus: {
          status: msg.status,
          ideaCount: msg.idea_count,
          lastActivity: msg.last_activity,
        },
      };

    case "pm_proposal":
      return {
        ...state,
        pmProposals: [...state.pmProposals, {
          ideaId: msg.idea_id,
          title: msg.title,
          problem: msg.problem,
          proposal: msg.proposal,
          priority: msg.priority,
          tlAssessment: msg.tl_assessment,
          timestamp: msg.timestamp,
        }],
      };

    default:
      return state;
  }
}

export function useAppState() {
  const [state, dispatch] = useReducer(reducer, initialState);

  const handleMessage = useCallback((msg: ServerMessage) => {
    dispatch({ type: "SERVER_MESSAGE", msg });
  }, []);

  const setConnected = useCallback((connected: boolean) => {
    dispatch({ type: "SET_CONNECTED", connected });
  }, []);

  const toggleConversationExpand = useCallback((conversationId: string) => {
    dispatch({ type: "TOGGLE_CONVERSATION_EXPAND", conversationId });
  }, []);

  const clearHistory = useCallback(() => {
    dispatch({ type: "CLEAR_HISTORY" });
  }, []);

  return { state, handleMessage, setConnected, toggleConversationExpand, clearHistory };
}

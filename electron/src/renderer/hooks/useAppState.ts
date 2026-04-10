import { useCallback, useReducer } from "react";
import type {
  AgentInfo,
  AppState,
  ServerMessage,
  TranscriptMessage,
} from "../types/messages";

export interface State {
  appState: AppState;
  narration: string;
  transcript: TranscriptMessage[];
  agents: AgentInfo[];
  ticker: string;
  progress: string;
  action: string;
  isSpeaking: boolean;
  connected: boolean;
}

const initialState: State = {
  appState: "idle",
  narration: "",
  transcript: [],
  agents: [],
  ticker: "",
  progress: "ready",
  action: "connecting...",
  isSpeaking: false,
  connected: false,
};

type Action =
  | { type: "SERVER_MESSAGE"; msg: ServerMessage }
  | { type: "SET_CONNECTED"; connected: boolean };

function reducer(state: State, action: Action): State {
  if (action.type === "SET_CONNECTED") {
    return { ...state, connected: action.connected };
  }

  const msg = action.msg;

  switch (msg.type) {
    case "state_change":
      return {
        ...state,
        appState: msg.state,
        narration: msg.narration || "",
      };

    case "transcript_message":
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            role: msg.role,
            text: msg.text,
            agent_name: msg.agent_name,
            timestamp: msg.timestamp,
          },
        ],
      };

    case "ticker_update":
      return { ...state, ticker: msg.activity };

    case "agent_spawned":
      return {
        ...state,
        agents: [
          ...state.agents,
          {
            agent_id: msg.agent_id,
            name: msg.name,
            number: msg.number,
            task: msg.task,
            status: msg.status || "working",
          },
        ],
      };

    case "agent_status": {
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.agent_id === msg.agent_id
            ? { ...a, status: msg.status, ticker: msg.ticker ?? a.ticker }
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

  return { state, handleMessage, setConnected };
}

import { useCallback, useEffect, useState } from "react";
import type { ClientMessage, ServerMessage } from "../types/messages";

declare global {
  interface Window {
    claude?: {
      send: (msg: Record<string, any>) => void;
      onEvent: (callback: (msg: Record<string, any>) => void) => () => void;
      removeAllListeners: () => void;
    };
  }
}

export function useIPC(onMessage: (msg: ServerMessage) => void) {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!window.claude) {
      console.warn("[ipc] preload API not available");
      return;
    }

    setConnected(true);
    const cleanup = window.claude.onEvent((msg) => {
      onMessage(msg as ServerMessage);
    });

    return () => {
      cleanup();
      setConnected(false);
    };
  }, [onMessage]);

  const send = useCallback((msg: ClientMessage) => {
    window.claude?.send(msg);
  }, []);

  return { send, connected };
}

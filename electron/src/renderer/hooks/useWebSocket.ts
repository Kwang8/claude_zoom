import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "../types/messages";

const WS_URL = "ws://localhost:8765";

export function useWebSocket(onMessage: (msg: ServerMessage) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        console.log("[ws] connected");
        setConnected(true);
        wsRef.current = ws;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as ServerMessage;
          onMessage(msg);
        } catch {
          console.warn("[ws] bad message:", event.data);
        }
      };

      ws.onclose = () => {
        console.log("[ws] disconnected, reconnecting in 2s...");
        setConnected(false);
        wsRef.current = null;
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = (err) => {
        console.error("[ws] error:", err);
        ws.close();
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [onMessage]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { send, connected };
}

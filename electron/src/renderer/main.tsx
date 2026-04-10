import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/theme.css";
import "./styles/components.css";

function renderFatalError(title: string, detail: string) {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = `
    <div style="height:100vh;padding:24px;background:#0f0f1a;color:#e8e8f0;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif">
      <h1 style="font-size:18px;margin-bottom:12px">${title}</h1>
      <p style="color:#8888a0;margin-bottom:16px">The voice engine may still be running, but the UI hit an unrecovered error.</p>
      <pre style="white-space:pre-wrap;background:#161625;border:1px solid #2a2a45;border-radius:10px;padding:16px">${detail}</pre>
    </div>
  `;
}

type ErrorBoundaryState = {
  error: Error | null;
};

class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[renderer] uncaught render error", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            height: "100vh",
            padding: 24,
            background: "#0f0f1a",
            color: "#e8e8f0",
            fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
          }}
        >
          <h1 style={{ fontSize: 18, marginBottom: 12 }}>Renderer crashed</h1>
          <p style={{ color: "#8888a0", marginBottom: 16 }}>
            The voice engine may still be running, but the UI hit a render error.
          </p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              background: "#161625",
              border: "1px solid #2a2a45",
              borderRadius: 10,
              padding: 16,
            }}
          >
            {this.state.error.stack || this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

window.addEventListener("error", (event) => {
  const error = event.error;
  renderFatalError("Renderer crashed", error?.stack || event.message || "Unknown error");
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const detail =
    reason instanceof Error ? reason.stack || reason.message : String(reason);
  renderFatalError("Renderer crashed", detail);
});

try {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  );
} catch (error) {
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  renderFatalError("Renderer failed to start", detail);
}

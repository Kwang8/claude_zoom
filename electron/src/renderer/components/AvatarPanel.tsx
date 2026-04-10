import type { AppState } from "../types/messages";

interface Props {
  state: AppState;
  narration: string;
}

const STATE_LABELS: Record<AppState, string> = {
  idle: "idle",
  listening: "listening...",
  thinking: "thinking...",
  working: "working...",
  talking: "talking...",
};

export function AvatarPanel({ state, narration }: Props) {
  return (
    <div className="avatar-panel">
      <div className={`avatar-orb ${state}`}>
        <span style={{ fontSize: 28, color: "#fff" }}>C</span>
      </div>
      <div className="avatar-label">claude</div>
      <div className="avatar-state">{STATE_LABELS[state]}</div>
      {narration && (
        <div
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            textAlign: "center",
            marginTop: 4,
          }}
        >
          {narration.slice(0, 80)}
        </div>
      )}
    </div>
  );
}

import type { AppState } from "../types/messages";

interface Props {
  state: AppState;
  narration: string;
  selected?: boolean;
  onClick?: () => void;
}

const STATE_LABELS: Record<AppState, string> = {
  idle: "idle",
  listening: "listening...",
  thinking: "thinking...",
  working: "working...",
  talking: "talking...",
};

export function AvatarPanel({ state, narration, selected = false, onClick }: Props) {
  return (
    <div
      className={`avatar-panel${selected ? " selected" : ""}${onClick ? " clickable" : ""}`}
      onClick={onClick}
      style={onClick ? { cursor: "pointer" } : undefined}
    >
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

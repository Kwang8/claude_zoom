interface Props {
  progress: string;
  action: string;
  connected: boolean;
}

export function StatusBar({ progress, action, connected }: Props) {
  return (
    <div className="statusbar">
      <div className={`statusbar-dot ${connected ? "connected" : "disconnected"}`} />
      {progress && <span className="statusbar-progress">{progress}</span>}
      <span className="statusbar-action">{action}</span>
      <span className="statusbar-hint">space talk &middot; esc cancel &middot; q quit</span>
    </div>
  );
}

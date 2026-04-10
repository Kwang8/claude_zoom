interface Props {
  progress: string;
  action: string;
  connected: boolean;
  isRecording: boolean;
}

export function StatusBar({ progress, action, connected, isRecording }: Props) {
  return (
    <div className={`statusbar${isRecording ? " statusbar-recording" : ""}`}>
      <div className={`statusbar-dot ${connected ? "connected" : "disconnected"}`} />
      {progress && <span className="statusbar-progress">{progress}</span>}
      <span className="statusbar-action">{action}</span>
      {isRecording ? (
        <span className="recording-indicator">
          <span className="recording-dot" />
          recording
        </span>
      ) : (
        <span className="statusbar-hint">hold space · esc cancel · q quit</span>
      )}
    </div>
  );
}

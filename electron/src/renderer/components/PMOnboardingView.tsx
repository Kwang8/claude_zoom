interface Props {
  status: string;
  onInstall: () => void;
  onBack: () => void;
}

export function PMOnboardingView({ status, onInstall, onBack }: Props) {
  const isInstalling = ["installing", "starting server"].includes(status) || status.startsWith("downloading");
  const isDone = status === "idle" || status === "scanning" || status === "thinking";

  return (
    <div className="pm-onboarding">
      <div className="pm-onboarding-header">
        <button className="transcript-back" onClick={onBack} type="button">back</button>
        <h2>Product Manager Agent</h2>
      </div>

      <div className="pm-onboarding-body">
        <div className="pm-onboarding-section">
          <h3>What it does</h3>
          <ul>
            <li>Continuously scans your codebase for patterns, TODOs, and gaps</li>
            <li>Analyzes past conversations to spot repeated requests and pain points</li>
            <li>Generates feature ideas and scores them by impact</li>
            <li>Presents polished proposals as new conversations you can approve</li>
          </ul>
        </div>

        <div className="pm-onboarding-section">
          <h3>How it works</h3>
          <p>
            Runs a local AI model on your machine using Ollama. Your code never leaves
            your computer. The PM thinks in the background while you work — zero cost,
            fully private.
          </p>
        </div>

        <div className="pm-onboarding-section">
          <h3>Requirements</h3>
          <div className="pm-req-list">
            <div className="pm-req-item">
              <span className="pm-req-icon">1</span>
              <div>
                <strong>Ollama</strong>
                <span className="pm-req-detail">Local AI runtime — installed automatically via Homebrew</span>
              </div>
            </div>
            <div className="pm-req-item">
              <span className="pm-req-icon">2</span>
              <div>
                <strong>Qwen 2.5 model</strong>
                <span className="pm-req-detail">~8GB download, one-time. Runs locally.</span>
              </div>
            </div>
          </div>
        </div>

        <div className="pm-onboarding-action">
          {isDone ? (
            <div className="pm-install-done">
              <span className="pm-done-check">done</span>
              <span>PM is active and scanning your project</span>
            </div>
          ) : isInstalling ? (
            <div className="pm-install-progress">
              <div className="pm-progress-dot" />
              <span>{status}</span>
            </div>
          ) : status === "disabled" ? (
            <div className="pm-install-error">
              <span>Setup failed. Check terminal for details.</span>
              <button className="pm-install-btn" onClick={onInstall} type="button">
                retry
              </button>
            </div>
          ) : (
            <button className="pm-install-btn" onClick={onInstall} type="button">
              install &amp; activate
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

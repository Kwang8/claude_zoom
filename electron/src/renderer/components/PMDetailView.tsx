import { useEffect, useState } from "react";

interface PMIdea {
  id: string;
  title: string;
  problem: string;
  proposal: string;
  priority: "high" | "medium" | "low";
  score: number;
}

interface Props {
  onBack: () => void;
}

const PRIORITY_COLORS: Record<string, string> = {
  high: "var(--accent-red)",
  medium: "var(--accent-yellow)",
  low: "var(--accent-green)",
};

export function PMDetailView({ onBack }: Props) {
  const [ideas, setIdeas] = useState<PMIdea[]>([]);
  const [observations, setObservations] = useState<string[]>([]);

  useEffect(() => {
    window.claude?.getPMData?.().then((data: any) => {
      setIdeas(data?.ideas ?? []);
      setObservations(data?.observations ?? []);
    });
  }, []);

  return (
    <div className="pm-detail">
      <div className="pm-detail-header">
        <button className="transcript-back" onClick={onBack} type="button">back</button>
        <h2>Product Manager</h2>
        {ideas.length > 0 && (
          <button
            className="pm-dismiss-btn"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              window.claude?.pmClearIdeas?.().then(() => {
                setIdeas([]);
                setObservations([]);
              });
            }}
            type="button"
          >
            clear all ideas
          </button>
        )}
      </div>

      <div className="pm-detail-body">
        {ideas.length > 0 ? (
          <div className="pm-detail-section">
            <h3>Ideas ({ideas.length})</h3>
            <div className="pm-ideas-list">
              {ideas.sort((a, b) => b.score - a.score).map((idea) => (
                <div key={idea.id} className="pm-idea-card">
                  <div className="pm-idea-header">
                    <span
                      className="pm-idea-priority"
                      style={{ color: PRIORITY_COLORS[idea.priority] }}
                    >
                      {idea.priority}
                    </span>
                    <span className="pm-idea-title">{idea.title}</span>
                  </div>
                  <div className="pm-idea-problem">{idea.problem}</div>
                  {idea.proposal && (
                    <div className="pm-idea-proposal">{idea.proposal}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="pm-detail-section">
            <h3>Ideas</h3>
            <p className="pm-detail-empty">No ideas yet — the PM is still scanning your project.</p>
          </div>
        )}

        {observations.length > 0 && (
          <div className="pm-detail-section">
            <h3>Recent Observations</h3>
            <div className="pm-observations-list">
              {observations.slice(0, 20).map((obs, i) => (
                <div key={i} className="pm-observation">{obs}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

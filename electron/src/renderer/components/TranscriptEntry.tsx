import type React from "react";
import type { TranscriptMessage } from "../types/messages";

interface Props {
  message: TranscriptMessage;
  githubRepo: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  user: "you",
  claude: "claude",
  claude_error: "claude (error)",
};

// Matches owner/repo#123 or bare #123
const PR_LINK_RE = /([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)?#(\d+)/g;

function openExternal(url: string) {
  (window as any).claude?.openExternal(url);
}

function renderWithLinks(text: string, githubRepo: string | null): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  PR_LINK_RE.lastIndex = 0;
  while ((match = PR_LINK_RE.exec(text)) !== null) {
    const [fullMatch, repoPrefix, number] = match;
    const repo = repoPrefix || githubRepo;
    if (!repo) continue;

    // Push text before this match
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const url = `https://github.com/${repo}/issues/${number}`;
    nodes.push(
      <a
        key={match.index}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          openExternal(url);
        }}
        className="pr-link"
      >
        {fullMatch}
      </a>
    );

    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [text];
}

export function TranscriptEntry({ message, githubRepo }: Props) {
  const { role, text, agent_name, kind, timestamp } = message;

  if (kind === "tool_use") {
    return (
      <div className="transcript-entry transcript-tool-use">
        <div className="transcript-header">
          <span className="transcript-role tool_use">{agent_name || "agent"} tool</span>
          <span className="transcript-time">{timestamp}</span>
        </div>
        <div className="transcript-body">{renderWithLinks(text, githubRepo)}</div>
      </div>
    );
  }

  if (role === "system") {
    return (
      <div className="transcript-entry system">
        <div className="transcript-body">{renderWithLinks(text, githubRepo)}</div>
      </div>
    );
  }

  const label = role === "sub_agent" ? agent_name || "agent" : ROLE_LABELS[role] || role;

  return (
    <div className="transcript-entry">
      <div className="transcript-header">
        <span className={`transcript-role ${role}`}>{label}</span>
        <span className="transcript-time">{timestamp}</span>
      </div>
      <div className="transcript-body">{renderWithLinks(text, githubRepo)}</div>
    </div>
  );
}

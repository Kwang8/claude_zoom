import type { ConversationGroup } from "../types/messages";

interface Props {
  conversations: ConversationGroup[];
  activeConversationId: string | null;
  viewingConversationId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onWorklog: () => void;
  isWorklogActive: boolean;
}

export function ConversationSwitcher({
  conversations,
  activeConversationId,
  viewingConversationId,
  onSelect,
  onNew,
  isWorklogActive,
}: Props) {
  if (conversations.length === 0 && !isWorklogActive) {
    return null;
  }

  return (
    <div className="conv-switcher">
      {conversations.map((conv, index) => {
        const isLive = conv.status === "active";
        const isSelected = isWorklogActive
          ? false
          : (viewingConversationId === conv.id ||
            (viewingConversationId === null && conv.id === activeConversationId));

        return (
          <button
            key={conv.id}
            className={`conv-tab${isSelected ? " selected" : ""}`}
            onClick={() => onSelect(conv.id)}
            title={conv.summary ?? undefined}
            type="button"
          >
            <span className={`conv-status-dot ${isLive ? "live" : "compacted"}`} />
            <span>Conv {index + 1}</span>
            {isLive && <span className="conv-live-label">live</span>}
          </button>
        );
      })}

      <button className="conv-new-btn" onClick={onNew} title="New conversation" type="button">
        +
      </button>
    </div>
  );
}

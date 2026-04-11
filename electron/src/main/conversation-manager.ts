import { ChatEngine } from "./chat-engine";
import { ClaudeSession } from "./claude-session";
import {
  ConversationRegistry,
  ConversationRegistryEntry,
  loadRegistry,
  saveRegistry,
} from "./state";

export interface ConversationManagerOpts {
  targetCwd: string | null;
  remoteRepo: string | null;
  remoteAuth: string;
  /** Called whenever any conversation's engine emits an event. Includes conversation_id. */
  onEmit: (conversationId: string, msg: Record<string, any>) => void;
}

interface ConversationEntry {
  id: string;
  engine: ChatEngine;
  createdAt: string;
}

export class ConversationManager {
  private _conversations: Map<string, ConversationEntry> = new Map();
  public activeConversationId: string | null = null;
  private _opts: ConversationManagerOpts;

  constructor(opts: ConversationManagerOpts) {
    this._opts = opts;
  }

  // ── Public API ──

  createConversation(): string {
    const id = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const engine = this._buildEngine(id);
    const createdAt = new Date().toISOString();
    this._conversations.set(id, { id, engine, createdAt });
    this._saveRegistry();
    return id;
  }

  getConversation(id: string): ChatEngine | undefined {
    return this._conversations.get(id)?.engine;
  }

  getActiveConversation(): ChatEngine | null {
    if (!this.activeConversationId) return null;
    return this.getConversation(this.activeConversationId) ?? null;
  }

  resolveTarget(conversationId?: string): ChatEngine | null {
    if (conversationId) return this.getConversation(conversationId) ?? null;
    return this.getActiveConversation();
  }

  setActive(id: string): void {
    if (this._conversations.has(id)) {
      // Unfocus the previous active conversation
      if (this.activeConversationId) {
        this._conversations.get(this.activeConversationId)?.engine.setFocused(false);
      }
      this.activeConversationId = id;
      // Focus the new active conversation
      this._conversations.get(id)?.engine.setFocused(true);
      this._saveRegistry();
    }
  }

  listConversations(): { id: string; createdAt: string; isActive: boolean }[] {
    return Array.from(this._conversations.values()).map(({ id, createdAt }) => ({
      id,
      createdAt,
      isActive: id === this.activeConversationId,
    }));
  }

  removeConversation(id: string): void {
    const entry = this._conversations.get(id);
    if (!entry) return;
    entry.engine.stop();
    this._conversations.delete(id);
    if (this.activeConversationId === id) {
      const first = this._conversations.keys().next();
      this.activeConversationId = first.done ? null : first.value;
    }
    this._saveRegistry();
  }

  async startAll(): Promise<void> {
    // Only start the active conversation's engine. Others stay dormant.
    for (const { id, engine } of this._conversations.values()) {
      if (id === this.activeConversationId) {
        engine.setFocused(true);
        await engine.start();
      } else {
        engine.setFocused(false);
      }
    }
  }

  stopAll(): void {
    for (const { engine } of this._conversations.values()) {
      engine.stop();
    }
  }

  replayStateAll(): void {
    for (const { engine } of this._conversations.values()) {
      engine.replayState();
    }
  }

  get githubRepo(): string | null {
    return this.getActiveConversation()?.githubRepo ?? null;
  }

  // ── Persistence ──

  /** Restore all conversations from the registry, creating engines for each. */
  restoreFromRegistry(): void {
    const cwd = this._opts.targetCwd;
    if (!cwd) return;
    const registry = loadRegistry(cwd);
    if (!registry || registry.conversations.length === 0) return;

    for (const entry of registry.conversations) {
      const engine = this._buildEngine(entry.id);
      this._conversations.set(entry.id, { id: entry.id, engine, createdAt: entry.createdAt });
    }
    if (registry.activeConversationId && this._conversations.has(registry.activeConversationId)) {
      this.activeConversationId = registry.activeConversationId;
    } else if (this._conversations.size > 0) {
      this.activeConversationId = this._conversations.keys().next().value!;
    }
  }

  private _saveRegistry(): void {
    const cwd = this._opts.targetCwd;
    if (!cwd) return;
    const entries: ConversationRegistryEntry[] = Array.from(this._conversations.values()).map(
      ({ id, createdAt }) => ({ id, createdAt })
    );
    const registry: ConversationRegistry = {
      activeConversationId: this.activeConversationId,
      conversations: entries,
    };
    saveRegistry(registry, cwd);
  }

  private _buildEngine(id: string): ChatEngine {
    const session = new ClaudeSession({
      cwd: this._opts.targetCwd,
      model: "sonnet",
      permissionMode: "acceptEdits",
      tools: "",
    });
    return new ChatEngine(session, {
      onEmit: (msg) => this._opts.onEmit(id, msg),
      remoteRepo: this._opts.remoteRepo,
      remoteAuth: this._opts.remoteAuth,
      stateId: id,
    });
  }
}

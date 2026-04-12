import { ChatEngine } from "./chat-engine";
import { ClaudeSession } from "./claude-session";
import {
  ConversationRegistry,
  ConversationRegistryEntry,
  loadRegistry,
  loadState,
  saveRegistry,
} from "./state";
import { ProductManager, PMProposal } from "./product-manager";

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
  private _pm: ProductManager | null = null;

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
    this._pm?.stop();
  }

  /** Start the background Product Manager agent. */
  startProductManager(): void {
    const cwd = this._opts.targetCwd;
    if (!cwd) return;
    this._pm = new ProductManager(cwd, {
      onProposal: (proposal) => this._handleProposal(proposal),
      onStatusUpdate: (update) => {
        this._opts.onEmit("__pm__", { type: "pm_status", ...update });
      },
      onLog: (msg) => console.log(`[pm] ${msg}`),
    });
    this._pm.start();
  }

  /** User-triggered PM install from the onboarding UI. */
  async installPM(): Promise<void> {
    if (this._pm) {
      await this._pm.install();
    }
  }

  /** Get PM data for the detail view. */
  getPMData(): { ideas: any[]; observations: string[] } {
    if (!this._pm) return { ideas: [], observations: [] };
    return {
      ideas: this._pm.getIdeas(),
      observations: this._pm.getObservations(),
    };
  }

  private _handleProposal(proposal: PMProposal): void {
    // Create a conversation for the proposal
    const id = this.createConversation();
    const engine = this.getConversation(id);
    if (!engine) return;

    // Emit proposal status + content to the renderer
    const timestamp = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    this._opts.onEmit(id, {
      type: "conversation_created",
      conversation_id: id,
      timestamp,
    });
    this._opts.onEmit(id, {
      type: "conversation_status",
      conversation_id: id,
      status: "proposal",
      detail: proposal.idea.title,
    });
    this._opts.onEmit(id, {
      type: "transcript_message",
      role: "system",
      text: `🐶 PM Proposal: ${proposal.idea.title}`,
      timestamp,
      conversation_id: id,
    });
    this._opts.onEmit(id, {
      type: "transcript_message",
      role: "claude",
      text: proposal.fullProposal,
      timestamp,
      conversation_id: id,
    });
    console.log(`[pm] proposal created as conversation ${id}: ${proposal.idea.title}`);
  }

  replayStateAll(): void {
    for (const { engine } of this._conversations.values()) {
      engine.replayState();
    }
  }

  get githubRepo(): string | null {
    return this.getActiveConversation()?.githubRepo ?? null;
  }

  getTotalUsage(): { totalInputTokens: number; totalOutputTokens: number } {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const { engine } of this._conversations.values()) {
      totalInputTokens += engine.totalInputTokens;
      totalOutputTokens += engine.totalOutputTokens;
    }
    return { totalInputTokens, totalOutputTokens };
  }

  // ── Persistence ──

  /** Restore all conversations from the registry, creating engines for each. */
  restoreFromRegistry(): void {
    const cwd = this._opts.targetCwd;
    if (!cwd) return;
    const registry = loadRegistry(cwd);
    if (!registry || registry.conversations.length === 0) return;

    let pruned = 0;
    for (const entry of registry.conversations) {
      // Skip empty conversations (no saved messages)
      const state = loadState(cwd, entry.id);
      if (!state || !state.messages || state.messages.length === 0) {
        pruned++;
        continue;
      }
      const engine = this._buildEngine(entry.id);
      this._conversations.set(entry.id, { id: entry.id, engine, createdAt: entry.createdAt });
    }
    if (pruned > 0) {
      console.log(`[conversations] pruned ${pruned} empty conversations from registry`);
      this._saveRegistry();
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

import { ChatEngine } from "./chat-engine";
import { ClaudeSession } from "./claude-session";
import {
  ConversationRegistry,
  ConversationRegistryEntry,
  loadRegistry,
  loadState,
  saveRegistry,
} from "./state";
import { ProductManager, PMProposal, PMIdea } from "./product-manager";
import { extractFinalText } from "./narrator";

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
      onQuestion: (question) => this._handlePMQuestion(question),
      vetWithTL: (idea) => this._vetIdeaWithTL(idea),
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

  /** Vet an idea with the TL (uses Sonnet via active conversation's TL session). */
  private async _vetIdeaWithTL(idea: PMIdea): Promise<string> {
    const engine = this.getActiveConversation();
    if (!engine) return "No active TL session available.";

    const prompt =
      `A Product Manager proposes this feature:\n\n` +
      `**${idea.title}**\n` +
      `Problem: ${idea.problem}\n` +
      `Proposal: ${idea.proposal}\n\n` +
      `Give a brief technical assessment (2-3 sentences):\n` +
      `- Is this feasible to build?\n` +
      `- Roughly how complex? (small/medium/large)\n` +
      `- Any risks or dependencies?\n\n` +
      `Reply with just your assessment, no XML markers.`;

    try {
      const events: Record<string, any>[] = [];
      for await (const event of engine.session.send(prompt)) {
        events.push(event);
      }
      return extractFinalText(events) || "Assessment unavailable.";
    } catch (e) {
      return `Assessment failed: ${e}`;
    }
  }

  private _handleProposal(proposal: PMProposal): void {
    // Lightweight: emit a proposal event, no ChatEngine needed
    const timestamp = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const { idea, tlAssessment } = proposal;

    // Emit as a special proposal event (renderer handles display)
    this._opts.onEmit("__pm__", {
      type: "pm_proposal",
      idea_id: idea.id,
      title: idea.title,
      problem: idea.problem,
      proposal: idea.proposal,
      priority: idea.priority,
      tl_assessment: tlAssessment,
      timestamp,
    });
    console.log(`[pm] proposal emitted: ${idea.title}`);
  }

  /** User approved a proposal — create a real task. */
  approveProposal(ideaId: string): void {
    const idea = this._pm?.getIdeas().find((i) => i.id === ideaId);
    if (!idea) return;

    // Create a new conversation and delegate to TL
    const id = this.createConversation();
    const timestamp = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

    this._opts.onEmit(id, {
      type: "conversation_created",
      conversation_id: id,
      timestamp,
    });
    this.setActive(id);

    // Start the engine and send the task to TL
    const engine = this.getConversation(id);
    if (engine) {
      engine.start().then(() => {
        engine.sendText(`Implement this feature: ${idea.title}. ${idea.proposal}`);
      });
    }
    console.log(`[pm] proposal approved, created task: ${idea.title}`);
  }

  /** User dismissed a proposal — PM learns. */
  dismissProposal(ideaId: string): void {
    this._pm?.dismissIdea(ideaId);
    console.log(`[pm] proposal dismissed: ${ideaId}`);
  }

  private _handlePMQuestion(question: string): void {
    const id = this.createConversation();
    const timestamp = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

    this._opts.onEmit(id, {
      type: "conversation_created",
      conversation_id: id,
      timestamp,
    });
    this._opts.onEmit(id, {
      type: "conversation_status",
      conversation_id: id,
      status: "needs_input",
      detail: "PM needs direction",
    });
    this._opts.onEmit(id, {
      type: "transcript_message",
      role: "claude",
      text: `The Product Manager needs your input to generate better feature ideas:\n\n${question}\n\n*Reply to help the PM understand your product vision.*`,
      timestamp,
      conversation_id: id,
    });
    console.log(`[pm] needs direction conversation created: ${id}, emitted 3 events`);
  }

  /** Forward a user's answer to the PM for product context. */
  addPMAnswer(answer: string): void {
    this._pm?.addUserAnswer(answer);
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

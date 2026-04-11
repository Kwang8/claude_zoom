import { ClaudeSession, summarizeToolArgs } from "./claude-session";
import {
  AgentInstance,
  AgentManager,
  SpeechQueue,
  formatAgentDisplayName,
  inferGithubRepo,
  parseAgentTarget,
  parseVoiceTrigger,
  mergePr,
  checkPrStatus,
} from "./agent-manager";
import { extractFinalText, checkConversationComplete } from "./narrator";
import { TechLead } from "./tech-lead";
import { RemoteClaudeSession } from "./remote-session";
import { playSound, RecorderBridge, speakAsync } from "./voice";
import { AppState, AgentState as AgentStateData, ConversationData, loadState, saveState } from "./state";

// ── Async Signal (replaces threading.Event) ──

class Signal {
  private _set = false;
  private _waiters: (() => void)[] = [];

  set(): void {
    this._set = true;
    const waiters = this._waiters;
    this._waiters = [];
    for (const r of waiters) r();
  }

  clear(): void {
    this._set = false;
  }

  isSet(): boolean {
    return this._set;
  }

  wait(): Promise<void> {
    if (this._set) return Promise.resolve();
    return new Promise((resolve) => {
      this._waiters.push(resolve);
    });
  }
}

// ── Helpers ──

function buildPromptWithImages(prompt: string, images: string[]): string {
  if (!images.length) return prompt;
  const paths = images.map((p) => `  - ${p}`).join("\n");
  return (
    `${prompt}\n\n[The user has attached the following image files as context. ` +
    `Use the Read tool to view them as needed.]\n${paths}`
  );
}

function stripSpawnMarkers(text: string): string {
  return text.replace(/<SPAWN[^>]*>.*?<\/SPAWN>/gis, "").trim();
}

function rewriteDirectedAgentMessage(agentName: string, msg: string): string {
  const escaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`^ask\\s+${escaped}[,\\s:]+(?:to\\s+)?`, "i"),
    new RegExp(`^tell\\s+${escaped}[,\\s:]+(?:to\\s+)?`, "i"),
    new RegExp(`^send\\s+(?:this\\s+)?to\\s+${escaped}[,\\s:]+`, "i"),
    new RegExp(`^${escaped}[,\\s:]+`, "i"),
  ];

  for (const pattern of patterns) {
    if (pattern.test(msg)) {
      const rewritten = msg.replace(pattern, "").trim();
      if (rewritten) return rewritten;
    }
  }
  return msg.trim();
}

// Agent naming
const KEYWORD_CATEGORIES: [Set<string>, string][] = [
  [new Set(["search", "find", "look", "grep", "locate"]), "search"],
  [new Set(["test", "spec", "check", "verify", "validate"]), "test"],
  [new Set(["fix", "bug", "debug", "repair", "patch"]), "fix"],
  [new Set(["code", "write", "implement", "build", "create", "add"]), "code"],
  [new Set(["review", "read", "analyze", "inspect", "audit"]), "review"],
  [new Set(["refactor", "clean", "simplify", "reorganize"]), "refactor"],
  [new Set(["deploy", "release", "ship", "publish"]), "deploy"],
  [new Set(["doc", "document", "readme", "comment"]), "docs"],
];
const CATEGORY_NAMES: Record<string, string[]> = {
  search: ["hermes", "argus", "scout"],
  test: ["athena", "oracle", "sentinel"],
  fix: ["asclepius", "phoenix", "medic"],
  code: ["hephaestus", "daedalus", "forge"],
  review: ["minerva", "sage", "critic"],
  refactor: ["theseus", "sculptor", "prism"],
  deploy: ["apollo", "herald", "mercury"],
  docs: ["calliope", "scribe", "muse"],
};
const DEFAULT_NAMES = [
  "aether", "zephyr", "nova", "spark", "echo",
  "atlas", "clio", "iris", "selene", "orion",
];

function extractAgentName(task: string): string {
  const words = new Set(task.toLowerCase().split(/\s+/));
  for (const [keywords, category] of KEYWORD_CATEGORIES) {
    for (const kw of keywords) {
      if (words.has(kw)) {
        const names = CATEGORY_NAMES[category];
        return names[Math.floor(Math.random() * names.length)];
      }
    }
  }
  return DEFAULT_NAMES[Math.floor(Math.random() * DEFAULT_NAMES.length)];
}

// ── ChatEngine ──

export class ChatEngine {
  session: ClaudeSession;
  private _emit: (msg: Record<string, any>) => void;
  private _resume: boolean;

  private _speechQueue: SpeechQueue;
  private _agentManager: AgentManager;
  private _techLead: TechLead;
  private _recorder: RecorderBridge | null = null;
  private _remoteRepo: string | null;
  private _remoteAuth: string;
  private _stateId: string | undefined;

  // Signals
  private _stopFlag = new Signal();
  private _micEvent = new Signal();
  private _cancelRecording = new Signal();
  private _mainIdle = new Signal();
  private _micHeld = false;

  // State
  private _transcriptLog: Record<string, any>[] = [];
  private _awaitingPrAgentId: string | null = null;
  private _awaitingQuestionAgentId: string | null = null;
  private _awaitingTLEscalation: string | null = null;
  private _awaitingTLAgentId: string | null = null;
  private _lastSubSpeakerId: string | null = null;
  private _imageContext: string[] = [];
  private _pendingText: string | null = null;
  private _currentConvId: string | null = null;
  private _convMessages: Record<string, any>[] = [];
  private _convLog: ConversationData[] = [];
  private _compactionPending: boolean = false;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _convStatus: string = "active";
  private _focused: boolean = true;
  private _unreadCount: number = 0;

  constructor(
    session: ClaudeSession,
    opts: {
      onEmit: (msg: Record<string, any>) => void;
      resume?: boolean;
      remoteRepo?: string | null;
      remoteAuth?: string;
      stateId?: string;
    }
  ) {
    this.session = session;
    this._emit = opts.onEmit;
    this._resume = opts.resume ?? true;

    this._speechQueue = new SpeechQueue();
    this._agentManager = new AgentManager(this._speechQueue);
    this._techLead = new TechLead(session.cwd || ".");
    this._remoteRepo = opts.remoteRepo ?? null;
    this._remoteAuth = opts.remoteAuth ?? "oauth";
    this._stateId = opts.stateId;
  }

  get githubRepo(): string | null {
    return this._remoteRepo || inferGithubRepo(this.session.cwd || ".");
  }

  // ── Emit helpers ──

  private _send(msgType: string, data: Record<string, any> = {}): void {
    this._emit({ type: msgType, ...data });
  }

  private _sendState(state: string, narration: string = ""): void {
    this._send("state_change", { state, narration });
  }

  private _emitConvStatus(status: string, detail?: string, prUrl?: string): void {
    this._convStatus = status;
    this._emit({ type: "conversation_status", conversation_id: "__self__", status, detail, pr_url: prUrl });
  }

  private _sendTranscript(
    role: string,
    text: string,
    agentName: string = "",
    agentId: string = "",
    kind: string = ""
  ): void {
    const msg: Record<string, any> = {
      type: "transcript_message",
      role,
      text,
      agent_name: agentName,
      agent_id: agentId,
      kind,
      conversation_id: this._currentConvId || undefined,
      timestamp: new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" }),
    };
    this._transcriptLog.push(msg);
    if (this._currentConvId) {
      this._convMessages.push(msg);
    }
    this._emit(msg);
    this._scheduleStateSave();
  }

  private _sendTicker(activity: string): void {
    this._send("ticker_update", { activity });
  }

  private _sendProgress(text: string): void {
    this._send("progress", { text });
  }

  private _sendAction(text: string): void {
    this._send("action", { text });
  }

  private _isWelcomeBackMessage(msg: Record<string, any> | null | undefined): boolean {
    if (!msg || msg.type !== "transcript_message" || msg.role !== "claude") {
      return false;
    }
    return typeof msg.text === "string" && msg.text.startsWith("Welcome back! Resumed previous session");
  }

  // ── Focus management ──

  setFocused(focused: boolean): void {
    this._focused = focused;
    if (focused && this._unreadCount > 0) {
      this._unreadCount = 0;
    }
  }

  get isFocused(): boolean {
    return this._focused;
  }

  // ── Public API ──

  async start(): Promise<void> {
    // Try to init recorder (non-blocking, best-effort)
    this._recorder = new RecorderBridge();
    this._recorder.start().then((ok) => {
      if (ok) console.log("[engine] STT recorder ready");
      else console.log("[engine] STT unavailable — text input only");
    });

    // Start concurrent loops
    this._runChatLoop().catch((err) => {
      console.error("[engine] chat loop crashed:", err);
      this._send("action", { text: `chat loop error: ${err}` });
    });
    this._speechConsumer().catch((err) => {
      console.error("[engine] speech consumer crashed:", err);
    });
  }

  stop(): void {
    this._flushStateSave();
    this._saveState();
    this._stopFlag.set();
    this._micEvent.set();
    this.session.cancel();
    this._agentManager.killAll();
    this._recorder?.close();
  }

  micStart(): void {
    this._micHeld = true;
    this._micEvent.set();
  }

  micStop(): void {
    this._micHeld = false;
    this._micEvent.set();
  }

  cancelTurn(): void {
    this.session.cancel();
    this._cancelRecording.set();
    this._micEvent.set();
    this._sendAction("cancel sent");
  }

  sendText(text: string): void {
    this._pendingText = text;
    this._micEvent.set();
  }

  async compactConversation(): Promise<void> {
    if (!this._currentConvId || this._convMessages.length < 1) return;

    const convId = this._currentConvId;
    const timestamp = new Date().toLocaleTimeString("en-US", {
      hour12: false, hour: "2-digit", minute: "2-digit",
    });

    // Generate summary from conversation messages
    let summary = "Conversation compacted by user";
    try {
      const result = await checkConversationComplete(this._convMessages);
      if (result.summary) summary = result.summary;
    } catch {}

    const conv = this._convLog.find((c) => c.id === convId);
    if (conv) {
      conv.status = "compacted";
      conv.summary = summary;
      conv.end_timestamp = timestamp;
    }
    this._send("conversation_compacted", {
      conversation_id: convId,
      summary,
      timestamp,
    });
    this._currentConvId = null;
    this._convMessages = [];
    this._scheduleStateSave();

    const msg = "Conversation compacted.";
    this._sendTranscript("claude", msg);
  }

  prDecision(agentId: string, approved: boolean): void {
    const prUrl = this._agentManager.handlePrDecision(agentId, approved);
    let ack: string;
    if (approved && prUrl) ack = `PR created: ${prUrl}`;
    else if (approved) ack = "Failed to create PR. Branch is still pushed.";
    else ack = "OK, branch is pushed if you want it later.";
    this._sendTranscript("claude", ack);
    this._speak(ack);
    this._awaitingPrAgentId = null;
  }

  /** Merge open PRs for this conversation and transition to completed. */
  mergeOpenPrs(): void {
    const agents = this._agentManager.allAgents.filter((a) => a.prUrl);
    if (agents.length === 0) {
      this._sendTranscript("claude", "No open PRs to merge.");
      this._speak("No open PRs to merge.");
      return;
    }

    let merged = 0;
    let failed = 0;
    const cwd = this.session.cwd || ".";
    for (const agent of agents) {
      const url = agent.prUrl!;
      const status = checkPrStatus(url, cwd);
      if (status === "merged") {
        merged++;
        continue;
      }
      if (status === "open") {
        const ok = mergePr(url, cwd);
        if (ok) {
          merged++;
          this._sendTranscript("claude", `Merged: ${url}`);
        } else {
          failed++;
          this._sendTranscript("claude_error", `Failed to merge: ${url}`);
        }
      } else {
        failed++;
        this._sendTranscript("claude", `PR is ${status}: ${url}`);
      }
    }

    const total = agents.length;
    if (merged === total) {
      const ack = `All ${total} PR${total > 1 ? "s" : ""} merged!`;
      this._sendTranscript("claude", ack);
      this._speak(ack);
      this._emitConvStatus("completed", "PRs merged");
    } else if (merged > 0) {
      const ack = `Merged ${merged}/${total} PRs. ${failed} failed.`;
      this._sendTranscript("claude", ack);
      this._speak(ack);
    } else {
      this._speak(`Failed to merge ${failed} PR${failed > 1 ? "s" : ""}.`);
    }
  }

  agentAnswer(agentId: string, text: string): void {
    const agent = this._agentManager.agents.get(agentId);
    if (agent && agent.status === "needs_input") {
      const displayName = formatAgentDisplayName(agent);
      this._agentManager.handleAgentQuestion(
        agentId, text,
        (id, ev) => this._onSubEvent(id, ev),
        (id) => this._onSubDone(id),
      );
      this._send("agent_status", { agent_id: agentId, status: "working", name: displayName });
      const ack = `Got it, forwarding your answer to ${displayName}.`;
      this._sendTranscript("claude", ack);
      this._speak(ack);
    }
    this._awaitingQuestionAgentId = null;
  }

  killAgent(agentId: string): void {
    this._agentManager.kill(agentId);
    this._send("agent_removed", { agent_id: agentId });
  }

  attachImage(imagePath: string): void {
    this._imageContext.push(imagePath);
    this._sendTranscript("system", `image attached: ${imagePath}`);
  }

  clearImages(): void {
    const n = this._imageContext.length;
    this._imageContext = [];
    if (n) this._sendTranscript("system", `cleared ${n} image(s)`);
  }

  // ── Conversation lifecycle ──

  private _startConversation(): void {
    const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._currentConvId = id;
    this._convMessages = [];
    this._compactionPending = false;
    const timestamp = new Date().toLocaleTimeString("en-US", {
      hour12: false, hour: "2-digit", minute: "2-digit",
    });
    const data: ConversationData = {
      id, status: "active", summary: null,
      start_timestamp: timestamp, end_timestamp: null, spawned_agent_ids: [],
    };
    this._convLog.push(data);
    this._send("conversation_start", { conversation_id: id, timestamp });
    this._scheduleStateSave();
  }

  private async _checkCompaction(): Promise<void> {
    if (!this._currentConvId || this._convMessages.length < 2) return;
    if (this._compactionPending) return;
    this._compactionPending = true;

    const convId = this._currentConvId;
    try {
      const result = await checkConversationComplete(this._convMessages);
      // If user started talking again, the conversation is still active — skip
      if (this._currentConvId !== convId) return;

      if (result.shouldCompact) {
        const timestamp = new Date().toLocaleTimeString("en-US", {
          hour12: false, hour: "2-digit", minute: "2-digit",
        });
        const conv = this._convLog.find((c) => c.id === convId);
        if (conv) {
          conv.status = "compacted";
          conv.summary = result.summary;
          conv.end_timestamp = timestamp;
        }
        this._send("conversation_compacted", {
          conversation_id: convId,
          summary: result.summary,
          timestamp,
        });
        this._currentConvId = null;
        this._convMessages = [];
        this._scheduleStateSave();
      }
    } catch (e) {
      console.warn("[engine] compaction check failed:", e);
    } finally {
      this._compactionPending = false;
    }
  }

  /** Replay transcript + agent list to a newly connected renderer. */
  replayState(): void {
    // Replay conversation events first
    for (const conv of this._convLog) {
      this._emit({ type: "conversation_start", conversation_id: conv.id, timestamp: conv.start_timestamp });
      for (const agentId of conv.spawned_agent_ids) {
        this._emit({ type: "conversation_agent_spawned", conversation_id: conv.id, agent_id: agentId });
      }
      if (conv.status === "compacted" && conv.summary) {
        this._emit({ type: "conversation_compacted", conversation_id: conv.id, summary: conv.summary, timestamp: conv.end_timestamp || conv.start_timestamp });
      }
    }
    // Then replay transcript messages and agents
    for (const msg of this._transcriptLog) {
      this._emit(msg);
    }
    for (const a of this._agentManager.allAgents) {
      this._emit({
        type: "agent_spawned",
        agent_id: a.id,
        name: formatAgentDisplayName(a),
        number: a.number,
        task: a.task,
        status: a.status,
      });
    }
  }

  // ── Main chat loop ──

  private async _runChatLoop(): Promise<void> {
    if (this._resume) this._restoreState();
    this._sendProgress("ready");
    this._micEvent.clear();

    let turn = 0;
    while (!this._stopFlag.isSet()) {
      // IDLE
      this._sendTicker("");
      this._sendState("idle");
      this._sendProgress(turn ? `turn ${turn}` : "ready");
      this._sendAction("press SPACE to talk");
      this._mainIdle.set();
      if (!(await this._waitForInput())) break;
      this._mainIdle.clear();

      // Check for typed text
      if (this._pendingText) {
        const text = this._pendingText;
        this._pendingText = null;
        turn++;
        if (!this._currentConvId) this._startConversation();
        this._sendTranscript("user", text);
        this._sendAction(`text: ${text.slice(0, 60)}`);
        await this._processUserInput(text, turn);
        continue;
      }

      // LISTEN (voice recording)
      turn++;
      this._cancelRecording.clear();
      this._sendState("listening");
      this._sendProgress(`turn ${turn}`);
      this._sendAction("recording — release SPACE to send");
      playSound("ready");

      if (!this._recorder?.ready) {
        this._sendAction("voice unavailable — type below to chat");
        this._sendState("idle");
        continue;
      }

      this._recorder.startRecording();

      // Wait for space release (or cancel/stop)
      while (this._micHeld && !this._stopFlag.isSet() && !this._cancelRecording.isSet()) {
        this._micEvent.clear();
        await Promise.race([this._micEvent.wait(), this._stopFlag.wait()]);
      }
      if (this._stopFlag.isSet()) break;

      if (this._cancelRecording.isSet()) {
        this._cancelRecording.clear();
        this._sendState("idle");
        this._sendAction("cancelled");
        continue;
      }

      // TRANSCRIBE
      this._sendState("thinking");
      this._sendAction("transcribing...");

      let transcript: string | null;
      try {
        transcript = await this._recorder.stopAndTranscribe();
      } catch (e: any) {
        this._sendAction(`transcribe error: ${String(e).slice(0, 60)}`);
        this._sendState("idle");
        continue;
      }

      if (!transcript) {
        this._sendAction("(no input)");
        this._sendState("idle");
        continue;
      }

      if (!this._currentConvId) this._startConversation();
      this._sendTranscript("user", transcript);
      this._sendAction(`heard: ${transcript.slice(0, 60)}`);
      await this._processUserInput(transcript, turn);
    }

    this._sendAction("bye");
  }

  private async _processUserInput(transcript: string, _turn: number): Promise<void> {
    this._lastSubSpeakerId = null;

    // PR DECISION ROUTING
    if (this._awaitingPrAgentId) {
      const agentId = this._awaitingPrAgentId;
      this._awaitingPrAgentId = null;
      const lower = transcript.toLowerCase();
      const approved = ["yes", "yeah", "yep", "sure", "do it", "open"].some((w) => lower.includes(w));
      this.prDecision(agentId, approved);
      return;
    }

    // TL ESCALATION RESPONSE
    if (this._awaitingTLEscalation) {
      const question = this._awaitingTLEscalation;
      const agentId = this._awaitingTLAgentId;
      this._awaitingTLEscalation = null;
      this._awaitingTLAgentId = null;
      this._emitConvStatus("working", "processing your answer");
      this._handleTLEscalationResponse(question, agentId, transcript);
      const ack = "Got it, passing that along.";
      this._sendTranscript("claude", ack);
      await this._speak(ack);
      return;
    }

    // AGENT QUESTION ROUTING (legacy)
    if (this._awaitingQuestionAgentId) {
      const agentId = this._awaitingQuestionAgentId;
      this.agentAnswer(agentId, transcript);
      return;
    }

    // USER-INITIATED COMMANDS
    const lowerTrimmed = transcript.toLowerCase().trim();
    if (lowerTrimmed === "compact" || lowerTrimmed === "/compact" || lowerTrimmed === "compact conversation") {
      await this.compactConversation();
      return;
    }

    // MERGE PR command
    if (["merge", "merge it", "merge the pr", "merge pr", "merge prs", "ship it"].some((w) => lowerTrimmed === w)) {
      this.mergeOpenPrs();
      return;
    }

    // VOICE TRIGGER — fast-path
    const trigger = parseVoiceTrigger(transcript);
    if (trigger) {
      const [triggerTask, triggerRemote] = trigger;
      if (triggerRemote) {
        const name = extractAgentName(triggerTask);
        try {
          const agent = this._spawnSub(name, triggerTask, true);
          const ack = `On it! Kicked off ${formatAgentDisplayName(agent)}.`;
          this._sendTranscript("claude", ack);
          this._sendState("talking", ack);
          await this._speak(ack);
        } catch (e) {
          this._sendTranscript("claude_error", `spawn failed: ${e}`);
        }
      } else {
        const ack = "On it, planning that out.";
        this._sendTranscript("claude", ack);
        this._sendState("talking", ack);
        await this._speak(ack);
        this._delegateToTechLead(triggerTask);
      }
      return;
    }

    // AGENT TARGETING — "agent hermes: do X"
    const target = parseAgentTarget(transcript);
    if (target) {
      const [ref, msg] = target;
      const agent = this._agentManager.resolveAgentRef(ref);
      if (agent) {
        await this._routeToAgent(agent, msg);
        return;
      }
    }

    // DIRECT TO TL — no EM middleman
    this._sendState("thinking");
    this._sendAction("tech lead is thinking...");
    this._delegateToTechLead(buildPromptWithImages(transcript, this._imageContext));
  }

  // ── Tech Lead integration ──

  private _delegateToTechLead(task: string): void {
    console.log("[engine] delegating to TL:", task.slice(0, 120));
    this._sendAction("tech lead is planning...");
    this._sendTicker("tech lead");

    this._techLead.delegateTask(task, (event) => {
      // Stream TL tool calls to the UI ticker
      if (event.type === "assistant") {
        const content = event.message?.content || [];
        for (const item of content) {
          if (item.type === "tool_use") {
            const tname = item.name || "?";
            const short = summarizeToolArgs(tname, item.input || {});
            this._sendTicker(`TL: ${tname}(${short})`);
          }
        }
      }
    }).then((response) => {
      console.log("[engine] TL responded:", JSON.stringify({
        spawns: response.spawns.length,
        escalation: !!response.escalation,
        report: !!response.report,
        answer: !!response.answer,
        fixes: response.fixes.length,
        insights: response.insights.length,
      }));
      if (response.insights.length > 0) this._scheduleStateSave();
      this._sendTicker("");
      for (const [name, agentTask] of response.spawns) {
        console.log("[engine] TL spawning:", name, agentTask.slice(0, 80));
        try { this._spawnSub(name, agentTask); } catch (e) {
          console.error(`[tl] spawn failed for ${name}:`, e);
        }
      }
      if (response.spawns.length > 0) {
        this._emitConvStatus("working", `${response.spawns.length} agent${response.spawns.length > 1 ? "s" : ""} working`);
      }
      if (response.escalation) {
        console.log("[engine] TL escalating:", response.escalation.slice(0, 80));
        this._awaitingTLEscalation = response.escalation;
        this._emitConvStatus("needs_input", response.escalation);
        this._speechQueue.put("tech lead", response.escalation, {
          requiresResponse: true, questionType: "agent_question",
        });
      }
      if (response.report) {
        console.log("[engine] TL report:", response.report.slice(0, 80));
        this._speakTLReport(response.report);
      }
      if (!response.spawns.length && !response.escalation && !response.report) {
        console.warn("[engine] TL returned no actionable output");
        this._speechQueue.put("tech lead", "On it.");
      }
    }).catch((e) => {
      console.error("[tl] delegate error:", e);
      this._sendTicker("");
      this._speechQueue.put("tech lead", `Hit an error while planning: ${e}`);
    });
  }

  private _handleTLQuestionFromAgent(
    agentId: string, agentName: string, question: string, task: string
  ): void {
    this._sendAction(`tech lead answering ${agentName}...`);
    this._techLead.handleAgentQuestion(agentName, agentId, question, task).then((response) => {
      if (response.answer) {
        this._agentManager.handleAgentQuestion(
          agentId, response.answer,
          (id, ev) => this._onSubEvent(id, ev),
          (id) => this._onSubDone(id),
        );
        this._send("agent_status", { agent_id: agentId, status: "working", name: agentName });
      } else if (response.escalation) {
        this._awaitingTLEscalation = response.escalation;
        this._awaitingTLAgentId = agentId;
        this._speechQueue.put("tech lead", `Question about ${agentName}'s work: ${response.escalation}`, {
          requiresResponse: true, questionType: "agent_question",
        });
      }
    }).catch((e) => {
      console.error(`[tl] question error for ${agentName}:`, e);
      this._awaitingTLEscalation = question;
      this._awaitingTLAgentId = agentId;
      this._speechQueue.put("tech lead", `Agent ${agentName} asks: ${question}`, {
        requiresResponse: true, questionType: "agent_question",
      });
    });
  }

  private _handleTLEscalationResponse(
    question: string, agentId: string | null, userAnswer: string
  ): void {
    this._techLead.forwardUserAnswer(question, userAnswer, agentId).then((response) => {
      if (response.answer && agentId) {
        this._agentManager.handleAgentQuestion(
          agentId, response.answer,
          (id, ev) => this._onSubEvent(id, ev),
          (id) => this._onSubDone(id),
        );
        const agent = this._agentManager.agents.get(agentId);
        if (agent) this._send("agent_status", { agent_id: agentId, status: "working", name: agent.name });
      }
      for (const [name, agentTask] of response.spawns) {
        try { this._spawnSub(name, agentTask); } catch {}
      }
      if (response.report) this._speakTLReport(response.report);
    }).catch((e) => console.error("[tl] escalation response error:", e));
  }

  private _submitResultToTL(agent: AgentInstance): void {
    const summary = extractFinalText(agent.events) || "Completed with no summary.";
    this._sendAction(`tech lead reviewing ${agent.name}...`);

    this._techLead.reviewResult(agent.name, agent.id, agent.task, summary).then((response) => {
      for (const [fixName, fixInstruction] of response.fixes) {
        const fixAgent = this._agentManager.resolveAgentRef(fixName);
        if (fixAgent) {
          this._agentManager.sendToAgent(fixAgent, fixInstruction,
            (id, ev) => this._onSubEvent(id, ev), (id) => this._onSubDone(id));
          this._send("agent_status", { agent_id: fixAgent.id, status: "working", name: fixAgent.name });
        }
      }
      for (const [name, agentTask] of response.spawns) {
        try { this._spawnSub(name, agentTask); } catch {}
      }
      if (response.report) this._speakTLReport(response.report);
      if (agent.prUrl) {
        const prMsg = response.report
          ? `${response.report} PR created: ${agent.prUrl}`
          : `Agent ${agent.name} finished. PR created: ${agent.prUrl}`;
        this._sendTranscript("claude", prMsg);
        if (this._focused) {
          this._speak(prMsg);
        } else {
          this._unreadCount++;
        }
      }
      // Only check completion after TL has had a chance to spawn follow-ups
      if (!response.spawns.length && !response.fixes.length) {
        this._checkAllAgentsDone();
      }
    }).catch((e) => {
      console.error(`[tl] review error for ${agent.name}:`, e);
      this._speechQueue.put(agent.name, summary);
    });
  }

  private _speakTLReport(report: string): void {
    if (this._focused) {
      this._speechQueue.put("tech lead", report);
    } else {
      this._unreadCount++;
    }
  }

  // ── Routing helper ──

  private async _routeToAgent(
    agent: AgentInstance,
    msg: string,
    suffix: string = ""
  ): Promise<void> {
    const rewritten = rewriteDirectedAgentMessage(agent.name, msg);
    const displayName = formatAgentDisplayName(agent);
    let ack: string;
    if (agent.status === "working") {
      agent.taskQueue.push(rewritten);
      ack = `Queued that for ${displayName}.`;
    } else {
      this._agentManager.sendToAgent(
        agent, rewritten,
        (id, ev) => this._onSubEvent(id, ev),
        (id) => this._onSubDone(id),
      );
      this._send("agent_status", { agent_id: agent.id, status: "working", name: displayName });
      ack = `Sent to ${displayName}.`;
    }
    if (suffix) ack = `${ack} ${suffix}`;
    this._sendTranscript("claude", ack);
    await this._speak(ack);
  }

  // ── Voice helpers ──

  private async _speak(text: string): Promise<void> {
    this._send("tts_start", { text, speaker: "claude" });
    const proc = speakAsync(text);
    if (!proc) {
      this._send("tts_end");
      return;
    }

    try {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (this._stopFlag.isSet() || this._micEvent.isSet()) {
            proc.kill("SIGTERM");
          }
        }, 50);

        proc.on("exit", () => {
          clearInterval(check);
          resolve();
        });
      });
    } finally {
      this._send("tts_end");
    }
  }

  private async _speechConsumer(): Promise<void> {
    while (!this._stopFlag.isSet()) {
      const item = await this._speechQueue.get(200);
      if (!item) continue;

      // Wait for main to be idle
      await Promise.race([this._mainIdle.wait(), this._stopFlag.wait()]);
      if (this._stopFlag.isSet()) break;

      playSound("done");
      this._sendTranscript("sub_agent", item.text, item.label, item.agentId || "");
      this._sendState("talking", item.text);
      this._sendAction(`speaking: ${item.label}`);

      this._send("tts_start", { text: item.text, speaker: item.label });
      const spokenText = `${item.label} says: ${item.text}`;
      const proc = speakAsync(spokenText);
      if (proc) {
        try {
          await new Promise<void>((resolve) => {
            const check = setInterval(() => {
              if (this._stopFlag.isSet() || this._micEvent.isSet()) {
                proc.kill("SIGTERM");
                this._speechQueue.drain();
              }
            }, 50);
            proc.on("exit", () => {
              clearInterval(check);
              resolve();
            });
          });
        } catch {}
      }
      this._send("tts_end");

      if (item.agentId) {
        this._lastSubSpeakerId = item.agentId;
      }

      if (item.requiresResponse && item.agentId) {
        if (item.questionType === "agent_question") {
          this._awaitingQuestionAgentId = item.agentId;
          this._send("agent_status", {
            agent_id: item.agentId,
            status: "needs_input",
            name: item.label,
          });
        } else {
          this._awaitingPrAgentId = item.agentId;
        }
      }

      this._sendState("idle");
      this._sendAction("press SPACE to talk");
    }
  }

  private async _waitForInput(): Promise<boolean> {
    await Promise.race([this._micEvent.wait(), this._stopFlag.wait()]);
    if (this._stopFlag.isSet()) return false;
    this._micEvent.clear();
    return true;
  }

  // ── Sub-agent helpers ──

  private _spawnSub(name: string, task: string, remote: boolean = false): AgentInstance {
    const baseCwd = this.session.cwd || ".";
    let repo = this._remoteRepo;
    if (remote && !repo) {
      repo = inferGithubRepo(baseCwd);
    }
    if (remote && !repo) {
      throw new Error(
        "Remote sub-agents need a GitHub repo. Set CLAUDE_ZOOM_REMOTE_REPO or configure remote.origin.url."
      );
    }
    const agent = this._agentManager.spawn({
      task: buildPromptWithImages(task, this._imageContext),
      name,
      baseCwd,
      model: "sonnet",
      permissionMode: this.session.permissionMode,
      remote,
      repo,
      auth: this._remoteAuth,
      onEvent: (id, ev) => this._onSubEvent(id, ev),
      onDone: (id) => this._onSubDone(id),
    });
    this._send("agent_spawned", {
      agent_id: agent.id,
      name: formatAgentDisplayName(agent),
      number: agent.number,
      task,
      status: agent.status,
    });
    this._sendTranscript("system", `spawned ${formatAgentDisplayName(agent)}`);
    if (this._currentConvId) {
      const conv = this._convLog.find((c) => c.id === this._currentConvId);
      if (conv) conv.spawned_agent_ids.push(agent.id);
      this._send("conversation_agent_spawned", {
        conversation_id: this._currentConvId,
        agent_id: agent.id,
      });
    }
    this._techLead.contextTree.addAgent(name, agent.id, task);
    this._scheduleStateSave();
    return agent;
  }

  private _onSubEvent(agentId: string, event: Record<string, any>): void {
    if (event.type !== "assistant") return;
    const agent = this._agentManager.agents.get(agentId);
    const content = event.message?.content || [];
    for (const item of content) {
      if (item.type === "tool_use") {
        const tname = item.name || "?";
        const short = summarizeToolArgs(tname, item.input || {});
        if (agent) {
          this._sendTranscript(
            "system",
            `${tname}(${short})`,
            formatAgentDisplayName(agent),
            agent.id,
            "tool_use"
          );
        }
        this._send("agent_status", {
          agent_id: agentId,
          status: "working",
          ticker: `${tname}(${short})`,
        });
      }
    }
  }

  private _onSubDone(agentId: string): void {
    const agent = this._agentManager.agents.get(agentId);
    if (!agent) return;

    this._techLead.contextTree.updateAgentStatus(agentId, agent.status as any);
    this._send("agent_status", {
      agent_id: agentId,
      status: agent.status,
      name: formatAgentDisplayName(agent),
    });
    this._scheduleStateSave();

    if (agent.status === "needs_input" && agent.pendingQuestion) {
      this._emitConvStatus("needs_input", `${agent.name} needs input`);
      this._handleTLQuestionFromAgent(agentId, agent.name, agent.pendingQuestion, agent.task);
    } else if (agent.status === "done" || agent.status === "pr_pending") {
      // TL reviews result — may spawn follow-ups. Check completion AFTER review.
      this._submitResultToTL(agent);
    } else if (agent.status === "error") {
      const errMsg = agent.pendingQuestion || "Unknown error";
      this._speechQueue.put(agent.name, `Error: ${errMsg}`, { agentId: agent.id });
      this._checkAllAgentsDone();
    }
  }

  private _checkAllAgentsDone(): void {
    const all = this._agentManager.allAgents;
    if (all.length === 0) return;
    const allDone = all.every((a) => a.status === "done" || a.status === "error");
    if (!allDone) return;

    const prUrls = all.map((a) => a.prUrl).filter(Boolean) as string[];
    if (prUrls.length > 0) {
      this._emitConvStatus("pr_open", `${prUrls.length} PR${prUrls.length > 1 ? "s" : ""} open`, prUrls[0]);
    } else {
      this._emitConvStatus("completed", "All agents finished");
    }
  }

  // ── State persistence ──

  private _saveState(): void {
    const cwd = this.session.cwd || ".";
    const stateId = this._stateId;
    const agentStates: AgentStateData[] = this._agentManager.allAgents.map((a) => ({
      id: a.id,
      name: a.name,
      session_id: a.session.sessionId,
      worktree_path: a.worktreePath,
      base_cwd: a.baseCwd,
      task: a.task,
      status: a.status === "working" ? "done" : a.status,
      number: a.number,
      branch: a.branch,
      remote: a.remote,
      repo: a.repo,
      auth: a.auth,
    }));

    const state: AppState = {
      main_session_id: this.session.sessionId,
      main_model: this.session.model,
      main_cwd: cwd,
      agents: agentStates,
      agent_counter: this._agentManager._counter,
      messages: this._transcriptLog.slice(-200),
      conversations: this._convLog,
      current_conversation_id: this._currentConvId,
      tech_lead_session_id: this._techLead.sessionId,
      tl_memory: this._techLead.getMemory(),
    };
    saveState(state, cwd, stateId);
  }

  private _scheduleStateSave(): void {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveState();
    }, 250);
  }

  private _flushStateSave(): void {
    if (!this._saveTimer) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
  }

  private _restoreState(): string | null | undefined {
    const cwd = this.session.cwd || ".";
    const state = loadState(cwd, this._stateId);
    if (!state || !state.main_session_id) return null;

    this.session.sessionId = state.main_session_id;
    this._agentManager._counter = state.agent_counter;
    if (state.tech_lead_session_id) {
      this._techLead.restoreSession(state.tech_lead_session_id);
    }
    if (state.tl_memory) {
      this._techLead.restoreMemory(state.tl_memory);
    }

    // Restore conversations
    if (state.conversations?.length) {
      this._convLog = state.conversations;
      this._currentConvId = state.current_conversation_id || null;
      for (const conv of this._convLog) {
        this._emit({ type: "conversation_start", conversation_id: conv.id, timestamp: conv.start_timestamp });
        for (const agentId of conv.spawned_agent_ids) {
          this._emit({ type: "conversation_agent_spawned", conversation_id: conv.id, agent_id: agentId });
        }
        if (conv.status === "compacted" && conv.summary) {
          this._emit({ type: "conversation_compacted", conversation_id: conv.id, summary: conv.summary, timestamp: conv.end_timestamp || conv.start_timestamp });
        }
      }
      if (this._currentConvId) {
        this._convMessages = (state.messages || []).filter(
          (m: any) => m.conversation_id === this._currentConvId
        );
      }
    }

    if (state.messages?.length) {
      this._transcriptLog = [...state.messages];
      for (const msg of state.messages) {
        this._emit(msg);
      }
    }

    for (const a of state.agents) {
      const session = a.remote
        ? new RemoteClaudeSession({
            cwd: a.base_cwd,
            model: "sonnet",
            permissionMode: this.session.permissionMode,
            appendSystemPrompt: this._agentManager.subSystemPrompt(),
            repo: a.repo,
            auth: a.auth,
          })
        : new ClaudeSession({
            cwd: a.worktree_path || a.base_cwd,
            model: "sonnet",
            permissionMode: this.session.permissionMode,
            appendSystemPrompt: this._agentManager.subSystemPrompt(),
          });
      session.sessionId = a.session_id;

      const agent: AgentInstance = {
        id: a.id,
        name: a.name,
        session,
        worktreePath: a.worktree_path,
        baseCwd: a.base_cwd,
        task: a.task,
        remote: Boolean(a.remote),
        repo: a.repo ?? null,
        auth: a.auth ?? "oauth",
        status: a.status as any,
        events: [],
        taskQueue: [],
        branch: a.branch,
        prUrl: null,
        number: a.number,
        pendingQuestion: null,
      };
      this._agentManager.agents.set(a.id, agent);
      this._send("agent_spawned", {
        agent_id: a.id,
        name: formatAgentDisplayName(agent),
        number: a.number,
        task: a.task,
        status: a.status,
      });

      if (a.status === "needs_input" && !this._awaitingQuestionAgentId) {
        this._awaitingQuestionAgentId = a.id;
      } else if (a.status === "pr_pending" && !this._awaitingPrAgentId) {
        this._awaitingPrAgentId = a.id;
      }
    }

    const n = state.agents.length;
    const names = state.agents
      .map((a) => this._agentManager.agents.get(a.id))
      .filter((agent): agent is AgentInstance => Boolean(agent))
      .map((agent) => formatAgentDisplayName(agent))
      .join(", ");
    const intro = n
      ? `Welcome back! Resumed previous session with ${n} agent${n !== 1 ? "s" : ""}: ${names}. Press space to talk.`
      : "Welcome back! Resumed previous session. Press space to talk.";
    const lastMessage = state.messages?.[state.messages.length - 1];
    return this._isWelcomeBackMessage(lastMessage) ? undefined : intro;
  }
}

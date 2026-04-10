import { ClaudeSession, summarizeToolArgs } from "./claude-session";
import {
  AgentInstance,
  AgentManager,
  SpeechQueue,
  classifyMessageTarget,
  inferGithubRepo,
  parseAgentTarget,
  parseSpawnMarkers,
  parseVoiceTrigger,
} from "./agent-manager";
import { CoordinatorAgent } from "./coordinator";
import { summarizeTurn } from "./narrator";
import { RemoteClaudeSession } from "./remote-session";
import { playSound, RecorderBridge, speakAsync } from "./voice";
import { AppState, AgentState as AgentStateData, loadState, saveState } from "./state";

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
  private _coordinator: CoordinatorAgent;
  private _recorder: RecorderBridge | null = null;
  private _remoteRepo: string | null;
  private _remoteAuth: string;

  // Signals
  private _stopFlag = new Signal();
  private _micEvent = new Signal();
  private _cancelRecording = new Signal();
  private _mainIdle = new Signal();

  // State
  private _transcriptLog: Record<string, any>[] = [];
  private _awaitingPrAgentId: string | null = null;
  private _awaitingQuestionAgentId: string | null = null;
  private _lastSubSpeakerId: string | null = null;
  private _imageContext: string[] = [];
  private _pendingText: string | null = null;

  constructor(
    session: ClaudeSession,
    opts: {
      onEmit: (msg: Record<string, any>) => void;
      resume?: boolean;
      remoteRepo?: string | null;
      remoteAuth?: string;
    }
  ) {
    this.session = session;
    this._emit = opts.onEmit;
    this._resume = opts.resume ?? true;

    this._speechQueue = new SpeechQueue();
    this._agentManager = new AgentManager(this._speechQueue);
    this._coordinator = new CoordinatorAgent(session.cwd || ".");
    this._remoteRepo = opts.remoteRepo ?? null;
    this._remoteAuth = opts.remoteAuth ?? "oauth";
  }

  // ── Emit helpers ──

  private _send(msgType: string, data: Record<string, any> = {}): void {
    this._emit({ type: msgType, ...data });
  }

  private _sendState(state: string, narration: string = ""): void {
    this._send("state_change", { state, narration });
  }

  private _sendTranscript(role: string, text: string, agentName: string = ""): void {
    const msg: Record<string, any> = {
      type: "transcript_message",
      role,
      text,
      agent_name: agentName,
      timestamp: new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" }),
    };
    this._transcriptLog.push(msg);
    this._emit(msg);
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
    this._saveState();
    this._stopFlag.set();
    this._micEvent.set();
    this.session.cancel();
    this._agentManager.killAll();
    this._recorder?.close();
  }

  micStart(): void {
    this._micEvent.set();
  }

  micStop(): void {
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

  agentAnswer(agentId: string, text: string): void {
    const agent = this._agentManager.agents.get(agentId);
    if (agent && agent.status === "needs_input") {
      this._agentManager.handleAgentQuestion(
        agentId, text,
        (id, ev) => this._onSubEvent(id, ev),
        (id) => this._onSubDone(id),
      );
      this._send("agent_status", { agent_id: agentId, status: "working", name: agent.name });
      const ack = `Got it, forwarding your answer to agent ${agent.name}.`;
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

  /** Replay transcript + agent list to a newly connected renderer. */
  replayState(): void {
    for (const msg of this._transcriptLog) {
      this._emit(msg);
    }
    for (const a of this._agentManager.allAgents) {
      this._emit({
        type: "agent_spawned",
        agent_id: a.id,
        name: a.name,
        number: a.number,
        task: a.task,
        status: a.status,
      });
    }
  }

  // ── Main chat loop ──

  private async _runChatLoop(): Promise<void> {
    let intro: string | null = null;
    if (this._resume) intro = this._restoreState();
    if (!intro) {
      intro = "Hey! Press space to talk. You can spin off sub-agents and talk to them by name or number.";
    }
    this._sendTranscript("claude", intro);
    this._sendProgress("ready");
    await this._speak(intro);
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
      this._sendAction("recording — press SPACE to send");
      playSound("ready");

      if (!this._recorder?.ready) {
        this._sendAction("voice unavailable — type below to chat");
        this._sendState("idle");
        continue;
      }

      this._recorder.startRecording();

      if (!(await this._waitForInput())) break;

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

      this._sendTranscript("user", transcript);
      this._sendAction(`heard: ${transcript.slice(0, 60)}`);
      await this._processUserInput(transcript, turn);
    }

    this._sendAction("bye");
  }

  private async _processUserInput(transcript: string, _turn: number): Promise<void> {
    const lastSubId = this._lastSubSpeakerId;
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

    // AGENT QUESTION ROUTING
    if (this._awaitingQuestionAgentId) {
      const agentId = this._awaitingQuestionAgentId;
      this.agentAnswer(agentId, transcript);
      return;
    }

    // VOICE TRIGGER
    const trigger = parseVoiceTrigger(transcript);
    if (trigger) {
      const [triggerTask, triggerRemote] = trigger;
      const name = extractAgentName(triggerTask);
      try {
        this._spawnSub(name, triggerTask, triggerRemote);
        const kind = triggerRemote ? "remote agent" : "agent";
        const ack = `On it! Kicked off ${kind} ${name}.`;
        this._sendTranscript("claude", ack);
        this._sendState("talking", ack);
        await this._speak(ack);
      } catch (e) {
        this._sendTranscript("claude_error", `spawn failed: ${e}`);
      }
      return;
    }

    // AGENT TARGETING
    const target = parseAgentTarget(transcript);
    if (target) {
      const [ref, msg] = target;
      const agent = this._agentManager.resolveAgentRef(ref);
      if (agent) {
        await this._routeToAgent(agent, msg);
        return;
      }
    }

    // COORDINATOR
    let coordinatorContext = "";
    if (this._agentManager.allAgents.length) {
      this._sendAction("consulting coordinator...");
      const suggestion = await this._coordinator.advise(
        transcript,
        this._agentManager.allAgents.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          task: a.task,
        }))
      );
      coordinatorContext = suggestion.advice;
      if (suggestion.agent_id) {
        const coordAgent = this._agentManager.agents.get(suggestion.agent_id);
        if (coordAgent) {
          await this._routeToAgent(coordAgent, transcript, "(coordinator)");
          return;
        }
      }
    }

    // SMART ROUTING
    if (lastSubId) {
      const agent = this._agentManager.agents.get(lastSubId);
      if (agent && agent.status !== "error") {
        this._sendAction("routing...");
        const route = await classifyMessageTarget(transcript, agent.name, agent.task);
        if (route === "agent") {
          await this._routeToAgent(agent, transcript);
          return;
        }
      }
    }

    // MAIN AGENT
    let prompt = transcript;
    if (coordinatorContext) {
      prompt = `[Coordinator context: ${coordinatorContext}]\n${transcript}`;
    }
    this._sendState("working");
    this._sendAction("claude is working...");
    const events: Record<string, any>[] = [];
    let earlyText = "";
    let hasToolCalls = false;
    let earlySpeakPromise: Promise<void> | null = null;

    try {
      const fullPrompt = buildPromptWithImages(prompt, this._imageContext);
      for await (const event of this.session.send(fullPrompt)) {
        events.push(event);
        if (event.type === "assistant") {
          const content = event.message?.content || [];
          for (const item of content) {
            if (item.type === "tool_use") {
              hasToolCalls = true;
              const tname = item.name || "?";
              const short = summarizeToolArgs(tname, item.input || {});
              this._sendTicker(`${tname}(${short})`);
            } else if (item.type === "text") {
              const text = item.text || "";
              for (const [sname, stask, sremote] of parseSpawnMarkers(text)) {
                try { this._spawnSub(sname, stask, sremote); } catch {}
              }
              const cleaned = stripSpawnMarkers(text).trim();
              if (!earlyText && cleaned) {
                earlyText = cleaned;
                this._sendTranscript("claude", earlyText);
                this._sendState("talking", earlyText);
                earlySpeakPromise = this._speak(earlyText);
              }
            }
          }
        }
      }
    } catch (e) {
      this._sendTranscript("claude_error", String(e));
      this._sendState("idle");
      this._sendAction(`error: ${String(e).slice(0, 60)}`);
      this._sendTicker("");
      return;
    }

    if (this._stopFlag.isSet()) return;

    if (earlySpeakPromise) {
      await earlySpeakPromise;
    }

    // SUMMARIZE + SPEAK
    this._sendTicker("");
    if (hasToolCalls) {
      this._sendState("thinking");
      this._sendAction("summarizing results...");
      let summary: string;
      try {
        summary = await summarizeTurn(transcript, events);
      } catch (e) {
        summary = `Hit an error while summarizing: ${e}`;
      }
      if (summary) {
        this._sendTranscript("claude", summary);
        this._sendState("talking", summary);
        this._sendAction("speaking (press SPACE to interrupt)");
        await this._speak(summary);
      }
    } else if (!earlyText) {
      this._sendTranscript("claude", "Done.");
      this._sendState("talking", "Done.");
      await this._speak("Done.");
    }
  }

  // ── Routing helper ──

  private async _routeToAgent(
    agent: AgentInstance,
    msg: string,
    suffix: string = ""
  ): Promise<void> {
    let ack: string;
    if (agent.status === "working") {
      agent.taskQueue.push(msg);
      ack = `Queued that for agent ${agent.name}.`;
    } else {
      this._agentManager.sendToAgent(
        agent, msg,
        (id, ev) => this._onSubEvent(id, ev),
        (id) => this._onSubDone(id),
      );
      this._send("agent_status", { agent_id: agent.id, status: "working", name: agent.name });
      ack = `Sent to agent ${agent.name}.`;
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
      this._sendTranscript("sub_agent", item.text, item.label);
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

  private _spawnSub(name: string, task: string, remote: boolean = false): void {
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
      name: agent.name,
      number: agent.number,
      task,
      status: agent.status,
    });
    this._sendTranscript("system", `spawned ${remote ? "remote " : ""}agent "${name}"`);
    this._coordinator.notifySpawn(agent.id, agent.name, task);
  }

  private _onSubEvent(agentId: string, event: Record<string, any>): void {
    if (event.type !== "assistant") return;
    const content = event.message?.content || [];
    for (const item of content) {
      if (item.type === "tool_use") {
        const tname = item.name || "?";
        const short = summarizeToolArgs(tname, item.input || {});
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
    if (agent) {
      this._coordinator.notifyDone(agentId, agent.name, agent.task, agent.status);
      this._send("agent_status", {
        agent_id: agentId,
        status: agent.status,
        name: agent.name,
      });
    }
  }

  // ── State persistence ──

  private _saveState(): void {
    const cwd = this.session.cwd || ".";
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
    };
    saveState(state, cwd);
  }

  private _restoreState(): string | null {
    const cwd = this.session.cwd || ".";
    const state = loadState(cwd);
    if (!state || !state.main_session_id) return null;

    this.session.sessionId = state.main_session_id;
    this._agentManager._counter = state.agent_counter;

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
        number: a.number,
        pendingQuestion: null,
      };
      this._agentManager.agents.set(a.id, agent);
      this._send("agent_spawned", {
        agent_id: a.id,
        name: a.name,
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
    const names = state.agents.map((a) => a.name).join(", ");
    if (n) {
      return `Welcome back! Resumed previous session with ${n} agent${n !== 1 ? "s" : ""}: ${names}. Press space to talk.`;
    }
    return "Welcome back! Resumed previous session. Press space to talk.";
  }
}

// ── Context Tree ──
// Lightweight structure the TL uses to track its decomposition and agent state.
// Injected into every TL prompt so it doesn't rely on session memory alone.

export type AgentNodeStatus = "working" | "done" | "error" | "needs_input" | "pr_pending";

export interface AgentNode {
  name: string;
  agentId: string;
  task: string;
  status: AgentNodeStatus;
  result: string | null;       // final summary when done
  questions: string[];         // questions asked so far
  answers: string[];           // answers received so far
}

export interface TaskNode {
  id: string;
  description: string;        // original user request (as routed by EM)
  agents: AgentNode[];         // sub-agents spawned for this task
  status: "active" | "done";
}

export class ContextTree {
  private _tasks: TaskNode[] = [];
  private _taskCounter = 0;

  /** Record a new top-level task delegated to the TL. Returns task id. */
  addTask(description: string): string {
    const id = `task-${++this._taskCounter}`;
    this._tasks.push({ id, description, agents: [], status: "active" });
    return id;
  }

  /** Record a spawned agent under the most recent active task. */
  addAgent(name: string, agentId: string, task: string): void {
    const parent = this._activeTask();
    if (!parent) return;
    parent.agents.push({
      name, agentId, task,
      status: "working",
      result: null,
      questions: [],
      answers: [],
    });
  }

  /** Update an agent's status. */
  updateAgentStatus(agentId: string, status: AgentNodeStatus): void {
    const node = this._findAgent(agentId);
    if (node) node.status = status;
  }

  /** Record an agent's final result summary. */
  setAgentResult(agentId: string, result: string): void {
    const node = this._findAgent(agentId);
    if (node) {
      node.result = result;
      if (node.status === "working") node.status = "done";
    }
  }

  /** Record a question an agent asked. */
  addAgentQuestion(agentId: string, question: string): void {
    const node = this._findAgent(agentId);
    if (node) node.questions.push(question);
  }

  /** Record an answer sent back to an agent. */
  addAgentAnswer(agentId: string, answer: string): void {
    const node = this._findAgent(agentId);
    if (node) node.answers.push(answer);
  }

  /** Mark a task done when all its agents are done. */
  checkTaskCompletion(): void {
    for (const task of this._tasks) {
      if (task.status !== "active") continue;
      if (task.agents.length === 0) continue;
      const allDone = task.agents.every(
        (a) => a.status === "done" || a.status === "error"
      );
      if (allDone) task.status = "done";
    }
  }

  /** Serialize the tree into a text block for injection into TL prompts. */
  serialize(): string {
    if (this._tasks.length === 0) return "[No tasks yet]";

    const lines: string[] = [];
    for (const task of this._tasks) {
      lines.push(`## Task ${task.id} [${task.status}]: ${task.description}`);
      if (task.agents.length === 0) {
        lines.push("  (no agents spawned yet)");
      }
      for (const a of task.agents) {
        lines.push(`  - ${a.name} (${a.agentId}) [${a.status}]: ${a.task.slice(0, 120)}`);
        if (a.result) {
          lines.push(`    Result: ${a.result.slice(0, 200)}`);
        }
        for (let i = 0; i < a.questions.length; i++) {
          lines.push(`    Q${i + 1}: ${a.questions[i].slice(0, 150)}`);
          if (a.answers[i]) {
            lines.push(`    A${i + 1}: ${a.answers[i].slice(0, 150)}`);
          }
        }
      }
    }
    return lines.join("\n");
  }

  // ── Internal helpers ──

  private _activeTask(): TaskNode | null {
    for (let i = this._tasks.length - 1; i >= 0; i--) {
      if (this._tasks[i].status === "active") return this._tasks[i];
    }
    return null;
  }

  private _findAgent(agentId: string): AgentNode | null {
    for (const task of this._tasks) {
      for (const agent of task.agents) {
        if (agent.agentId === agentId) return agent;
      }
    }
    return null;
  }
}

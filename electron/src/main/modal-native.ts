import { reportUsage } from "./claude-session";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function projectRoot(): string {
  return process.cwd();
}

type ModalModule = typeof import("modal");

let modalModulePromise: Promise<ModalModule> | null = null;
let modalClientPromise: Promise<any> | null = null;
let modalAppPromise: Promise<any> | null = null;
let modalImagePromise: Promise<any> | null = null;
let oauthSecretPromise: Promise<any> | null = null;
let apiKeySecretPromise: Promise<any> | null = null;

async function getModalModule(): Promise<ModalModule> {
  modalModulePromise ??= import("modal");
  return modalModulePromise;
}

async function getModalClient(): Promise<any> {
  modalClientPromise ??= getModalModule().then(({ ModalClient }) => new ModalClient());
  return modalClientPromise;
}

async function getModalApp(): Promise<any> {
  modalAppPromise ??= getModalClient().then((client) =>
    client.apps.fromName("claude-zoom", { createIfMissing: true })
  );
  return modalAppPromise;
}

async function getModalImage(): Promise<any> {
  modalImagePromise ??= (async () => {
    const client = await getModalClient();
    const app = await getModalApp();
    const image = client.images
      .fromRegistry("python:3.12-slim")
      .dockerfileCommands([
        "RUN apt-get update && apt-get install -y git curl build-essential jq",
        "RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "RUN apt-get install -y nodejs",
        "RUN npm install -g @anthropic-ai/claude-code",
      ]);
    return image.build(app);
  })();
  return modalImagePromise;
}

async function getOAuthSecret(): Promise<any> {
  oauthSecretPromise ??= getModalClient().then((client) =>
    client.secrets.fromName("claude-auth-token", {
      requiredKeys: ["CLAUDE_CODE_OAUTH_TOKEN"],
    })
  );
  return oauthSecretPromise;
}

async function getApiKeySecret(): Promise<any> {
  apiKeySecretPromise ??= getModalClient().then((client) =>
    client.secrets.fromName("anthropic-api-key", {
      requiredKeys: ["ANTHROPIC_API_KEY"],
    })
  );
  return apiKeySecretPromise;
}

async function readStreamLines(
  stream: ReadableStream<string>,
  onLine: (line: string) => Promise<void> | void
): Promise<void> {
  const reader = stream.getReader();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value ?? "";
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) await onLine(line);
        newline = pending.indexOf("\n");
      }
    }
    const tail = pending.trim();
    if (tail) await onLine(tail);
  } finally {
    reader.releaseLock();
  }
}

export type NativeModalSessionOptions = {
  cwd?: string | null;
  model?: string;
  permissionMode?: string;
  appendSystemPrompt: string;
  tools?: string | null;
  repo?: string | null;
  auth?: string;
};

export class NativeModalSession {
  cwd: string | null;
  model: string;
  permissionMode: string;
  appendSystemPrompt: string;
  tools: string | null;
  repo: string | null;
  auth: string;
  sessionId: string | null = null;

  private _sandbox: any = null;
  private _currentProcess: any = null;
  private _workdir = "/work";

  constructor(opts: NativeModalSessionOptions) {
    this.cwd = opts.cwd ?? null;
    this.model = opts.model ?? "opus";
    this.permissionMode = opts.permissionMode ?? "acceptEdits";
    this.appendSystemPrompt = opts.appendSystemPrompt;
    this.tools = opts.tools ?? null;
    this.repo = opts.repo ?? null;
    this.auth = opts.auth ?? "oauth";
  }

  async *send(prompt: string): AsyncGenerator<Record<string, any>> {
    await this._ensureSandbox();

    const proc = await this._sandbox.exec(this._buildCommand(prompt), {
      workdir: this._workdir,
    });
    this._currentProcess = proc;

    let capturedInit = false;
    const streamTask = readStreamLines(proc.stdout, async (line) => {
      let event: Record<string, any>;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (
        this.sessionId === null &&
        event.type === "system" &&
        event.subtype === "init" &&
        event.session_id
      ) {
        this.sessionId = event.session_id;
        capturedInit = true;
      } else if (event.type === "system" && event.subtype === "init") {
        capturedInit = true;
      }

      if (event.type === "result" && event.usage) {
        reportUsage(event.usage.input_tokens || 0, event.usage.output_tokens || 0);
      }
      yielded.push(event);
      wake?.();
      wake = null;
    });

    const yielded: Record<string, any>[] = [];
    let wake: (() => void) | null = null;
    let streamDone = false;
    let streamError: Error | null = null;

    streamTask
      .then(() => {
        streamDone = true;
        wake?.();
        wake = null;
      })
      .catch((err) => {
        streamError = err instanceof Error ? err : new Error(String(err));
        streamDone = true;
        wake?.();
        wake = null;
      });

    try {
      while (!streamDone || yielded.length > 0) {
        if (yielded.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        yield yielded.shift()!;
      }

      if (streamError) throw streamError;

      const [exitCode, stderr] = await Promise.all([
        proc.wait(),
        proc.stderr.readText(),
      ]);
      if (exitCode !== 0) {
        throw new Error(`native modal claude -p exited ${exitCode}: ${stderr.trim().slice(-400)}`);
      }
      if (!capturedInit) {
        throw new Error(`native modal claude -p emitted no init event: ${stderr.trim().slice(-400)}`);
      }
    } finally {
      this._currentProcess = null;
    }
  }

  cancel(): void {
    try {
      this._currentProcess?.kill();
    } catch {}
  }

  async close(): Promise<void> {
    this.cancel();
    if (!this._sandbox) return;
    try {
      await this._sandbox.terminate();
    } catch {}
    this._sandbox = null;
  }

  private async _ensureSandbox(): Promise<void> {
    if (this._sandbox) return;

    const client = await getModalClient();
    const app = await getModalApp();
    const image = await getModalImage();
    const secret = this.auth === "api-key"
      ? await getApiKeySecret()
      : await getOAuthSecret();

    this._sandbox = await client.sandboxes.create(app, image, {
      cpu: 2,
      memoryMiB: 4096,
      timeoutMs: 60 * 60 * 1000,
      workdir: "/work",
      secrets: [secret],
      verbose: true,
    });

    const setup = await this._sandbox.exec(["bash", "-lc", this._setupScript()], {
      workdir: "/work",
    });
    const [exitCode, stderr] = await Promise.all([setup.wait(), setup.stderr.readText()]);
    if (exitCode !== 0) {
      throw new Error(`native modal sandbox setup failed: ${stderr.trim().slice(-400)}`);
    }
  }

  private _setupScript(): string {
    const steps = ["mkdir -p /work"];
    if (this.repo) {
      steps.push(
        `if [ ! -d /work/repo/.git ]; then git clone ${shellQuote(`https://github.com/${this.repo}.git`)} /work/repo; fi`
      );
      steps.push("cd /work/repo && git fetch origin --prune");
      this._workdir = "/work/repo";
    } else {
      this._workdir = "/work";
    }
    return steps.join(" && ");
  }

  private _buildCommand(prompt: string): string[] {
    const args = [
      "claude",
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--model", shellQuote(this.model),
      "--permission-mode", shellQuote(this.permissionMode),
      "--append-system-prompt-file", "/tmp/.cz-sysprompt.txt",
    ];
    if (this.tools !== null) args.push("--tools", shellQuote(this.tools));
    if (this.sessionId) args.push("--resume", shellQuote(this.sessionId));

    const script = [
      "cat > /tmp/.cz-sysprompt.txt <<'__CZ_SYSPROMPT_EOF__'",
      this.appendSystemPrompt,
      "__CZ_SYSPROMPT_EOF__",
      `printf %s ${shellQuote(prompt)} | ${args.join(" ")}`,
    ].join("\n");

    return ["bash", "-lc", script];
  }
}

import http from "http";

const DEFAULT_BASE_URL = "http://localhost:11434";

export interface OllamaSessionOpts {
  model?: string;
  baseUrl?: string;
  systemPrompt?: string;
}

/**
 * Lightweight session that talks to a local Ollama instance.
 * Implements the same async-generator `send()` interface as ClaudeSession
 * so it can be used interchangeably for tool-less roles (PM, narrator, etc.).
 *
 * Manages conversation history client-side since local models have no
 * server-side session persistence.
 */
export class OllamaSession {
  model: string;
  baseUrl: string;
  systemPrompt: string;
  sessionId: string | null = null;

  private _history: { role: string; content: string }[] = [];
  private _abortController: AbortController | null = null;

  constructor(opts: OllamaSessionOpts = {}) {
    this.model = opts.model ?? "qwen2.5:14b";
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.systemPrompt = opts.systemPrompt ?? "";
    this.sessionId = `ollama_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  /** Check if Ollama is reachable. */
  static async isAvailable(baseUrl: string = DEFAULT_BASE_URL): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`${baseUrl}/api/tags`, { timeout: 2000 }, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });
  }

  /**
   * Send a prompt and stream the response as Claude-compatible events.
   * Yields events matching the format that ChatEngine/TechLead expect:
   * - { type: "system", subtype: "init", session_id }
   * - { type: "assistant", message: { content: [{ type: "text", text }] } }
   * - { type: "result", result: fullText, is_error: false }
   */
  async *send(prompt: string): AsyncGenerator<Record<string, any>> {
    // Emit init event (mimics Claude CLI)
    yield {
      type: "system",
      subtype: "init",
      session_id: this.sessionId,
    };

    // Build messages array
    const messages: { role: string; content: string }[] = [];
    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    // Include history for multi-turn
    messages.push(...this._history);
    messages.push({ role: "user", content: prompt });

    // Call Ollama streaming API
    const body = JSON.stringify({
      model: this.model,
      messages,
      stream: true,
    });

    this._abortController = new AbortController();
    let fullText = "";

    try {
      const response = await this._post("/api/chat", body);
      const chunks: string[] = [];
      let buffer = "";

      for await (const chunk of response) {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.message?.content) {
              const token = data.message.content;
              fullText += token;
              // Emit as assistant event (matches Claude format)
              yield {
                type: "assistant",
                message: {
                  content: [{ type: "text", text: token }],
                },
              };
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      // Save to history
      this._history.push({ role: "user", content: prompt });
      this._history.push({ role: "assistant", content: fullText });

      // Cap history to avoid unbounded growth
      if (this._history.length > 20) {
        this._history = this._history.slice(-20);
      }
    } catch (e: any) {
      if (e.name === "AbortError") return;
      yield {
        type: "result",
        result: `Ollama error: ${e.message}`,
        is_error: true,
      };
      return;
    } finally {
      this._abortController = null;
    }

    // Emit result event
    yield {
      type: "result",
      result: fullText,
      is_error: false,
      usage: {
        input_tokens: 0,  // Ollama doesn't always report tokens
        output_tokens: 0,
      },
    };
  }

  cancel(): void {
    this._abortController?.abort();
  }

  /** Reset conversation history. */
  clearHistory(): void {
    this._history = [];
  }

  private _post(path: string, body: string): Promise<AsyncIterable<string>> {
    const url = new URL(path, this.baseUrl);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          timeout: 120000,
        },
        (res) => {
          if (res.statusCode !== 200) {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              reject(new Error(`Ollama ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
            });
            return;
          }
          res.setEncoding("utf-8");
          resolve(res as unknown as AsyncIterable<string>);
        }
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Ollama request timeout")); });
      req.write(body);
      req.end();
    });
  }
}

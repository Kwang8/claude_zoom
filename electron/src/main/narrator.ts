import { execFile } from "child_process";
import { eventsToTranscript, getClaudePath } from "./claude-session";

const MODEL = "sonnet";
const MAX_TRANSCRIPT_CHARS = 8_000;
const MAX_FAST_PATH_WORDS = 30;

const NARRATOR_SYSTEM_PROMPT = `\
You rewrite an internal tool transcript into one short spoken status update.

Return exactly one sentence, under 20 words.
Focus on the concrete outcome, not the process.
Prefer first-person past tense when natural.

Rules:
- Mention what changed, what was found, or what blocked progress
- Do not mention tools, files, transcripts, or "events"
- Do not use markdown, bullets, code, or quotes
- Do not add filler such as "Okay", "Done", or "Here's what happened"
- If the turn failed or was blocked, say that plainly in one sentence`;

const MARKDOWN_RE = /[`*#>\[\]]|```/;

export function extractFinalText(events: Record<string, any>[]): string {
  let lastText = "";
  for (const event of events) {
    if (event.type !== "assistant") continue;
    const content = event.message?.content || [];
    const textParts = content
      .filter((c: any) => c.type === "text")
      .map((c: any) => (c.text || "").trim())
      .filter(Boolean);
    const text = textParts.join(" ").trim();
    if (text) lastText = text;
  }

  if (lastText) return lastText;

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "result" && !event.is_error) {
      return (event.result || "").trim();
    }
  }
  return "";
}

function isVoiceFriendly(text: string): boolean {
  if (!text) return false;
  if (text.split(/\s+/).length > MAX_FAST_PATH_WORDS) return false;
  if (MARKDOWN_RE.test(text)) return false;
  if (text.includes("\n\n")) return false;
  return true;
}

export function summarizeTurn(
  userMessage: string,
  events: Record<string, any>[]
): Promise<string> {
  const finalText = extractFinalText(events);
  if (isVoiceFriendly(finalText)) return Promise.resolve(finalText);
  return sonnetSummarize(userMessage, events);
}

// ── Conversation compaction check ──

const COMPACTION_SYSTEM_PROMPT = `\
You are deciding if a voice conversation has reached a clear stopping point — a plan \
was agreed, a question was answered, or work was delegated.

Respond with EXACTLY one line of JSON, no other text:
{"compact":true,"summary":"one-line title of what was discussed/decided"}
or
{"compact":false}

Rules:
- compact=true if: a clear plan was stated, work was delegated to agents, a question \
was fully answered, or the user acknowledged completion.
- compact=false if: the user asked something the assistant hasn't answered yet, the \
conversation is mid-negotiation, or the response invited further input.
- Summary should be under 12 words, past tense, no markdown.`;

export interface CompactionResult {
  shouldCompact: boolean;
  summary: string;
}

export function checkConversationComplete(
  messages: Record<string, any>[]
): Promise<CompactionResult> {
  let transcript = messages
    .filter((m) => m.role && m.text)
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n");

  if (!transcript.trim()) {
    return Promise.resolve({ shouldCompact: true, summary: "Empty conversation" });
  }
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);
  }

  return new Promise((resolve) => {
    const proc = execFile(
      getClaudePath(),
      [
        "-p",
        "--output-format", "json",
        "--model", MODEL,
        "--system-prompt", COMPACTION_SYSTEM_PROMPT,
      ],
      { timeout: 15_000 },
      (err, stdout) => {
        if (err) {
          // On failure, don't compact — try again next turn
          resolve({ shouldCompact: false, summary: "" });
          return;
        }
        try {
          const envelope = JSON.parse(stdout);
          const text = (envelope.result || "").trim();
          const result = JSON.parse(text);
          resolve({
            shouldCompact: Boolean(result.compact),
            summary: result.summary || "Conversation",
          });
        } catch {
          resolve({ shouldCompact: false, summary: "" });
        }
      }
    );
    proc.stdin?.write(transcript);
    proc.stdin?.end();
  });
}

function sonnetSummarize(
  userMessage: string,
  events: Record<string, any>[]
): Promise<string> {
  let transcript = eventsToTranscript(events);
  if (!transcript.trim()) return Promise.resolve("Nothing happened that turn.");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS) + "\n...(truncated)";
  }

  const prompt =
    `USER REQUEST:\n${userMessage || "(silent)"}\n\n` +
    `TURN TRANSCRIPT:\n${transcript}\n\n` +
    "Summarize the outcome for speech.";

  return new Promise((resolve, reject) => {
    const proc = execFile(
      getClaudePath(),
      [
        "-p",
        "--output-format", "json",
        "--model", MODEL,
        "--system-prompt", NARRATOR_SYSTEM_PROMPT,
      ],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`narrator claude call failed: ${stderr?.trim().slice(-400) || err.message}`));
          return;
        }
        try {
          const envelope = JSON.parse(stdout);
          if (envelope.is_error) {
            reject(new Error(`narrator error: ${envelope.result}`));
            return;
          }
          resolve((envelope.result || "").trim());
        } catch (e) {
          reject(new Error(`narrator parse error: ${e}`));
        }
      }
    );
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  });
}

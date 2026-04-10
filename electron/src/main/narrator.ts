import { execFile } from "child_process";
import { eventsToTranscript } from "./claude-session";

const MODEL = "sonnet";
const MAX_TRANSCRIPT_CHARS = 8_000;
const MAX_FAST_PATH_WORDS = 30;

const NARRATOR_SYSTEM_PROMPT = `\
Rewrite the events below as ONE spoken sentence, under 25 words, first-person \
past tense, describing the OUTCOME. No filler, no markdown, no code.
USER ASKED: {user_message}
EVENTS:
{transcript}`;

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

function sonnetSummarize(
  userMessage: string,
  events: Record<string, any>[]
): Promise<string> {
  let transcript = eventsToTranscript(events);
  if (!transcript.trim()) return Promise.resolve("Nothing happened that turn.");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS) + "\n...(truncated)";
  }

  const systemPrompt = NARRATOR_SYSTEM_PROMPT
    .replace("{user_message}", userMessage || "(silent)")
    .replace("{transcript}", transcript);

  return new Promise((resolve, reject) => {
    const proc = execFile(
      "claude",
      [
        "-p",
        "--output-format", "json",
        "--model", MODEL,
        "--system-prompt", systemPrompt,
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
    proc.stdin?.write("Summarize.");
    proc.stdin?.end();
  });
}

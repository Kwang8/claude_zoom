import { app, BrowserWindow, ipcMain, shell } from "electron";
import fs from "fs";
import path from "path";
import { ConversationManager } from "./conversation-manager";

let mainWindow: BrowserWindow | null = null;
let conversationManager: ConversationManager | null = null;
const DEV_SERVER_URL = "http://localhost:5173";

function findGitRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveTargetCwd(
  argv: string[],
  env: NodeJS.ProcessEnv,
  fallbackStartDir: string
): string | null {
  const envCwd = env.CLAUDE_ZOOM_CWD?.trim();
  let raw = envCwd || "";
  if (!raw) {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === "--cwd") {
        raw = argv[i + 1] || "";
        break;
      }
      if (arg.startsWith("--cwd=")) {
        raw = arg.slice("--cwd=".length);
        break;
      }
    }
  }

  if (!raw) {
    return findGitRoot(fallbackStartDir);
  }

  const resolved = path.resolve(raw);
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
  } catch {}

  if (envCwd) {
    console.warn(`[main] ignoring invalid CLAUDE_ZOOM_CWD: ${resolved}`);
  } else {
    console.warn(`[main] ignoring invalid --cwd target: ${resolved}`);
  }
  return null;
}

async function createWindow() {
  const targetCwd = resolveTargetCwd(process.argv.slice(1), process.env, process.cwd());
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0f0f1a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // In dev, load from Vite dev server; in prod, load the built file
  const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
  if (isDev) {
    await loadDevRenderer(mainWindow);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  // Build the conversation manager — each engine's events are tagged with their conversation ID
  conversationManager = new ConversationManager({
    targetCwd,
    remoteRepo: process.env.CLAUDE_ZOOM_REMOTE_REPO || null,
    remoteAuth: process.env.CLAUDE_ZOOM_REMOTE_AUTH === "api-key" ? "api-key" : "oauth",
    onEmit: (conversationId, msg) => {
      try {
        mainWindow?.webContents.send("engine-event", { ...msg, conversation_id: conversationId });
      } catch {}
    },
  });

  // Restore existing conversations from registry, or create the first one
  conversationManager.restoreFromRegistry();
  if (conversationManager.listConversations().length === 0) {
    const firstId = conversationManager.createConversation();
    conversationManager.setActive(firstId);
  }

  // Handle commands from the renderer
  ipcMain.on("engine-command", (_event, msg: Record<string, any>) => {
    if (!conversationManager) return;
    const msgType = msg.type || "";

    // ── Conversation management commands ──
    if (msgType === "create_conversation") {
      const id = conversationManager.createConversation();
      // Send conversation_created BEFORE starting the engine so the renderer
      // has a ConversationGroup ready when messages start arriving.
      mainWindow?.webContents.send("engine-event", {
        type: "conversation_created",
        conversation_id: id,
        timestamp: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
      });
      conversationManager.setActive(id);
      conversationManager.getConversation(id)!.start().then(() => {
        console.log("[main] new conversation started:", id);
      }).catch((err) => {
        console.error("[main] failed to start new conversation:", err);
      });
      return;
    }

    if (msgType === "switch_conversation") {
      const targetId = msg.conversation_id || "";
      const engine = conversationManager.getConversation(targetId);
      if (!engine) return;
      conversationManager.setActive(targetId);
      mainWindow?.webContents.send("engine-event", {
        type: "conversation_switched",
        conversation_id: targetId,
      });
      return;
    }

    if (msgType === "list_conversations") {
      mainWindow?.webContents.send("engine-event", {
        type: "conversations_list",
        conversations: conversationManager.listConversations(),
      });
      return;
    }

    // ── Commands routed to a specific or active conversation ──
    const engine = conversationManager.resolveTarget(msg.conversation_id);
    if (!engine) return;

    switch (msgType) {
      case "mic_start":
        // Voice is global — only the active conversation receives mic input
        conversationManager.getActiveConversation()?.micStart();
        break;
      case "mic_stop":
        conversationManager.getActiveConversation()?.micStop();
        break;
      case "cancel_turn":
        engine.cancelTurn();
        break;
      case "send_text":
        engine.sendText(msg.text || "");
        break;
      case "pr_decision":
        engine.prDecision(msg.agent_id || "", msg.approved ?? false);
        break;
      case "agent_answer":
        engine.agentAnswer(msg.agent_id || "", msg.text || "");
        break;
      case "kill_agent":
        engine.killAgent(msg.agent_id || "");
        break;
      case "attach_image":
        engine.attachImage(msg.path || "");
        break;
      case "clear_images":
        engine.clearImages();
        break;
      case "merge_pr":
        engine.mergeOpenPrs();
        break;
      case "compact":
        engine.compactConversation();
        break;
      case "quit":
        conversationManager.stopAll();
        app.quit();
        break;
    }
  });

  // When renderer is ready, replay state for all conversations and send repo context
  mainWindow.webContents.on("did-finish-load", () => {
    if (!conversationManager) return;
    // Only send conversation_created + replay for the active conversation
    const activeId = conversationManager.activeConversationId;
    const activeEngine = conversationManager.getActiveConversation();
    if (activeId && activeEngine) {
      const convList = conversationManager.listConversations();
      const activeConv = convList.find((c) => c.id === activeId);
      mainWindow?.webContents.send("engine-event", {
        type: "conversation_created",
        conversation_id: activeId,
        timestamp: activeConv
          ? new Date(activeConv.createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
          : new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
      });
      activeEngine.replayState();
    }
    const repo = conversationManager.githubRepo;
    if (repo) {
      mainWindow?.webContents.send("engine-event", { type: "repo_context", repo });
    }
  });

  // Open external URLs in the system browser
  ipcMain.on("open-external", (_event, url: string) => {
    if (typeof url === "string" && url.startsWith("https://")) {
      shell.openExternal(url);
    }
  });

  // Start all restored conversations
  await conversationManager.startAll();
  console.log("[main] conversation manager started with", conversationManager.listConversations().length, "conversation(s)");

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function loadDevRenderer(window: BrowserWindow): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await window.loadURL(DEV_SERVER_URL);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to load Vite dev server");
}

console.log("[main] app starting up");
app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  conversationManager?.stopAll();
  app.quit();
});

app.on("before-quit", () => {
  conversationManager?.stopAll();
});

// Ensure child processes are stopped when Electron is terminated externally
// (e.g. Ctrl+C in concurrently during development).
process.on("SIGINT", () => {
  conversationManager?.stopAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  conversationManager?.stopAll();
  process.exit(0);
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

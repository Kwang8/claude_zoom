import { app, BrowserWindow, ipcMain, shell } from "electron";
import fs from "fs";
import path from "path";
import { ClaudeSession } from "./claude-session";
import { ChatEngine } from "./chat-engine";

let mainWindow: BrowserWindow | null = null;
let engine: ChatEngine | null = null;

function resolveTargetCwd(argv: string[], env: NodeJS.ProcessEnv): string | null {
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

  if (!raw) return null;

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
  const targetCwd = resolveTargetCwd(process.argv.slice(1), process.env);
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
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }

  // Create the chat engine
  const session = new ClaudeSession({
    cwd: targetCwd,
    model: "opus",
    permissionMode: "acceptEdits",
    tools: "",
  });

  engine = new ChatEngine(session, {
    onEmit: (msg) => {
      try {
        mainWindow?.webContents.send("engine-event", msg);
      } catch {}
    },
    remoteRepo: process.env.CLAUDE_ZOOM_REMOTE_REPO || null,
    remoteAuth: process.env.CLAUDE_ZOOM_REMOTE_AUTH === "api-key" ? "api-key" : "oauth",
  });

  // Handle commands from the renderer
  ipcMain.on("engine-command", (_event, msg: Record<string, any>) => {
    if (!engine) return;
    const msgType = msg.type || "";
    switch (msgType) {
      case "mic_start":
        engine.micStart();
        break;
      case "mic_stop":
        engine.micStop();
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
      case "quit":
        engine.stop();
        app.quit();
        break;
    }
  });

  // When renderer is ready, replay state and start engine
  mainWindow.webContents.on("did-finish-load", () => {
    engine?.replayState();
    const repo = engine?.githubRepo;
    if (repo) {
      mainWindow?.webContents.send("engine-event", { type: "repo_context", repo });
    }
  });

  // Open external URLs in the system browser
  ipcMain.on("open-external", (_event, url: string) => {
    if (typeof url === "string" && url.startsWith("https://github.com/")) {
      shell.openExternal(url);
    }
  });

  // Start the engine
  await engine.start();
  console.log("[main] chat engine started");

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  engine?.stop();
  app.quit();
});

app.on("before-quit", () => {
  engine?.stop();
});

// Ensure child processes are stopped when Electron is terminated externally
// (e.g. Ctrl+C in concurrently during development).
process.on("SIGINT", () => {
  engine?.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  engine?.stop();
  process.exit(0);
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

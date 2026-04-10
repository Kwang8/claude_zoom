import { app, BrowserWindow, globalShortcut } from "electron";
import path from "path";
import { PythonBridge } from "./python-bridge";

let mainWindow: BrowserWindow | null = null;
let pythonBridge: PythonBridge | null = null;

const PORT = 8765;

async function createWindow() {
  // Start the Python WebSocket server
  pythonBridge = new PythonBridge({
    port: PORT,
    host: "localhost",
    permissionMode: "acceptEdits",
  });

  try {
    await pythonBridge.start();
    console.log("[main] Python server started");
  } catch (err) {
    console.error("[main] Failed to start Python server:", err);
  }

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
      // preload: path.join(__dirname, "preload.js"),
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

  // Pass the WebSocket URL to the renderer via the window title
  // (preload script can also be used for this)
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow?.webContents.send("ws-url", `ws://localhost:${PORT}`);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  pythonBridge?.stop();
  app.quit();
});

app.on("before-quit", () => {
  pythonBridge?.stop();
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

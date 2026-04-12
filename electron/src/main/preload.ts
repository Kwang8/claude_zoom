import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("claude", {
  send: (msg: Record<string, any>) => {
    ipcRenderer.send("engine-command", msg);
  },
  onEvent: (callback: (msg: Record<string, any>) => void) => {
    const handler = (_event: any, msg: Record<string, any>) => callback(msg);
    ipcRenderer.on("engine-event", handler);
    return () => ipcRenderer.removeListener("engine-event", handler);
  },
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners("engine-event");
  },
  openExternal: (url: string) => {
    ipcRenderer.send("open-external", url);
  },
  getUsage: (): Promise<{ totalInputTokens: number; totalOutputTokens: number }> => {
    return ipcRenderer.invoke("get-usage");
  },
});

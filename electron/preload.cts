import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type PtyDataEvent = {
  id: string;
  kind: "shell" | "tmux-control";
  backend: "pty" | "pipe";
  data: string;
};

type PtyExitEvent = {
  id: string;
  kind: "shell" | "tmux-control";
  exitCode: number;
};

const api = {
  createPty: (options?: {
    cwd?: string;
    shell?: string;
    args?: string[];
    cols?: number;
    rows?: number;
  }): Promise<{ id: string; pid: number; backend: "pty" | "pipe" }> =>
    ipcRenderer.invoke("pty:create", options),

  startTmuxControl: (params?: {
    sessionName?: string;
    cwd?: string;
    sshTarget?: string;
    sshPort?: number;
  }): Promise<{ id: string; pid: number; backend: "pty" | "pipe" }> =>
    ipcRenderer.invoke("tmux:start-control", params),

  listTmuxSessions: (): Promise<string[]> => ipcRenderer.invoke("tmux:list-sessions"),

  captureTmuxPane: (paneId: string, lines?: number, socketPath?: string): Promise<string> =>
    ipcRenderer.invoke("tmux:capture-pane", { paneId, lines, socketPath }),

  writePty: (id: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke("pty:write", { id, data }),

  resizePty: (id: string, cols: number, rows: number): Promise<boolean> =>
    ipcRenderer.invoke("pty:resize", { id, cols, rows }),

  killPty: (id: string): Promise<boolean> => ipcRenderer.invoke("pty:kill", { id }),

  onPtyData: (callback: (payload: PtyDataEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: PtyDataEvent) => callback(payload);
    ipcRenderer.on("pty:data", listener);
    return () => {
      ipcRenderer.removeListener("pty:data", listener);
    };
  },

  onPtyExit: (callback: (payload: PtyExitEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: PtyExitEvent) => callback(payload);
    ipcRenderer.on("pty:exit", listener);
    return () => {
      ipcRenderer.removeListener("pty:exit", listener);
    };
  },

  onMenuAction: (callback: (action: string) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, action: string) => callback(action);
    ipcRenderer.on("menu:action", listener);
    return () => {
      ipcRenderer.removeListener("menu:action", listener);
    };
  }
};

contextBridge.exposeInMainWorld("portableTerm", api);

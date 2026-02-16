import { app, BrowserWindow, ipcMain, Menu } from "electron";
import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import pty, { type IPty } from "node-pty";

type PtyKind = "shell" | "tmux-control";

interface PtySession {
  id: string;
  ownerWebContentsId: number;
  pid: number;
  kind: PtyKind;
  backend: "pty" | "pipe";
  write: (data: string) => boolean;
  resize: (cols: number, rows: number) => boolean;
  kill: () => boolean;
}

interface CreatePtyOptions {
  cwd?: string;
  shell?: string;
  args?: string[];
  cols?: number;
  rows?: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ptySessions = new Map<string, PtySession>();
let helperProcess: ChildProcessWithoutNullStreams | null = null;
let helperBuffer = "";

function getDefaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

function resolveShell(requested?: string): string {
  if (process.platform === "win32") {
    return requested || process.env.COMSPEC || "powershell.exe";
  }

  const candidates = [requested, process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0
  );

  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    return candidate;
  }

  return "/bin/sh";
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    try {
      await window.loadURL(devServerUrl);
      window.webContents.openDevTools({ mode: "detach" });
      return;
    } catch (error) {
      console.error("Failed to load dev server URL:", devServerUrl, error);
    }
  }

  try {
    await window.loadFile(join(__dirname, "../dist/index.html"));
  } catch (error) {
    console.error("Failed to load dist/index.html", error);
    const html = `
      <html>
        <body style="font-family: sans-serif; background:#111; color:#eee; padding: 16px;">
          <h2>PortableTerm2 failed to load</h2>
          <p>Renderer entrypoint could not be loaded. Check terminal logs for details.</p>
        </body>
      </html>
    `;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: "PortableTerm2",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("Renderer did-fail-load:", { errorCode, errorDescription, validatedURL });
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer process gone:", details);
  });

  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  void loadRenderer(window);

  return window;
}

function sendMenuAction(action: string): void {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!focusedWindow) {
    return;
  }
  focusedWindow.webContents.send("menu:action", action);
}

function setupMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => {
            createWindow();
          }
        },
        {
          label: "New Tab",
          accelerator: "CmdOrCtrl+T",
          click: () => sendMenuAction("new-tab")
        },
        {
          label: "Attach tmux Session",
          accelerator: "CmdOrCtrl+Shift+T",
          click: () => sendMenuAction("tmux-attach")
        },
        {
          label: "Detach tmux Client",
          click: () => sendMenuAction("tmux-detach")
        },
        { type: "separator" },
        {
          role: process.platform === "darwin" ? "close" : "quit"
        }
      ]
    },
    {
      label: "Pane",
      submenu: [
        {
          label: "Split Horizontally",
          accelerator: "CmdOrCtrl+D",
          click: () => sendMenuAction("split-horizontal")
        },
        {
          label: "Split Vertically",
          accelerator: "CmdOrCtrl+Shift+D",
          click: () => sendMenuAction("split-vertical")
        },
        {
          label: "Close Pane",
          accelerator: "CmdOrCtrl+W",
          click: () => sendMenuAction("close-pane")
        }
      ]
    },
    {
      role: "editMenu"
    },
    {
      role: "viewMenu"
    }
  ];

  if (process.platform === "darwin") {
    template.unshift({
      role: "appMenu"
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function forwardPtyData(session: PtySession, data: string): void {
  const owner = BrowserWindow.getAllWindows().find(
    (win) => win.webContents.id === session.ownerWebContentsId
  );
  if (!owner || owner.isDestroyed()) {
    return;
  }

  owner.webContents.send("pty:data", {
    id: session.id,
    kind: session.kind,
    backend: session.backend,
    data
  });
}

function forwardPtyExit(session: PtySession, exitCode: number): void {
  const owner = BrowserWindow.getAllWindows().find(
    (win) => win.webContents.id === session.ownerWebContentsId
  );

  if (!owner || owner.isDestroyed()) {
    return;
  }

  owner.webContents.send("pty:exit", {
    id: session.id,
    kind: session.kind,
    exitCode
  });
}

function ensureHelperProcess(): ChildProcessWithoutNullStreams {
  if (helperProcess && !helperProcess.killed) {
    return helperProcess;
  }

  const helperPath = join(__dirname, "../electron/pty-helper.cjs");
  helperProcess = spawn("node", [helperPath], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  helperBuffer = "";

  helperProcess.stdout.setEncoding("utf8");
  helperProcess.stdout.on("data", (chunk: string) => {
    helperBuffer += chunk;
    const lines = helperBuffer.split("\n");
    helperBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const message = JSON.parse(trimmed) as {
          type: "created" | "data" | "exit" | "create-error";
          sessionId: string;
          pid?: number;
          data?: string;
          exitCode?: number;
          message?: string;
        };

        const session = ptySessions.get(message.sessionId);
        if (!session) {
          continue;
        }

        if (message.type === "created") {
          session.pid = message.pid ?? session.pid;
        } else if (message.type === "data") {
          forwardPtyData(session, message.data ?? "");
        } else if (message.type === "exit") {
          ptySessions.delete(message.sessionId);
          forwardPtyExit(session, message.exitCode ?? 0);
        } else if (message.type === "create-error") {
          forwardPtyData(session, `\r\n[PTY helper error: ${message.message ?? "unknown error"}]\r\n`);
          ptySessions.delete(message.sessionId);
          forwardPtyExit(session, 1);
        }
      } catch (_error) {
        // Ignore malformed helper output lines.
      }
    }
  });

  helperProcess.stderr.setEncoding("utf8");
  helperProcess.stderr.on("data", (chunk: string) => {
    console.error(`[pty-helper] ${chunk}`);
  });

  helperProcess.on("exit", () => {
    helperProcess = null;
    helperBuffer = "";
  });

  return helperProcess;
}

function sendHelperMessage(message: Record<string, unknown>): boolean {
  const helper = ensureHelperProcess();
  return helper.stdin.write(`${JSON.stringify(message)}\n`);
}

function createPtyBackedSession(
  id: string,
  ownerWebContentsId: number,
  command: string,
  args: string[],
  options: CreatePtyOptions,
  kind: PtyKind
): { session: PtySession; pid: number } {
  const ptyOptions = {
    cols: options.cols ?? 120,
    rows: options.rows ?? 35,
    cwd: options.cwd ?? process.cwd(),
    env: process.env as Record<string, string>,
    name: process.platform === "win32" ? "xterm-256color" : "xterm-color"
  };

  let instance: IPty;
  try {
    instance = pty.spawn(command, args, ptyOptions);
  } catch (error) {
    if (kind === "shell" && process.platform !== "win32" && command !== "/bin/sh") {
      instance = pty.spawn("/bin/sh", [], ptyOptions);
    } else {
      throw error;
    }
  }

  const session: PtySession = {
    id,
    ownerWebContentsId,
    pid: instance.pid,
    kind,
    backend: "pty",
    write: (data: string) => {
      instance.write(data);
      return true;
    },
    resize: (cols: number, rows: number) => {
      const safeCols = Math.max(10, Math.floor(cols));
      const safeRows = Math.max(5, Math.floor(rows));
      instance.resize(safeCols, safeRows);
      return true;
    },
    kill: () => {
      instance.kill();
      return true;
    }
  };

  instance.onData((data) => {
    forwardPtyData(session, data);
  });

  instance.onExit(({ exitCode }) => {
    ptySessions.delete(id);
    forwardPtyExit(session, exitCode);
  });

  return { session, pid: instance.pid };
}

function createPipeBackedSession(
  id: string,
  ownerWebContentsId: number,
  command: string,
  args: string[],
  options: CreatePtyOptions,
  kind: PtyKind
): { session: PtySession; pid: number } {
  const effectiveArgs = kind === "shell" && args.length === 0 ? ["-i"] : args;
  const normalizeOutput = (text: string): string => text.replace(/\r?\n/g, "\r\n");
  const env = {
    ...(process.env as Record<string, string>),
    TERM: process.env.TERM || "xterm-256color",
    COLORTERM: process.env.COLORTERM || "truecolor",
    FORCE_COLOR: process.env.FORCE_COLOR || "1"
  };

  const child: ChildProcessWithoutNullStreams = spawn(command, effectiveArgs, {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdio: "pipe"
  });

  const session: PtySession = {
    id,
    ownerWebContentsId,
    pid: child.pid ?? -1,
    kind,
    backend: "pipe",
    write: (data: string) => {
      if (data.includes("\u0003")) {
        // Emulate Ctrl+C for foreground task in non-PTY fallback mode.
        child.kill("SIGINT");
        data = data.replace(/\u0003/g, "");
      }

      if (data.length === 0) {
        return true;
      }

      return child.stdin.write(data);
    },
    resize: () => {
      return true;
    },
    kill: () => {
      child.kill();
      return true;
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    forwardPtyData(session, normalizeOutput(chunk.toString("utf8")));
  });

  child.stderr.on("data", (chunk: Buffer) => {
    forwardPtyData(session, normalizeOutput(chunk.toString("utf8")));
  });

  child.on("exit", (code) => {
    ptySessions.delete(id);
    forwardPtyExit(session, typeof code === "number" ? code : 0);
  });

  child.on("error", (error) => {
    forwardPtyData(session, `\r\n[Process error: ${error.message}]\r\n`);
  });

  return { session, pid: child.pid ?? -1 };
}

function createHelperBackedSession(
  id: string,
  ownerWebContentsId: number,
  command: string,
  args: string[],
  options: CreatePtyOptions,
  kind: PtyKind
): { session: PtySession; pid: number } {
  const session: PtySession = {
    id,
    ownerWebContentsId,
    pid: -1,
    kind,
    backend: "pty",
    write: (data: string) =>
      sendHelperMessage({
        type: "write",
        sessionId: id,
        data
      }),
    resize: (cols: number, rows: number) =>
      sendHelperMessage({
        type: "resize",
        sessionId: id,
        cols,
        rows
      }),
    kill: () =>
      sendHelperMessage({
        type: "kill",
        sessionId: id
      })
  };

  sendHelperMessage({
    type: "create",
    sessionId: id,
    kind,
    command,
    args,
    options
  });

  return { session, pid: -1 };
}

function createPtySession(
  ownerWebContentsId: number,
  command: string,
  args: string[],
  options: CreatePtyOptions,
  kind: PtyKind
): { id: string; pid: number; backend: "pty" | "pipe" } {
  const id = randomUUID();
  let created: { session: PtySession; pid: number };
  try {
    created = createPtyBackedSession(id, ownerWebContentsId, command, args, options, kind);
  } catch (error) {
    console.warn(`PTY backend failed (${command}), falling back to helper PTY backend.`, error);
    try {
      created = createHelperBackedSession(id, ownerWebContentsId, command, args, options, kind);
    } catch (helperError) {
      console.warn(`Helper PTY backend failed (${command}), falling back to pipe backend.`, helperError);
      created = createPipeBackedSession(id, ownerWebContentsId, command, args, options, kind);
    }
  }

  ptySessions.set(id, created.session);
  return { id, pid: created.pid, backend: created.session.backend };
}

function setupIpcHandlers(): void {
  ipcMain.handle("pty:create", (event, options?: CreatePtyOptions) => {
    const shell = resolveShell(options?.shell || getDefaultShell());
    const args = options?.args ?? [];

    return createPtySession(event.sender.id, shell, args, options ?? {}, "shell");
  });

  ipcMain.handle(
    "tmux:start-control",
    (event, params?: { sessionName?: string; cwd?: string; sshTarget?: string; sshPort?: number }) => {
      const sessionName = params?.sessionName?.trim();
      const tmuxArgs = ["-CC"];
      if (sessionName && sessionName.length > 0) {
        tmuxArgs.push("new-session", "-A", "-s", sessionName);
      } else {
        tmuxArgs.push("new-session");
      }

      const sshTarget = params?.sshTarget?.trim();
      const sshPort = Number.isFinite(params?.sshPort) ? Math.floor(params!.sshPort as number) : 0;
      let command = "tmux";
      let args = tmuxArgs;
      if (sshTarget && sshTarget.length > 0) {
        command = "ssh";
        args = ["-tt"];
        if (sshPort > 0) {
          args.push("-p", String(sshPort));
        }
        args.push(sshTarget, "tmux", ...tmuxArgs);
      }

      const created = createPtySession(
        event.sender.id,
        command,
        args,
        { cwd: params?.cwd },
        "tmux-control"
      );
      if (created.backend !== "pty") {
        const session = ptySessions.get(created.id);
        if (session) {
          session.kill();
          ptySessions.delete(created.id);
        }
        throw new Error("tmux control mode requires a PTY backend on this machine.");
      }
      return created;
    }
  );

  ipcMain.handle("tmux:list-sessions", async () => {
    if (process.platform === "win32") {
      return [] as string[];
    }

    return new Promise<string[]>((resolve) => {
      execFile("tmux", ["list-sessions", "-F", "#{session_name}"], (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const sessions = stdout
          .split("\n")
          .map((session) => session.trim())
          .filter((session) => session.length > 0);
        resolve(sessions);
      });
    });
  });

  ipcMain.handle(
    "tmux:capture-pane",
    async (_event, payload?: { paneId?: string; lines?: number; socketPath?: string }) => {
    const paneId = payload?.paneId?.trim();
    if (!paneId) {
      return "";
    }

    const requestedLines = Math.floor(payload?.lines ?? 2000);
    const safeLines = Math.min(5000, Math.max(100, requestedLines));
    const socketPath = payload?.socketPath?.trim();

    const runCapture = (args: string[]): Promise<string> =>
      new Promise<string>((resolve) => {
        execFile("tmux", args, (error, stdout) => {
          if (error) {
            resolve("");
            return;
          }
          resolve(stdout);
        });
      });

    const socketArgs = socketPath ? ["-S", socketPath] : [];
    const fullHistory = await runCapture([
      ...socketArgs,
      "capture-pane",
      "-p",
      "-J",
      "-S",
      "-",
      "-t",
      paneId
    ]);
    if (fullHistory.length > 0) {
      return fullHistory;
    }

    return runCapture([
      ...socketArgs,
      "capture-pane",
      "-p",
      "-J",
      "-S",
      `-${safeLines}`,
      "-t",
      paneId
    ]);
  }
  );

  ipcMain.handle("pty:write", (_event, payload: { id: string; data: string }) => {
    const session = ptySessions.get(payload.id);
    if (!session) {
      return false;
    }
    return session.write(payload.data);
  });

  ipcMain.handle("pty:resize", (_event, payload: { id: string; cols: number; rows: number }) => {
    const session = ptySessions.get(payload.id);
    if (!session) {
      return false;
    }

    return session.resize(payload.cols, payload.rows);
  });

  ipcMain.handle("pty:kill", (_event, payload: { id: string }) => {
    const session = ptySessions.get(payload.id);
    if (!session) {
      return false;
    }
    session.kill();
    ptySessions.delete(payload.id);
    return true;
  });
}

function cleanupDeadWindowPtys(): void {
  const liveWebContents = new Set(BrowserWindow.getAllWindows().map((window) => window.webContents.id));
  for (const [id, session] of ptySessions) {
    if (!liveWebContents.has(session.ownerWebContentsId)) {
      session.kill();
      ptySessions.delete(id);
    }
  }
}

app.on("window-all-closed", () => {
  if (helperProcess) {
    helperProcess.kill();
    helperProcess = null;
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("browser-window-created", (_event, window) => {
  window.on("closed", cleanupDeadWindowPtys);
});

app.whenReady().then(() => {
  setupIpcHandlers();
  setupMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

export {};

declare global {
  interface Window {
    portableTerm: {
      createPty: (options?: {
        cwd?: string;
        shell?: string;
        args?: string[];
        cols?: number;
        rows?: number;
      }) => Promise<{ id: string; pid: number; backend: "pty" | "pipe" }>;
      startTmuxControl: (params?: {
        sessionName?: string;
        cwd?: string;
        sshTarget?: string;
        sshPort?: number;
      }) => Promise<{ id: string; pid: number; backend: "pty" | "pipe" }>;
      listTmuxSessions: () => Promise<string[]>;
      captureTmuxPane: (paneId: string, lines?: number, socketPath?: string) => Promise<string>;
      writePty: (id: string, data: string) => Promise<boolean>;
      resizePty: (id: string, cols: number, rows: number) => Promise<boolean>;
      killPty: (id: string) => Promise<boolean>;
      onPtyData: (
        callback: (payload: {
          id: string;
          kind: "shell" | "tmux-control";
          backend: "pty" | "pipe";
          data: string;
        }) => void
      ) => () => void;
      onPtyExit: (
        callback: (payload: {
          id: string;
          kind: "shell" | "tmux-control";
          exitCode: number;
        }) => void
      ) => () => void;
      onMenuAction: (callback: (action: string) => void) => () => void;
    };
  }
}

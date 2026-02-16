export type SplitDirection = "horizontal" | "vertical";

export interface PaneNode {
  type: "pane";
  paneId: string;
}

export interface SplitNode {
  type: "split";
  direction: SplitDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

export type PaneType = "local" | "tmux";

export interface PaneState {
  id: string;
  type: PaneType;
  backend?: "pty" | "pipe";
  ptyId?: string;
  tmuxPaneId?: string;
  controlPtyId?: string;
}

export interface TabState {
  id: string;
  title: string;
  layout: LayoutNode;
  panes: Record<string, PaneState>;
  activePaneId: string;
  tmuxWindowId?: string;
  controlPtyId?: string;
}

export interface TmuxPaneBinding {
  tabId: string;
  paneId: string;
}

export interface TmuxControllerState {
  controlPtyId: string;
  sessionName: string;
  socketPath?: string;
  windowToTab: Record<string, string>;
  paneToNative: Record<string, TmuxPaneBinding>;
}

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { TerminalPane } from "./components/TerminalPane";
import { collectPaneIds, removePaneFromLayout, singlePaneLayout, splitLayoutAtPane } from "./lib/layout";
import {
  makeSendKeysHexCommand,
  parseBootstrapWindowLine,
  parseTmuxControlLine,
  parseTmuxLayout,
  splitLines
} from "./lib/tmux";
import type { LayoutNode, PaneState, TabState, TmuxControllerState, TmuxPaneBinding } from "./types";

interface TmuxPickerState {
  open: boolean;
  loading: boolean;
  sessions: string[];
  newSessionName: string;
  error: string | null;
  sourceLabel: string;
  sshTarget: string | null;
  sshPort: number | null;
}

const initialPickerState: TmuxPickerState = {
  open: false,
  loading: false,
  sessions: [],
  newSessionName: "",
  error: null,
  sourceLabel: "Local machine",
  sshTarget: null,
  sshPort: null
};

const MAX_PANE_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_TMUX_BOOTSTRAP_BUFFER_BYTES = 512 * 1024;
const TRACE_TMUX_ATTACH = false;

interface PaneGridSize {
  cols: number;
  rows: number;
}

interface TmuxPaneBootstrapState {
  chunks: string[];
  totalBytes: number;
  flushTimer: number | null;
}

interface PendingTmuxCapture {
  tmuxPaneId: string;
  lines: string[];
  collecting: boolean;
  timeoutId: number | null;
  resolve: (captured: string) => void;
}

interface PendingShellTmuxProbe {
  token: string;
  collecting: boolean;
  lines: string[];
  buffer: string;
  timeoutId: number;
  resolve: (result: {
    sessions: string[];
    sshTarget: string | null;
    sshPort: number | null;
    sourceLabel: string;
  }) => void;
}

function uid(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toSafeLocalEcho(input: string): string {
  let out = "";
  for (const ch of input) {
    if (ch === "\r" || ch === "\n") {
      out += "\r\n";
      continue;
    }
    if (ch === "\t") {
      out += "\t";
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) {
      out += ch;
    }
  }
  return out;
}

function sanitizeTmuxOutput(data: string): string {
  return data
    .replace(/\x1b\[\?3J/g, "")
    .replace(/\x1b\[3J/g, "");
}

function normalizeCapturedHistory(text: string): string {
  return sanitizeTmuxOutput(text)
    .replace(/\r/g, "")
    .replace(/\r?\n/g, "\r\n");
}

function previewControlText(text: string): string {
  return text
    .replace(/\x1b/g, "<ESC>")
    .replace(/\r/g, "<CR>")
    .replace(/\n/g, "<LF>")
    .slice(0, 180);
}

function parseSocketPathLine(line: string): string | null {
  const marker = "__SOCKET__::";
  const idx = line.indexOf(marker);
  if (idx < 0) {
    return null;
  }
  const value = line.slice(idx + marker.length).trim();
  return value.length > 0 ? value : null;
}

function parseBootstrapPaneLine(
  line: string
): { windowId: string; paneId: string } | null {
  const marker = "__PANE__::";
  if (!line.startsWith(marker)) {
    return null;
  }
  const parts = line.slice(marker.length).split("::");
  if (parts.length < 2) {
    return null;
  }
  const [windowId, paneId] = parts;
  if (!windowId || !paneId) {
    return null;
  }
  return { windowId, paneId };
}

function measureLayoutGridSize(
  node: LayoutNode,
  paneSizes: Map<string, PaneGridSize>
): PaneGridSize | null {
  if (node.type === "pane") {
    return paneSizes.get(node.paneId) ?? null;
  }

  const first = measureLayoutGridSize(node.first, paneSizes);
  const second = measureLayoutGridSize(node.second, paneSizes);
  if (!first || !second) {
    return null;
  }

  if (node.direction === "horizontal") {
    return {
      cols: first.cols + second.cols,
      rows: Math.max(first.rows, second.rows)
    };
  }

  return {
    cols: Math.max(first.cols, second.cols),
    rows: first.rows + second.rows
  };
}

function clampRatio(next: number): number {
  if (Number.isNaN(next)) {
    return 0.5;
  }
  return Math.max(0.1, Math.min(0.9, next));
}

function updateSplitRatioAtPath(layout: LayoutNode, path: string, ratio: number): LayoutNode {
  if (path.length === 0) {
    if (layout.type !== "split") {
      return layout;
    }
    return {
      ...layout,
      ratio: clampRatio(ratio)
    };
  }

  if (layout.type !== "split") {
    return layout;
  }

  const [head, ...rest] = path;
  const nextPath = rest.join("");
  if (head === "L") {
    return {
      ...layout,
      first: updateSplitRatioAtPath(layout.first, nextPath, ratio)
    };
  }
  if (head === "R") {
    return {
      ...layout,
      second: updateSplitRatioAtPath(layout.second, nextPath, ratio)
    };
  }

  return layout;
}

function preserveSplitRatios(previous: LayoutNode, next: LayoutNode): LayoutNode {
  if (previous.type !== "split" || next.type !== "split") {
    return next;
  }

  if (previous.direction !== next.direction) {
    return next;
  }

  return {
    ...next,
    ratio: clampRatio(previous.ratio),
    first: preserveSplitRatios(previous.first, next.first),
    second: preserveSplitRatios(previous.second, next.second)
  };
}

function stripAnsiText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

export default function App(): JSX.Element {
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tmuxPicker, setTmuxPicker] = useState<TmuxPickerState>(initialPickerState);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [ptyHealthy, setPtyHealthy] = useState(true);

  const tabsRef = useRef<TabState[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const paneWritersRef = useRef<Map<string, (data: string) => void>>(new Map());
  const paneHistoryRef = useRef<
    Map<string, { chunks: string[]; totalBytes: number }>
  >(new Map());
  const paneGridSizeRef = useRef<Map<string, PaneGridSize>>(new Map());
  const tmuxPaneBootstrapRef = useRef<Map<string, TmuxPaneBootstrapState>>(new Map());
  const tmuxPaneSizeRef = useRef<Map<string, PaneGridSize>>(new Map());
  const localPtyToPaneRef = useRef<Map<string, { tabId: string; paneId: string }>>(new Map());
  const tmuxCaptureQueuesRef = useRef<Map<string, PendingTmuxCapture[]>>(new Map());
  const tmuxCaptureActiveRef = useRef<Map<string, PendingTmuxCapture>>(new Map());
  const tmuxPrefetchedHistoryRef = useRef<Map<string, Map<string, string>>>(new Map());
  const tmuxPrefetchInFlightRef = useRef<Map<string, Set<string>>>(new Map());
  const tmuxHydrateStartedRef = useRef<Set<string>>(new Set());
  const shellTmuxProbeRef = useRef<Map<string, PendingShellTmuxProbe>>(new Map());
  const controllersRef = useRef<Record<string, TmuxControllerState>>({});
  const tmuxLineBuffersRef = useRef<Record<string, string>>({});
  const tmuxClientSizeRef = useRef<Map<string, PaneGridSize>>(new Map());
  const initializedRef = useRef(false);
  const tmuxOutputTraceCountRef = useRef<Map<string, number>>(new Map());

  const traceTmux = useCallback((label: string, details?: Record<string, unknown>) => {
    if (!TRACE_TMUX_ATTACH) {
      return;
    }
    if (details) {
      console.log(`[tmux-trace] ${label} ${JSON.stringify(details)}`);
      return;
    }
    console.log(`[tmux-trace] ${label}`);
  }, []);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  const setTabActivePane = useCallback((tabId: string, paneId: string) => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== tabId) {
          return tab;
        }
        return {
          ...tab,
          activePaneId: paneId
        };
      })
    );
  }, []);

  const registerWriter = useCallback((paneId: string, writer: (data: string) => void) => {
    paneWritersRef.current.set(paneId, writer);

    const history = paneHistoryRef.current.get(paneId);
    if (history && history.chunks.length > 0) {
      for (const chunk of history.chunks) {
        writer(chunk);
      }
    }

    return () => {
      const current = paneWritersRef.current.get(paneId);
      if (current === writer) {
        paneWritersRef.current.delete(paneId);
      }
    };
  }, []);

  const writeToPane = useCallback((paneId: string, data: string) => {
    const existingHistory = paneHistoryRef.current.get(paneId) ?? {
      chunks: [],
      totalBytes: 0
    };
    existingHistory.chunks.push(data);
    existingHistory.totalBytes += data.length;

    while (existingHistory.totalBytes > MAX_PANE_HISTORY_BYTES && existingHistory.chunks.length > 1) {
      const removed = existingHistory.chunks.shift();
      if (!removed) {
        break;
      }
      existingHistory.totalBytes -= removed.length;
    }

    paneHistoryRef.current.set(paneId, existingHistory);

    const writer = paneWritersRef.current.get(paneId);
    if (!writer) {
      return;
    }
    writer(data);
  }, []);

  const getActiveTab = useCallback((): TabState | null => {
    const currentActive = activeTabIdRef.current;
    if (!currentActive) {
      return null;
    }
    return tabsRef.current.find((tab) => tab.id === currentActive) ?? null;
  }, []);

  const cleanupPaneArtifacts = useCallback((paneId: string) => {
    const bootstrap = tmuxPaneBootstrapRef.current.get(paneId);
    if (bootstrap && bootstrap.flushTimer !== null) {
      window.clearTimeout(bootstrap.flushTimer);
    }
    tmuxHydrateStartedRef.current.delete(paneId);
    paneWritersRef.current.delete(paneId);
    paneHistoryRef.current.delete(paneId);
    paneGridSizeRef.current.delete(paneId);
    tmuxPaneBootstrapRef.current.delete(paneId);
    tmuxPaneSizeRef.current.delete(paneId);
  }, []);

  const createLocalTab = useCallback(async () => {
    let created: { id: string; pid: number; backend: "pty" | "pipe" };
    try {
      created = await window.portableTerm.createPty({});
      setRuntimeError(null);
      if (created.backend !== "pty") {
        setPtyHealthy(false);
        setRuntimeError(
          "PTY backend unavailable on this machine. Running in degraded mode: tmux-CC and full-screen terminal apps may not work."
        );
      } else {
        setPtyHealthy(true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeError(`Failed to start local shell: ${message}`);
      return;
    }

    const tabId = uid("tab");
    const paneId = uid("pane");

    localPtyToPaneRef.current.set(created.id, { tabId, paneId });

    const pane: PaneState = {
      id: paneId,
      type: "local",
      backend: created.backend,
      ptyId: created.id
    };

    const tab: TabState = {
      id: tabId,
      title: "Shell",
      layout: singlePaneLayout(paneId),
      panes: {
        [paneId]: pane
      },
      activePaneId: paneId
    };

    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tabId);
  }, []);

  const removeTabById = useCallback(
    async (tabId: string) => {
      const targetTab = tabsRef.current.find((tab) => tab.id === tabId);
      if (!targetTab) {
        return;
      }

      if (targetTab.tmuxWindowId && targetTab.controlPtyId) {
        const tabsForSameClient = tabsRef.current.filter(
          (tab) => tab.controlPtyId === targetTab.controlPtyId
        );

        if (tabsForSameClient.length <= 1) {
          void window.portableTerm.writePty(targetTab.controlPtyId, "detach-client\n");
        } else {
          void window.portableTerm.writePty(
            targetTab.controlPtyId,
            `kill-window -t ${targetTab.tmuxWindowId}\n`
          );
        }
        return;
      }

      const paneList = Object.values(targetTab.panes);
      for (const pane of paneList) {
        cleanupPaneArtifacts(pane.id);
        if (pane.ptyId) {
          localPtyToPaneRef.current.delete(pane.ptyId);
          void window.portableTerm.killPty(pane.ptyId);
        }
      }

      setTabs((prev) => prev.filter((tab) => tab.id !== tabId));

      const nextTabs = tabsRef.current.filter((tab) => tab.id !== tabId);
      if (nextTabs.length > 0) {
        setActiveTabId((current) => (current === tabId ? nextTabs[0].id : current));
      } else {
        setActiveTabId(null);
        await createLocalTab();
      }
    },
    [cleanupPaneArtifacts, createLocalTab]
  );

  const splitActivePane = useCallback(
    async (direction: "horizontal" | "vertical") => {
      const activeTab = getActiveTab();
      if (!activeTab) {
        return;
      }

      const activePane = activeTab.panes[activeTab.activePaneId];
      if (!activePane) {
        return;
      }

      if (activePane.type === "tmux" && activePane.tmuxPaneId && activePane.controlPtyId) {
        const tmuxDirection = direction === "horizontal" ? "-h" : "-v";
        void window.portableTerm.writePty(
          activePane.controlPtyId,
          `split-window ${tmuxDirection} -t ${activePane.tmuxPaneId}\n`
        );
        return;
      }

      const created = await window.portableTerm.createPty({});
      const newPaneId = uid("pane");

      localPtyToPaneRef.current.set(created.id, {
        tabId: activeTab.id,
        paneId: newPaneId
      });

      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== activeTab.id) {
            return tab;
          }

          const nextLayout = splitLayoutAtPane(tab.layout, tab.activePaneId, direction, newPaneId);
          return {
            ...tab,
            panes: {
              ...tab.panes,
              [newPaneId]: {
                id: newPaneId,
                type: "local",
                backend: created.backend,
                ptyId: created.id
              }
            },
            layout: nextLayout,
            activePaneId: newPaneId
          };
        })
      );
    },
    [getActiveTab]
  );

  const closeActivePane = useCallback(async () => {
    const activeTab = getActiveTab();
    if (!activeTab) {
      return;
    }

    const paneToClose = activeTab.panes[activeTab.activePaneId];
    if (!paneToClose) {
      return;
    }

    if (paneToClose.type === "tmux" && paneToClose.tmuxPaneId && paneToClose.controlPtyId) {
      void window.portableTerm.writePty(
        paneToClose.controlPtyId,
        `kill-pane -t ${paneToClose.tmuxPaneId}\n`
      );
      return;
    }

    const paneCount = Object.keys(activeTab.panes).length;
    if (paneCount === 1) {
      await removeTabById(activeTab.id);
      return;
    }

    if (paneToClose.ptyId) {
      localPtyToPaneRef.current.delete(paneToClose.ptyId);
      void window.portableTerm.killPty(paneToClose.ptyId);
    }
    cleanupPaneArtifacts(paneToClose.id);

    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== activeTab.id) {
          return tab;
        }

        const nextLayout = removePaneFromLayout(tab.layout, tab.activePaneId);
        if (!nextLayout) {
          return tab;
        }

        const nextPanes = { ...tab.panes };
        delete nextPanes[tab.activePaneId];

        const candidatePaneIds = collectPaneIds(nextLayout);
        const nextActivePaneId = candidatePaneIds[0] ?? Object.keys(nextPanes)[0];

        return {
          ...tab,
          panes: nextPanes,
          layout: nextLayout,
          activePaneId: nextActivePaneId
        };
      })
    );
  }, [cleanupPaneArtifacts, getActiveTab, removeTabById]);

  const detachTmuxClient = useCallback((controlPtyId: string) => {
    void window.portableTerm.writePty(controlPtyId, "detach-client\n");
  }, []);

  const detachActiveTmuxClient = useCallback(() => {
    const activeTab = getActiveTab();
    if (!activeTab?.controlPtyId) {
      return;
    }
    detachTmuxClient(activeTab.controlPtyId);
  }, [detachTmuxClient, getActiveTab]);

  const ensureController = useCallback((controlPtyId: string, sessionName: string) => {
    const existing = controllersRef.current[controlPtyId];
    if (existing) {
      existing.sessionName = sessionName;
      return existing;
    }

    const next: TmuxControllerState = {
      controlPtyId,
      sessionName,
      windowToTab: {},
      paneToNative: {}
    };

    controllersRef.current[controlPtyId] = next;
    return next;
  }, []);

  const runNextTmuxCapture = useCallback((controlPtyId: string) => {
    if (tmuxCaptureActiveRef.current.has(controlPtyId)) {
      return;
    }

    const queue = tmuxCaptureQueuesRef.current.get(controlPtyId);
    if (!queue || queue.length === 0) {
      return;
    }

    const next = queue.shift();
    if (!next) {
      return;
    }

    next.timeoutId = window.setTimeout(() => {
      const active = tmuxCaptureActiveRef.current.get(controlPtyId);
      if (active !== next) {
        return;
      }
      tmuxCaptureActiveRef.current.delete(controlPtyId);
      next.resolve("");
      runNextTmuxCapture(controlPtyId);
    }, 5000);

    tmuxCaptureActiveRef.current.set(controlPtyId, next);
    void window.portableTerm.writePty(
      controlPtyId,
      `capture-pane -p -J -S -3000 -t ${next.tmuxPaneId}\n`
    );
  }, []);

  const captureTmuxPaneInBand = useCallback(
    (controlPtyId: string, tmuxPaneId: string): Promise<string> =>
      new Promise<string>((resolve) => {
        const queue = tmuxCaptureQueuesRef.current.get(controlPtyId) ?? [];
        queue.push({
          tmuxPaneId,
          lines: [],
          collecting: false,
          timeoutId: null,
          resolve
        });
        tmuxCaptureQueuesRef.current.set(controlPtyId, queue);
        runNextTmuxCapture(controlPtyId);
      }),
    [runNextTmuxCapture]
  );

  const syncTmuxClientSizeForTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab?.controlPtyId) {
      return;
    }

    const measured = measureLayoutGridSize(tab.layout, paneGridSizeRef.current);
    if (!measured) {
      return;
    }

    const safeCols = Math.max(10, Math.floor(measured.cols));
    const safeRows = Math.max(5, Math.floor(measured.rows));
    const last = tmuxClientSizeRef.current.get(tab.controlPtyId);
    if (last && last.cols === safeCols && last.rows === safeRows) {
      return;
    }
    tmuxClientSizeRef.current.set(tab.controlPtyId, { cols: safeCols, rows: safeRows });

    void window.portableTerm.resizePty(tab.controlPtyId, safeCols, safeRows);
    void window.portableTerm.writePty(
      tab.controlPtyId,
      `refresh-client -C ${safeCols}x${safeRows}\n`
    );
  }, []);

  const flushTmuxBootstrapPane = useCallback(
    (paneId: string, capturedHistory?: string) => {
      const bootstrap = tmuxPaneBootstrapRef.current.get(paneId);
      traceTmux("flush-bootstrap", {
        paneId,
        hasBootstrap: Boolean(bootstrap),
        capturedBytes: capturedHistory?.length ?? 0,
        bufferedChunks: bootstrap?.chunks.length ?? 0,
        bufferedBytes: bootstrap?.totalBytes ?? 0
      });
      if (!bootstrap) {
        if (capturedHistory && capturedHistory.length > 0) {
          writeToPane(paneId, capturedHistory);
        }
        return;
      }

      tmuxPaneBootstrapRef.current.delete(paneId);
      tmuxHydrateStartedRef.current.delete(paneId);
      if (bootstrap.flushTimer !== null) {
        window.clearTimeout(bootstrap.flushTimer);
      }

      if (capturedHistory && capturedHistory.length > 0) {
        writeToPane(paneId, capturedHistory);
        return;
      }

      for (const chunk of bootstrap.chunks) {
        writeToPane(paneId, chunk);
      }
    },
    [traceTmux, writeToPane]
  );

  const hydrateTmuxPaneHistory = useCallback(
    async (controlPtyId: string, tmuxPaneId: string, paneId: string, attempt = 1) => {
      traceTmux("hydrate-start", {
        controlPtyId,
        tmuxPaneId,
        paneId,
        attempt,
        hasBootstrap: tmuxPaneBootstrapRef.current.has(paneId),
        hasPrefetch: Boolean(
          tmuxPrefetchedHistoryRef.current.get(controlPtyId)?.get(tmuxPaneId)
        ),
        hasSocket: Boolean(controllersRef.current[controlPtyId]?.socketPath)
      });
      try {
        const prefetched = tmuxPrefetchedHistoryRef.current
          .get(controlPtyId)
          ?.get(tmuxPaneId);
        if (prefetched && prefetched.length > 0) {
          tmuxPrefetchedHistoryRef.current.get(controlPtyId)?.delete(tmuxPaneId);
          traceTmux("hydrate-use-prefetch", {
            controlPtyId,
            tmuxPaneId,
            paneId,
            bytes: prefetched.length
          });
          flushTmuxBootstrapPane(paneId, prefetched);
          return;
        }

        const socketPath = controllersRef.current[controlPtyId]?.socketPath;
        if (!socketPath && attempt <= 10) {
          window.setTimeout(() => {
            void hydrateTmuxPaneHistory(controlPtyId, tmuxPaneId, paneId, attempt + 1);
          }, 150);
          return;
        }

        const captured = await window.portableTerm.captureTmuxPane(tmuxPaneId, 3000, socketPath);
        traceTmux("hydrate-captured", {
          controlPtyId,
          tmuxPaneId,
          paneId,
          attempt,
          bytes: captured.length
        });

        if ((!captured || captured.length === 0) && attempt < 4) {
          window.setTimeout(() => {
            void hydrateTmuxPaneHistory(controlPtyId, tmuxPaneId, paneId, attempt + 1);
          }, 250);
          return;
        }

        if (!captured || captured.length === 0) {
          flushTmuxBootstrapPane(paneId);
          return;
        }

        const normalized = normalizeCapturedHistory(captured);
        const history = normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
        traceTmux("hydrate-flush-history", {
          controlPtyId,
          tmuxPaneId,
          paneId,
          bytes: history.length
        });
        flushTmuxBootstrapPane(paneId, history);
      } catch (_error) {
        traceTmux("hydrate-error", {
          controlPtyId,
          tmuxPaneId,
          paneId,
          attempt
        });
        if (attempt < 4) {
          window.setTimeout(() => {
            void hydrateTmuxPaneHistory(controlPtyId, tmuxPaneId, paneId, attempt + 1);
          }, 250);
          return;
        }
        flushTmuxBootstrapPane(paneId);
      }
    },
    [flushTmuxBootstrapPane, traceTmux]
  );

  const prefetchTmuxPaneHistory = useCallback(
    (controlPtyId: string, tmuxPaneId: string, attempt = 1) => {
      if (!tmuxPaneId) {
        return;
      }
      traceTmux("prefetch-start", { controlPtyId, tmuxPaneId, attempt });

      const prefetchedForController =
        tmuxPrefetchedHistoryRef.current.get(controlPtyId) ?? new Map<string, string>();
      tmuxPrefetchedHistoryRef.current.set(controlPtyId, prefetchedForController);
      if (prefetchedForController.has(tmuxPaneId)) {
        return;
      }

      const inflightForController =
        tmuxPrefetchInFlightRef.current.get(controlPtyId) ?? new Set<string>();
      tmuxPrefetchInFlightRef.current.set(controlPtyId, inflightForController);
      if (inflightForController.has(tmuxPaneId)) {
        return;
      }
      inflightForController.add(tmuxPaneId);

      void (async () => {
        try {
          const socketPath = controllersRef.current[controlPtyId]?.socketPath;
          if (!socketPath) {
            traceTmux("prefetch-wait-socket", { controlPtyId, tmuxPaneId, attempt });
            if (attempt < 10) {
              window.setTimeout(() => {
                prefetchTmuxPaneHistory(controlPtyId, tmuxPaneId, attempt + 1);
              }, 150);
            }
            return;
          }

          const captured = await window.portableTerm.captureTmuxPane(tmuxPaneId, 3000, socketPath);
          if (!captured || captured.length === 0) {
            traceTmux("prefetch-empty", { controlPtyId, tmuxPaneId, attempt });
            return;
          }

          const normalized = normalizeCapturedHistory(captured);
          const history = normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
          prefetchedForController.set(tmuxPaneId, history);
          traceTmux("prefetch-stored", {
            controlPtyId,
            tmuxPaneId,
            bytes: history.length
          });
        } catch (_error) {
          traceTmux("prefetch-error", { controlPtyId, tmuxPaneId, attempt });
          // Ignore prefetch failures; normal hydration retries still run.
        } finally {
          inflightForController.delete(tmuxPaneId);
          if (inflightForController.size === 0) {
            tmuxPrefetchInFlightRef.current.delete(controlPtyId);
          }
        }
      })();
    },
    []
  );

  const applyTmuxLayout = useCallback(
    (controlPtyId: string, windowId: string, layout: string, explicitName?: string) => {
      const controller = controllersRef.current[controlPtyId];
      if (!controller) {
        return;
      }
      traceTmux("layout-apply", { controlPtyId, windowId, explicitName });

      let tabId = controller.windowToTab[windowId];
      if (!tabId) {
        tabId = uid("tab");
        controller.windowToTab[windowId] = tabId;
      }

      setTabs((prev) => {
        const nextTabs = [...prev];
        const existingIndex = nextTabs.findIndex((tab) => tab.id === tabId);
        const existingTab = existingIndex >= 0 ? nextTabs[existingIndex] : null;

        const livePaneIds = new Set<string>();

        const mapPane = (tmuxPaneId: string): string => {
          livePaneIds.add(tmuxPaneId);
          const mapped = controller.paneToNative[tmuxPaneId];
          if (mapped && mapped.tabId === tabId) {
            return mapped.paneId;
          }

          const paneId = uid("pane");
          const flushTimer = window.setTimeout(() => {
            flushTmuxBootstrapPane(paneId);
          }, 15000);
          controller.paneToNative[tmuxPaneId] = { tabId, paneId } as TmuxPaneBinding;
          tmuxPaneBootstrapRef.current.set(paneId, {
            chunks: [],
            totalBytes: 0,
            flushTimer
          });
          traceTmux("pane-mapped", { controlPtyId, windowId, tmuxPaneId, paneId });
          return paneId;
        };

        let nativeLayout: LayoutNode;
        try {
          nativeLayout = parseTmuxLayout(layout, mapPane);
        } catch (_error) {
          const fallbackPaneId = mapPane("%0");
          nativeLayout = singlePaneLayout(fallbackPaneId);
        }

        const nextPanes: Record<string, PaneState> = {};
        for (const tmuxPaneId of livePaneIds) {
          const mapping = controller.paneToNative[tmuxPaneId];
          if (!mapping || mapping.tabId !== tabId) {
            continue;
          }
          nextPanes[mapping.paneId] = {
            id: mapping.paneId,
            type: "tmux",
            tmuxPaneId,
            controlPtyId
          };
        }

        for (const [tmuxPaneId, mapping] of Object.entries(controller.paneToNative)) {
          if (mapping.tabId !== tabId) {
            continue;
          }
          if (!livePaneIds.has(tmuxPaneId)) {
            cleanupPaneArtifacts(mapping.paneId);
            delete controller.paneToNative[tmuxPaneId];
          }
        }

        const nextActivePaneId =
          existingTab && nextPanes[existingTab.activePaneId]
            ? existingTab.activePaneId
            : Object.keys(nextPanes)[0];

        if (!nextActivePaneId) {
          return nextTabs;
        }

        const mergedLayout = existingTab
          ? preserveSplitRatios(existingTab.layout, nativeLayout)
          : nativeLayout;

        const nextTab: TabState = {
          id: tabId,
          title: explicitName ?? existingTab?.title ?? `tmux ${windowId}`,
          layout: mergedLayout,
          panes: nextPanes,
          activePaneId: nextActivePaneId,
          tmuxWindowId: windowId,
          controlPtyId
        };

        if (existingIndex >= 0) {
          nextTabs[existingIndex] = nextTab;
        } else {
          nextTabs.push(nextTab);
        }

        return nextTabs;
      });

      window.setTimeout(() => {
        const latest = controllersRef.current[controlPtyId];
        if (!latest) {
          return;
        }
        for (const [tmuxPaneId, binding] of Object.entries(latest.paneToNative)) {
          if (binding.tabId !== tabId) {
            continue;
          }
          if (!tmuxPaneBootstrapRef.current.has(binding.paneId)) {
            continue;
          }
          if (tmuxHydrateStartedRef.current.has(binding.paneId)) {
            continue;
          }
          tmuxHydrateStartedRef.current.add(binding.paneId);
          void hydrateTmuxPaneHistory(controlPtyId, tmuxPaneId, binding.paneId);
        }
      }, 0);

      if (!activeTabIdRef.current) {
        setActiveTabId(tabId);
      }

      if (activeTabIdRef.current === tabId) {
        syncTmuxClientSizeForTab(tabId);
      }
    },
    [
      cleanupPaneArtifacts,
      flushTmuxBootstrapPane,
      hydrateTmuxPaneHistory,
      traceTmux,
      syncTmuxClientSizeForTab
    ]
  );

  const closeTmuxWindow = useCallback(async (controlPtyId: string, windowId: string) => {
    const controller = controllersRef.current[controlPtyId];
    if (!controller) {
      return;
    }

    const tabId = controller.windowToTab[windowId];
    if (!tabId) {
      return;
    }

    delete controller.windowToTab[windowId];
    const removedPaneIds = new Set<string>();
    for (const [tmuxPaneId, mapping] of Object.entries(controller.paneToNative)) {
      if (mapping.tabId === tabId) {
        removedPaneIds.add(mapping.paneId);
        delete controller.paneToNative[tmuxPaneId];
      }
    }

    for (const paneId of removedPaneIds) {
      cleanupPaneArtifacts(paneId);
    }

    const remainingTabs = tabsRef.current.filter((tab) => tab.id !== tabId);
    setTabs(remainingTabs);

    if (activeTabIdRef.current === tabId) {
      setActiveTabId(remainingTabs[0]?.id ?? null);
    }

    if (remainingTabs.length === 0) {
      await createLocalTab();
    }
  }, [cleanupPaneArtifacts, createLocalTab]);

  const handleTmuxControlLine = useCallback(
    async (controlPtyId: string, line: string) => {
      if (line.length === 0) {
        return;
      }

      const activeCapture = tmuxCaptureActiveRef.current.get(controlPtyId);
      if (activeCapture) {
        if (line.startsWith("%begin")) {
          activeCapture.collecting = true;
          return;
        }

        if (line.startsWith("%end") || line.startsWith("%error")) {
          if (activeCapture.timeoutId !== null) {
            window.clearTimeout(activeCapture.timeoutId);
            activeCapture.timeoutId = null;
          }
          tmuxCaptureActiveRef.current.delete(controlPtyId);
          activeCapture.resolve(activeCapture.lines.join("\n"));
          runNextTmuxCapture(controlPtyId);
          return;
        }

        if (activeCapture.collecting && !line.startsWith("%")) {
          activeCapture.lines.push(line);
          return;
        }
      }

      const socketPath = parseSocketPathLine(line);
      if (socketPath) {
        const controller = controllersRef.current[controlPtyId];
        if (controller) {
          controller.socketPath = socketPath;
          traceTmux("socket-discovered", { controlPtyId, socketPath });
        }
        return;
      }

      const parsedPane = parseBootstrapPaneLine(line);
      if (parsedPane) {
        traceTmux("bootstrap-pane-line", { controlPtyId, ...parsedPane });
        prefetchTmuxPaneHistory(controlPtyId, parsedPane.paneId);
        return;
      }

      const parsedBootstrap = parseBootstrapWindowLine(line);
      if (parsedBootstrap) {
        traceTmux("bootstrap-window-line", {
          controlPtyId,
          windowId: parsedBootstrap.windowId,
          name: parsedBootstrap.name
        });
        applyTmuxLayout(
          controlPtyId,
          parsedBootstrap.windowId,
          parsedBootstrap.layout,
          parsedBootstrap.name
        );
        return;
      }

      const event = parseTmuxControlLine(line);
      switch (event.type) {
        case "output": {
          const controller = controllersRef.current[controlPtyId];
          if (!controller) {
            return;
          }
          const socketPath = parseSocketPathLine(event.data);
          if (socketPath) {
            controller.socketPath = socketPath;
            return;
          }
          const mapping = controller.paneToNative[event.paneId];
          if (mapping) {
            const outputKey = `${controlPtyId}:${event.paneId}`;
            const seen = tmuxOutputTraceCountRef.current.get(outputKey) ?? 0;
            if (seen < 6) {
              tmuxOutputTraceCountRef.current.set(outputKey, seen + 1);
              traceTmux("pane-output", {
                controlPtyId,
                tmuxPaneId: event.paneId,
                paneId: mapping.paneId,
                bytes: event.data.length,
                bootstrapPending: tmuxPaneBootstrapRef.current.has(mapping.paneId),
                preview: previewControlText(event.data)
              });
            }
            const sanitized = sanitizeTmuxOutput(event.data);
            if (sanitized.length === 0) {
              return;
            }

            const bootstrap = tmuxPaneBootstrapRef.current.get(mapping.paneId);
            if (bootstrap) {
              bootstrap.chunks.push(sanitized);
              bootstrap.totalBytes += sanitized.length;
              while (
                bootstrap.totalBytes > MAX_TMUX_BOOTSTRAP_BUFFER_BYTES &&
                bootstrap.chunks.length > 1
              ) {
                const removed = bootstrap.chunks.shift();
                if (!removed) {
                  break;
                }
                bootstrap.totalBytes -= removed.length;
              }
              if (bootstrap.totalBytes >= MAX_TMUX_BOOTSTRAP_BUFFER_BYTES) {
                flushTmuxBootstrapPane(mapping.paneId);
              }
              return;
            }

            writeToPane(mapping.paneId, sanitized);
          }
          break;
        }
        case "window-add": {
          applyTmuxLayout(controlPtyId, event.windowId, "80x24,0,0,0");
          break;
        }
        case "window-close": {
          await closeTmuxWindow(controlPtyId, event.windowId);
          break;
        }
        case "window-renamed": {
          const controller = controllersRef.current[controlPtyId];
          if (!controller) {
            return;
          }
          const tabId = controller.windowToTab[event.windowId];
          if (!tabId) {
            return;
          }
          setTabs((prev) =>
            prev.map((tab) => {
              if (tab.id !== tabId) {
                return tab;
              }
              return {
                ...tab,
                title: event.name
              };
            })
          );
          break;
        }
        case "layout-change": {
          applyTmuxLayout(controlPtyId, event.windowId, event.layout);
          break;
        }
        case "window-pane-changed": {
          const controller = controllersRef.current[controlPtyId];
          if (!controller) {
            return;
          }
          const mapping = controller.paneToNative[event.paneId];
          if (!mapping) {
            return;
          }
          setTabActivePane(mapping.tabId, mapping.paneId);
          break;
        }
        case "session-changed": {
          const controller = controllersRef.current[controlPtyId];
          if (controller) {
            controller.sessionName = event.sessionName;
          }
          break;
        }
        default:
          break;
      }
    },
    [
      applyTmuxLayout,
      closeTmuxWindow,
      flushTmuxBootstrapPane,
      prefetchTmuxPaneHistory,
      runNextTmuxCapture,
      setTabActivePane,
      traceTmux,
      writeToPane
    ]
  );

  const startTmuxControl = useCallback(
    async (
      sessionName: string,
      sshTarget: string | null = null,
      sshPort: number | null = null
    ) => {
    let created: { id: string; pid: number; backend: "pty" | "pipe" };
    try {
      created = await window.portableTerm.startTmuxControl({
        sessionName: sessionName.trim(),
        sshTarget: sshTarget || undefined,
        sshPort: sshPort ?? undefined
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTmuxPicker((prev) => ({
        ...prev,
        error: `Failed to attach tmux: ${message}`
      }));
      return;
    }

    ensureController(created.id, sessionName.trim() || "default");
    tmuxLineBuffersRef.current[created.id] = "";
    traceTmux("start-control", {
      controlPtyId: created.id,
      sessionName: sessionName.trim() || "default",
      sshTarget: sshTarget ?? "",
      sshPort: sshPort ?? ""
    });

    await window.portableTerm.writePty(
      created.id,
      "display-message -p \"__SOCKET__::#{socket_path}\"\n"
    );

    await window.portableTerm.writePty(
      created.id,
      "list-panes -s -F \"__PANE__::#{window_id}::#{pane_id}\"\n"
    );

    await window.portableTerm.writePty(
      created.id,
      "list-windows -F \"__WINDOW__::#{window_id}::#{window_name}::#{window_layout}\"\n"
    );

    setTmuxPicker(initialPickerState);
  },
  [ensureController, traceTmux]
  );

  const handlePaneInput = useCallback((tabId: string, paneId: string, input: string) => {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab) {
      return;
    }

    const pane = tab.panes[paneId];
    if (!pane) {
      return;
    }

    if (pane.type === "local" && pane.ptyId) {
      if (pane.backend === "pipe") {
        const localEcho = toSafeLocalEcho(input);
        if (localEcho.length > 0) {
          writeToPane(pane.id, localEcho);
        }
      }
      void window.portableTerm.writePty(pane.ptyId, input);
      return;
    }

    if (pane.type === "tmux" && pane.tmuxPaneId && pane.controlPtyId) {
      const cmd = makeSendKeysHexCommand(pane.tmuxPaneId, input);
      if (cmd.length > 0) {
        void window.portableTerm.writePty(pane.controlPtyId, cmd);
      }
    }
  }, [writeToPane]);

  const handlePaneResize = useCallback((tabId: string, paneId: string, cols: number, rows: number) => {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab) {
      return;
    }

    const pane = tab.panes[paneId];
    if (!pane) {
      return;
    }

    const safeCols = Math.max(10, Math.floor(cols));
    const safeRows = Math.max(5, Math.floor(rows));
    paneGridSizeRef.current.set(paneId, { cols: safeCols, rows: safeRows });

    if (pane.type === "local" && pane.ptyId) {
      void window.portableTerm.resizePty(pane.ptyId, safeCols, safeRows);
      return;
    }

    if (pane.type !== "tmux" || !pane.controlPtyId) {
      return;
    }

    if (pane.tmuxPaneId) {
      const lastPaneSize = tmuxPaneSizeRef.current.get(pane.id);
      if (!lastPaneSize || lastPaneSize.cols !== safeCols || lastPaneSize.rows !== safeRows) {
        tmuxPaneSizeRef.current.set(pane.id, { cols: safeCols, rows: safeRows });
        void window.portableTerm.writePty(
          pane.controlPtyId,
          `resize-pane -t ${pane.tmuxPaneId} -x ${safeCols} -y ${safeRows}\n`
        );
      }
    }

    syncTmuxClientSizeForTab(tabId);
  }, [syncTmuxClientSizeForTab]);

  const beginSplitResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, tabId: string, path: string, direction: "horizontal" | "vertical") => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const splitElement = event.currentTarget.parentElement as HTMLDivElement | null;
      if (!splitElement) {
        return;
      }

      const handleMove = (moveEvent: PointerEvent) => {
        const rect = splitElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return;
        }

        const nextRatio =
          direction === "horizontal"
            ? (moveEvent.clientX - rect.left) / rect.width
            : (moveEvent.clientY - rect.top) / rect.height;

        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== tabId) {
              return tab;
            }
            return {
              ...tab,
              layout: updateSplitRatioAtPath(tab.layout, path, nextRatio)
            };
          })
        );
      };

      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        syncTmuxClientSizeForTab(tabId);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp, { once: true });
    },
    [syncTmuxClientSizeForTab]
  );

  const probeTmuxFromShellPty = useCallback(
    (
      ptyId: string
    ): Promise<{ sessions: string[]; sshTarget: string | null; sshPort: number | null; sourceLabel: string }> =>
      new Promise((resolve) => {
        const token = uid("probe").replace(/[^a-zA-Z0-9]/g, "");
        const startMarker = `__PTMUX_BEGIN_${token}__`;
        const endMarker = `__PTMUX_END_${token}__`;

        const timeoutId = window.setTimeout(() => {
          const pending = shellTmuxProbeRef.current.get(ptyId);
          if (!pending || pending.token !== token) {
            return;
          }
          shellTmuxProbeRef.current.delete(ptyId);
          resolve({
            sessions: [],
            sshTarget: null,
            sshPort: null,
            sourceLabel: "Local machine"
          });
        }, 2200);

        shellTmuxProbeRef.current.set(ptyId, {
          token,
          collecting: false,
          lines: [],
          buffer: "",
          timeoutId,
          resolve
        });

        const probeCommand =
          `printf '${startMarker}\\n'; ` +
          "printf \"__PTMUX_CTX__::${USER:-}::${HOSTNAME:-}::${SSH_CONNECTION:-}\\n\"; " +
          `tmux list-sessions -F '#{session_name}' 2>/dev/null; ` +
          `printf '${endMarker}\\n'\n`;
        void window.portableTerm.writePty(ptyId, probeCommand);
      }),
    []
  );

  const consumeShellProbeData = useCallback(
    (ptyId: string, data: string) => {
      const pending = shellTmuxProbeRef.current.get(ptyId);
      if (!pending) {
        return;
      }

      pending.buffer += data;
      const lines = pending.buffer.split(/\r?\n/);
      pending.buffer = lines.pop() ?? "";

      const startMarker = `__PTMUX_BEGIN_${pending.token}__`;
      const endMarker = `__PTMUX_END_${pending.token}__`;

      for (const line of lines) {
        const cleaned = stripAnsiText(line).replace(/\r/g, "").trim();
        if (cleaned.includes(startMarker)) {
          pending.collecting = true;
          continue;
        }
        if (!pending.collecting) {
          continue;
        }
        if (cleaned.includes(endMarker)) {
          window.clearTimeout(pending.timeoutId);
          shellTmuxProbeRef.current.delete(ptyId);

          let sshTarget: string | null = null;
          let sshPort: number | null = null;
          let sourceLabel = "Local machine";
          const sessions: string[] = [];
          for (const collected of pending.lines) {
            if (!collected) {
              continue;
            }
            if (collected.startsWith("__PTMUX_CTX__::")) {
              const [, user, host, sshConnection] = collected.split("::");
              if (sshConnection && host) {
                const parts = sshConnection.trim().split(/\s+/);
                const serverIp = parts[2] || host;
                const serverPort = Number.parseInt(parts[3] || "", 10);
                sshPort = Number.isFinite(serverPort) ? serverPort : null;
                sshTarget = user ? `${user}@${serverIp}` : serverIp;
                sourceLabel = `Remote (${user ? `${user}@${host}` : host})`;
              }
              continue;
            }
            if (collected.startsWith("__PTMUX_")) {
              continue;
            }
            if (collected.includes("tmux list-sessions") || collected.includes("__PTMUX_BEGIN_")) {
              continue;
            }
            if (!sessions.includes(collected)) {
              sessions.push(collected);
            }
          }

          pending.resolve({
            sessions,
            sshTarget,
            sshPort,
            sourceLabel
          });
          return;
        }
        pending.lines.push(cleaned);
      }
    },
    []
  );

  const openTmuxPicker = useCallback(async () => {
    if (!ptyHealthy) {
      setTmuxPicker((prev) => ({
        ...prev,
        open: true,
        loading: false,
        error: "tmux control mode requires PTY backend. Disabled in degraded mode."
      }));
      return;
    }

    setTmuxPicker((prev) => ({ ...prev, open: true, loading: true, error: null }));
    try {
      const activeTab = getActiveTab();
      const activePane = activeTab ? activeTab.panes[activeTab.activePaneId] : null;

      if (activePane?.type === "local" && activePane.ptyId) {
        const probed = await probeTmuxFromShellPty(activePane.ptyId);
        setTmuxPicker((prev) => ({
          ...prev,
          loading: false,
          sessions: probed.sessions,
          sourceLabel: probed.sourceLabel,
          sshTarget: probed.sshTarget,
          sshPort: probed.sshPort
        }));
        return;
      }

      const sessions = await window.portableTerm.listTmuxSessions();
      setTmuxPicker((prev) => ({
        ...prev,
        loading: false,
        sessions,
        sourceLabel: "Local machine",
        sshTarget: null,
        sshPort: null
      }));
    } catch (_error) {
      setTmuxPicker((prev) => ({
        ...prev,
        loading: false,
        error: "Failed to load tmux sessions. Verify tmux is installed and running."
      }));
    }
  }, [getActiveTab, probeTmuxFromShellPty, ptyHealthy]);

  const focusPane = useCallback((tabId: string, paneId: string) => {
    setActiveTabId(tabId);
    setTabActivePane(tabId, paneId);

    const tab = tabsRef.current.find((item) => item.id === tabId);
    const pane = tab?.panes[paneId];
    if (pane?.type === "tmux" && pane.tmuxPaneId && pane.controlPtyId) {
      void window.portableTerm.writePty(pane.controlPtyId, `select-pane -t ${pane.tmuxPaneId}\n`);
    }
  }, [setTabActivePane]);

  useEffect(() => {
    const unsubscribeData = window.portableTerm.onPtyData((payload) => {
      if (payload.kind === "shell") {
        const mapping = localPtyToPaneRef.current.get(payload.id);
        if (!mapping) {
          return;
        }
        consumeShellProbeData(payload.id, payload.data);
        writeToPane(mapping.paneId, payload.data);
        return;
      }

      const previous = tmuxLineBuffersRef.current[payload.id] || "";
      const { rest, lines } = splitLines(previous, payload.data);
      tmuxLineBuffersRef.current[payload.id] = rest;

      for (const line of lines) {
        void handleTmuxControlLine(payload.id, line);
      }
    });

    const unsubscribeExit = window.portableTerm.onPtyExit((payload) => {
      if (payload.kind === "shell") {
        const mapping = localPtyToPaneRef.current.get(payload.id);
        const probe = shellTmuxProbeRef.current.get(payload.id);
        if (probe) {
          window.clearTimeout(probe.timeoutId);
          shellTmuxProbeRef.current.delete(payload.id);
        }
        if (mapping) {
          writeToPane(mapping.paneId, `\r\n[Process exited with code ${payload.exitCode}]\r\n`);
          localPtyToPaneRef.current.delete(payload.id);
        }
        return;
      }

      const controller = controllersRef.current[payload.id];
      if (controller) {
        for (const binding of Object.values(controller.paneToNative)) {
          cleanupPaneArtifacts(binding.paneId);
        }
      }

      setTabs((prev) => {
        const remaining = prev.filter((tab) => tab.controlPtyId !== payload.id);
        if (remaining.length === 0) {
          setActiveTabId(null);
          void createLocalTab();
          return remaining;
        }

        const currentActive = activeTabIdRef.current;
        if (currentActive && !remaining.some((tab) => tab.id === currentActive)) {
          setActiveTabId(remaining[0]?.id ?? null);
        }
        return remaining;
      });

      delete controllersRef.current[payload.id];
      delete tmuxLineBuffersRef.current[payload.id];
      tmuxClientSizeRef.current.delete(payload.id);
      tmuxPrefetchedHistoryRef.current.delete(payload.id);
      tmuxPrefetchInFlightRef.current.delete(payload.id);
      const activeCapture = tmuxCaptureActiveRef.current.get(payload.id);
      if (activeCapture && activeCapture.timeoutId !== null) {
        window.clearTimeout(activeCapture.timeoutId);
      }
      tmuxCaptureActiveRef.current.delete(payload.id);
      tmuxCaptureQueuesRef.current.delete(payload.id);
    });

    const unsubscribeMenu = window.portableTerm.onMenuAction((action) => {
      if (action === "new-tab") {
        void createLocalTab();
      } else if (action === "split-horizontal") {
        void splitActivePane("horizontal");
      } else if (action === "split-vertical") {
        void splitActivePane("vertical");
      } else if (action === "close-pane") {
        void closeActivePane();
      } else if (action === "tmux-attach") {
        void openTmuxPicker();
      } else if (action === "tmux-detach") {
        detachActiveTmuxClient();
      }
    });

    return () => {
      unsubscribeData();
      unsubscribeExit();
      unsubscribeMenu();
    };
  }, [
    cleanupPaneArtifacts,
    closeActivePane,
    consumeShellProbeData,
    createLocalTab,
    detachActiveTmuxClient,
    handleTmuxControlLine,
    openTmuxPicker,
    splitActivePane,
    writeToPane
  ]);

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;
    void createLocalTab();
  }, [createLocalTab]);

  useEffect(() => {
    if (activeTabId || tabs.length === 0) {
      return;
    }
    setActiveTabId(tabs[0].id);
  }, [activeTabId, tabs]);

  const effectiveActiveTabId = activeTabId ?? tabs[0]?.id ?? null;

  useEffect(() => {
    if (!effectiveActiveTabId) {
      return;
    }
    const tab = tabsRef.current.find((item) => item.id === effectiveActiveTabId);
    if (!tab?.controlPtyId) {
      return;
    }

    const raf = window.requestAnimationFrame(() => {
      syncTmuxClientSizeForTab(effectiveActiveTabId);
    });

    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [effectiveActiveTabId, tabs, syncTmuxClientSizeForTab]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === effectiveActiveTabId) ?? null,
    [effectiveActiveTabId, tabs]
  );

  const renderLayout = useCallback(
    (tabId: string, tab: TabState, node: LayoutNode, path = ""): JSX.Element => {
      if (node.type === "pane") {
        const pane = tab.panes[node.paneId];
        if (!pane) {
          return <div className="pane-placeholder">Pane not available</div>;
        }
        return (
          <TerminalPane
            key={pane.id}
            pane={pane}
            isActive={tab.activePaneId === pane.id}
            onFocus={() => focusPane(tabId, pane.id)}
            onInput={(input) => handlePaneInput(tabId, pane.id, input)}
            onResize={(cols, rows) => handlePaneResize(tabId, pane.id, cols, rows)}
            registerWriter={registerWriter}
          />
        );
      }

      return (
        <div className={`split split-${node.direction}`}>
          <div className="split-child" style={{ flex: node.ratio }}>
            {renderLayout(tabId, tab, node.first, `${path}L`)}
          </div>
          <div
            className={`split-divider divider-${node.direction}`}
            onPointerDown={(event) => beginSplitResize(event, tabId, path, node.direction)}
            role="separator"
            aria-orientation={node.direction === "horizontal" ? "vertical" : "horizontal"}
          />
          <div className="split-child" style={{ flex: 1 - node.ratio }}>
            {renderLayout(tabId, tab, node.second, `${path}R`)}
          </div>
        </div>
      );
    },
    [beginSplitResize, focusPane, handlePaneInput, handlePaneResize, registerWriter]
  );

  return (
    <div className="app-shell">
      {runtimeError ? <div className="runtime-error">{runtimeError}</div> : null}
      <header className="toolbar">
        <div className="toolbar-main-actions">
          <button type="button" onClick={() => void createLocalTab()}>
            New Tab
          </button>
          <button
            type="button"
            onClick={() => void openTmuxPicker()}
            disabled={!ptyHealthy}
            title={
              ptyHealthy
                ? "Attach tmux session"
                : "Disabled: tmux control mode requires PTY backend"
            }
          >
            Attach tmux
          </button>
          <button type="button" onClick={() => void splitActivePane("horizontal")}>
            Split H
          </button>
          <button type="button" onClick={() => void splitActivePane("vertical")}>
            Split V
          </button>
          <button type="button" onClick={() => void closeActivePane()}>
            Close Pane
          </button>
          <button
            type="button"
            onClick={detachActiveTmuxClient}
            disabled={!activeTab?.controlPtyId}
            title="Detach active tmux client"
          >
            Detach tmux
          </button>
        </div>
      </header>

      <div className="tabs-strip">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab-item${tab.id === effectiveActiveTabId ? " active" : ""}`}
            onClick={() => setActiveTabId(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setActiveTabId(tab.id);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <span className="tab-title">{tab.title}</span>
            <button
              type="button"
              className="tab-close"
              onClick={(event) => {
                event.stopPropagation();
                void removeTabById(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <main className="workspace">
        {tabs.length > 0 ? (
          tabs.map((tab) => (
            <section
              key={tab.id}
              className={`workspace-tab${tab.id === effectiveActiveTabId ? " active" : " inactive"}`}
            >
              {renderLayout(tab.id, tab, tab.layout)}
            </section>
          ))
        ) : (
          <div className="empty-state">No tab open</div>
        )}
      </main>

      {tmuxPicker.open ? (
        <div className="modal-backdrop" onClick={() => setTmuxPicker(initialPickerState)}>
          <div
            className="modal"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <h2>Attach tmux Session</h2>
            <p className="muted">Session source: {tmuxPicker.sourceLabel}</p>
            {tmuxPicker.loading ? <p>Loading sessions...</p> : null}
            {tmuxPicker.error ? <p className="error-text">{tmuxPicker.error}</p> : null}

            <div className="session-list">
              {tmuxPicker.sessions.map((session) => (
                <button
                  key={session}
                  type="button"
                  onClick={() =>
                    void startTmuxControl(session, tmuxPicker.sshTarget, tmuxPicker.sshPort)
                  }
                >
                  {session}
                </button>
              ))}
              {tmuxPicker.sessions.length === 0 && !tmuxPicker.loading ? (
                <p className="muted">No tmux sessions found. Create one below.</p>
              ) : null}
            </div>

            <label htmlFor="new-session">New / attach by name</label>
            <input
              id="new-session"
              type="text"
              value={tmuxPicker.newSessionName}
              onChange={(event) =>
                setTmuxPicker((prev) => ({
                  ...prev,
                  newSessionName: event.target.value
                }))
              }
              placeholder="session-name"
            />

            <div className="modal-actions">
              <button
                type="button"
                onClick={() =>
                  void startTmuxControl(
                    tmuxPicker.newSessionName || "main",
                    tmuxPicker.sshTarget,
                    tmuxPicker.sshPort
                  )
                }
              >
                Connect
              </button>
              <button type="button" onClick={() => setTmuxPicker(initialPickerState)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

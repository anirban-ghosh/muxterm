import { useEffect, useMemo, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { PaneState } from "../types";

interface TerminalPaneProps {
  pane: PaneState;
  isActive: boolean;
  onFocus: () => void;
  onInput: (input: string) => void;
  onResize: (cols: number, rows: number) => void;
  registerWriter: (paneId: string, writer: (data: string) => void) => () => void;
}

export function TerminalPane({
  pane,
  isActive,
  onFocus,
  onInput,
  onResize,
  registerWriter
}: TerminalPaneProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const onFocusRef = useRef(onFocus);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    onFocusRef.current = onFocus;
  }, [onFocus]);

  const theme = useMemo(
    () => ({
      background: "#0b1218",
      foreground: "#d4e1f0",
      cursor: "#f9c74f",
      selectionBackground: "#33475c"
    }),
    []
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    let disposed = false;

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      scrollback: 12000,
      fontSize: 13,
      lineHeight: 1.2,
      fontFamily: "'JetBrains Mono', 'Menlo', 'Consolas', monospace",
      theme
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;
    terminal.open(root);
    terminalRef.current = terminal;

    const resize = () => {
      if (disposed) {
        return;
      }
      try {
        fitAddon.fit();
        if (terminal.cols > 0 && terminal.rows > 0) {
          onResizeRef.current(terminal.cols, terminal.rows);
        }
      } catch (_error) {
        // xterm can throw during rapid mount/unmount cycles; ignore and wait for next resize tick.
      }
    };

    let pendingResizeRaf: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (pendingResizeRaf !== null) {
        return;
      }
      pendingResizeRaf = window.requestAnimationFrame(() => {
        pendingResizeRaf = null;
        resize();
      });
    });

    resizeObserver.observe(root);
    const onWindowResize = () => {
      resize();
    };
    window.addEventListener("resize", onWindowResize);

    const unregister = registerWriter(pane.id, (data) => {
      void terminal.write(data);
    });

    const dataDisposable = terminal.onData((data) => {
      onInputRef.current(data);
    });

    const clickListener = () => {
      onFocusRef.current();
      terminal.focus();
    };

    const focusInListener = () => {
      onFocusRef.current();
    };

    root.addEventListener("mousedown", clickListener);
    root.addEventListener("focusin", focusInListener);

    const firstFitRaf = window.requestAnimationFrame(() => {
      resize();
      if (isActive) {
        terminal.focus();
      }
    });
    const delayedFit = window.setTimeout(() => {
      resize();
    }, 120);

    return () => {
      root.removeEventListener("mousedown", clickListener);
      root.removeEventListener("focusin", focusInListener);
      resizeObserver.disconnect();
      if (pendingResizeRaf !== null) {
        window.cancelAnimationFrame(pendingResizeRaf);
      }
      window.removeEventListener("resize", onWindowResize);
      dataDisposable.dispose();
      unregister();
      window.cancelAnimationFrame(firstFitRaf);
      window.clearTimeout(delayedFit);
      disposed = true;
      fitAddonRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [pane.id, registerWriter, theme]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) {
      return;
    }

    const refitAndFocus = () => {
      try {
        fitAddon.fit();
        if (terminal.cols > 0 && terminal.rows > 0) {
          onResizeRef.current(terminal.cols, terminal.rows);
        }
      } catch (_error) {
        // Ignore intermittent fit failures and wait for next resize/activation.
      }
      terminal.focus();
    };

    const raf = window.requestAnimationFrame(refitAndFocus);
    const timeout = window.setTimeout(refitAndFocus, 80);

    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
    };
  }, [isActive]);

  return <div className={`terminal-pane${isActive ? " active" : ""}`} ref={rootRef} />;
}

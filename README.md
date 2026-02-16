# PortableTerm2

Cross-platform desktop terminal emulator scaffold with:

- Multiple windows (`File -> New Window`)
- Native tabs
- Horizontal + vertical split panes
- PTY-backed local shells (Linux/macOS/Windows)
- tmux control mode (`tmux -CC`) integration
  - tmux sessions selectable from UI (`Attach tmux`)
  - tmux windows mapped to native tabs
  - tmux panes mapped to native split panes
  - `%output` multiplexing routed to the correct pane

## Stack

- Electron (desktop shell, menu, window lifecycle)
- React + Vite (renderer)
- `node-pty` (cross-platform terminal process layer)
- `xterm.js` (terminal rendering)

## Quick start

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
npx electron-builder
```

## Key shortcuts

- `Cmd/Ctrl+T`: New tab
- `Cmd/Ctrl+Shift+N`: New window
- `Cmd/Ctrl+D`: Split horizontally
- `Cmd/Ctrl+Shift+D`: Split vertically
- `Cmd/Ctrl+W`: Close pane
- `Cmd/Ctrl+Shift+T`: Attach tmux session

## tmux control-mode behavior

- A tmux control client is spawned via `tmux -CC`.
- Bootstrap command queries all windows:
  - `list-windows -a -F "__WINDOW__::#{window_id}::#{window_name}::#{window_layout}"`
- Control lines are parsed and mapped:
  - `%window-add`, `%window-close`, `%window-renamed`
  - `%layout-change`
  - `%window-pane-changed`
  - `%output`
- Keyboard input in tmux panes is converted into:
  - `send-keys -t <pane> -H <hex bytes...>`

## Architecture notes

- Electron main process manages PTY lifecycle and forwards data/exit events via IPC.
- Renderer manages tab/pane layout and terminal instances.
- tmux layout strings are parsed into a native binary split tree.

## Current limitations

This is a strong base implementation, not full iTerm2 parity yet. Notably missing:

- Drag-resize split dividers
- Search, profiles, triggers, broadcast input, advanced key mapping
- Robust tmux command-response parser (`%begin/%end` transaction semantics)
- Fine-grained tmux client resize behavior per native window geometry
- Session persistence/restoration across app restarts
- Packaging/signing scripts per OS

## Project layout

- `electron/main.ts`: Window/menu + PTY + tmux process bridge
- `electron/preload.ts`: Safe renderer API
- `src/App.tsx`: Tabs/splits + tmux mapping logic
- `src/lib/tmux.ts`: tmux control protocol parser + layout parser
- `src/components/TerminalPane.tsx`: xterm pane component

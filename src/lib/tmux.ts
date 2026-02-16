import type { LayoutNode, SplitDirection } from "../types";

type InternalLayoutNode = {
  width: number;
  height: number;
  node: TmuxLayoutNode;
};

type TmuxLayoutNode =
  | { type: "pane"; tmuxPaneId: string }
  | {
      type: "split";
      direction: SplitDirection;
      ratio: number;
      first: TmuxLayoutNode;
      second: TmuxLayoutNode;
    };

export type ParsedTmuxEvent =
  | { type: "output"; paneId: string; data: string }
  | { type: "window-add"; windowId: string }
  | { type: "window-close"; windowId: string }
  | { type: "window-renamed"; windowId: string; name: string }
  | { type: "layout-change"; windowId: string; layout: string }
  | { type: "window-pane-changed"; windowId: string; paneId: string }
  | { type: "session-changed"; sessionName: string }
  | { type: "begin" }
  | { type: "end" }
  | { type: "error"; message: string }
  | { type: "other"; line: string };

function stripChecksum(layout: string): string {
  const firstComma = layout.indexOf(",");
  const firstX = layout.indexOf("x");
  if (firstComma > -1 && firstX > -1 && firstComma < firstX) {
    return layout.slice(firstComma + 1);
  }
  return layout;
}

class LayoutParser {
  private readonly input: string;
  private idx = 0;

  constructor(layout: string) {
    this.input = stripChecksum(layout);
  }

  parse(): InternalLayoutNode {
    const parsed = this.parseCell();
    return parsed;
  }

  private peek(): string {
    return this.input[this.idx] || "";
  }

  private consume(char: string): void {
    if (this.input[this.idx] !== char) {
      throw new Error(`Expected '${char}' at ${this.idx}`);
    }
    this.idx += 1;
  }

  private readNumber(): number {
    let out = "";
    while (/[0-9]/.test(this.peek())) {
      out += this.peek();
      this.idx += 1;
    }

    if (out.length === 0) {
      throw new Error(`Expected number at ${this.idx}`);
    }

    return Number.parseInt(out, 10);
  }

  private foldChildren(
    children: InternalLayoutNode[],
    direction: SplitDirection
  ): InternalLayoutNode["node"] {
    if (children.length === 0) {
      throw new Error("Empty children");
    }

    let current = children[0];
    for (let i = 1; i < children.length; i += 1) {
      const next = children[i];
      const currentSpan = direction === "horizontal" ? current.width : current.height;
      const nextSpan = direction === "horizontal" ? next.width : next.height;
      const total = Math.max(1, currentSpan + nextSpan);

      current = {
        width: direction === "horizontal" ? current.width + next.width : current.width,
        height: direction === "vertical" ? current.height + next.height : current.height,
        node: {
          type: "split",
          direction,
          ratio: currentSpan / total,
          first: current.node,
          second: next.node
        }
      };
    }

    return current.node;
  }

  private parseCell(): InternalLayoutNode {
    const width = this.readNumber();
    this.consume("x");
    const height = this.readNumber();
    this.consume(",");
    this.readNumber();
    this.consume(",");
    this.readNumber();

    const next = this.peek();
    if (next === "[") {
      this.consume("[");
      const children: InternalLayoutNode[] = [];
      while (this.peek() !== "]") {
        children.push(this.parseCell());
        if (this.peek() === ",") {
          this.consume(",");
        }
      }
      this.consume("]");
      return {
        width,
        height,
        node: this.foldChildren(children, "vertical")
      };
    }

    if (next === "{") {
      this.consume("{");
      const children: InternalLayoutNode[] = [];
      while (this.peek() !== "}") {
        children.push(this.parseCell());
        if (this.peek() === ",") {
          this.consume(",");
        }
      }
      this.consume("}");
      return {
        width,
        height,
        node: this.foldChildren(children, "horizontal")
      };
    }

    this.consume(",");
    const paneNumericId = this.readNumber();

    return {
      width,
      height,
      node: {
        type: "pane",
        tmuxPaneId: `%${paneNumericId}`
      }
    };
  }
}

function mapNode(
  node: TmuxLayoutNode,
  mapPane: (tmuxPaneId: string) => string
): LayoutNode {
  if (node.type === "pane") {
    return {
      type: "pane",
      paneId: mapPane(node.tmuxPaneId)
    };
  }

  return {
    type: "split",
    direction: node.direction,
    ratio: Math.min(0.9, Math.max(0.1, node.ratio)),
    first: mapNode(node.first, mapPane),
    second: mapNode(node.second, mapPane)
  };
}

export function parseTmuxLayout(
  layout: string,
  mapPane: (tmuxPaneId: string) => string
): LayoutNode {
  const root = new LayoutParser(layout).parse();
  return mapNode(root.node, mapPane);
}

export function splitLines(buffer: string, incoming: string): { rest: string; lines: string[] } {
  const text = buffer + incoming;
  const lines = text.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  return { rest, lines };
}

export function decodeTmuxEscapedText(payload: string): string {
  let out = "";
  for (let i = 0; i < payload.length; i += 1) {
    const char = payload[i];
    if (char !== "\\") {
      out += char;
      continue;
    }

    const next = payload[i + 1] || "";
    if (next === "\\") {
      out += "\\";
      i += 1;
      continue;
    }

    if (/[0-7]/.test(next) && /[0-7]/.test(payload[i + 2] || "") && /[0-7]/.test(payload[i + 3] || "")) {
      const oct = payload.slice(i + 1, i + 4);
      out += String.fromCharCode(Number.parseInt(oct, 8));
      i += 3;
      continue;
    }

    if (next === "n") {
      out += "\n";
      i += 1;
      continue;
    }

    if (next === "r") {
      out += "\r";
      i += 1;
      continue;
    }

    if (next === "t") {
      out += "\t";
      i += 1;
      continue;
    }

    out += next;
    i += 1;
  }

  return out;
}

export function parseTmuxControlLine(line: string): ParsedTmuxEvent {
  if (line.startsWith("%begin")) {
    return { type: "begin" };
  }

  if (line.startsWith("%end")) {
    return { type: "end" };
  }

  if (line.startsWith("%error")) {
    return { type: "error", message: line.slice(6).trim() };
  }

  const outputMatch = /^%output\s+(%\d+)\s?(.*)$/u.exec(line);
  if (outputMatch) {
    return {
      type: "output",
      paneId: outputMatch[1],
      data: decodeTmuxEscapedText(outputMatch[2] || "")
    };
  }

  const extendedOutputMatch = /^%extended-output\s+(%\d+)\s+\d+\s?(.*)$/u.exec(line);
  if (extendedOutputMatch) {
    return {
      type: "output",
      paneId: extendedOutputMatch[1],
      data: decodeTmuxEscapedText(extendedOutputMatch[2] || "")
    };
  }

  const windowAddMatch = /^%window-add\s+(@\d+)(?:\s+.*)?$/u.exec(line);
  if (windowAddMatch) {
    return { type: "window-add", windowId: windowAddMatch[1] };
  }

  const windowCloseMatch = /^%window-close\s+(@\d+)(?:\s+.*)?$/u.exec(line);
  if (windowCloseMatch) {
    return { type: "window-close", windowId: windowCloseMatch[1] };
  }

  const windowRenamedMatch = /^%window-renamed\s+(@\d+)\s+(.+)$/u.exec(line);
  if (windowRenamedMatch) {
    return {
      type: "window-renamed",
      windowId: windowRenamedMatch[1],
      name: windowRenamedMatch[2]
    };
  }

  const layoutMatch = /^%layout-change\s+(@\d+)\s+([^\s]+).*$/.exec(line);
  if (layoutMatch) {
    return {
      type: "layout-change",
      windowId: layoutMatch[1],
      layout: layoutMatch[2]
    };
  }

  const paneChangedMatch = /^%window-pane-changed\s+(@\d+)\s+(%\d+)(?:\s+.*)?$/u.exec(line);
  if (paneChangedMatch) {
    return {
      type: "window-pane-changed",
      windowId: paneChangedMatch[1],
      paneId: paneChangedMatch[2]
    };
  }

  const sessionChanged = /^%session-changed\s+\$?\d+\s+(.+)$/u.exec(line);
  if (sessionChanged) {
    return {
      type: "session-changed",
      sessionName: sessionChanged[1]
    };
  }

  return { type: "other", line };
}

export function makeSendKeysHexCommand(tmuxPaneId: string, input: string): string {
  const bytes = new TextEncoder().encode(input);
  if (bytes.length === 0) {
    return "";
  }

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
  return `send-keys -t ${tmuxPaneId} -H ${hex}\n`;
}

export function parseBootstrapWindowLine(
  line: string
): { windowId: string; name: string; layout: string } | null {
  const marker = "__WINDOW__::";
  if (!line.startsWith(marker)) {
    return null;
  }

  const data = line.slice(marker.length);
  const parts = data.split("::");
  if (parts.length < 3) {
    return null;
  }

  const [windowId, name, ...layoutParts] = parts;
  return {
    windowId,
    name,
    layout: layoutParts.join("::")
  };
}

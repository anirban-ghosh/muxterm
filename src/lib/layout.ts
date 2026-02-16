import type { LayoutNode, PaneNode, SplitDirection, SplitNode } from "../types";

export function singlePaneLayout(paneId: string): PaneNode {
  return { type: "pane", paneId };
}

export function splitLayoutAtPane(
  layout: LayoutNode,
  targetPaneId: string,
  direction: SplitDirection,
  newPaneId: string
): LayoutNode {
  if (layout.type === "pane") {
    if (layout.paneId !== targetPaneId) {
      return layout;
    }

    return {
      type: "split",
      direction,
      ratio: 0.5,
      first: layout,
      second: singlePaneLayout(newPaneId)
    };
  }

  return {
    ...layout,
    first: splitLayoutAtPane(layout.first, targetPaneId, direction, newPaneId),
    second: splitLayoutAtPane(layout.second, targetPaneId, direction, newPaneId)
  };
}

function removePaneRec(
  layout: LayoutNode,
  paneId: string
): { node: LayoutNode | null; removed: boolean } {
  if (layout.type === "pane") {
    if (layout.paneId === paneId) {
      return { node: null, removed: true };
    }
    return { node: layout, removed: false };
  }

  const left = removePaneRec(layout.first, paneId);
  const right = removePaneRec(layout.second, paneId);

  if (!left.removed && !right.removed) {
    return { node: layout, removed: false };
  }

  if (!left.node && right.node) {
    return { node: right.node, removed: true };
  }

  if (left.node && !right.node) {
    return { node: left.node, removed: true };
  }

  if (!left.node && !right.node) {
    return { node: null, removed: true };
  }

  const split: SplitNode = {
    ...layout,
    first: left.node,
    second: right.node
  } as SplitNode;

  return { node: split, removed: true };
}

export function removePaneFromLayout(layout: LayoutNode, paneId: string): LayoutNode | null {
  return removePaneRec(layout, paneId).node;
}

export function collectPaneIds(layout: LayoutNode): string[] {
  if (layout.type === "pane") {
    return [layout.paneId];
  }
  return [...collectPaneIds(layout.first), ...collectPaneIds(layout.second)];
}

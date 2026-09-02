// Converts a DrawSpec batch into tldraw shapes on a live editor.
// Deterministic shape ids (derived from spec ids) make re-sent nodes update
// in place instead of duplicating.
import {
  createShapeId,
  toRichText,
  type Editor,
  type TLShapeId,
} from "tldraw";
import {
  estimateNodeSize,
  layoutSpec,
  type KnownNodes,
  type LayoutResult,
  type Placed,
} from "./layout";
import type { DrawEdge, DrawNode, DrawSpec, DrawText } from "./spec";

const GEO_BY_SHAPE = {
  rect: "rectangle",
  ellipse: "ellipse",
  diamond: "diamond",
} as const;

export function nodeShapeId(id: string): TLShapeId {
  return createShapeId(`node-${id}`);
}

export function edgeKey(edge: DrawEdge): string {
  return edge.id ?? `${edge.from}->${edge.to}`;
}

export function edgeShapeId(key: string): TLShapeId {
  return createShapeId(`edge-${key}`);
}

export function textShapeId(id: string): TLShapeId {
  return createShapeId(`text-${id}`);
}

/** Where a node in this spec should end up, before any animation. */
export function nodeTarget(
  editor: Editor,
  node: DrawNode,
  layout: LayoutResult,
): Placed {
  const existing = editor.getShape(nodeShapeId(node.id));
  const pos = layout.nodes.get(node.id);
  return {
    x: node.x ?? pos?.x ?? existing?.x ?? 0,
    y: node.y ?? pos?.y ?? existing?.y ?? 0,
  };
}

export function applyNode(
  editor: Editor,
  node: DrawNode,
  layout: LayoutResult,
  // Animated playback draws a node at its *current* spot and tweens it to the
  // target afterwards, so it can override the placement here.
  at?: Placed,
) {
  const id = nodeShapeId(node.id);
  const existing = editor.getShape(id);
  const exists = existing !== undefined;
  // Explicit coordinates win, then the layout engine, then wherever the shape
  // already sits (so a re-sent node never jumps back to the origin).
  const target = at ?? nodeTarget(editor, node, layout);
  const x = target.x;
  const y = target.y;
  // Boxes are sized to fit their label unless the agent asked for a size.
  const size = layout.sizes.get(node.id) ?? estimateNodeSize(node);
  if (node.shape === "note") {
    const shape = {
      id,
      type: "note" as const,
      x,
      y,
      props: {
        richText: toRichText(node.label),
        color: node.color ?? "yellow",
      },
    };
    if (exists) editor.updateShape(shape);
    else editor.createShape(shape);
    return;
  }
  const shape = {
    id,
    type: "geo" as const,
    x,
    y,
    props: {
      geo: GEO_BY_SHAPE[(node.shape ?? "rect") as keyof typeof GEO_BY_SHAPE] ?? "rectangle",
      w: node.w ?? size.w,
      h: node.h ?? size.h,
      richText: toRichText(node.label),
      color: node.color ?? "black",
      fill: "semi" as const,
    },
  };
  if (exists) editor.updateShape(shape);
  else editor.createShape(shape);
}

export function applyEdge(editor: Editor, edge: DrawEdge) {
  const arrowId = edgeShapeId(edgeKey(edge));
  const fromId = nodeShapeId(edge.from);
  const toId = nodeShapeId(edge.to);
  const from = editor.getShape(fromId);
  const to = editor.getShape(toId);
  if (!from || !to) return;

  // Recreate rather than diff: bindings + terminals are fiddly to patch.
  if (editor.getShape(arrowId)) editor.deleteShape(arrowId);

  const fromBounds = editor.getShapePageBounds(fromId);
  const toBounds = editor.getShapePageBounds(toId);
  const start = fromBounds
    ? { x: fromBounds.midX, y: fromBounds.midY }
    : { x: 0, y: 0 };
  const end = toBounds ? { x: toBounds.midX, y: toBounds.midY } : { x: 100, y: 100 };

  editor.createShape({
    id: arrowId,
    type: "arrow",
    x: 0,
    y: 0,
    props: {
      start: { x: start.x, y: start.y },
      end: { x: end.x, y: end.y },
      color: edge.color ?? "grey",
      dash: edge.dashed ? "dashed" : "draw",
      ...(edge.label ? { richText: toRichText(edge.label) } : {}),
    },
  });

  // Bind both terminals so the arrow follows dragged nodes. If the binding
  // API shifts, the unbound arrow above still renders.
  try {
    for (const [terminal, targetId] of [
      ["start", fromId],
      ["end", toId],
    ] as const) {
      editor.createBinding({
        type: "arrow",
        fromId: arrowId,
        toId: targetId,
        props: {
          terminal,
          normalizedAnchor: { x: 0.5, y: 0.5 },
          isExact: false,
          isPrecise: false,
        },
      });
    }
  } catch {
    // ignore: arrow stays unbound at fixed points
  }
}

export function applyText(editor: Editor, text: DrawText, layout: LayoutResult) {
  const id = textShapeId(text.id);
  const existing = editor.getShape(id);
  const exists = existing !== undefined;
  const pos = layout.texts.get(text.id);
  const shape = {
    id,
    type: "text" as const,
    x: text.x ?? pos?.x ?? existing?.x ?? 0,
    y: text.y ?? pos?.y ?? existing?.y ?? 0,
    props: {
      richText: toRichText(text.text),
      size: text.size ?? "m",
    },
  };
  if (exists) editor.updateShape(shape);
  else editor.createShape(shape);
}

export function clearCanvas(editor: Editor) {
  const all = [...editor.getCurrentPageShapeIds()];
  if (all.length > 0) editor.deleteShapes(all);
}

/**
 * Lay out a spec against the canvas as it stands. `cleared` means the canvas
 * is about to be (or has just been) wiped, so nothing anchors the layout.
 */
export function buildLayout(
  editor: Editor,
  spec: DrawSpec,
  cleared = spec.clear === true,
): LayoutResult {
  // Nodes already on the canvas anchor the layout — after a clear there are
  // none, so the diagram is laid out from scratch.
  const known: KnownNodes = new Map();
  if (!cleared) {
    for (const node of spec.nodes ?? []) {
      const shape = editor.getShape(nodeShapeId(node.id));
      if (shape) known.set(node.id, { x: shape.x, y: shape.y });
    }
    for (const text of spec.texts ?? []) {
      const shape = editor.getShape(textShapeId(text.id));
      if (shape) known.set(text.id, { x: shape.x, y: shape.y });
    }
  }
  return layoutSpec(spec, known);
}

export function applyDrawSpec(editor: Editor, spec: DrawSpec) {
  editor.run(() => {
    if (spec.clear) clearCanvas(editor);
    const layout = buildLayout(editor, spec);
    for (const node of spec.nodes ?? []) applyNode(editor, node, layout);
    for (const edge of spec.edges ?? []) applyEdge(editor, edge);
    for (const text of spec.texts ?? []) applyText(editor, text, layout);
  });
  try {
    editor.zoomToFit({ animation: { duration: 200 } });
  } catch {
    // zoom is cosmetic
  }
}

// Layered auto-layout for diagram specs.
//
// The agent usually knows the *structure* of a diagram (who points at whom)
// but is bad at picking pixel coordinates, so nodes may omit x/y and get
// placed here: nodes are assigned to layers by following the edges, then laid
// out on a grid along the flow direction.
//
// The layout also decides box *sizes* and where unpositioned text goes, since
// a box that is too small for its label or a title dropped at (0,0) is the
// main way these diagrams turn into a pile of overlapping shapes.
import type { DrawSpec, DrawNode } from "./spec";

/** Gap between the edges of two boxes, along and across the flow. */
const ALONG_GAP = 140;
const ACROSS_GAP = 60;
/** Gap between the flow and the band of unconnected nodes. */
const BAND_GAP = 120;

const MIN_W = 180;
const MAX_W = 340;
const MIN_H = 70;
/** tldraw notes are square-ish and grow their own height. */
const NOTE_W = 200;
const NOTE_H = 200;

// Rough metrics for tldraw's default handwriting font. Deliberately generous:
// a box slightly too wide is invisible, a box too small clips its label.
const CHAR_W = 13.5;
const LINE_H = 30;
const PAD_X = 28;
const PAD_Y = 24;
/** Arrow labels render smaller than shape labels. */
const EDGE_CHAR_W = 10;

export type Placed = { x: number; y: number };
export type Size = { w: number; h: number };
/** Nodes/texts already on the canvas, so re-sent ids keep user positions. */
export type KnownNodes = Map<string, Placed>;

export type LayoutResult = {
  /** Positions for nodes that needed one. */
  nodes: Map<string, Placed>;
  /** Positions for texts that had no coordinates. */
  texts: Map<string, Placed>;
  /** Chosen size for every node in the spec. */
  sizes: Map<string, Size>;
};

/** Greedy word wrap; returns the number of lines a label needs at width `w`. */
function lineCount(label: string, w: number, charW: number): number {
  // Explicit newlines are hard breaks, not spaces.
  const paragraphs = label.split("\n");
  if (paragraphs.length > 1) {
    return paragraphs.reduce((sum, line) => sum + lineCount(line, w, charW), 0);
  }
  const perLine = Math.max(1, Math.floor((w - PAD_X) / charW));
  let lines = 1;
  let used = 0;
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const need = used === 0 ? word.length : used + 1 + word.length;
    if (need <= perLine) {
      used = need;
    } else {
      lines++;
      // A word longer than the line wraps mid-word onto further lines.
      used = word.length % perLine;
      lines += Math.floor(word.length / perLine);
    }
  }
  return lines;
}

/**
 * Pick a box size that actually fits the label: widen first (up to MAX_W),
 * then let the box grow taller. Explicit w/h from the spec always wins.
 */
export function estimateNodeSize(node: DrawNode): Size {
  if (node.shape === "note") {
    const lines = lineCount(node.label, NOTE_W, CHAR_W);
    return { w: NOTE_W, h: Math.max(NOTE_H, lines * LINE_H + PAD_Y) };
  }
  if (node.w !== undefined && node.h !== undefined) return { w: node.w, h: node.h };

  let w = node.w ?? MIN_W;
  if (node.w === undefined) {
    // Grow the box until the label fits in at most two lines, or we hit MAX_W.
    for (const candidate of [MIN_W, 240, 290, MAX_W]) {
      w = candidate;
      if (lineCount(node.label, candidate, CHAR_W) <= 2) break;
    }
  }
  const lines = lineCount(node.label, w, CHAR_W);
  // Ellipses and diamonds waste corner space, so give their text more room.
  const slack = node.shape === "ellipse" || node.shape === "diamond" ? 1 : 0;
  const h = node.h ?? Math.max(MIN_H, (lines + slack) * LINE_H + PAD_Y);
  return { w, h };
}

/**
 * Find edges that close a cycle (a DFS back-edge), so layering can ignore
 * them. Round trips like `client -> server -> client` are common in diagrams;
 * without this the return arrow would push the client past the server.
 */
function findBackEdges(
  ids: string[],
  edges: { from: string; to: string }[],
): Set<number> {
  const out = new Map<string, number[]>(ids.map((id) => [id, []]));
  edges.forEach((edge, i) => out.get(edge.from)?.push(i));
  const back = new Set<number>();
  const state = new Map<string, 0 | 1 | 2>(); // unseen / on stack / done
  for (const root of ids) {
    if (state.get(root)) continue;
    // Iterative DFS: `enter` frames descend, `exit` frames pop the stack.
    const stack: { id: string; exit: boolean }[] = [{ id: root, exit: false }];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.exit) {
        state.set(frame.id, 2);
        continue;
      }
      if (state.get(frame.id)) continue;
      state.set(frame.id, 1);
      stack.push({ id: frame.id, exit: true });
      for (const i of out.get(frame.id) ?? []) {
        const to = edges[i].to;
        if (state.get(to) === 1) back.add(i);
        else if (!state.get(to)) stack.push({ id: to, exit: false });
      }
    }
  }
  return back;
}

/**
 * Longest-path layering: every node sits one layer after its deepest
 * predecessor, ignoring back-edges so cycles terminate.
 */
function assignLayers(
  ids: string[],
  edges: { from: string; to: string }[],
): Map<string, number> {
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const edge of edges) {
      const next = layer.get(edge.from)! + 1;
      if (next > layer.get(edge.to)!) {
        layer.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layer;
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };

function growBox(box: Box | null, pos: Placed, size: Size): Box {
  if (!box) {
    return { minX: pos.x, minY: pos.y, maxX: pos.x + size.w, maxY: pos.y + size.h };
  }
  box.minX = Math.min(box.minX, pos.x);
  box.minY = Math.min(box.minY, pos.y);
  box.maxX = Math.max(box.maxX, pos.x + size.w);
  box.maxY = Math.max(box.maxY, pos.y + size.h);
  return box;
}

/**
 * Compute positions for the nodes and unpositioned texts in a spec.
 *
 * Nodes with explicit x/y (or already on the canvas, in `auto` mode) act as
 * anchors: the computed layout is translated to sit where they already are, so
 * incremental updates don't jump.
 */
export function layoutSpec(spec: DrawSpec, known: KnownNodes): LayoutResult {
  const nodes = spec.nodes ?? [];
  const sizes = new Map<string, Size>(
    nodes.map((n) => [n.id, estimateNodeSize(n)]),
  );
  const result: LayoutResult = { nodes: new Map(), texts: new Map(), sizes };

  const mode = spec.layout ?? "auto";
  if (mode === "none") return result;

  const forceAll = mode === "lr" || mode === "tb";
  const vertical = mode === "tb";

  // An anchor is a node whose position is already decided.
  const anchors = new Map<string, Placed>();
  const free = new Set<string>();
  for (const node of nodes) {
    if (!forceAll) {
      if (node.x !== undefined && node.y !== undefined) {
        anchors.set(node.id, { x: node.x, y: node.y });
        continue;
      }
      const existing = known.get(node.id);
      if (existing) {
        anchors.set(node.id, existing);
        continue;
      }
    }
    free.add(node.id);
  }

  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const usable = (spec.edges ?? []).filter(
    (e) => e.from !== e.to && idSet.has(e.from) && idSet.has(e.to),
  );
  const back = findBackEdges(ids, usable);
  const forward = usable.filter((_, i) => !back.has(i));

  // Nodes with no connections at all are annotations, not flow steps: they go
  // in their own band instead of padding out the first column.
  const connected = new Set<string>();
  for (const edge of usable) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  const flowIds = ids.filter((id) => connected.has(id));
  const loneIds = ids.filter((id) => !connected.has(id));

  const layers = assignLayers(flowIds, forward);
  const grouped = new Map<number, string[]>();
  for (const id of flowIds) {
    const l = layers.get(id) ?? 0;
    const bucket = grouped.get(l);
    if (bucket) bucket.push(id);
    else grouped.set(l, [id]);
  }

  // Labelled arrows need room between the layers they span, or the label
  // lands on top of a box.
  const extraGap = new Map<number, number>();
  for (const edge of forward) {
    if (!edge.label) continue;
    const l = layers.get(edge.from) ?? 0;
    const want = vertical
      ? LINE_H + 20
      : Math.min(240, edge.label.length * EDGE_CHAR_W + 30);
    extraGap.set(l, Math.max(extraGap.get(l) ?? 0, want));
  }

  // Walk layers along the flow axis, stacking each layer's nodes across it and
  // centring the stack on 0.
  const local = new Map<string, Placed>();
  const bounds: { box: Box | null } = { box: null };
  let along = 0;
  const sortedLayers = [...grouped.keys()].sort((a, b) => a - b);
  for (const l of sortedLayers) {
    const bucket = grouped.get(l)!;
    const bucketSizes = bucket.map((id) => sizes.get(id)!);
    const acrossTotal =
      bucketSizes.reduce((sum, s) => sum + (vertical ? s.w : s.h), 0) +
      ACROSS_GAP * (bucket.length - 1);
    let across = -acrossTotal / 2;
    let alongMax = 0;
    bucket.forEach((id, i) => {
      const size = bucketSizes[i];
      const pos = vertical ? { x: across, y: along } : { x: along, y: across };
      local.set(id, pos);
      bounds.box = growBox(bounds.box, pos, size);
      across += (vertical ? size.w : size.h) + ACROSS_GAP;
      alongMax = Math.max(alongMax, vertical ? size.h : size.w);
    });
    along += alongMax + ALONG_GAP + (extraGap.get(l) ?? 0);
  }

  // Unconnected nodes: a band under (lr) or beside (tb) the flow, wrapping so
  // a spec that is nothing but notes still forms a block rather than a line.
  if (loneIds.length > 0) {
    const perRow = Math.max(1, Math.ceil(Math.sqrt(loneIds.length)));
    const startX = bounds.box ? bounds.box.minX : 0;
    const startY = bounds.box ? bounds.box.maxY + BAND_GAP : 0;
    let cursorX = startX;
    let cursorY = startY;
    let rowH = 0;
    loneIds.forEach((id, i) => {
      if (i > 0 && i % perRow === 0) {
        cursorX = startX;
        cursorY += rowH + ACROSS_GAP;
        rowH = 0;
      }
      const size = sizes.get(id)!;
      const pos = { x: cursorX, y: cursorY };
      local.set(id, pos);
      bounds.box = growBox(bounds.box, pos, size);
      cursorX += size.w + ACROSS_GAP;
      rowH = Math.max(rowH, size.h);
    });
  }

  // Anchor the layout: translate it so anchored nodes land (on average) where
  // they already are. With no anchors the layout is centred on the origin.
  let dx = 0;
  let dy = 0;
  const anchored = [...anchors.keys()].filter((id) => local.has(id));
  if (anchored.length > 0) {
    for (const id of anchored) {
      dx += anchors.get(id)!.x - local.get(id)!.x;
      dy += anchors.get(id)!.y - local.get(id)!.y;
    }
    dx = Math.round(dx / anchored.length);
    dy = Math.round(dy / anchored.length);
  }

  for (const id of free) {
    const pos = local.get(id);
    if (pos) {
      result.nodes.set(id, { x: Math.round(pos.x) + dx, y: Math.round(pos.y) + dy });
    }
  }

  // Text without coordinates stacks above the diagram, in listed order, so a
  // title never lands on top of the boxes it is titling.
  const freeTexts = (spec.texts ?? []).filter(
    (t) => (t.x === undefined || t.y === undefined) && !known.has(t.id),
  );
  if (freeTexts.length > 0) {
    // Include anchored nodes in the bounds, or the title floats off alone.
    const b = bounds.box;
    let full: Box | null = b
      ? { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy }
      : null;
    for (const [id, pos] of anchors) full = growBox(full, pos, sizes.get(id) ?? { w: MIN_W, h: MIN_H });
    const left = full ? full.minX : 0;
    const top = full ? full.minY : 0;
    freeTexts.forEach((text, i) => {
      const fromBottom = freeTexts.length - 1 - i;
      result.texts.set(text.id, {
        x: Math.round(left),
        y: Math.round(top) - 90 - fromBottom * 60,
      });
    });
  }

  return result;
}

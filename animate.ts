// Viewer-local playback for animated specs.
//
// A spec's `steps` are a timeline: each beat can add or move shapes, fly the
// camera, and flash accents. Everything here runs on the local editor only —
// tweens, travelling dots and camera moves are never saved or broadcast, and
// the caller persists a single snapshot once the timeline has finished.
import {
  Box,
  type Editor,
  type TLDefaultColorStyle,
  type TLShapeId,
  type TLShapePartial,
} from "tldraw";
import {
  applyEdge,
  applyNode,
  applyText,
  buildLayout,
  clearCanvas,
  edgeKey,
  edgeShapeId,
  nodeShapeId,
  nodeTarget,
  textShapeId,
} from "./canvas-apply";
import type { DrawSpec, DrawStep } from "./spec";

const MOVE_MS = 500; // a node sliding to a new position
const FLY_MS = 600; // camera moves
const PULSE_MS = 190;
const FLOW_MS = 900; // a dot travelling the length of one arrow
const DEFAULT_HOLD = 700;
const PASS_GAP = 800; // pause between loop passes
const MAX_LOOPS = 20; // ceiling for `loop: true`, so it can never spin forever
const DOT = 18;

export type PlayOptions = {
  /** Stop as soon as this returns true (new batch queued, panel unmounted). */
  cancelled?: () => boolean;
  /** Narration for the current step, or null when nothing is playing. */
  onCaption?: (caption: string | null) => void;
  /**
   * Replaying an already-drawn timeline: wipe the shapes this spec owns first
   * so the build-up is visible again, leaving everything else (the user's own
   * drawings, other diagrams) untouched.
   */
  replay?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Every shape mentioned anywhere in the batch, so layout runs once up front.
 * Also the timeline's final state, which is what a headless render draws. */
export function mergedSpec(spec: DrawSpec): DrawSpec {
  const nodes = new Map((spec.nodes ?? []).map((n) => [n.id, n]));
  const texts = new Map((spec.texts ?? []).map((t) => [t.id, t]));
  const edges = new Map((spec.edges ?? []).map((e) => [edgeKey(e), e]));
  for (const step of spec.steps ?? []) {
    for (const n of step.nodes ?? []) nodes.set(n.id, n);
    for (const t of step.texts ?? []) texts.set(t.id, t);
    for (const e of step.edges ?? []) edges.set(edgeKey(e), e);
  }
  return {
    ...spec,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    texts: [...texts.values()],
  };
}

/** Every shape id this spec is responsible for, across its steps. */
export function specShapeIds(spec: DrawSpec): TLShapeId[] {
  const full = mergedSpec(spec);
  return [
    ...(full.nodes ?? []).map((n) => nodeShapeId(n.id)),
    ...(full.edges ?? []).map((e) => edgeShapeId(edgeKey(e))),
    ...(full.texts ?? []).map((t) => textShapeId(t.id)),
  ];
}

/** Take the spec's own shapes off the board, so a replay builds up again. */
function removeSpecShapes(editor: Editor, spec: DrawSpec) {
  const ids = specShapeIds(spec).filter((id) => editor.getShape(id));
  if (ids.length > 0) editor.deleteShapes(ids);
}

function pageBoundsOf(editor: Editor, nodeIds: string[]): Box | null {
  const boxes = nodeIds
    .map((id) => editor.getShapePageBounds(nodeShapeId(id)))
    .filter((b): b is Box => b !== undefined);
  if (boxes.length === 0) return null;
  return Box.Common(boxes);
}

function flyTo(editor: Editor, nodeIds: string[]) {
  const box = pageBoundsOf(editor, nodeIds);
  if (!box) return;
  const padded = box.clone().expandBy(90);
  try {
    editor.zoomToBounds(padded, {
      animation: { duration: FLY_MS },
      // A lone box would otherwise fill the viewport at absurd magnification.
      ...(padded.width < 700 && padded.height < 700 ? { targetZoom: 1 } : {}),
    });
  } catch {
    // camera moves are cosmetic
  }
}

/** Swell a node and let it settle back, to draw the eye to it. */
async function pulse(editor: Editor, id: string) {
  const shape = editor.getShape(nodeShapeId(id));
  if (!shape) return;
  const bounds = editor.getShapePageBounds(shape.id);
  if (!bounds) return;
  const grow = 0.14;
  const dx = (bounds.width * grow) / 2;
  const dy = (bounds.height * grow) / 2;
  const props = shape.props as { w?: number; h?: number };
  const canResize = typeof props.w === "number" && typeof props.h === "number";
  const big = canResize
    ? { w: (props.w as number) * (1 + grow), h: (props.h as number) * (1 + grow) }
    : null;
  const anim = { animation: { duration: PULSE_MS } };
  // Casts: the shape's type is only known at runtime, so TS can't pick a
  // branch of the shape-partial union for us.
  editor.animateShape(
    {
      id: shape.id,
      type: shape.type,
      x: shape.x - dx,
      y: shape.y - dy,
      ...(big ? { props: big } : {}),
    } as TLShapePartial,
    anim,
  );
  await sleep(PULSE_MS + 40);
  editor.animateShape(
    {
      id: shape.id,
      type: shape.type,
      x: shape.x,
      y: shape.y,
      ...(canResize ? { props: { w: props.w, h: props.h } } : {}),
    } as TLShapePartial,
    { animation: { duration: PULSE_MS + 60 } },
  );
}

/** The arrow's rendered path in page space, or its endpoints as a fallback. */
function arrowPath(editor: Editor, arrowId: TLShapeId): { x: number; y: number }[] {
  try {
    const shape = editor.getShape(arrowId);
    if (!shape) return [];
    const geometry = editor.getShapeGeometry(shape);
    const transform = editor.getShapePageTransform(shape);
    const points = geometry.vertices;
    if (!transform || !points || points.length < 2) return [];
    return transform.applyToPoints(points).map((p) => ({ x: p.x, y: p.y }));
  } catch {
    return [];
  }
}

function pointAt(path: { x: number; y: number }[], t: number) {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    lengths.push(d);
    total += d;
  }
  if (total === 0) return path[0];
  let travelled = t * total;
  for (let i = 0; i < lengths.length; i++) {
    if (travelled <= lengths[i] || i === lengths.length - 1) {
      const f = lengths[i] === 0 ? 0 : Math.min(1, travelled / lengths[i]);
      return {
        x: path[i].x + (path[i + 1].x - path[i].x) * f,
        y: path[i].y + (path[i + 1].y - path[i].y) * f,
      };
    }
    travelled -= lengths[i];
  }
  return path[path.length - 1];
}

/**
 * Send a dot down an arrow. Driven by a timer rather than `animateShape` so it
 * follows the arrow's actual curve, and torn down again on the way out.
 */
async function flow(editor: Editor, key: string, cancelled: () => boolean) {
  const arrowId = edgeShapeId(key);
  const path = arrowPath(editor, arrowId);
  if (path.length < 2) return;
  // Deterministic id under the `__flow-` prefix so a cancelled run can sweep
  // any dot it left behind.
  const id = nodeShapeId(`__flow-${key}`);
  const colour = (editor.getShape(arrowId)?.props as { color?: string })?.color;
  const place = (t: number) => {
    const p = pointAt(path, t);
    return { x: p.x - DOT / 2, y: p.y - DOT / 2 };
  };
  const start = place(0);
  editor.createShape({
    id,
    type: "geo",
    x: start.x,
    y: start.y,
    props: {
      geo: "ellipse",
      w: DOT,
      h: DOT,
      fill: "solid",
      color: (!colour || colour === "grey" ? "blue" : colour) as TLDefaultColorStyle,
    },
  });
  const began = Date.now();
  try {
    for (;;) {
      const t = Math.min(1, (Date.now() - began) / FLOW_MS);
      const at = place(t);
      editor.updateShape({ id, type: "geo", x: at.x, y: at.y });
      if (t >= 1 || cancelled()) break;
      await sleep(32);
    }
  } finally {
    if (editor.getShape(id)) editor.deleteShape(id);
  }
}

/** Apply one step's shapes; returns how long the resulting motion takes. */
function playStep(
  editor: Editor,
  step: DrawStep,
  layout: ReturnType<typeof buildLayout>,
): number {
  const moving: TLShapePartial[] = [];
  editor.run(() => {
    for (const node of step.nodes ?? []) {
      const existing = editor.getShape(nodeShapeId(node.id));
      const target = nodeTarget(editor, node, layout);
      if (existing && (existing.x !== target.x || existing.y !== target.y)) {
        // Update label/size in place, then slide to the new home.
        applyNode(editor, node, layout, { x: existing.x, y: existing.y });
        moving.push({ id: existing.id, type: existing.type, ...target } as TLShapePartial);
      } else {
        applyNode(editor, node, layout);
      }
    }
    for (const edge of step.edges ?? []) applyEdge(editor, edge);
    for (const text of step.texts ?? []) applyText(editor, text, layout);
  });
  if (moving.length > 0) {
    editor.animateShapes(moving, { animation: { duration: MOVE_MS } });
  }
  return moving.length > 0 ? MOVE_MS : 0;
}

/**
 * Draw the batch's static shapes, then play its timeline. Resolves once the
 * last beat is done; the caller saves the resulting canvas exactly once.
 */
export async function playDrawSpec(
  editor: Editor,
  spec: DrawSpec,
  opts: PlayOptions = {},
): Promise<void> {
  const caption = opts.onCaption ?? (() => {});
  // A pointer or key press means the viewer wants the canvas back: stop the
  // timeline (and any loop) rather than animating under their hands.
  let interrupted = false;
  const onInput = (info: { name?: string }) => {
    if (info?.name === "pointer_down" || info?.name === "key_down") {
      interrupted = true;
    }
  };
  editor.on("event", onInput);
  const cancelled = () => interrupted || (opts.cancelled?.() ?? false);

  // One layout for everything the batch will ever show, so boxes introduced by
  // a later step land in their final spot instead of shuffling the diagram.
  const full = mergedSpec(spec);
  const layout = buildLayout(editor, full, spec.clear === true || opts.replay === true);

  const drawBase = () => {
    editor.run(() => {
      for (const node of spec.nodes ?? []) applyNode(editor, node, layout);
      for (const edge of spec.edges ?? []) applyEdge(editor, edge);
      for (const text of spec.texts ?? []) applyText(editor, text, layout);
    });
  };

  const passes =
    (spec.steps?.length ?? 0) === 0
      ? 1
      : spec.loop === true
        ? MAX_LOOPS
        : typeof spec.loop === "number"
          ? spec.loop
          : 1;

  try {
    for (let pass = 0; pass < passes; pass++) {
      if (cancelled()) break;
      if (pass === 0) {
        // A replay clears only what this spec owns; a fresh batch honours
        // `clear` and wipes the board.
        if (opts.replay) removeSpecShapes(editor, full);
        else if (spec.clear) editor.run(() => clearCanvas(editor));
      } else {
        editor.run(() => removeSpecShapes(editor, full));
      }
      drawBase();
      if ((spec.nodes?.length ?? 0) + (spec.texts?.length ?? 0) > 0) {
        editor.zoomToFit({ animation: { duration: 300 } });
        await sleep(350);
      }
      let flew = false;
      for (const step of spec.steps ?? []) {
        if (cancelled()) break;
        caption(step.caption ?? null);
        const settle = playStep(editor, step, layout);
        if (step.focus?.length) {
          flyTo(editor, step.focus);
          flew = true;
        } else if (!flew) {
          // Keep newly added shapes in view while we are still in overview.
          editor.zoomToFit({ animation: { duration: 300 } });
        }
        if (settle > 0) await sleep(settle);
        if (cancelled()) break;
        if (step.pulse?.length) {
          await Promise.all(step.pulse.map((id) => pulse(editor, id)));
        }
        if (step.flow?.length) {
          await Promise.all(step.flow.map((key) => flow(editor, key, cancelled)));
        }
        await sleep(step.hold ?? DEFAULT_HOLD);
      }
      caption(null);
      if (cancelled()) break;
      if (pass < passes - 1) await sleep(PASS_GAP);
    }
  } finally {
    editor.off("event", onInput);
    caption(null);
    editor.run(() => {
      // However the run ended — finished, interrupted, superseded — the canvas
      // is left holding the whole diagram, because that is what gets saved.
      for (const node of full.nodes ?? []) applyNode(editor, node, layout);
      for (const edge of full.edges ?? []) applyEdge(editor, edge);
      for (const text of full.texts ?? []) applyText(editor, text, layout);
      // Never leave playback scaffolding behind in the saved snapshot.
      const strays = [...editor.getCurrentPageShapeIds()].filter((id) =>
        String(id).includes("__flow-"),
      );
      if (strays.length > 0) editor.deleteShapes(strays);
    });
    if (!interrupted) {
      try {
        editor.zoomToFit({ animation: { duration: 400 } });
      } catch {
        // zoom is cosmetic
      }
    }
  }
}

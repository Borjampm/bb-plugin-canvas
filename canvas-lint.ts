// Overlap lint: which shapes on the canvas sit on top of each other.
//
// Runs in the panel after every change (agent batch or user edit) because
// only the live editor knows real shape bounds — text and notes size
// themselves. The result travels with the saved snapshot so the agent can
// see, on its next canvas_draw or canvas_read, that its last drawing left
// shapes colliding and fix them. This mirrors tldraw's own agent kit, which
// lints overlapping shapes and feeds the list back into the next prompt.
import { Box, type Editor, type TLShape } from "tldraw";
import { plainText } from "./canvas-read";

/** Overlaps smaller than this on both axes are touching, not colliding. */
const TOLERANCE = 6;
const MAX_FINDINGS = 20;

const LINTED_TYPES = new Set(["geo", "note", "text", "frame", "image"]);

/** `shape:node-foo` -> `node "foo"`; anything else is described by its type and label. */
function describe(shape: TLShape): string {
  const id = String(shape.id);
  for (const kind of ["node", "text"]) {
    const prefix = `shape:${kind}-`;
    if (id.startsWith(prefix)) return `${kind} "${id.slice(prefix.length)}"`;
  }
  const props = shape.props as Record<string, unknown>;
  const label = plainText(props.richText ?? props.text);
  return `user-drawn ${shape.type}${label ? ` "${label.slice(0, 40)}"` : ""}`;
}

/**
 * Return one line per pair of overlapping shapes, e.g.
 * `node "api" overlaps node "db"`. Arrows are skipped: they are supposed to
 * cross boxes at their ends, and their labels float.
 */
export function lintCanvas(editor: Editor): string[] {
  const entries: { shape: TLShape; box: Box }[] = [];
  for (const id of editor.getCurrentPageShapeIds()) {
    const shape = editor.getShape(id);
    if (!shape || !LINTED_TYPES.has(shape.type)) continue;
    const bounds = editor.getShapePageBounds(id);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;
    // Shrink so shapes that merely touch (a note tucked against a box) pass.
    const box = new Box(
      bounds.minX + TOLERANCE,
      bounds.minY + TOLERANCE,
      Math.max(1, bounds.width - 2 * TOLERANCE),
      Math.max(1, bounds.height - 2 * TOLERANCE),
    );
    entries.push({ shape, box });
  }

  const findings: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      // A shape inside a frame is meant to be there.
      if (a.shape.parentId === b.shape.id || b.shape.parentId === a.shape.id) continue;
      if (!Box.Collides(a.box, b.box)) continue;
      findings.push(`${describe(a.shape)} overlaps ${describe(b.shape)}`);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}

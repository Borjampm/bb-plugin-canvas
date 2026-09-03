// Turns a persisted tldraw store snapshot back into text the agent can read.
//
// The frontend saves the whole tldraw document; this walks those records and
// reconstructs the diagram in the same vocabulary the canvas_draw tool uses,
// so the agent can see the user's edits and build on them.
import { drawSpecSchema } from "./spec";

type Rec = Record<string, unknown>;

/** tldraw stores labels as a TipTap document; pull the plain text out. */
export function plainText(rich: unknown): string {
  if (typeof rich === "string") return rich;
  if (!rich || typeof rich !== "object") return "";
  const node = rich as Rec;
  if (typeof node.text === "string") return node.text;
  const content = node.content;
  if (!Array.isArray(content)) return "";
  const parts = content.map(plainText).filter((t) => t.length > 0);
  // Paragraph-level nodes become separate lines, inline runs stay joined.
  return node.type === "doc" ? parts.join(" / ") : parts.join("");
}

function round(n: unknown): number {
  return typeof n === "number" ? Math.round(n) : 0;
}

/** `shape:node-foo` -> `foo`, for ids this plugin created. */
function specId(shapeId: string, kind: string): string | null {
  const prefix = `shape:${kind}-`;
  return shapeId.startsWith(prefix) ? shapeId.slice(prefix.length) : null;
}

/** Ids of every shape record in a saved snapshot (empty when unreadable). */
export function snapshotShapeIds(snapshot: string | null): Set<string> {
  const ids = new Set<string>();
  if (!snapshot) return ids;
  try {
    const parsed = JSON.parse(snapshot) as Rec;
    const doc = (parsed.document ?? parsed) as Rec;
    const store = (doc.store ?? doc) as Rec;
    for (const rec of Object.values(store)) {
      if (rec && typeof rec === "object" && (rec as Rec).typeName === "shape") {
        ids.add(String((rec as Rec).id ?? ""));
      }
    }
  } catch {
    // corrupt snapshot: treat as empty
  }
  return ids;
}

/** Lines telling the agent about overlapping shapes, or nothing when clean. */
export function describeLint(lint: string[] | null | undefined): string[] {
  if (!lint || lint.length === 0) return [];
  return [
    "",
    `Overlapping shapes (${lint.length}):`,
    ...lint.map((l) => `- ${l}`),
    "Fix them: re-send the overlapping node ids with clear:true to redraw the whole " +
      "diagram, or give them explicit x/y away from the shapes they collide with.",
  ];
}

function describeSpecs(pending: { rev: number; spec: string }[]): string[] {
  const lines: string[] = [];
  for (const entry of pending) {
    try {
      const spec = drawSpecSchema.parse(JSON.parse(entry.spec));
      const bits = [
        spec.clear ? "clear" : null,
        spec.nodes?.length ? `${spec.nodes.length} node(s): ${spec.nodes.map((n) => n.id).join(", ")}` : null,
        spec.edges?.length ? `${spec.edges.length} edge(s)` : null,
        spec.texts?.length ? `${spec.texts.length} text(s)` : null,
      ].filter(Boolean);
      lines.push(`- rev ${entry.rev}: ${bits.join("; ") || "no-op"}`);
    } catch {
      lines.push(`- rev ${entry.rev}: (unreadable batch)`);
    }
  }
  return lines;
}

export function describeCanvas(
  snapshot: string | null,
  pending: { rev: number; spec: string }[],
  lint: string[] | null = null,
): string {
  const queued = pending.length > 0
    ? [
        "",
        `${pending.length} drawing batch(es) queued but not yet rendered (they apply when the canvas panel is open):`,
        ...describeSpecs(pending),
      ]
    : [];

  if (!snapshot) {
    return (
      "The canvas for this thread is empty — nothing has been drawn and saved yet." +
      (queued.length > 0 ? `\n${queued.join("\n")}` : "")
    );
  }

  let store: Rec;
  try {
    const parsed = JSON.parse(snapshot) as Rec;
    const doc = (parsed.document ?? parsed) as Rec;
    store = (doc.store ?? doc) as Rec;
    if (!store || typeof store !== "object") throw new Error("no store");
  } catch {
    return "The canvas snapshot could not be read (corrupt data).";
  }

  const records = Object.values(store).filter(
    (r): r is Rec => !!r && typeof r === "object",
  );
  const shapes = records.filter((r) => r.typeName === "shape");

  // arrow shape id -> { start: bound shape id, end: bound shape id }
  const bindings = new Map<string, { start?: string; end?: string }>();
  for (const rec of records) {
    if (rec.typeName !== "binding" || rec.type !== "arrow") continue;
    const from = String(rec.fromId ?? "");
    const terminal = (rec.props as Rec | undefined)?.terminal;
    if (terminal !== "start" && terminal !== "end") continue;
    const entry = bindings.get(from) ?? {};
    entry[terminal] = String(rec.toId ?? "");
    bindings.set(from, entry);
  }

  const nodeLines: string[] = [];
  const arrowLines: string[] = [];
  const textLines: string[] = [];
  const otherCounts = new Map<string, number>();
  // shape id -> the label used in arrow descriptions
  const nameOf = new Map<string, string>();

  for (const shape of shapes) {
    const id = String(shape.id ?? "");
    const props = (shape.props ?? {}) as Rec;
    const label = plainText(props.richText ?? props.text);
    const mine = specId(id, "node");
    if (shape.type === "geo" || shape.type === "note") {
      nameOf.set(id, mine ?? (label || id));
    } else if (shape.type === "text") {
      nameOf.set(id, mine ?? (label || id));
    }
  }

  for (const shape of shapes) {
    const id = String(shape.id ?? "");
    const props = (shape.props ?? {}) as Rec;
    const label = plainText(props.richText ?? props.text);
    const at = `at (${round(shape.x)}, ${round(shape.y)})`;

    if (shape.type === "geo" || shape.type === "note") {
      const nodeId = specId(id, "node");
      const kind = shape.type === "note" ? "note" : String(props.geo ?? "rectangle");
      const size =
        shape.type === "note" ? "" : ` ${round(props.w)}x${round(props.h)}`;
      const color = props.color ? `, ${String(props.color)}` : "";
      const who = nodeId ? `id "${nodeId}"` : `user-drawn (${id})`;
      nodeLines.push(
        `- ${who} [${kind}${color}] ${label ? `"${label}"` : "(no label)"} ${at}${size}`,
      );
      continue;
    }

    if (shape.type === "arrow") {
      const bound = bindings.get(id);
      const start = bound?.start ? nameOf.get(bound.start) ?? bound.start : null;
      const end = bound?.end ? nameOf.get(bound.end) ?? bound.end : null;
      const edgeId = specId(id, "edge");
      const ends =
        start && end
          ? `${start} -> ${end}`
          : `unbound arrow ${at}${edgeId ? ` (id "${edgeId}")` : ""}`;
      arrowLines.push(`- ${ends}${label ? ` "${label}"` : ""}`);
      continue;
    }

    if (shape.type === "text") {
      const textId = specId(id, "text");
      textLines.push(
        `- ${textId ? `id "${textId}"` : "user-drawn"}: "${label}" ${at}`,
      );
      continue;
    }

    const type = String(shape.type ?? "unknown");
    otherCounts.set(type, (otherCounts.get(type) ?? 0) + 1);
  }

  const sections: string[] = [
    `Canvas contents — ${shapes.length} shape(s) on the board.`,
  ];
  if (nodeLines.length > 0) sections.push("", "Nodes:", ...nodeLines);
  if (arrowLines.length > 0) sections.push("", "Arrows:", ...arrowLines);
  if (textLines.length > 0) sections.push("", "Text:", ...textLines);
  if (otherCounts.size > 0) {
    const summary = [...otherCounts.entries()]
      .map(([type, n]) => `${n} ${type}`)
      .join(", ");
    sections.push("", `Other shapes drawn by the user: ${summary}.`);
  }
  if (shapes.length === 0) {
    sections.push("", "The board is currently blank.");
  }
  sections.push(...describeLint(lint));
  sections.push(...queued);
  return sections.join("\n");
}

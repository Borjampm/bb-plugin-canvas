// Shared diagram spec: what the agent's canvas_draw tool emits and the
// frontend converts into tldraw shapes. Kept in its own module so server.ts
// (zod validation) and app.tsx (conversion) share one definition.
import { z } from "zod";

export const canvasColors = [
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
] as const;

export const nodeSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(300),
  // Omit x/y to let the layout engine place the node (see `layout`).
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().positive().max(2000).optional(),
  h: z.number().positive().max(2000).optional(),
  shape: z.enum(["rect", "ellipse", "diamond", "note"]).optional(),
  color: z.enum(canvasColors).optional(),
});

export const edgeSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().max(200).optional(),
  color: z.enum(canvasColors).optional(),
  dashed: z.boolean().optional(),
});

export const textSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(2000),
  // Omit x/y and the text is stacked above the diagram (good for titles).
  x: z.number().optional(),
  y: z.number().optional(),
  size: z.enum(["s", "m", "l", "xl"]).optional(),
});

/**
 * How nodes without explicit x/y are placed.
 * - `auto` (default): layered left-to-right layout from the edge graph.
 * - `lr` / `tb`: force a layered layout for *every* node in this batch,
 *   ignoring any x/y the agent supplied.
 * - `none`: no layout; nodes without x/y land at the origin.
 */
export const layoutSchema = z.enum(["auto", "lr", "tb", "none"]);

/**
 * One beat of an animated walkthrough. Steps play in order, on top of
 * whatever the batch already drew: a step can add shapes, move existing ones,
 * fly the camera somewhere, and flash accents, then pause before the next one.
 *
 * Playback is viewer-local and ephemeral — only the state the diagram ends in
 * is saved and synced, so replays never spam the canvas history.
 */
export const stepSchema = z.object({
  // Shapes to add (or, for ids already on the canvas, move/update). A node
  // that moves slides to its new position instead of jumping.
  nodes: z.array(nodeSchema).max(60).optional(),
  edges: z.array(edgeSchema).max(100).optional(),
  texts: z.array(textSchema).max(30).optional(),
  // Node ids to fly the camera to (the union of their bounds). Omit to leave
  // the camera where it is.
  focus: z.array(z.string()).max(20).optional(),
  // Node ids to flash: the box swells and settles back.
  pulse: z.array(z.string()).max(20).optional(),
  // Edges to send a travelling dot along, as `edge id` or `from->to`.
  flow: z.array(z.string()).max(20).optional(),
  // Pause after this step, in ms (default 700, max 8000).
  hold: z.number().min(0).max(8000).optional(),
  // One line of narration shown while the step plays.
  caption: z.string().max(160).optional(),
});

export const drawSpecSchema = z.object({
  clear: z.boolean().optional(),
  layout: layoutSchema.optional(),
  nodes: z.array(nodeSchema).max(120).optional(),
  edges: z.array(edgeSchema).max(200).optional(),
  texts: z.array(textSchema).max(60).optional(),
  // Optional animated walkthrough played after the static shapes land.
  steps: z.array(stepSchema).max(24).optional(),
  // Repeat the timeline: a count (max 10), or `true` to keep replaying until
  // the viewer touches the canvas. Ignored without `steps`.
  loop: z.union([z.boolean(), z.number().int().min(1).max(10)]).optional(),
});

export type DrawSpec = z.infer<typeof drawSpecSchema>;
export type DrawLayout = z.infer<typeof layoutSchema>;
export type DrawNode = z.infer<typeof nodeSchema>;
export type DrawEdge = z.infer<typeof edgeSchema>;
export type DrawText = z.infer<typeof textSchema>;
export type DrawStep = z.infer<typeof stepSchema>;

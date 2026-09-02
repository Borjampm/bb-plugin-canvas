// bb-plugin-canvas — a per-thread tldraw canvas the agent can draw on.
//
// The agent calls the canvas_draw tool with a small diagram spec (nodes,
// edges, floating texts). The server queues each batch per thread; the
// frontend panel (app.tsx) converts pending batches into tldraw shapes,
// persists the resulting store snapshot back here, and marks them applied.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { describeCanvas } from "./canvas-read";
import { drawSpecSchema } from "./spec";

export const rpcContract = defineRpcContract({
  canvas_get: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({
      snapshot: z.string().nullable(),
      pending: z.array(z.object({ rev: z.number(), spec: z.string() })),
      appliedRev: z.number(),
      /** The last spec with `steps`, replayable from the panel. */
      animation: z.string().nullable(),
      /** tldraw license key from settings, or null when unset. Not a secret:
       * tldraw keys are signed, origin-bound tokens meant to ship in the
       * client bundle. */
      licenseKey: z.string().nullable(),
    }),
  },
  canvas_save_snapshot: {
    input: z
      .object({
        threadId: z.string(),
        snapshot: z.string(),
        clientId: z.string().optional(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  canvas_mark_applied: {
    input: z.object({ threadId: z.string(), rev: z.number() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
});

/** Realtime channel: published after canvas_draw queues a new batch. */
export const CANVAS_CHANGED = "canvas-changed";
/** Realtime channel: published after a client saves a snapshot, so other
 * clients viewing the same canvas reload instead of overwriting it later. */
export const CANVAS_SAVED = "canvas-saved";

/** Injected into every thread only when the user opts in (see settings). */
const NUDGE =
  "When a visual explanation helps (architecture, control flow, data flow, plans), " +
  "prefer the canvas_draw tool over ASCII/Mermaid. Omit node x/y and let auto-layout " +
  "place them. Call canvas_read before editing a diagram that already exists. After " +
  'drawing, put `::canvas{title="..."}` on its own line so the user gets an ' +
  "open-canvas button.";

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();

  // The canvas tools are always available, but by default nothing tells agents
  // to reach for them: the `canvas` skill carries that guidance and loads only
  // when it is invoked. Turn this on to spend ~60 tokens per thread on a
  // standing suggestion instead.
  const settings = bb.settings.define({
    suggestEverywhere: {
      type: "boolean",
      label: "Suggest the canvas in every thread",
      description:
        "Add a line to every agent's instructions telling it to prefer the canvas " +
        "over ASCII/Mermaid diagrams. Off by default — agents still have the tools, " +
        "and /canvas still explains how to use them.",
      default: false,
    },
    // tldraw is free for local/development use but requires a license for
    // production origins. BB served remotely over https is a production
    // origin as far as tldraw is concerned, so without a key here the panel
    // refuses to mount the editor rather than let tldraw hide it after five
    // seconds. See README "Licensing".
    tldrawLicenseKey: {
      type: "string",
      label: "tldraw license key",
      description:
        "Only needed when you open BB over a non-local https origin (a shared or " +
        "remote BB). Leave empty for local use — tldraw is free there. Get a key at " +
        "tldraw.dev. Note: a licensed editor reports usage to cdn.tldraw.com.",
      default: "",
    },
  });
  let suggestEverywhere = (await settings.get()).suggestEverywhere;
  let tldrawLicenseKey = (await settings.get()).tldrawLicenseKey;
  settings.onChange((next) => {
    suggestEverywhere = next.suggestEverywhere;
    tldrawLicenseKey = next.tldrawLicenseKey;
  });

  // configure() selects what this plugin contributes per session, so the tools
  // and skill must be named here even when the nudge is off.
  bb.agents.configure(() => ({
    tools: ["canvas_draw", "canvas_read"],
    skills: ["canvas"],
    ...(suggestEverywhere ? { instructions: NUDGE } : {}),
  }));
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS canvases (
      thread_id TEXT PRIMARY KEY,
      snapshot TEXT,
      applied_rev INTEGER NOT NULL DEFAULT 0,
      next_rev INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS pending_specs (
      thread_id TEXT NOT NULL,
      rev INTEGER NOT NULL,
      spec TEXT NOT NULL,
      PRIMARY KEY (thread_id, rev)
    )`,
    // Keeps the most recent animated spec so the panel can offer a replay
    // long after the batch itself was applied and dropped.
    `ALTER TABLE canvases ADD COLUMN last_animation TEXT`,
  ]);

  const ensureRow = db.prepare(
    `INSERT INTO canvases (thread_id, updated_at) VALUES (?, ?)
     ON CONFLICT(thread_id) DO NOTHING`,
  );

  bb.rpc.register(rpcContract, {
    canvas_get({ threadId }) {
      const row = db
        .prepare(
          `SELECT snapshot, applied_rev AS appliedRev, last_animation AS animation
           FROM canvases WHERE thread_id = ?`,
        )
        .get(threadId) as
        | { snapshot: string | null; appliedRev: number; animation: string | null }
        | undefined;
      const pending = db
        .prepare(
          `SELECT rev, spec FROM pending_specs WHERE thread_id = ? ORDER BY rev ASC`,
        )
        .all(threadId) as { rev: number; spec: string }[];
      return {
        snapshot: row?.snapshot ?? null,
        pending,
        appliedRev: row?.appliedRev ?? 0,
        animation: row?.animation ?? null,
        licenseKey: tldrawLicenseKey ? String(tldrawLicenseKey) : null,
      };
    },
    canvas_save_snapshot({ threadId, snapshot, clientId }) {
      ensureRow.run(threadId, new Date().toISOString());
      db.prepare(
        `UPDATE canvases SET snapshot = ?, updated_at = ? WHERE thread_id = ?`,
      ).run(snapshot, new Date().toISOString(), threadId);
      bb.realtime.publish(CANVAS_SAVED, { threadId, clientId: clientId ?? null });
      return { ok: true };
    },
    canvas_mark_applied({ threadId, rev }) {
      ensureRow.run(threadId, new Date().toISOString());
      db.prepare(
        `UPDATE canvases SET applied_rev = MAX(applied_rev, ?) WHERE thread_id = ?`,
      ).run(rev, threadId);
      db.prepare(
        `DELETE FROM pending_specs WHERE thread_id = ? AND rev <= ?`,
      ).run(threadId, rev);
      return { ok: true };
    },
  });

  bb.agents.registerTool({
    name: "canvas_draw",
    description:
      "Draw or update a boxes-and-arrows diagram on this thread's shared tldraw canvas. " +
      "Nodes are shapes with labels at absolute canvas coordinates; edges connect nodes " +
      "by id with bound arrows that follow the shapes when moved. Re-sending a node id " +
      "updates that node in place, so you can evolve the diagram incrementally. " +
      "Node x/y are optional: omit them and the nodes are auto-laid-out in layers " +
      "following the edges (layout: 'lr' left-to-right, 'tb' top-to-bottom). " +
      "Set clear=true to wipe the canvas first. " +
      "Pass `steps` to animate a walkthrough: each step can add or move shapes, fly " +
      "the camera to `focus` nodes, `pulse` nodes, send a dot along an edge with " +
      "`flow`, show a `caption`, and `hold` before the next beat. " +
      "`loop` repeats the timeline (a count, or true to keep going until the user " +
      "touches the canvas).",
    presentation: {
      label: { pending: "Drawing on the canvas", completed: "Drew on the canvas" },
    },
    parameters: drawSpecSchema,
    async execute(spec, { threadId }) {
      if (!threadId) {
        return {
          content: [{ type: "text", text: "canvas_draw needs a thread context." }],
          isError: true,
        };
      }
      const nodeIds = new Set((spec.nodes ?? []).map((n) => n.id));
      const now = new Date().toISOString();
      ensureRow.run(threadId, now);
      const rev =
        ((db
          .prepare(`SELECT next_rev AS nextRev FROM canvases WHERE thread_id = ?`)
          .get(threadId) as { nextRev: number }).nextRev ?? 0) + 1;
      db.prepare(
        `UPDATE canvases SET next_rev = ?, updated_at = ? WHERE thread_id = ?`,
      ).run(rev, now, threadId);
      db.prepare(
        `INSERT INTO pending_specs (thread_id, rev, spec) VALUES (?, ?, ?)`,
      ).run(threadId, rev, JSON.stringify(spec));
      if (spec.steps?.length) {
        // Remembered so the panel's replay button outlives the batch.
        db.prepare(
          `UPDATE canvases SET last_animation = ? WHERE thread_id = ?`,
        ).run(JSON.stringify(spec), threadId);
      }
      bb.realtime.publish(CANVAS_CHANGED, { threadId, rev });
      const counts = [
        spec.clear ? "cleared canvas" : null,
        spec.nodes?.length ? `${spec.nodes.length} node(s)` : null,
        spec.edges?.length ? `${spec.edges.length} edge(s)` : null,
        spec.texts?.length ? `${spec.texts.length} text(s)` : null,
        spec.steps?.length ? `${spec.steps.length} animation step(s)` : null,
        spec.steps?.length && spec.loop
          ? `looping ${spec.loop === true ? "until the user interacts" : `${spec.loop}x`}`
          : null,
      ]
        .filter(Boolean)
        .join(", ");
      return (
        `Queued drawing (rev ${rev}): ${counts || "no-op"}. ` +
        (spec.steps?.length
          ? "The animation plays for whoever has the canvas panel open; only the final state is saved, " +
            "and the panel keeps a replay button for it. "
          : "") +
        (nodeIds.size
          ? `Node ids on canvas: ${[...nodeIds].join(", ")}. `
          : "") +
        'Now include `::canvas{title="..."}` on its own line in your reply so the user can open the canvas.'
      );
    },
  });

  bb.agents.registerTool({
    name: "canvas_read",
    description:
      "Read back what is currently on this thread's canvas: nodes (with their ids, " +
      "labels, colors and positions), arrows between them, text, and any shapes the " +
      "user drew or moved by hand. Use this before updating a diagram, or when the " +
      "user refers to something on the canvas.",
    presentation: {
      label: { pending: "Reading the canvas", completed: "Read the canvas" },
    },
    parameters: z.object({}),
    async execute(_input, { threadId }) {
      if (!threadId) {
        return {
          content: [{ type: "text", text: "canvas_read needs a thread context." }],
          isError: true,
        };
      }
      const row = db
        .prepare(`SELECT snapshot FROM canvases WHERE thread_id = ?`)
        .get(threadId) as { snapshot: string | null } | undefined;
      const pending = db
        .prepare(
          `SELECT rev, spec FROM pending_specs WHERE thread_id = ? ORDER BY rev ASC`,
        )
        .all(threadId) as { rev: number; spec: string }[];
      return describeCanvas(row?.snapshot ?? null, pending);
    },
  });
}

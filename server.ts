// bb-plugin-canvas — a per-thread tldraw canvas the agent can draw on.
//
// The agent calls the canvas_draw tool with a small diagram spec (nodes,
// edges, floating texts). The server queues each batch per thread; the
// frontend panel (app.tsx) converts pending batches into tldraw shapes,
// persists the resulting store snapshot back here, and marks them applied.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { describeCanvas, snapshotShapeIds } from "./canvas-read";
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
        /** Overlapping-shape findings computed by the panel for this snapshot. */
        lint: z.array(z.string()).optional(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  canvas_save_image: {
    input: z
      .object({
        threadId: z.string(),
        /** Base64 PNG of the whole board, or null when the board is empty. */
        png: z.string().nullable(),
        width: z.number(),
        height: z.number(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  /** What the headless renderer (a content script) needs: the license key
   * and which threads have batches waiting. */
  canvas_headless_state: {
    input: z.object({}).strict(),
    output: z.object({
      licenseKey: z.string().nullable(),
      pendingThreads: z.array(z.string()),
    }),
  },
  canvas_mark_applied: {
    input: z.object({ threadId: z.string(), rev: z.number() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
});

/** How long canvas_view waits for queued batches to render before answering. */
const VIEW_WAIT_MS = 12000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Realtime channel: published after canvas_draw queues a new batch. */
export const CANVAS_CHANGED = "canvas-changed";
/** Realtime channel: published after a client saves a snapshot, so other
 * clients viewing the same canvas reload instead of overwriting it later. */
export const CANVAS_SAVED = "canvas-saved";

/** Injected into every thread only when the user opts in (see settings). */
const NUDGE =
  "When a visual explanation helps (architecture, control flow, data flow, plans), " +
  "prefer the canvas_draw tool over ASCII/Mermaid. Omit node x/y and let auto-layout " +
  "place them. Put a whole diagram in one canvas_draw call; a new, unrelated diagram " +
  "should use clear:true (or it is placed below the old one). Call canvas_read before " +
  'editing a diagram that already exists. After drawing, put `::canvas{title="..."}` ' +
  "on its own line so the user gets an open-canvas button.";

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
    tools: ["canvas_draw", "canvas_read", "canvas_view"],
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
    // Overlap findings for the saved snapshot (JSON string[]), so the agent
    // can be told its last drawing left shapes on top of each other.
    `ALTER TABLE canvases ADD COLUMN lint TEXT`,
    // PNG (base64) of the board as last rendered by a panel, for canvas_view.
    `ALTER TABLE canvases ADD COLUMN image TEXT`,
    `ALTER TABLE canvases ADD COLUMN image_at TEXT`,
    `ALTER TABLE canvases ADD COLUMN image_size TEXT`,
  ]);

  const ensureRow = db.prepare(
    `INSERT INTO canvases (thread_id, updated_at) VALUES (?, ?)
     ON CONFLICT(thread_id) DO NOTHING`,
  );

  const readLint = (threadId: string): string[] => {
    const row = db
      .prepare(`SELECT lint FROM canvases WHERE thread_id = ?`)
      .get(threadId) as { lint: string | null } | undefined;
    if (!row?.lint) return [];
    try {
      const parsed = JSON.parse(row.lint);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };

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
    canvas_save_snapshot({ threadId, snapshot, clientId, lint }) {
      ensureRow.run(threadId, new Date().toISOString());
      db.prepare(
        `UPDATE canvases SET snapshot = ?, lint = ?, updated_at = ? WHERE thread_id = ?`,
      ).run(snapshot, JSON.stringify(lint ?? []), new Date().toISOString(), threadId);
      bb.realtime.publish(CANVAS_SAVED, { threadId, clientId: clientId ?? null });
      return { ok: true };
    },
    canvas_save_image({ threadId, png, width, height }) {
      ensureRow.run(threadId, new Date().toISOString());
      db.prepare(
        `UPDATE canvases SET image = ?, image_at = ?, image_size = ? WHERE thread_id = ?`,
      ).run(png, new Date().toISOString(), JSON.stringify({ width, height }), threadId);
      return { ok: true };
    },
    canvas_headless_state() {
      const rows = db
        .prepare(`SELECT DISTINCT thread_id AS threadId FROM pending_specs ORDER BY thread_id`)
        .all() as { threadId: string }[];
      return {
        licenseKey: tldrawLicenseKey ? String(tldrawLicenseKey) : null,
        pendingThreads: rows.map((r) => r.threadId),
      };
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
      "Nodes are labelled shapes; edges connect nodes by id with bound arrows that " +
      "follow the shapes when moved. Omit node x/y and the nodes are auto-laid-out in " +
      "layers following the edges (layout: 'lr' left-to-right, 'tb' top-to-bottom). " +
      "Send a whole diagram in one call. Re-sending a node id updates that node in " +
      "place and new nodes slot in next to it, which is how you evolve a diagram. " +
      "A batch whose node ids are all new is a separate diagram: it is placed below " +
      "everything already on the canvas, so set clear=true when it is meant to " +
      "replace the old drawing. " +
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
      // Work out, from the saved canvas, where this batch is going to land so
      // the agent is not surprised by a diagram appearing under the old one.
      const existingRow = db
        .prepare(`SELECT snapshot FROM canvases WHERE thread_id = ?`)
        .get(threadId) as { snapshot: string | null } | undefined;
      const onCanvas = snapshotShapeIds(existingRow?.snapshot ?? null);
      const priorLint = readLint(threadId);
      let placement = "";
      if (spec.clear) {
        placement = "The canvas is wiped first, so this diagram starts at the origin. ";
      } else if (onCanvas.size > 0 && (spec.nodes?.length ?? 0) > 0 && spec.layout !== "none") {
        const reused = [...nodeIds].filter((id) => onCanvas.has(`shape:node-${id}`));
        const positioned = (spec.nodes ?? []).some((n) => n.x !== undefined && n.y !== undefined);
        if (reused.length > 0) {
          placement = `Adding to the existing diagram (anchored on ${reused.slice(0, 5).join(", ")}${reused.length > 5 ? ", …" : ""}). `;
        } else if (!positioned) {
          placement =
            `The canvas already holds ${onCanvas.size} shape(s) and none of these node ids are on it, ` +
            "so this is drawn as a separate diagram BELOW the existing content. If it was meant to " +
            "replace the old diagram, call canvas_draw again with clear:true. ";
        }
      }
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
        placement +
        (nodeIds.size
          ? `Node ids on canvas: ${[...nodeIds].join(", ")}. `
          : "") +
        (priorLint.length > 0
          ? `Before this batch the canvas had ${priorLint.length} overlapping pair(s) ` +
            `(e.g. ${priorLint[0]}); call canvas_view after it renders to check they are resolved. `
          : "") +
        "Before you reply, call canvas_view to check how it looks (it waits for the render): fix " +
        "overlaps, clipped or wrapped labels and arrows through boxes with another canvas_draw. " +
        'Then include `::canvas{title="..."}` on its own line in your reply so the user can open the canvas.'
      );
    },
  });

  bb.agents.registerTool({
    name: "canvas_read",
    description:
      "Read back what is currently on this thread's canvas: nodes (with their ids, " +
      "labels, colors and positions), arrows between them, text, and any shapes the " +
      "user drew or moved by hand, plus any shapes that overlap each other. Use this " +
      "before updating a diagram, after drawing to check nothing collided, or when the " +
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
      return describeCanvas(row?.snapshot ?? null, pending, readLint(threadId));
    },
  });

  bb.agents.registerTool({
    name: "canvas_view",
    description:
      "Look at this thread's canvas as an image: a PNG of the whole board. Call it after every " +
      "canvas_draw, before replying, to check the result reads well (no overlaps, labels fit, " +
      "arrows do not cross boxes), or when the user asks about something they drew. It waits " +
      "up to 12s for freshly queued batches to render, so you can call it right after drawing; " +
      "the text part says how old the image is and whether anything is still queued.",
    presentation: {
      label: { pending: "Looking at the canvas", completed: "Looked at the canvas" },
    },
    parameters: z.object({}),
    async execute(_input, { threadId, signal }) {
      if (!threadId) {
        return {
          content: [{ type: "text", text: "canvas_view needs a thread context." }],
          isError: true,
        };
      }
      // A batch queued a moment ago takes a few seconds to render (the panel
      // is quick; the headless renderer polls). Wait for the queue to drain
      // and the image to be re-exported rather than hand back a stale picture.
      const countPending = db.prepare(
        `SELECT COUNT(*) AS n FROM pending_specs WHERE thread_id = ?`,
      );
      const imageAtOf = () =>
        (db.prepare(`SELECT image_at AS at FROM canvases WHERE thread_id = ?`).get(threadId) as
          | { at: string | null }
          | undefined)?.at ?? null;
      const before = imageAtOf();
      const deadline = Date.now() + VIEW_WAIT_MS;
      while (Date.now() < deadline && !signal?.aborted) {
        const n = (countPending.get(threadId) as { n: number }).n;
        // Drained and re-exported (or nothing was ever queued): good to go.
        if (n === 0 && (before === null || imageAtOf() !== before)) break;
        if (n === 0 && before !== null) {
          // Nothing queued but no new image yet: the renderer that applied
          // the batch is exporting. Give it a moment more, then take what is there.
          await sleep(400);
          if (imageAtOf() !== before) break;
          continue;
        }
        await sleep(400);
      }
      const row = db
        .prepare(
          `SELECT image, image_at AS imageAt, image_size AS imageSize, snapshot
           FROM canvases WHERE thread_id = ?`,
        )
        .get(threadId) as
        | { image: string | null; imageAt: string | null; imageSize: string | null; snapshot: string | null }
        | undefined;
      const pending = db
        .prepare(`SELECT COUNT(*) AS n FROM pending_specs WHERE thread_id = ?`)
        .get(threadId) as { n: number };
      const notes: string[] = [];
      if (pending.n > 0) {
        notes.push(
          `${pending.n} drawing batch(es) are queued and not in this image yet. They render within a ` +
            "few seconds while any bb window is open, and canvas_view already waited 12s for them, " +
            "so no bb client seems to be connected — ask the user to open bb or the canvas panel.",
        );
      }
      if (!row?.image) {
        const shapes = snapshotShapeIds(row?.snapshot ?? null).size;
        return [
          shapes > 0
            ? `The canvas has ${shapes} shape(s) but no image has been captured yet — one is taken ` +
              "the next time any bb window renders it. Use canvas_read for a text description meanwhile."
            : "The canvas is empty; there is nothing to look at.",
          ...notes,
        ].join("\n");
      }
      let size = "";
      try {
        const parsed = JSON.parse(row.imageSize ?? "{}") as { width?: number; height?: number };
        if (parsed.width && parsed.height) size = ` (${parsed.width}x${parsed.height}px)`;
      } catch {
        // size is cosmetic
      }
      const age = row.imageAt ? Math.max(0, Math.round((Date.now() - Date.parse(row.imageAt)) / 60000)) : null;
      const when = age === null ? "" : age < 1 ? ", captured just now" : `, captured ${age} min ago`;
      const lint = readLint(threadId);
      const caption = [
        `Canvas image${size}${when}. Node ids are not visible in the picture; use canvas_read to map labels to ids.`,
        ...(lint.length > 0 ? [`Detected overlaps: ${lint.slice(0, 5).join("; ")}${lint.length > 5 ? "; …" : ""}.`] : []),
        ...notes,
      ].join("\n");
      return {
        content: [
          { type: "image", data: row.image, mimeType: "image/png" },
          { type: "text", text: caption },
        ],
      };
    },
  });
}

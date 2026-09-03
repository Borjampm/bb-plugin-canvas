---
name: canvas
description: Draw, read and look at live boxes-and-arrows diagrams on the thread's shared tldraw canvas with the canvas_draw, canvas_read and canvas_view tools. Use when a visual explanation helps — architecture overviews, control or data flow, sequence of calls, refactor plans, system maps — or when the user says "show me", "draw", "diagram", or "visualize".
---

Use the `canvas_draw` tool to explain things visually on this thread's shared, editable canvas. Prefer it over ASCII art or Mermaid when the topic is boxes and arrows: components, services, flows, dependencies, plans.

## Spec

- `nodes`: `{ id, label, x?, y?, w?, h?, shape?, color? }` — `shape` is `rect` (default), `ellipse`, `diamond` (decisions), or `note` (sticky note, fixed size, good for annotations). Colors: `black grey blue light-blue violet light-violet green light-green yellow orange red light-red`.
- `edges`: `{ from, to, label?, color?, dashed? }` — connects node ids with arrows bound to the shapes (they follow when the user drags nodes).
- `texts`: `{ id, text, x?, y?, size? }` — free-floating labels and headings (`size`: `s m l xl`). Leave `x`/`y` off: unpositioned text stacks above the finished diagram, which is what you want for a title. You cannot guess a safe coordinate, because you do not know where auto-layout will put the boxes.
- `layout`: `auto` (default), `lr`, `tb`, or `none` — see below.
- `clear: true` wipes the canvas first. Use it whenever the new drawing *replaces* what is there. Omit it only when you are extending the diagram already on the board.
- `steps`: an optional animated walkthrough — see below.

## One diagram, one call

Send the whole diagram in a single `canvas_draw` call, not one call per box. Where a batch lands depends on its node ids:

- **All ids are new** → it is a *separate* diagram and is placed below everything already on the canvas, left-aligned with it. If you meant to replace the previous drawing, pass `clear: true` instead of stacking diagrams down the page.
- **Some ids already exist** → it is an *extension* of that diagram: existing nodes stay where they are (including where the user dragged them) and the new nodes are laid out around them.
- `layout: "lr"` / `"tb"` over ids that already exist re-flows that diagram in place.

Whether extending or replacing, keep one topic per canvas. A thread that explains three unrelated things should `clear` between them, or the board becomes a pile.

## Layout

Prefer auto-layout: **omit `x` and `y`** and the nodes are placed in layers that follow the edges (each node one layer after its deepest predecessor), left→right by default. `layout: "tb"` flows top→bottom. Both `lr` and `tb` re-lay-out every node in the batch; `auto` only places nodes that have no coordinates and are not already on the canvas.

- Auto-layout anchors on nodes that already exist, so adding a node to a live diagram slots it in rather than shifting everything the user has arranged.
- Auto-layout only knows about the nodes in the batch. It will not route around shapes the user drew by hand or a different diagram, so when adding to a crowded board, call `canvas_read` first and pass `clear: true` or explicit `x`/`y` if needed.
- Set `x`/`y` yourself only when the picture is not a flow (a quadrant chart, a map, free annotation) — or use `layout: "none"` to opt out entirely.
- Default box is 180×70. When placing by hand, ~250px horizontal and ~150px vertical between box origins reads well.
- Keep labels short (1–4 words). Boxes grow to fit their text, so a long label produces a fat box that crowds its neighbours.
- Never pack a list into one label. `Entity · Reference · Dimensions · Reconciliation` should be four nodes (or one node plus a `note`), not one box.
- Edge labels are the tightest space in the diagram — 1–3 words (`REST`, `post · edit`). Longer ones force the columns apart and stretch the whole drawing.
- Re-sending a node id updates it in place — evolve the diagram across the conversation instead of redrawing everything.
- Color meaningfully but sparingly: e.g. green = new, red = problem, grey = external.

## Animating

`steps` turns a batch into a timeline played for whoever has the canvas panel open. Top-level `nodes`/`edges`/`texts` are drawn first (the starting picture, often nothing), then each step runs in order:

- `nodes` / `edges` / `texts` — added at this beat. A node id that is already on the canvas **slides** to its new position instead of jumping, which is how you show a move or a refactor.
- `focus: ["id", ...]` — fly the camera to those nodes. A step with only `focus` and `caption` is a guided tour of a diagram you already drew.
- `pulse: ["id", ...]` — the box swells and settles, to say "this one".
- `flow: ["a->b"]` — send a dot down that arrow (use the edge's `id`, or `from->to`).
- `caption` — one line of narration shown while the step plays.
- `hold` — pause in ms before the next beat (default 700).

Spec-level `loop` repeats the timeline: a count (up to 10), or `true` to keep replaying until the viewer touches the canvas. Any pointer or key press stops playback immediately and leaves the finished diagram in place, so a loop can never trap the canvas. Use it for a short cycle worth watching twice; a long walkthrough is better played once.

```json
{ "clear": true,
  "nodes": [{"id":"api","label":"API"},{"id":"db","label":"Postgres"}],
  "edges": [{"id":"q","from":"api","to":"db","label":"query"}],
  "steps": [
    {"focus":["api"],"pulse":["api"],"caption":"A request lands on the API","hold":900},
    {"flow":["q"],"caption":"…which reads from Postgres"},
    {"nodes":[{"id":"cache","label":"Redis","color":"green"}],
     "edges":[{"from":"api","to":"cache"}],
     "caption":"Add a cache in front"}
  ]}
```

The whole diagram is laid out once up front, so boxes introduced by a later step land in their final spot instead of shuffling everything. Layout still applies inside steps, so keep omitting `x`/`y`.

Animation is viewer-local: only the state the timeline ends in is saved and synced. Someone opening the canvas later sees the finished diagram, not the replay — so the diagram must make sense standing still. The panel keeps a **Replay** button for the most recent animated spec, which rebuilds only the shapes that spec owns (anything the user drew themselves survives), so it is worth mentioning the button when you animate something. Keep timelines short (under ~10 steps); the user cannot pause or scrub yet.

## Reading the canvas

`canvas_read` returns what is on the board right now: node ids, labels, colors, sizes and positions, the arrows between them, floating text, anything the user drew or moved by hand, and an **Overlapping shapes** list when any shapes sit on top of each other.

Call it before touching an existing diagram, whenever the user says "this box", "what I added", or "move that", and after asking them to mark something up. The canvas is shared and editable, so their arrangement is state you should build on, not overwrite.

Overlaps are the main way a canvas turns unreadable. If `canvas_draw` or `canvas_read` reports them, fix them in your next call: redraw the diagram with `clear: true`, or move the offending nodes with explicit `x`/`y`. Do not leave a known overlap on the board.

## Looking at the canvas

`canvas_view` returns a PNG of the whole board. Any open bb window keeps it fresh: the canvas panel if it is open, otherwise a hidden renderer that applies your batches within a few seconds, and the tool waits for that before answering. Use it:

- **After drawing**, to check the result the way the user will see it: do arrows cross boxes, is the flow readable, did a long label make a fat box? Fix what you see with another `canvas_draw`.
- When the user talks about something they drew or arranged by hand and the text from `canvas_read` is not enough.

If `canvas_view` reports batches still queued after its wait, no bb window is connected right now; the picture predates your drawing and you should ask the user to open bb. Node ids are not drawn on the picture, so pair it with `canvas_read` when you need to address a specific node.

## After drawing

**Look before you answer.** Call `canvas_view` after every `canvas_draw`; it waits for the render, so you can call it immediately. Check the picture the way the user will see it: overlapping shapes, labels that wrap or clip, arrows running through boxes, a flow that reads in the wrong direction, a title sitting on top of the diagram. Fix problems with another `canvas_draw` (usually `clear: true` plus the corrected spec, or shorter labels) and look again. One round of fixing is normal; do not ship a diagram you have not seen.

Then put this directive on its own line in your reply so the user gets an open button:

```
::canvas{title="Short diagram title"}
```

The canvas persists per thread and the user can edit it; treat their edits as part of the shared state (do not clear without being asked).

# Canvas

A BB plugin that gives every thread a shared [tldraw](https://tldraw.dev) canvas.
You draw on it, your agents draw on it, and both of you are looking at the same
board.

![The canvas panel with a diagram an agent drew](docs/canvas.png)

## What it does

- **A canvas panel per thread.** Open it from the thread's panel menu. It
  persists per thread, syncs across every client you have open (desktop, phone,
  a `bb connect` tunnel), and it is a full tldraw editor — draw, drag, annotate.
- **Agents draw on it.** The `canvas_draw` tool takes a small spec of nodes,
  edges and text. Boxes are sized to fit their labels and laid out
  automatically in layers that follow the arrows, so agents do not have to
  invent coordinates (and stop producing overlapping diagrams when they try).
- **Agents animate it.** A spec can carry `steps`: a timeline that adds shapes,
  slides boxes to new positions, flies the camera, pulses a node, sends a dot
  down an arrow and narrates each beat. Playback is local to whoever is
  watching; only the finished diagram is saved. The panel keeps a **Replay**
  button.
- **Diagrams do not pile up.** A batch whose node ids are all new is placed
  below whatever is already on the board; a batch that re-sends existing ids
  slots its new nodes in next to them. Agents are told which of the two just
  happened, and to use `clear: true` when a drawing is meant to replace the
  last one.
- **Agents can look at it.** `canvas_view` returns a PNG of the board so an
  agent can check its own drawing the way you see it. The panel exports one
  every time it saves; when no panel is open, a hidden renderer in any open bb
  window applies queued batches and exports the image within a few seconds.
- **Agents read it back.** `canvas_read` returns what is on the board right
  now — including the shapes *you* added or moved, and a list of any shapes
  that overlap — so a diagram is a conversation rather than a one-way render.

## Install

```sh
bb plugin install canvas
```

Or from a checkout:

```sh
bb plugin install /path/to/bb-plugin-canvas
```

## Using it

Ask for a picture: *"draw the request path"*, *"show me how these services
talk"*, *"animate what happens when a job fails"*. The bundled `canvas` skill
teaches agents the spec, the layout rules and the animation timeline.

By default nothing nags agents to use the canvas — the skill loads when it is
relevant. If you would rather every thread be told to prefer the canvas over
ASCII or Mermaid diagrams:

```sh
bb plugin config canvas set suggestEverywhere true
```

## How it fits together

- `server.ts` — queues each drawing batch per thread in the plugin's SQLite
  database, stores the canvas snapshot, registers the `canvas_draw`,
  `canvas_read` and `canvas_view` agent tools, and publishes realtime signals.
- `app.tsx` — the panel: a tldraw editor that applies queued batches, saves
  snapshots back, and reconciles concurrent edits from other clients.
- `headless.tsx` — a content script that keeps an off-screen tldraw editor in
  every bb window and renders queued batches for threads whose panel is closed.
- `persist.ts` — what both renderers save: the document, the overlap lint and
  the PNG for `canvas_view`.
- `layout.ts` — the layered auto-layout that places nodes and sizes boxes.
- `canvas-lint.ts` — finds overlapping shapes after every change; the result is
  saved with the snapshot and reported back to agents.
- `animate.ts` — timeline playback (steps, camera, pulses, flow dots, loops).
- `canvas-read.ts` — turns a stored snapshot into text an agent can read.
- `skills/canvas/SKILL.md` — how agents are taught to use all of the above.

## Data and network

Your diagrams stay on your machine: every canvas lives in this plugin's local
SQLite database (`<bb data dir>/plugins/canvas/data.db`) and is never uploaded.
The plugin itself has no server of its own and sends nothing anywhere.

The bundled tldraw editor does make requests, and you should know about them:

- **Editor assets** — tldraw loads its fonts, icons, translations and embed
  icons from `https://cdn.tldraw.com/<tldraw-version>/…` whenever the panel is
  open. These are plain static asset requests; they carry no canvas content,
  but like any request they expose your IP address and the tldraw version to
  that CDN. There is currently no way to turn this off short of self-hosting
  the asset bundle.
- **Usage reporting** — tldraw pings `cdn.tldraw.com/watermarks/watermark-track.svg`
  with the page URL, tldraw version, environment and license id when it is
  running unlicensed in production, on an evaluation license, or licensed with
  a watermark. On a local BB (`http://…` or loopback) tldraw is in development
  mode and this never fires. On a non-local https origin, this panel refuses to
  mount the editor unless you have configured a license key, so it does not
  fire there either — see below.

## Licensing

This plugin's own code is MIT (see `LICENSE`).

It bundles the tldraw SDK, which is **not** open source. tldraw is distributed
under the [tldraw license](https://github.com/tldraw/tldraw/blob/main/LICENSE.md),
a verbatim copy of which is included as `LICENSE-tldraw.md`. In short: you may
use and modify it for development, and it may be bundled inside another
application, but production use requires a license from tldraw, and the
"made with tldraw" watermark must stay in place. If you are using this
commercially, talk to [tldraw](https://tldraw.dev) about a license.

What that means in practice: tldraw treats `http://` origins and https on
loopback as development and runs for free. Any other origin — for example a BB
you reach over a shared https URL — is "production", and an unlicensed editor
there is replaced by a hidden element five seconds after it loads. Rather than
let the canvas silently vanish, this panel detects that case and shows an
explanation instead of mounting tldraw at all. If you have a key, set it:

```sh
bb plugin config canvas set tldrawLicenseKey "tldraw-…"
```

The key is a signed, origin-bound token that tldraw intends to ship in client
bundles, so the panel receives it like any other setting. Be aware that a
licensed-with-watermark or evaluation key re-enables tldraw's usage reporting
described above.

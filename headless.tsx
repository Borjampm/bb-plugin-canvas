// Headless renderer: applies queued drawing batches when nobody has the
// canvas panel open.
//
// The panel renders agent batches into tldraw shapes, but only while it is
// mounted. Without it a batch sits in the queue, the snapshot goes stale and
// canvas_view has nothing fresh to show. This content script runs in every
// bb window or tab as long as bb is open, keeps one tldraw editor mounted
// off-screen, and works through queued batches for *any* thread: load that
// thread's snapshot, apply the batches (final state, no animation), save the
// snapshot, lint and PNG, mark the batches applied.
//
// It talks to the plugin server over the same fetch-based RPC the SDK hooks
// use, because content scripts run outside the React tree those hooks need.
// Realtime signals are likewise unavailable here, so it polls: a small
// sqlite query every few seconds, and only when the tab is visible.
//
// A batch is left alone for one poll interval after it is first seen, so an
// open panel — which applies immediately — nearly always wins. If both do
// apply, the deterministic shape ids make the result identical.
import { StrictMode, useCallback, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Tldraw, allDefaultFontFaces, getSnapshot, loadSnapshot, type Editor } from "tldraw";
import type { PluginAppBuilder } from "@get-bb/plugin-sdk/app";
import { applyDrawSpec } from "./canvas-apply";
import { mergedSpec } from "./animate";
import { persistCanvas, type RpcCall } from "./persist";
import { drawSpecSchema } from "./spec";

const PLUGIN_ID = "canvas";
const POLL_MS = 3000;
/** Off-screen editor size: big enough that zoomToFit leaves shapes legible. */
const STAGE_W = 1400;
const STAGE_H = 900;

/** Same transport as the SDK's useRpc, without the hook. */
const rpc: RpcCall = async (method, input) => {
  const res = await fetch(
    `/api/v1/plugins/${encodeURIComponent(PLUGIN_ID)}/rpc/${encodeURIComponent(method)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input ?? null),
    },
  );
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: unknown; error?: { message?: string } }
    | null;
  if (!res.ok || body?.ok !== true) {
    throw new Error(body?.error?.message ?? `rpc "${method}" failed (HTTP ${res.status})`);
  }
  return body.result;
};

/** Mirrors the panel's check: tldraw is free on http:// and https loopback. */
function isDevelopmentOrigin(): boolean {
  const { protocol, hostname } = window.location;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.endsWith(".localhost")) return false;
  if (protocol === "http:") return true;
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  return protocol === "https:" && loopback;
}

type HeadlessState = { licenseKey: string | null; pendingThreads: string[] };
type CanvasGet = {
  snapshot: string | null;
  pending: { rev: number; spec: string }[];
};

function HeadlessRenderer({
  licenseKey,
  signal,
}: {
  licenseKey: string | null;
  signal: AbortSignal;
}) {
  const editorRef = useRef<Editor | null>(null);
  const blank = useRef<ReturnType<typeof getSnapshot>["document"] | null>(null);
  const clientId = useRef(`headless-${Math.random().toString(36).slice(2)}`);
  /** Resolves once tldraw's fonts are in: label boxes measured before that
   * use a fallback font and end up too small for the real one. */
  const fontsReady = useRef<Promise<unknown>>(Promise.resolve());
  /** Threads seen pending on the previous poll: eligible this time round. */
  const seen = useRef(new Set<string>());
  const busy = useRef(false);

  const renderThread = useCallback(async (editor: Editor, threadId: string) => {
    const state = (await rpc("canvas_get", { threadId })) as CanvasGet;
    if (state.pending.length === 0) return; // a panel got there first
    await fontsReady.current;
    // Start from that thread's saved document, or a pristine one.
    if (blank.current) loadSnapshot(editor.store, { document: blank.current });
    if (state.snapshot) {
      try {
        const parsed = JSON.parse(state.snapshot);
        loadSnapshot(editor.store, { document: parsed.document ?? parsed });
      } catch {
        // corrupt snapshot: draw onto a blank board, as the panel would
      }
    }
    let applied = 0;
    for (const entry of state.pending) {
      try {
        const spec = drawSpecSchema.parse(JSON.parse(entry.spec));
        // No viewer, so no animation: land the timeline's final state.
        applyDrawSpec(editor, mergedSpec(spec));
      } catch {
        // malformed batch: skip it, like the panel does
      }
      applied = entry.rev;
    }
    await persistCanvas(editor, rpc, threadId, clientId.current);
    if (applied > 0) await rpc("canvas_mark_applied", { threadId, rev: applied });
  }, []);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped || busy.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const editor = editorRef.current;
      if (!editor) return;
      busy.current = true;
      try {
        const state = (await rpc("canvas_headless_state", {})) as HeadlessState;
        const now = new Set(state.pendingThreads);
        for (const threadId of now) {
          if (stopped) break;
          if (!seen.current.has(threadId)) continue; // give a panel a chance
          try {
            await renderThread(editor, threadId);
          } catch (err) {
            console.warn(`canvas headless renderer: thread ${threadId} failed`, err);
          }
        }
        seen.current = now;
      } catch {
        // server unreachable: try again next tick
      } finally {
        busy.current = false;
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    void tick();
    const stop = () => {
      stopped = true;
      clearInterval(timer);
    };
    signal.addEventListener("abort", stop, { once: true });
    return () => {
      stop();
      signal.removeEventListener("abort", stop);
    };
  }, [signal, renderThread]);

  return (
    <Tldraw
      hideUi
      onMount={(editor) => {
        editorRef.current = editor;
        blank.current = getSnapshot(editor.store).document;
        fontsReady.current = Promise.allSettled(
          allDefaultFontFaces.map((font) => editor.fonts.ensureFontIsLoaded(font)),
        );
      }}
      {...(licenseKey ? { licenseKey } : {})}
    />
  );
}

export function registerHeadlessRenderer(app: PluginAppBuilder) {
  app.contentScripts.register({
    id: "headless-renderer",
    async mount(context) {
      if (typeof document === "undefined") return;
      let licenseKey: string | null = null;
      try {
        licenseKey = ((await rpc("canvas_headless_state", {})) as HeadlessState).licenseKey;
      } catch {
        // no server yet: fall through with no key
      }
      // Unlicensed on a production origin: tldraw would hide itself and
      // report the page URL. The panel refuses to mount there; so do we.
      if (!isDevelopmentOrigin() && !licenseKey) return;
      if (context.signal.aborted) return;

      const host = document.createElement("div");
      host.setAttribute("data-bb-canvas-headless", "");
      host.setAttribute("aria-hidden", "true");
      // Off-screen but laid out: display:none would leave tldraw with no
      // geometry to export. opacity keeps it from ever flashing into view.
      Object.assign(host.style, {
        position: "fixed",
        left: "-20000px",
        top: "0",
        width: `${STAGE_W}px`,
        height: `${STAGE_H}px`,
        opacity: "0",
        pointerEvents: "none",
        overflow: "hidden",
      } as Partial<CSSStyleDeclaration>);
      document.body.appendChild(host);
      const root = createRoot(host);
      root.render(
        <StrictMode>
          <HeadlessRenderer licenseKey={licenseKey} signal={context.signal} />
        </StrictMode>,
      );
      return () => {
        root.unmount();
        host.remove();
      };
    },
  });
}

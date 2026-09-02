// bb-plugin-canvas frontend: a per-thread canvas panel + a message directive
// that gives the reader an "open canvas" button.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import {
  Tldraw,
  getSnapshot,
  loadSnapshot,
  type Editor,
} from "tldraw";
import "tldraw/tldraw.css";
import { Button } from "@/components/ui/button";
import { applyDrawSpec } from "./canvas-apply";
import { playDrawSpec } from "./animate";
import { drawSpecSchema, type DrawSpec } from "./spec";
import type { rpcContract } from "./server";

const CANVAS_CHANGED = "canvas-changed";
const CANVAS_SAVED = "canvas-saved";

/** tldraw treats http:// and https:// loopback as development (free); every
 * other origin is production and needs a license key, or tldraw replaces the
 * editor with a hidden element five seconds in. We mirror that test so we can
 * explain the situation instead of letting the canvas silently vanish — and
 * so an unlicensed production origin never mounts tldraw at all, which is
 * also what stops tldraw's unlicensed-usage beacon (it reports the page URL
 * to cdn.tldraw.com) from ever firing. */
function isTldrawDevelopmentOrigin() {
  if (typeof window === "undefined") return true;
  const { protocol, hostname } = window.location;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // tldraw short-circuits on *.localhost and calls it production in a
  // production build, so we must too — even over http.
  if (host.endsWith(".localhost")) return false;
  if (protocol === "http:") return true;
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  return protocol === "https:" && loopback;
}

/** Shown instead of the editor when tldraw cannot legally run on this origin.
 * `reason` distinguishes "no key at all" from "tldraw rejected the key". */
function LicenseNotice({ reason }: { reason: "missing" | "rejected" }) {
  const host = typeof window === "undefined" ? "this origin" : window.location.hostname;
  return (
    <div className="mx-auto flex h-full max-w-sm flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
      <p className="font-medium text-foreground">Canvas needs a tldraw license here</p>
      {reason === "missing" ? (
        <p>
          tldraw is free on local origins, but you are on{" "}
          <span className="font-mono">{host}</span>, which tldraw treats as
          production. It would hide the editor a few seconds after it loaded, so the
          canvas is not started here.
        </p>
      ) : (
        <p>
          tldraw rejected the configured license key for{" "}
          <span className="font-mono">{host}</span> — keys are tied to the hosts they
          were issued for, and they expire.
        </p>
      )}
      <p>
        A{" "}
        <a
          className="underline"
          href="https://tldraw.dev/get-a-license/hobby"
          target="_blank"
          rel="noreferrer"
        >
          free hobby licence
        </a>{" "}
        covers non-commercial use (with a "made with tldraw" watermark). Register{" "}
        <span className="font-mono">{host}</span> as the domain, then run:
      </p>
      <code className="rounded bg-muted px-2 py-1 text-xs text-foreground">
        bb plugin config canvas set tldrawLicenseKey "…"
      </code>
      <p>Your diagrams are stored locally and are not lost — open BB on the machine itself to keep drawing.</p>
    </div>
  );
}

function CanvasPanel({ threadId }: { threadId: string; params: unknown }) {
  const rpc = useRpc<typeof rpcContract>();
  const editorRef = useRef<Editor | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<(() => void) | null>(null);
  // True while we replace the store with a snapshot another client saved.
  // Those changes must NOT re-trigger our own save, or two open clients
  // ping-pong save→reload→save forever and the canvas thrashes.
  const applyingRemote = useRef(false);
  // True while an animated spec is playing. Tweens, travelling dots and the
  // shapes they leave mid-flight are viewer-local: they must not be saved or
  // clobbered by a remote reload until the timeline lands.
  const animating = useRef(false);
  const playToken = useRef(0);
  const [caption, setCaption] = useState<string | null>(null);
  // The last animated spec drawn here, kept so the viewer can replay it long
  // after the batch was applied.
  const [animation, setAnimation] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  // Set when tldraw swaps the editor for its hidden license gate: the key we
  // passed was not valid for this origin.
  const [licenseRejected, setLicenseRejected] = useState(false);
  const frame = useRef<HTMLDivElement | null>(null);
  const clientId = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `c-${Math.random().toString(36).slice(2)}`,
  );
  const [initial, setInitial] = useState<{
    snapshot: string | null;
    pending: { rev: number; spec: string }[];
    animation: string | null;
    licenseKey: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpc.call("canvas_get", { threadId }).then((result) => {
      if (cancelled) return;
      setInitial(result);
      setAnimation(result.animation);
    });
    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      playToken.current++; // stop any timeline still playing
      // Flush a debounced save synchronously so switching tabs/threads
      // never drops the last edits.
      pendingSave.current?.();
    };
  }, [threadId]);

  // Every animated run goes through here: one token so a newer run (or a
  // teardown) stops the previous one, and one flag so no tween is ever saved.
  const play = useCallback(
    async (editor: Editor, spec: DrawSpec, replay = false) => {
      const token = ++playToken.current;
      animating.current = true;
      setPlaying(true);
      try {
        await playDrawSpec(editor, spec, {
          cancelled: () => playToken.current !== token || editorRef.current !== editor,
          onCaption: setCaption,
          replay,
        });
      } finally {
        if (playToken.current === token) {
          animating.current = false;
          setPlaying(false);
        }
      }
    },
    [],
  );

  const applyPending = useCallback(
    async (editor: Editor, pending: { rev: number; spec: string }[]) => {
      let applied = 0;
      for (const entry of pending) {
        try {
          const spec = drawSpecSchema.parse(JSON.parse(entry.spec));
          if (spec.steps && spec.steps.length > 0) {
            setAnimation(entry.spec);
            await play(editor, spec);
          } else {
            applyDrawSpec(editor, spec);
          }
          applied = entry.rev;
        } catch {
          applied = entry.rev; // skip a malformed batch, never replay it forever
        }
      }
      if (applied > 0) void rpc.call("canvas_mark_applied", { threadId, rev: applied });
    },
    [threadId, play],
  );

  const scheduleSave = useCallback(
    (editor: Editor) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const save = () => {
        pendingSave.current = null;
        try {
          // Document only: the session (camera, selection) is per-device
          // state and must never travel between clients.
          const { document } = getSnapshot(editor.store);
          void rpc.call("canvas_save_snapshot", {
            threadId,
            snapshot: JSON.stringify({ document }),
            clientId: clientId.current,
          });
        } catch {
          // editor already disposed during teardown: nothing to flush
        }
      };
      pendingSave.current = save;
      saveTimer.current = setTimeout(save, 800);
    },
    [threadId],
  );

  // Apply a batch and persist whatever it ends up drawing — once, after any
  // animation has finished.
  const applyAndSave = useCallback(
    (editor: Editor, pending: { rev: number; spec: string }[]) => {
      void applyPending(editor, pending).then(() => {
        if (editorRef.current === editor) scheduleSave(editor);
      });
    },
    [applyPending, scheduleSave],
  );

  // Realtime signals are ephemeral: after a reconnect (e.g. remote/mobile
  // viewing), pull any batches queued while we were offline.
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (!wasConnected.current) {
      wasConnected.current = true;
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    void rpc.call("canvas_get", { threadId }).then(({ pending }) => {
      if (pending.length > 0) applyAndSave(editor, pending);
    });
  }, [connection, threadId, applyAndSave]);

  // Mobile browsers freeze/kill background pages without unmounting React,
  // so flush the debounced save the moment the page is hidden.
  useEffect(() => {
    const flush = () => {
      if (typeof document === "undefined" || document.visibilityState === "hidden") {
        pendingSave.current?.();
      }
    };
    const onPageHide = () => pendingSave.current?.();
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  // Another client (e.g. the desktop window while drawing on the phone)
  // saved this canvas: reload it instead of overwriting it with stale state
  // on our next local save. Skip while we have unsaved local edits.
  useRealtime(CANVAS_SAVED, (payload) => {
    const editor = editorRef.current;
    if (!editor) return;
    const p = payload as { threadId?: string; clientId?: string | null };
    if (p?.threadId !== threadId || p?.clientId === clientId.current) return;
    if (pendingSave.current || animating.current) return;
    void rpc.call("canvas_get", { threadId }).then(({ snapshot }) => {
      if (!snapshot || pendingSave.current) return;
      // Never replace the store mid-gesture: the next save signal retries.
      if (editor.inputs.isPointing || editor.inputs.isDragging) return;
      applyingRemote.current = true;
      try {
        const parsed = JSON.parse(snapshot);
        const camera = editor.getCamera();
        loadSnapshot(editor.store, { document: parsed.document ?? parsed });
        editor.setCamera(camera);
      } catch {
        // corrupt snapshot: keep current state
      } finally {
        applyingRemote.current = false;
      }
    });
  });

  useRealtime(CANVAS_CHANGED, (payload) => {
    const editor = editorRef.current;
    if (!editor) return;
    const p = payload as { threadId?: string };
    if (p?.threadId !== threadId) return;
    void rpc.call("canvas_get", { threadId }).then(({ pending }) => {
      if (pending.length > 0) applyAndSave(editor, pending);
    });
  });

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;
      if (initial?.snapshot) {
        try {
          const parsed = JSON.parse(initial.snapshot);
          loadSnapshot(editor.store, { document: parsed.document ?? parsed });
        } catch {
          // corrupt snapshot: start blank
        }
      }
      if (initial && initial.pending.length > 0) applyAndSave(editor, initial.pending);
      editor.zoomToFit();
      editor.store.listen(
        () => {
          if (!applyingRemote.current && !animating.current) scheduleSave(editor);
        },
        { scope: "document", source: "user" },
      );
    },
    [initial, applyAndSave, scheduleSave],
  );

  const replay = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !animation) return;
    if (playing) {
      playToken.current++; // stop: the run's finally leaves the diagram whole
      return;
    }
    try {
      const spec = drawSpecSchema.parse(JSON.parse(animation));
      void play(editor, spec, true).then(() => {
        if (editorRef.current === editor) scheduleSave(editor);
      });
    } catch {
      setAnimation(null); // unparseable: stop offering it
    }
  }, [animation, playing, play, scheduleSave]);

  // A key can still be wrong: issued for another host, or expired. tldraw
  // reacts by replacing the editor with a hidden element ~5s in, which looks
  // exactly like the bug we just fixed. Watch for that element and explain.
  useEffect(() => {
    if (!initial?.licenseKey || isTldrawDevelopmentOrigin()) return;
    let stop = false;
    const deadline = Date.now() + 15000;
    const tick = () => {
      if (stop) return;
      if (frame.current?.querySelector('[data-testid="tl-license-expired"]')) {
        setLicenseRejected(true);
        return;
      }
      if (Date.now() < deadline) setTimeout(tick, 500);
    };
    const timer = setTimeout(tick, 500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [initial?.licenseKey]);

  if (!initial) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading canvas…
      </div>
    );
  }

  // Unlicensed on a production origin: mounting tldraw here would show the
  // editor for five seconds and then hide it, and would report this page's
  // URL to tldraw. Say so instead. Everything already drawn is safe in the
  // plugin's database and shows up as soon as you open BB locally or add a key.
  if (!isTldrawDevelopmentOrigin() && (!initial.licenseKey || licenseRejected)) {
    return <LicenseNotice reason={initial.licenseKey ? "rejected" : "missing"} />;
  }

  return (
    <div className="h-full w-full" ref={frame} style={{ position: "relative" }}>
      <Tldraw
        key={threadId}
        onMount={handleMount}
        colorScheme="system"
        {...(initial.licenseKey ? { licenseKey: initial.licenseKey } : {})}
      />
      {animation ? (
        <Button
          size="sm"
          variant="secondary"
          className="absolute right-3 top-3 z-[400] gap-1.5 shadow-md"
          onClick={replay}
        >
          {playing ? "Stop" : "Replay"}
        </Button>
      ) : null}
      {/* Narration for the playing step. Top-centre: the bottom of the canvas
          belongs to tldraw's own toolbar. */}
      {caption ? (
        <div
          className="pointer-events-none absolute left-1/2 top-4 z-[400] -translate-x-1/2 rounded-md bg-foreground/85 px-3 py-1.5 text-center text-sm text-background shadow-lg"
          style={{ maxWidth: "80%" }}
        >
          {caption}
        </div>
      ) : null}
    </div>
  );
}

function OpenCanvasDirective({
  attributes,
}: {
  attributes: Readonly<Record<string, string>>;
}) {
  const navigate = useBbNavigate();
  const title =
    typeof attributes.title === "string" && attributes.title.trim().length > 0
      ? attributes.title.trim().slice(0, 80)
      : "Canvas";
  return (
    <div className="my-2 flex items-center gap-3 rounded-lg border border-border bg-card p-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs text-muted-foreground">
          The agent drew on this thread's canvas
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          navigate.openThreadPanel({ actionId: "canvas", title });
        }}
      >
        Open canvas
      </Button>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "canvas",
    title: "Canvas",
    icon: "PenTool",
    layout: "flush",
    component: CanvasPanel,
  });
  app.slots.messageDirective({
    id: "canvas",
    component: OpenCanvasDirective,
  });
});

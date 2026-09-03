// What both renderers (the visible panel and the headless one) save after a
// change: the tldraw document, the overlap lint, and a PNG for canvas_view.
// The RPC transport differs (the panel has the SDK hook, the content script
// only has fetch), so callers pass a `call` function.
import { getSnapshot, type Editor } from "tldraw";
import { lintCanvas } from "./canvas-lint";

/** Longest side, in px, of the PNG exported for agents. */
export const IMAGE_MAX_SIDE = 1500;
export const IMAGE_PADDING = 32;

export type RpcCall = (method: string, input: unknown) => Promise<unknown>;

/** Serialize the document (not the session: camera/selection are per-device). */
export function documentSnapshot(editor: Editor): string {
  const { document } = getSnapshot(editor.store);
  return JSON.stringify({ document });
}

/** Overlap findings, or [] when the lint itself fails (it is advisory). */
export function safeLint(editor: Editor): string[] {
  try {
    return lintCanvas(editor);
  } catch {
    return [];
  }
}

/**
 * PNG of every shape on the page, scaled so the long side is about
 * IMAGE_MAX_SIDE: enough to read labels, small enough to send to a model.
 * Returns null for an empty board.
 */
export async function exportImage(
  editor: Editor,
): Promise<{ png: string; width: number; height: number } | null> {
  const ids = [...editor.getCurrentPageShapeIds()];
  if (ids.length === 0) return null;
  // Text is measured with whatever font is available: a freshly mounted
  // (headless) editor has not fetched tldraw's fonts yet, and labels sized
  // with the fallback font wrap wrongly in the export. Load them first and
  // let the label sizes settle.
  try {
    await editor.fonts.loadRequiredFontsForCurrentPage();
    await new Promise((resolve) => setTimeout(resolve, 150));
  } catch {
    // no font access: export with what we have
  }
  const bounds = editor.getCurrentPageBounds();
  const longest = bounds ? Math.max(bounds.width, bounds.height) + 2 * IMAGE_PADDING : 1;
  const scale = Math.min(1, IMAGE_MAX_SIDE / longest);
  const { url, width, height } = await editor.toImageDataUrl(ids, {
    format: "png",
    scale,
    pixelRatio: 1,
    background: true,
    darkMode: false,
    padding: IMAGE_PADDING,
  });
  const comma = url.indexOf(",");
  return { png: comma >= 0 ? url.slice(comma + 1) : url, width, height };
}

/** Save the snapshot + lint now, then the image once it has rendered. */
export async function persistCanvas(
  editor: Editor,
  call: RpcCall,
  threadId: string,
  clientId: string,
): Promise<void> {
  await call("canvas_save_snapshot", {
    threadId,
    snapshot: documentSnapshot(editor),
    clientId,
    lint: safeLint(editor),
  });
  try {
    const image = await exportImage(editor);
    await call(
      "canvas_save_image",
      image
        ? { threadId, ...image }
        : { threadId, png: null, width: 0, height: 0 },
    );
  } catch {
    // the image is a convenience for the agent: never fail a save over it
  }
}

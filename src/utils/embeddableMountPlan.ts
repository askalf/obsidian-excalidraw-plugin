/**
 * Mount-time host selection for embedded files.
 *
 * A subpath embed (a back-of-the-note section or a block reference) can only be
 * rendered section-scoped by a native Canvas node. A workspace leaf always
 * renders the whole file, which for a hybrid drawing is the entire drawing.
 * `CanvasNodeFactory` initializes asynchronously on layout ready, so an
 * embeddable can mount before the factory is usable; these helpers let the
 * caller wait for it instead of silently mounting the wrong host.
 */

/** Minimal `CanvasNodeFactory` surface needed to decide when a node can be created. */
export interface CanvasNodeHost {
  isInitialized: () => boolean;
}

export const CANVAS_NODE_HOST_WAIT_INTERVAL_MS = 25;
export const CANVAS_NODE_HOST_WAIT_TIMEOUT_MS = 2000;

/**
 * Decides whether an embeddable must be hosted by a native Canvas node.
 *
 * @param subpath - Section or block reference of the link, null when absent.
 * @param fileExtension - Extension of the embedded file.
 * @returns True when only a Canvas node can render the requested section.
 * @remarks
 * Any non-empty subpath counts, including a bare `#`, matching the previous
 * inline truthiness check at the call site.
 */
export function requiresCanvasNodeHost(
  subpath: string | null | undefined,
  fileExtension: string | null | undefined,
): boolean {
  return Boolean(subpath) && (fileExtension?.toLowerCase?.() ?? "") === "md";
}

/**
 * Waits for the Canvas node factory to finish its asynchronous initialization.
 *
 * @param getHost - Reads the factory on each poll; it may be absent at first
 * and may be torn down while waiting, so it is re-read rather than captured.
 * @param isCancelled - Signals that the embeddable unmounted; stops the wait.
 * @param timeoutMs - Upper bound on the wait before the caller falls back.
 * @param intervalMs - Delay between polls.
 * @returns True when the factory became usable, false on cancel or timeout.
 */
export async function awaitCanvasNodeHost(
  getHost: () => CanvasNodeHost | null | undefined,
  isCancelled: () => boolean = () => false,
  timeoutMs: number = CANVAS_NODE_HOST_WAIT_TIMEOUT_MS,
  intervalMs: number = CANVAS_NODE_HOST_WAIT_INTERVAL_MS,
  delay: (ms: number) => Promise<void> = sleep,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isCancelled()) {
      return false;
    }
    if (getHost()?.isInitialized()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(intervalMs);
  }
}

/** Host chosen for an embeddable, or "none" when the embeddable unmounted first. */
export type EmbeddableMountHost = "canvas-node" | "workspace-leaf" | "none";

/** Collaborators the mount dispatch needs; injected so the decision stays testable. */
export interface EmbeddableMountOptions {
  subpath: string | null | undefined;
  fileExtension: string | null | undefined;
  getHost: () => CanvasNodeHost | null | undefined;
  isCancelled?: () => boolean;
  createCanvasNode: () => void;
  createWorkspaceLeaf: () => void;
  timeoutMs?: number;
  intervalMs?: number;
  delay?: (ms: number) => Promise<void>;
}

/**
 * Mounts an embeddable into the host that can actually render it.
 *
 * @param options - Link details and the two mount actions.
 * @returns The host that was used, for logging and tests.
 * @remarks
 * A subpath embed waits for the Canvas node factory rather than falling through
 * to a workspace leaf, which would render the whole file instead of the linked
 * section. The workspace leaf remains the fallback when the factory never
 * initializes, preserving the previous behavior for that case.
 */
export async function mountEmbeddableHost(
  options: EmbeddableMountOptions,
): Promise<EmbeddableMountHost> {
  const {
    subpath,
    fileExtension,
    getHost,
    isCancelled = () => false,
    createCanvasNode,
    createWorkspaceLeaf,
    timeoutMs,
    intervalMs,
    delay,
  } = options;

  if (!requiresCanvasNodeHost(subpath, fileExtension)) {
    if (isCancelled()) {
      return "none";
    }
    createWorkspaceLeaf();
    return "workspace-leaf";
  }

  if (getHost()?.isInitialized()) {
    createCanvasNode();
    return "canvas-node";
  }

  const ready = await awaitCanvasNodeHost(
    getHost,
    isCancelled,
    timeoutMs,
    intervalMs,
    delay,
  );
  if (isCancelled()) {
    return "none";
  }
  if (ready) {
    createCanvasNode();
    return "canvas-node";
  }
  createWorkspaceLeaf();
  return "workspace-leaf";
}

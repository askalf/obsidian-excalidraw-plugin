import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  awaitCanvasNodeHost,
  mountEmbeddableHost,
  requiresCanvasNodeHost,
} = await jiti.import("../src/utils/embeddableMountPlan.ts");

const log = (message) => process.stdout.write(`${message}\n`);

// The module under test defaults its wait to Obsidian's `sleep` global, which
// does not exist here; every call below injects a delay instead.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Canvas node factory that reports ready after a given number of polls. */
const hostReadyAfter = (polls) => {
  const host = {
    reads: 0,
    isInitialized: () => {
      host.reads += 1;
      return host.reads > polls;
    },
  };
  return host;
};

/** Records which host the dispatch mounted, mirroring the two call-site actions. */
const mountRecorder = (overrides = {}) => {
  const calls = { canvasNodes: 0, workspaceLeaves: 0 };
  return {
    calls,
    options: {
      subpath: "#Section",
      fileExtension: "md",
      getHost: () => ({ isInitialized: () => true }),
      createCanvasNode: () => {
        calls.canvasNodes += 1;
      },
      createWorkspaceLeaf: () => {
        calls.workspaceLeaves += 1;
      },
      timeoutMs: 200,
      intervalMs: 1,
      delay,
      ...overrides,
    },
  };
};

//--------------------------------------------------------------------------------
//requiresCanvasNodeHost: which embeds can only be rendered by a Canvas node
//--------------------------------------------------------------------------------

assert.equal(
  requiresCanvasNodeHost("#Section", "md"),
  true,
  "a markdown subpath embed requires a canvas node host",
);
assert.equal(
  requiresCanvasNodeHost("#Section", "MD"),
  true,
  "an uppercase markdown extension still requires a canvas node host",
);
assert.equal(
  requiresCanvasNodeHost("#^blockid", "md"),
  true,
  "a block reference subpath requires a canvas node host",
);
assert.equal(
  requiresCanvasNodeHost(null, "md"),
  false,
  "a whole-file markdown embed does not require a canvas node host",
);
assert.equal(
  requiresCanvasNodeHost("", "md"),
  false,
  "an empty subpath does not require a canvas node host",
);
assert.equal(
  requiresCanvasNodeHost("#page=2", "pdf"),
  false,
  "a subpath on a non-markdown file does not require a canvas node host",
);
assert.equal(
  requiresCanvasNodeHost("#Section", undefined),
  false,
  "a subpath on a file without an extension does not require a canvas node host",
);

//--------------------------------------------------------------------------------
//awaitCanvasNodeHost: waiting out the factory's asynchronous initialization
//--------------------------------------------------------------------------------

{
  const host = hostReadyAfter(0);
  assert.equal(
    await awaitCanvasNodeHost(() => host, () => false, 1000, 1, delay),
    true,
    "an already initialized factory is accepted",
  );
  assert.equal(host.reads, 1, "an initialized factory is read exactly once");
}

{
  const host = hostReadyAfter(3);
  assert.equal(
    await awaitCanvasNodeHost(() => host, () => false, 1000, 1, delay),
    true,
    "a factory that initializes late is awaited rather than skipped",
  );
  assert.ok(host.reads > 1, "a late factory is polled more than once");
}

{
  let host = null;
  setTimeout(() => {
    host = { isInitialized: () => true };
  }, 5);
  assert.equal(
    await awaitCanvasNodeHost(() => host, () => false, 1000, 1, delay),
    true,
    "a factory absent at mount time is re-read until it appears",
  );
}

assert.equal(
  await awaitCanvasNodeHost(
    () => ({ isInitialized: () => false }),
    () => false,
    20,
    1,
    delay,
  ),
  false,
  "a factory that never initializes times out so the caller can fall back",
);

{
  let unmounted = false;
  setTimeout(() => {
    unmounted = true;
  }, 5);
  assert.equal(
    await awaitCanvasNodeHost(
      () => ({ isInitialized: () => false }),
      () => unmounted,
      5000,
      1,
      delay,
    ),
    false,
    "an embeddable that unmounts while waiting cancels the wait",
  );
}

{
  const host = hostReadyAfter(0);
  assert.equal(
    await awaitCanvasNodeHost(() => host, () => true, 1000, 1, delay),
    false,
    "an already unmounted embeddable stops before mounting",
  );
  assert.equal(
    host.reads,
    0,
    "an already unmounted embeddable never reads the factory",
  );
}

//--------------------------------------------------------------------------------
//mountEmbeddableHost: the dispatch the embeddable mount effect calls. #2931
//--------------------------------------------------------------------------------

{
  const host = hostReadyAfter(4);
  const { options, calls } = mountRecorder({ getHost: () => host });
  assert.equal(
    await mountEmbeddableHost(options),
    "canvas-node",
    "a subpath embed mounting before the factory is ready still gets a canvas node",
  );
  assert.equal(
    calls.workspaceLeaves,
    0,
    "a workspace leaf renders the whole drawing instead of the linked section",
  );
  assert.equal(calls.canvasNodes, 1);
}

{
  let host = null;
  setTimeout(() => {
    host = { isInitialized: () => true };
  }, 5);
  const { options, calls } = mountRecorder({ getHost: () => host });
  assert.equal(
    await mountEmbeddableHost(options),
    "canvas-node",
    "a subpath embed whose factory appears only after mount still gets a canvas node",
  );
  assert.equal(calls.workspaceLeaves, 0);
}

{
  const host = hostReadyAfter(4);
  const { options, calls } = mountRecorder({
    subpath: "#^blockid",
    getHost: () => host,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "canvas-node",
    "a block reference embed mounting before the factory is ready gets a canvas node",
  );
  assert.equal(calls.workspaceLeaves, 0);
}

{
  const { options, calls } = mountRecorder();
  assert.equal(
    await mountEmbeddableHost(options),
    "canvas-node",
    "a subpath embed with a ready factory mounts a canvas node (control)",
  );
  assert.equal(calls.canvasNodes, 1);
  assert.equal(calls.workspaceLeaves, 0);
}

{
  const { options, calls } = mountRecorder({
    getHost: () => ({ isInitialized: () => false }),
    timeoutMs: 20,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "workspace-leaf",
    "a subpath embed falls back to a workspace leaf when the factory never initializes",
  );
  assert.equal(calls.workspaceLeaves, 1);
  assert.equal(calls.canvasNodes, 0);
}

{
  const host = hostReadyAfter(0);
  const { options, calls } = mountRecorder({
    subpath: null,
    getHost: () => host,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "workspace-leaf",
    "a whole-file embed mounts a workspace leaf (control)",
  );
  assert.equal(calls.workspaceLeaves, 1);
  assert.equal(host.reads, 0, "a whole-file embed must not wait on the factory");
}

{
  const host = hostReadyAfter(0);
  const { options, calls } = mountRecorder({
    subpath: "#page=2",
    fileExtension: "pdf",
    getHost: () => host,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "workspace-leaf",
    "a non-markdown subpath embed mounts a workspace leaf (control)",
  );
  assert.equal(calls.workspaceLeaves, 1);
  assert.equal(host.reads, 0);
}

{
  let unmounted = false;
  setTimeout(() => {
    unmounted = true;
  }, 5);
  const { options, calls } = mountRecorder({
    getHost: () => ({ isInitialized: () => false }),
    isCancelled: () => unmounted,
    timeoutMs: 5000,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "none",
    "an embeddable unmounted while waiting mounts nothing",
  );
  assert.equal(calls.canvasNodes, 0);
  assert.equal(
    calls.workspaceLeaves,
    0,
    "an unmounted embeddable must not mount a leaf into a detached container",
  );
}

{
  const { options, calls } = mountRecorder({
    subpath: null,
    isCancelled: () => true,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "none",
    "an already unmounted whole-file embed mounts nothing",
  );
  assert.equal(calls.workspaceLeaves, 0);
}

log("embeddable mount plan checks passed");

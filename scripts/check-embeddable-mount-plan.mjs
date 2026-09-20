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

//--------------------------------------------------------------------------------
//Boundaries the rows above reach only by argument: zero and nullish inputs, the
//exact deadline, and the synchrony the mount effect depends on.
//--------------------------------------------------------------------------------

{
  //timeoutMs = 0 is falsy-but-valid. `Date.now() >= deadline` (not `>`) is what
  //makes it terminate; a `>` would spin forever on a factory that never readies.
  let reads = 0;
  const started = Date.now();
  assert.equal(
    await awaitCanvasNodeHost(
      () => ({
        isInitialized: () => {
          reads += 1;
          return false;
        },
      }),
      () => false,
      0,
      25,
      delay,
    ),
    false,
    "a zero timeout gives up instead of looping forever",
  );
  assert.equal(reads, 1, "a zero timeout still checks readiness exactly once");
  assert.ok(
    Date.now() - started < 25,
    "a zero timeout returns without waiting out a poll interval",
  );
}

{
  //A zero timeout must not discard a factory that is already usable.
  const host = hostReadyAfter(0);
  assert.equal(
    await awaitCanvasNodeHost(() => host, () => false, 0, 25, delay),
    true,
    "a zero timeout still accepts a factory that is already initialized",
  );
}

assert.equal(
  requiresCanvasNodeHost(undefined, "md"),
  false,
  "an undefined subpath does not require a canvas node host",
);
assert.equal(
  requiresCanvasNodeHost("#Section", null),
  false,
  "a null extension does not require a canvas node host",
);

{
  //`getHost()` returning null forever must time out rather than throw: the
  //optional call is the only thing standing between a torn-down view and a
  //TypeError inside the poll loop.
  assert.equal(
    await awaitCanvasNodeHost(() => null, () => false, 20, 1, delay),
    false,
    "a factory that never appears times out instead of throwing",
  );
}

{
  //The factory can be torn down mid-wait (view closed while the poll runs).
  let host = { isInitialized: () => false };
  setTimeout(() => {
    host = null;
  }, 3);
  assert.equal(
    await awaitCanvasNodeHost(() => host, () => false, 30, 1, delay),
    false,
    "a factory that disappears mid-wait times out instead of throwing",
  );
}

{
  //The mount effect is synchronous up to its first await, and the base code
  //mounted both hosts before returning. Neither fast path may become deferred:
  //the effect's cleanup runs against whatever these calls have already created.
  const order = [];
  const pending = mountEmbeddableHost({
    subpath: "#Section",
    fileExtension: "md",
    getHost: () => ({ isInitialized: () => true }),
    createCanvasNode: () => order.push("canvas-node"),
    createWorkspaceLeaf: () => order.push("workspace-leaf"),
    delay,
  });
  order.push("effect-returned");
  assert.equal(await pending, "canvas-node");
  assert.deepEqual(
    order,
    ["canvas-node", "effect-returned"],
    "a ready factory mounts the canvas node before the mount effect returns",
  );
}

{
  const order = [];
  const pending = mountEmbeddableHost({
    subpath: null,
    fileExtension: "md",
    getHost: () => ({ isInitialized: () => true }),
    createCanvasNode: () => order.push("canvas-node"),
    createWorkspaceLeaf: () => order.push("workspace-leaf"),
    delay,
  });
  order.push("effect-returned");
  assert.equal(await pending, "workspace-leaf");
  assert.deepEqual(
    order,
    ["workspace-leaf", "effect-returned"],
    "a whole-file embed mounts its leaf before the mount effect returns",
  );
}

{
  //The call site cancels on `!leafRef.current || !containerRef.current`, which
  //the effect cleanup nulls. Cancellation is read again after the wait, so a
  //teardown that lands while the factory is initializing mounts nothing even
  //though the factory did become ready.
  let torndown = false;
  const host = {
    isInitialized: () => torndown,
  };
  setTimeout(() => {
    torndown = true;
  }, 5);
  const { options, calls } = mountRecorder({
    getHost: () => host,
    isCancelled: () => torndown,
    timeoutMs: 500,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "none",
    "a teardown landing as the factory readies mounts nothing",
  );
  assert.equal(
    calls.canvasNodes,
    0,
    "a canvas node must not be created into a container the cleanup already released",
  );
  assert.equal(calls.workspaceLeaves, 0);
}

{
  //Several embeddables mount concurrently in one drawing; each dispatch owns
  //its own wait and must reach its own host.
  const hosts = [hostReadyAfter(3), hostReadyAfter(1), hostReadyAfter(6)];
  const recorders = hosts.map((host) =>
    mountRecorder({ getHost: () => host, timeoutMs: 500 }),
  );
  const results = await Promise.all(
    recorders.map(({ options }) => mountEmbeddableHost(options)),
  );
  assert.deepEqual(
    results,
    ["canvas-node", "canvas-node", "canvas-node"],
    "concurrent embeddables each wait out the factory independently",
  );
  for (const { calls } of recorders) {
    assert.equal(calls.canvasNodes, 1);
    assert.equal(calls.workspaceLeaves, 0);
  }
}

log("embeddable mount plan checks passed");

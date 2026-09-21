import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  CANVAS_NODE_HOST_WAIT_TIMEOUT_MS,
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

//--------------------------------------------------------------------------------
//The factory's lifecycle, not the clock, decides how long a subpath embed waits.
//Startup can legitimately outrun any fixed cap: layout ready polls up to
//50 x 50 ms before initialize() is called, and initialize() then awaits the core
//canvas plugin's load. A host that reports whenInitialized is waited on through
//that signal; the cap survives only for a host that reports nothing.
//--------------------------------------------------------------------------------

/** Factory that reports its lifecycle and readies when the returned hook is run. */
const lifecycleHost = () => {
  let settle;
  const host = {
    reads: 0,
    initialized: false,
    isInitialized: () => {
      host.reads += 1;
      return host.initialized;
    },
    whenInitialized: new Promise((resolve) => {
      settle = resolve;
    }),
    ready: () => {
      host.initialized = true;
      settle(true);
    },
    /** initialize() threw, or destroy() ran: it will never host a node. */
    givesUp: () => {
      host.initialized = false;
      settle(false);
    },
  };
  return host;
};

{
  //The review's case, at the real default cap: a factory that becomes usable
  //well after CANVAS_NODE_HOST_WAIT_TIMEOUT_MS must still get its canvas node,
  //because the whole point of the wait is the slow-startup path.
  const host = lifecycleHost();
  const readyAt = CANVAS_NODE_HOST_WAIT_TIMEOUT_MS + 150;
  setTimeout(() => host.ready(), readyAt);
  const started = Date.now();
  const { options, calls } = mountRecorder({
    getHost: () => host,
    timeoutMs: undefined,
    intervalMs: 25,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "canvas-node",
    "a factory that initializes after the default cap still mounts a canvas node",
  );
  assert.equal(calls.canvasNodes, 1);
  assert.equal(
    calls.workspaceLeaves,
    0,
    "a slow startup must not fall back to the whole-file workspace leaf",
  );
  assert.ok(
    Date.now() - started >= CANVAS_NODE_HOST_WAIT_TIMEOUT_MS,
    "the wait really did outlast the cap rather than readying early",
  );
}

{
  //The same shape with a short cap, so the discrimination is pinned twice: the
  //cap expires long before readiness and must not end the wait.
  const host = lifecycleHost();
  setTimeout(() => host.ready(), 60);
  const { options, calls } = mountRecorder({
    getHost: () => host,
    timeoutMs: 5,
    intervalMs: 1,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "canvas-node",
    "an expired cap does not end a wait on a factory that is still initializing",
  );
  assert.equal(calls.canvasNodes, 1);
  assert.equal(calls.workspaceLeaves, 0);
}

{
  //The fallback survives, on the signal instead of the clock: a factory whose
  //initialize() threw settles false and the embed takes the old leaf path.
  const host = lifecycleHost();
  setTimeout(() => host.givesUp(), 5);
  const { options, calls } = mountRecorder({
    getHost: () => host,
    timeoutMs: 5000,
    intervalMs: 1,
  });
  const started = Date.now();
  assert.equal(
    await mountEmbeddableHost(options),
    "workspace-leaf",
    "a factory that reports it will not initialize falls back at once",
  );
  assert.equal(calls.workspaceLeaves, 1);
  assert.equal(calls.canvasNodes, 0);
  assert.ok(
    Date.now() - started < 5000,
    "the fallback is taken on the signal, not by waiting out the cap",
  );
}

{
  //destroy() settles the lifecycle true-then-destroyed is impossible, but a
  //factory that initialized and was torn down in the same turn still reports
  //true on the promise; the re-read is what stops a node going into a dead
  //factory.
  const host = lifecycleHost();
  setTimeout(() => {
    host.ready();
    host.initialized = false; //destroy() ran right behind initialize()
  }, 5);
  const { options, calls } = mountRecorder({
    getHost: () => host,
    timeoutMs: 5000,
    intervalMs: 1,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "workspace-leaf",
    "a factory destroyed as it settled cannot host a canvas node",
  );
  assert.equal(calls.canvasNodes, 0);
  assert.equal(calls.workspaceLeaves, 1);
}

{
  //Cancellation must stay observable while waiting on the lifecycle: the poll
  //interval races the promise precisely so an unmount is still noticed.
  const host = lifecycleHost();
  let torndown = false;
  setTimeout(() => {
    torndown = true;
  }, 5);
  const { options, calls } = mountRecorder({
    getHost: () => host,
    isCancelled: () => torndown,
    timeoutMs: 5000,
    intervalMs: 1,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "none",
    "an embeddable unmounted while waiting on the lifecycle mounts nothing",
  );
  assert.equal(calls.canvasNodes, 0);
  assert.equal(calls.workspaceLeaves, 0);
}

{
  //A host that reports no lifecycle keeps the bounded wait: the cap is the
  //floor for a factory that cannot say when it is done (control).
  const { options, calls } = mountRecorder({
    getHost: () => ({ isInitialized: () => false }),
    timeoutMs: 20,
    intervalMs: 1,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "workspace-leaf",
    "a factory without a lifecycle signal still falls back at the cap (control)",
  );
  assert.equal(calls.workspaceLeaves, 1);
  assert.equal(calls.canvasNodes, 0);
}

{
  //A lifecycle that already settled true is honoured on the first poll rather
  //than waiting out an interval.
  const host = lifecycleHost();
  host.ready();
  const { options, calls } = mountRecorder({
    getHost: () => host,
    timeoutMs: 5000,
    intervalMs: 1000,
  });
  const started = Date.now();
  assert.equal(await mountEmbeddableHost(options), "canvas-node");
  assert.equal(calls.canvasNodes, 1);
  assert.ok(
    Date.now() - started < 1000,
    "an already settled lifecycle does not wait out a poll interval",
  );
}

//--------------------------------------------------------------------------------
//Cancellation latches per dispatch. The call site's signal reads shared refs,
//which a replacement mount repopulates, so a superseded wait would otherwise
//see itself live again and mount over the host the replacement just created.
//--------------------------------------------------------------------------------

{
  const host = lifecycleHost();
  let live = true;
  setTimeout(() => {
    live = false; //React cleanup for this invocation nulls the refs
  }, 5);
  setTimeout(() => {
    live = true; //the replacement invocation repopulates the same refs
    host.ready();
  }, 15);
  const { options, calls } = mountRecorder({
    getHost: () => host,
    isCancelled: () => !live,
    timeoutMs: 5000,
    intervalMs: 1,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "none",
    "a dispatch cancelled mid-wait stays cancelled when the refs come back",
  );
  assert.equal(
    calls.canvasNodes,
    0,
    "a superseded wait must not create a node over the replacement's host",
  );
  assert.equal(calls.workspaceLeaves, 0);
}

{
  //The same latch on the workspace-leaf route: a whole-file embed whose refs
  //were released and repopulated is still a superseded dispatch.
  let live = true;
  const { options, calls } = mountRecorder({
    subpath: null,
    getHost: () => ({ isInitialized: () => false }),
    isCancelled: () => {
      const wasLive = live;
      live = !live; //flips to cancelled on the first read, live again on the next
      return !wasLive;
    },
    timeoutMs: 20,
    intervalMs: 1,
  });
  live = false;
  assert.equal(
    await mountEmbeddableHost(options),
    "none",
    "a cancelled whole-file dispatch does not mount a leaf",
  );
  assert.equal(calls.workspaceLeaves, 0);
  assert.equal(calls.canvasNodes, 0);
}

{
  //Link changed while the first mount was waiting: only the replacement mounts.
  //Both dispatches share the refs, as the two effect invocations do.
  const host = lifecycleHost();
  const mounted = [];
  const refs = { live: true };
  const first = mountEmbeddableHost({
    subpath: "#A",
    fileExtension: "md",
    getHost: () => host,
    isCancelled: () => !refs.live,
    createCanvasNode: () => mounted.push("#A"),
    createWorkspaceLeaf: () => mounted.push("#A-leaf"),
    timeoutMs: 5000,
    intervalMs: 1,
    delay,
  });
  await delay(5);
  refs.live = false; //cleanup of the #A invocation
  await delay(5);
  refs.live = true; //setup of the #B invocation
  host.ready();
  const second = await mountEmbeddableHost({
    subpath: "#B",
    fileExtension: "md",
    getHost: () => host,
    isCancelled: () => !refs.live,
    createCanvasNode: () => mounted.push("#B"),
    createWorkspaceLeaf: () => mounted.push("#B-leaf"),
    timeoutMs: 5000,
    intervalMs: 1,
    delay,
  });
  assert.equal(second, "canvas-node", "the replacement takes the fast path");
  assert.equal(
    await first,
    "none",
    "the superseded dispatch reports it mounted nothing",
  );
  assert.deepEqual(
    mounted,
    ["#B"],
    "only the current link is mounted; the superseded wait must not replace it",
  );
}

{
  //Control: a dispatch that is never cancelled is unaffected by the latch.
  const host = lifecycleHost();
  setTimeout(() => host.ready(), 5);
  const { options, calls } = mountRecorder({
    getHost: () => host,
    isCancelled: () => false,
    timeoutMs: 5000,
    intervalMs: 1,
  });
  assert.equal(
    await mountEmbeddableHost(options),
    "canvas-node",
    "an uncancelled dispatch still mounts its canvas node (control)",
  );
  assert.equal(calls.canvasNodes, 1);
}

{
  //awaitCanvasNodeHost is reached by the dispatch above, but it is exported and
  //its own latch is what the dispatch relies on: once cancelled, a later live
  //read does not resurrect the wait.
  const host = lifecycleHost();
  let live = true;
  setTimeout(() => {
    live = false;
  }, 5);
  setTimeout(() => {
    live = true;
    host.ready();
  }, 15);
  assert.equal(
    await awaitCanvasNodeHost(
      () => host,
      () => !live,
      5000,
      1,
      delay,
    ),
    false,
    "a cancelled wait does not resume when the caller's signal reads live again",
  );
}

log("embeddable mount plan checks passed");

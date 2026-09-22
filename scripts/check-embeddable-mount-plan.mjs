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

//The module defaults its wait to Obsidian's `sleep` global, absent here.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

//Each block is independent: on an arm that reintroduces a defect, a failing
//block must not hide the blocks after it.
const blocks = [];
const block = (name, fn) => blocks.push([name, fn]);

const hostReadyOnRead = (read) => {
  const host = {
    reads: 0,
    isInitialized: () => {
      host.reads += 1;
      return host.reads >= read;
    },
  };
  return host;
};

const unreadyHost = { isInitialized: () => false };

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
    //initialize() threw, or destroy() ran: it will never host a node.
    givesUp: () => {
      host.initialized = false;
      settle(false);
    },
  };
  return host;
};

//Cancellation as React drives it: live at setup, cancelled on the poll that
//observes this invocation's cleanup, then live again because the replacement
//invocation repopulated the very same refs. Read-counted, so it is
//deterministic and models a signal that can go back to reporting live.
const cancelledOnRead = (read) => {
  let reads = 0;
  return () => {
    reads += 1;
    return reads === read;
  };
};

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

block("only a markdown subpath embed requires a canvas node host", () => {
  for (const [subpath, extension, required] of [
    ["#Section", "md", true],
    ["#Section", "MD", true],
    ["#^blockid", "md", true],
    ["#", "md", true],
    [null, "md", false],
    ["", "md", false],
    [undefined, "md", false],
    ["#page=2", "pdf", false],
    ["#Section", undefined, false],
    ["#Section", null, false],
    ["#Section", "", false],
  ]) {
    assert.equal(
      requiresCanvasNodeHost(subpath, extension),
      required,
      `subpath ${JSON.stringify(subpath)} on ${JSON.stringify(extension)}`,
    );
  }
});

//--------------------------------------------------------------------------------
//awaitCanvasNodeHost: waiting out the factory's asynchronous initialization
//--------------------------------------------------------------------------------

block("an initialized factory is accepted on the first read", async () => {
  const host = hostReadyOnRead(1);
  assert.equal(
    await awaitCanvasNodeHost(() => host, () => false, 1000, 1, delay),
    true,
  );
  assert.equal(host.reads, 1);
});

block("a factory that initializes late is awaited", async () => {
  const host = hostReadyOnRead(4);
  assert.equal(
    await awaitCanvasNodeHost(() => host, () => false, 1000, 1, delay),
    true,
  );
  assert.equal(host.reads, 4);
});

block("a factory absent at mount time is re-read until it appears", async () => {
  let reads = 0;
  const getHost = () => {
    reads += 1;
    return reads < 3 ? null : { isInitialized: () => true };
  };
  assert.equal(await awaitCanvasNodeHost(getHost, () => false, 1000, 1, delay), true);
});

block("a factory that never initializes times out", async () => {
  assert.equal(await awaitCanvasNodeHost(() => unreadyHost, () => false, 20, 1, delay), false);
});

block("a factory that never appears times out instead of throwing", async () => {
  //The optional call on getHost() is all that stands between a torn-down view
  //and a TypeError inside the poll loop.
  assert.equal(await awaitCanvasNodeHost(() => null, () => false, 20, 1, delay), false);
});

block("a factory that disappears mid-wait times out instead of throwing", async () => {
  let reads = 0;
  const getHost = () => {
    reads += 1;
    return reads < 3 ? unreadyHost : null;
  };
  assert.equal(await awaitCanvasNodeHost(getHost, () => false, 30, 1, delay), false);
});

block("an embeddable that unmounts while waiting cancels the wait", async () => {
  assert.equal(
    await awaitCanvasNodeHost(() => unreadyHost, cancelledOnRead(3), 5000, 1, delay),
    false,
  );
});

block("an already unmounted embeddable never reads the factory", async () => {
  const host = hostReadyOnRead(1);
  assert.equal(await awaitCanvasNodeHost(() => host, () => true, 1000, 1, delay), false);
  assert.equal(host.reads, 0);
});

block("a zero timeout gives up after one read rather than looping", async () => {
  //timeoutMs = 0 is falsy but valid; `Date.now() >= deadline`, not `>`, is what
  //makes it terminate.
  const host = hostReadyOnRead(Number.MAX_SAFE_INTEGER);
  const started = Date.now();
  assert.equal(await awaitCanvasNodeHost(() => host, () => false, 0, 25, delay), false);
  assert.equal(host.reads, 1);
  assert.ok(Date.now() - started < 25, "it returned without waiting out a poll interval");
});

block("a zero timeout still accepts an initialized factory", async () => {
  assert.equal(
    await awaitCanvasNodeHost(() => hostReadyOnRead(1), () => false, 0, 25, delay),
    true,
  );
});

//--------------------------------------------------------------------------------
//mountEmbeddableHost: the dispatch the embeddable mount effect calls
//--------------------------------------------------------------------------------

block("a subpath embed mounting before the factory is ready gets a node", async () => {
  for (const subpath of ["#Section", "#^blockid"]) {
    const host = hostReadyOnRead(5);
    const { options, calls } = mountRecorder({ subpath, getHost: () => host });
    assert.equal(await mountEmbeddableHost(options), "canvas-node", subpath);
    assert.equal(calls.canvasNodes, 1, subpath);
    assert.equal(
      calls.workspaceLeaves,
      0,
      `a workspace leaf renders the whole drawing instead of ${subpath}`,
    );
  }
});

block("a subpath embed whose factory appears only after mount gets a node", async () => {
  let reads = 0;
  const { options, calls } = mountRecorder({
    getHost: () => {
      reads += 1;
      return reads < 3 ? null : { isInitialized: () => true };
    },
  });
  assert.equal(await mountEmbeddableHost(options), "canvas-node");
  assert.equal(calls.workspaceLeaves, 0);
});

block("a subpath embed with a ready factory mounts a node", async () => {
  const { options, calls } = mountRecorder();
  assert.equal(await mountEmbeddableHost(options), "canvas-node");
  assert.equal(calls.canvasNodes, 1);
  assert.equal(calls.workspaceLeaves, 0);
});

block("a subpath embed falls back when the factory never initializes", async () => {
  const { options, calls } = mountRecorder({
    getHost: () => unreadyHost,
    timeoutMs: 20,
  });
  assert.equal(await mountEmbeddableHost(options), "workspace-leaf");
  assert.equal(calls.workspaceLeaves, 1);
  assert.equal(calls.canvasNodes, 0);
});

block("an embed that needs no node mounts a leaf without waiting", async () => {
  for (const [subpath, fileExtension] of [
    [null, "md"],
    ["#page=2", "pdf"],
  ]) {
    const host = hostReadyOnRead(1);
    const { options, calls } = mountRecorder({
      subpath,
      fileExtension,
      getHost: () => host,
    });
    assert.equal(await mountEmbeddableHost(options), "workspace-leaf", fileExtension);
    assert.equal(calls.workspaceLeaves, 1, fileExtension);
    assert.equal(host.reads, 0, `${fileExtension} must not wait on the factory`);
  }
});

block("an embeddable unmounted while waiting mounts nothing", async () => {
  const { options, calls } = mountRecorder({
    getHost: () => unreadyHost,
    isCancelled: cancelledOnRead(3),
    timeoutMs: 5000,
  });
  assert.equal(await mountEmbeddableHost(options), "none");
  assert.equal(calls.canvasNodes, 0);
  assert.equal(
    calls.workspaceLeaves,
    0,
    "it must not mount a leaf into a container the cleanup released",
  );
});

block("an already unmounted whole-file embed mounts nothing", async () => {
  const { options, calls } = mountRecorder({ subpath: null, isCancelled: () => true });
  assert.equal(await mountEmbeddableHost(options), "none");
  assert.equal(calls.workspaceLeaves, 0);
});

block("a teardown landing as the factory readies mounts nothing", async () => {
  //Cancellation is read again after the wait, so a teardown that lands while
  //the factory is initializing mounts nothing even though it did become ready.
  let torndown = false;
  const host = { isInitialized: () => torndown };
  const { options, calls } = mountRecorder({
    getHost: () => host,
    isCancelled: () => {
      torndown = true;
      return torndown;
    },
    timeoutMs: 500,
  });
  assert.equal(await mountEmbeddableHost(options), "none");
  assert.equal(calls.canvasNodes, 0);
  assert.equal(calls.workspaceLeaves, 0);
});

block("a ready factory mounts its host before the effect returns", async () => {
  //The mount effect is synchronous up to its first await, so neither fast path
  //may become deferred: the effect's cleanup runs against whatever these calls
  //have already created.
  for (const [subpath, expected] of [
    ["#Section", "canvas-node"],
    [null, "workspace-leaf"],
  ]) {
    const order = [];
    const pending = mountEmbeddableHost({
      subpath,
      fileExtension: "md",
      getHost: () => ({ isInitialized: () => true }),
      createCanvasNode: () => order.push("canvas-node"),
      createWorkspaceLeaf: () => order.push("workspace-leaf"),
      delay,
    });
    order.push("effect-returned");
    assert.equal(await pending, expected);
    assert.deepEqual(order, [expected, "effect-returned"]);
  }
});

block("concurrent embeddables each wait out the factory independently", async () => {
  const recorders = [5, 2, 7].map((read) => {
    const host = hostReadyOnRead(read);
    return mountRecorder({ getHost: () => host, timeoutMs: 500 });
  });
  const results = await Promise.all(
    recorders.map(({ options }) => mountEmbeddableHost(options)),
  );
  assert.deepEqual(results, ["canvas-node", "canvas-node", "canvas-node"]);
  for (const { calls } of recorders) {
    assert.equal(calls.canvasNodes, 1);
    assert.equal(calls.workspaceLeaves, 0);
  }
});

//--------------------------------------------------------------------------------
//The factory's lifecycle, not the clock, decides how long a subpath embed waits.
//Startup can legitimately outrun any fixed cap: layout ready polls up to
//50 x 50 ms before initialize() is called, and initialize() then awaits the core
//canvas plugin's load. A host reporting whenInitialized is waited on through
//that signal; the cap survives only for a host that reports nothing.
//check-canvas-node-factory-lifecycle.mjs drives the same arm through the real
//factory; these blocks pin the inputs it cannot produce.
//--------------------------------------------------------------------------------

block("readiness after the default cap still mounts a node", async () => {
  //Elapsed time is the property under test here: readiness lands strictly
  //after the real default bound, and the outcome must still be the node.
  const host = lifecycleHost();
  setTimeout(() => host.ready(), CANVAS_NODE_HOST_WAIT_TIMEOUT_MS + 150);
  const started = Date.now();
  const { options, calls } = mountRecorder({
    getHost: () => host,
    timeoutMs: undefined,
    intervalMs: 25,
  });
  assert.equal(await mountEmbeddableHost(options), "canvas-node");
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
});

block("an expired cap does not end a wait on a starting factory", async () => {
  const host = lifecycleHost();
  const { options, calls } = mountRecorder({
    getHost: () => host,
    isCancelled: () => {
      //Ready on a later poll, so the cap has expired many times over by then.
      host.reads >= 5 && host.ready();
      return false;
    },
    timeoutMs: 5,
  });
  assert.equal(await mountEmbeddableHost(options), "canvas-node");
  assert.equal(calls.canvasNodes, 1);
  assert.equal(calls.workspaceLeaves, 0);
});

block("a factory that reports it will not initialize falls back", async () => {
  const host = lifecycleHost();
  const { options, calls } = mountRecorder({
    getHost: () => host,
    isCancelled: () => {
      host.givesUp();
      return false;
    },
    timeoutMs: 5000,
  });
  const started = Date.now();
  assert.equal(await mountEmbeddableHost(options), "workspace-leaf");
  assert.equal(calls.workspaceLeaves, 1);
  assert.equal(calls.canvasNodes, 0);
  assert.ok(
    Date.now() - started < 1000,
    "the fallback is taken on the signal, not by waiting out the cap",
  );
});

block("a factory destroyed as it settled cannot host a node", async () => {
  //Settling true and being destroyed in the same turn: the read after the
  //signal is the only thing that catches it.
  const host = lifecycleHost();
  const { options, calls } = mountRecorder({
    getHost: () => host,
    isCancelled: () => {
      host.ready();
      host.initialized = false;
      return false;
    },
    timeoutMs: 5000,
  });
  assert.equal(await mountEmbeddableHost(options), "workspace-leaf");
  assert.equal(calls.canvasNodes, 0);
  assert.equal(calls.workspaceLeaves, 1);
});

block("an embeddable unmounted while waiting on the lifecycle mounts nothing", async () => {
  //Racing the lifecycle against the poll interval is what keeps an unmount
  //observable while waiting on a promise that may never settle.
  const host = lifecycleHost();
  const { options, calls } = mountRecorder({
    getHost: () => host,
    isCancelled: cancelledOnRead(3),
    timeoutMs: 5000,
  });
  assert.equal(await mountEmbeddableHost(options), "none");
  assert.equal(calls.canvasNodes, 0);
  assert.equal(calls.workspaceLeaves, 0);
});

block("a factory reporting no lifecycle still falls back at the cap", async () => {
  const { options, calls } = mountRecorder({ getHost: () => unreadyHost, timeoutMs: 20 });
  assert.equal(await mountEmbeddableHost(options), "workspace-leaf");
  assert.equal(calls.workspaceLeaves, 1);
  assert.equal(calls.canvasNodes, 0);
});

block("an already initialized factory mounts without consulting the lifecycle", async () => {
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
  assert.ok(Date.now() - started < 1000, "it did not wait out a poll interval");
});

//--------------------------------------------------------------------------------
//Cancellation latches per dispatch. The call site's signal reads leafRef and
//containerRef, which the replacement invocation of the mount effect repopulates,
//so a superseded wait would otherwise see itself live again after the poll that
//observed the cleanup, and mount over the host the replacement just created.
//--------------------------------------------------------------------------------

block("a dispatch cancelled mid-wait stays cancelled when the refs come back", async () => {
  const { options, calls } = mountRecorder({
    getHost: () => unreadyHost,
    isCancelled: cancelledOnRead(2),
    timeoutMs: 5000,
  });
  assert.equal(await mountEmbeddableHost(options), "none");
  assert.equal(
    calls.workspaceLeaves,
    0,
    "a superseded wait must not mount a whole-file leaf over the replacement",
  );
  assert.equal(calls.canvasNodes, 0);
});

block("a superseded wait creates no node once the factory readies", async () => {
  const host = lifecycleHost();
  const { options, calls } = mountRecorder({
    getHost: () => host,
    isCancelled: (() => {
      const cancelled = cancelledOnRead(2);
      return () => {
        const value = cancelled();
        host.reads >= 2 && host.ready();
        return value;
      };
    })(),
    timeoutMs: 5000,
  });
  assert.equal(await mountEmbeddableHost(options), "none");
  assert.equal(calls.canvasNodes, 0);
  assert.equal(calls.workspaceLeaves, 0);
});

block("only the current link is mounted when it changes mid-wait", async () => {
  //The replacement's setup lands while the superseded wait is still polling,
  //with the factory usable by then, so it takes the fast path.
  const host = lifecycleHost();
  const mounted = [];
  let replacement;
  const first = mountEmbeddableHost({
    subpath: "#A",
    fileExtension: "md",
    getHost: () => host,
    isCancelled: (() => {
      const cancelled = cancelledOnRead(2);
      return () => {
        const value = cancelled();
        if (value && replacement === undefined) {
          host.ready();
          replacement = mountEmbeddableHost({
            subpath: "#B",
            fileExtension: "md",
            getHost: () => host,
            isCancelled: () => false,
            createCanvasNode: () => mounted.push("#B"),
            createWorkspaceLeaf: () => mounted.push("#B-leaf"),
            timeoutMs: 5000,
            intervalMs: 1,
            delay,
          });
        }
        return value;
      };
    })(),
    createCanvasNode: () => mounted.push("#A"),
    createWorkspaceLeaf: () => mounted.push("#A-leaf"),
    timeoutMs: 5000,
    intervalMs: 1,
    delay,
  });
  assert.equal(await first, "none", "the superseded dispatch mounted nothing");
  assert.equal(await replacement, "canvas-node", "the replacement took the fast path");
  assert.deepEqual(
    mounted,
    ["#B"],
    "the superseded wait must not replace the current link's host",
  );
});

let failed = 0;
for (const [name, fn] of blocks) {
  try {
    await fn();
    log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    log(`FAIL ${name}: ${error.message.split("\n")[0]}`);
  }
}
if (failed > 0) {
  process.exitCode = 1;
  log(`${failed} of ${blocks.length} embeddable mount plan checks failed`);
} else {
  log("embeddable mount plan checks passed");
}

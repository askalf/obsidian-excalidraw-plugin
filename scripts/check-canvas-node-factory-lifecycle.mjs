// `CanvasNodeFactory.whenInitialized`: the producer side of the mount wait, and
// the real factory driven through the real dispatch. check-embeddable-mount-plan
// covers the consumer through the injected `CanvasNodeHost` interface instead.
//
// The factory imports `obsidian` (types only, `"main": ""`) and
// `utils/obsidianUtils` (which pulls in the whole plugin), so both are aliased
// to the stub module next to this file. The lifecycle, the promise and the
// dispatch are the shipped code.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const here = path.dirname(fileURLToPath(import.meta.url));
const stubs = path.join(here, "check-canvas-node-factory-lifecycle.stubs.mjs");

const jiti = createJiti(import.meta.url, {
  alias: { obsidian: stubs, "../../utils/obsidianUtils": stubs },
});

//The factory reads this global to tell a main-window split from a popout one.
globalThis.mainDocument = {};

const { CanvasNodeFactory } = await jiti.import(
  "../src/view/managers/CanvasNodeFactory.ts",
);
const { CANVAS_NODE_HOST_WAIT_TIMEOUT_MS, mountEmbeddableHost } =
  await jiti.import("../src/utils/embeddableMountPlan.ts");

const log = (message) => process.stdout.write(`${message}\n`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

//Minimal `ExcalidrawView` stand-in: the members `initialize()` reaches.
const fakeView = ({ loadMs = 0, loadThrows = false } = {}) => ({
  ownerDocument: {},
  app: {
    internalPlugins: {
      plugins: {
        canvas: {
          _loaded: false,
          load: async () => {
            await delay(loadMs);
            if (loadThrows) {
              throw new Error("canvas plugin failed to load");
            }
          },
          views: { canvas: () => ({ canvas: { createFileNode: () => ({}) } }) },
        },
      },
    },
    workspace: {
      rootSplit: {},
      floatingSplit: {},
      createLeafInParent: () => ({}),
    },
  },
});

//Resolves to the promise's value, or to `PENDING` if it has not settled.
const PENDING = Symbol("pending");
const settleWithin = (promise, ms = 50) =>
  Promise.race([promise, delay(ms).then(() => PENDING)]);

//Mount options for a subpath markdown embed hosted by `factory`.
const subpathMountOn = (factory, overrides = {}) => {
  const calls = { canvasNodes: 0, workspaceLeaves: 0 };
  return {
    calls,
    options: {
      subpath: "#Section",
      fileExtension: "md",
      getHost: () => factory,
      createCanvasNode: () => {
        calls.canvasNodes += 1;
      },
      createWorkspaceLeaf: () => {
        calls.workspaceLeaves += 1;
      },
      intervalMs: 5,
      delay,
      ...overrides,
    },
  };
};

//Each block is independent: on an arm that reintroduces a defect, a failing
//block must not hide the blocks after it.
const blocks = [];
const block = (name, fn) => blocks.push([name, fn]);

//--------------------------------------------------------------------------------
//The three sites that settle the lifecycle promise
//--------------------------------------------------------------------------------

block("initialize() that succeeds settles the lifecycle true", async () => {
  const factory = new CanvasNodeFactory(fakeView({ loadMs: 10 }));
  assert.equal(
    await settleWithin(factory.whenInitialized, 5),
    PENDING,
    "the lifecycle must not be settled before initialization finishes",
  );
  await factory.initialize();
  assert.equal(factory.isInitialized(), true);
  assert.equal(
    await settleWithin(factory.whenInitialized),
    true,
    "a successful initialize() must release a waiting mount with true",
  );
});

block("initialize() that throws settles false and rethrows", async () => {
  const factory = new CanvasNodeFactory(fakeView({ loadThrows: true }));
  await assert.rejects(
    () => factory.initialize(),
    /canvas plugin failed to load/,
    "the error must still propagate exactly as it did before the catch existed",
  );
  assert.equal(
    factory.isInitialized(),
    false,
    "a failed initialize() must not report itself initialized",
  );
  assert.equal(
    await settleWithin(factory.whenInitialized),
    false,
    "a failed initialize() must release a waiting mount instead of stranding it",
  );
});

block("destroy() before initialize() settles the lifecycle false", async () => {
  const factory = new CanvasNodeFactory(fakeView({ loadMs: 1000 }));
  factory.destroy();
  assert.equal(
    await settleWithin(factory.whenInitialized),
    false,
    "a view closed before its factory initialized must not strand a mount",
  );
});

block(
  "destroy() after initialize() cannot revise the settled value",
  async () => {
    const factory = new CanvasNodeFactory(fakeView());
    await factory.initialize();
    factory.destroy();
    assert.equal(
      await settleWithin(factory.whenInitialized),
      true,
      "the first terminal state wins; a resolver ignores every later call",
    );
    assert.equal(
      factory.isInitialized(),
      false,
      "destroy() still clears the flag the consumer re-reads after the signal",
    );
  },
);

//--------------------------------------------------------------------------------
//The real factory through the real dispatch
//--------------------------------------------------------------------------------

block("a slow real factory still gets its canvas node", async () => {
  //A cold vault start: the core canvas plugin's load outlasts the cap.
  const factory = new CanvasNodeFactory(
    fakeView({ loadMs: CANVAS_NODE_HOST_WAIT_TIMEOUT_MS + 150 }),
  );
  const { options, calls } = subpathMountOn(factory);
  const started = Date.now();
  const [host] = await Promise.all([
    mountEmbeddableHost(options),
    factory.initialize(),
  ]);
  assert.equal(host, "canvas-node");
  assert.equal(calls.canvasNodes, 1);
  assert.equal(
    calls.workspaceLeaves,
    0,
    "a slow start must not mount the whole-file workspace leaf",
  );
  assert.ok(
    Date.now() - started >= CANVAS_NODE_HOST_WAIT_TIMEOUT_MS,
    "the wait really did outlast the cap rather than readying early",
  );
});

block(
  "a real factory that fails to initialize falls back at once",
  async () => {
    const factory = new CanvasNodeFactory(
      fakeView({ loadMs: 10, loadThrows: true }),
    );
    const { options, calls } = subpathMountOn(factory);
    const started = Date.now();
    const [host] = await Promise.all([
      mountEmbeddableHost(options),
      factory.initialize().catch(() => undefined),
    ]);
    assert.equal(host, "workspace-leaf");
    assert.equal(calls.workspaceLeaves, 1);
    assert.ok(
      Date.now() - started < CANVAS_NODE_HOST_WAIT_TIMEOUT_MS,
      "the failure is known from the lifecycle, so the caller must not wait out the cap",
    );
  },
);

block("a real factory destroyed mid-wait falls back at once", async () => {
  const factory = new CanvasNodeFactory(fakeView({ loadMs: 10_000 }));
  const { options, calls } = subpathMountOn(factory);
  const started = Date.now();
  setTimeout(() => factory.destroy(), 20);
  assert.equal(await mountEmbeddableHost(options), "workspace-leaf");
  assert.equal(calls.canvasNodes, 0, "a destroyed factory must not host a node");
  assert.ok(
    Date.now() - started < CANVAS_NODE_HOST_WAIT_TIMEOUT_MS,
    "destroy() releases the wait, so the caller must not wait out the cap",
  );
});

//--------------------------------------------------------------------------------
//Boundaries of the lifecycle arm of the `whenInitialized !== undefined` dispatch.
//The no-lifecycle arm's cap boundaries are covered in check-embeddable-mount-plan;
//these pin the same inputs on the arm that skips the cap.
//--------------------------------------------------------------------------------

block("a zero cap does not shorten a lifecycle wait", async () => {
  const factory = new CanvasNodeFactory(fakeView({ loadMs: 60 }));
  const { options, calls } = subpathMountOn(factory, { timeoutMs: 0 });
  const [host] = await Promise.all([
    mountEmbeddableHost(options),
    factory.initialize(),
  ]);
  assert.equal(
    host,
    "canvas-node",
    "a factory that reports its lifecycle is waited on however small the cap is",
  );
  assert.equal(calls.workspaceLeaves, 0);
});

block("a negative cap does not shorten a lifecycle wait", async () => {
  //Already expired at the first comparison, so the cap is not merely large
  //enough on this arm but unconsulted.
  const factory = new CanvasNodeFactory(fakeView({ loadMs: 60 }));
  const { options } = subpathMountOn(factory, { timeoutMs: -1 });
  const [host] = await Promise.all([
    mountEmbeddableHost(options),
    factory.initialize(),
  ]);
  assert.equal(host, "canvas-node");
});

block(
  "a lifecycle that never settles waits rather than mis-mounting, and stays cancellable",
  async () => {
    //With a lifecycle present the cap is skipped, so a host that never settles
    //keeps its placeholder rather than falling back to the workspace leaf that
    //renders the whole file. The teardown is what bounds such a wait.
    const neverSettles = {
      isInitialized: () => false,
      whenInitialized: new Promise(() => {}),
    };
    let unmounted = false;
    const { options, calls } = subpathMountOn(neverSettles, {
      timeoutMs: 20,
      isCancelled: () => unmounted,
    });
    const mounting = mountEmbeddableHost(options);
    assert.equal(
      await Promise.race([mounting, delay(120).then(() => "still-waiting")]),
      "still-waiting",
      "an expired cap must not end a wait on a host that has not reported failure",
    );
    assert.equal(
      calls.workspaceLeaves,
      0,
      "an expired cap must not mis-mount a host that has not reported failure",
    );
    unmounted = true;
    assert.equal(
      await mounting,
      "none",
      "the teardown ends the wait the cap no longer bounds",
    );
    assert.equal(calls.canvasNodes, 0);
    assert.equal(calls.workspaceLeaves, 0);
  },
);

block(
  "a view that drops its factory ends even a never-settling wait",
  async () => {
    //`ExcalidrawView.onClose` sets `canvasNodeFactory = null`, and `getHost()`
    //is re-read on every poll, so the cap applies again once no factory is
    //visible even if the embeddable itself never unmounts.
    let factory = {
      isInitialized: () => false,
      whenInitialized: new Promise(() => {}),
    };
    const { options, calls } = subpathMountOn(null, {
      getHost: () => factory,
      timeoutMs: 30,
    });
    setTimeout(() => {
      factory = null;
    }, 80);
    const started = Date.now();
    assert.equal(
      await mountEmbeddableHost(options),
      "workspace-leaf",
      "once no factory is visible the bounded wait resumes and the caller falls back",
    );
    assert.equal(calls.canvasNodes, 0);
    assert.ok(
      Date.now() - started >= 80,
      "the wait lasted until the factory went away, not until the cap expired",
    );
  },
);

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
  log(
    `${failed} of ${blocks.length} canvas node factory lifecycle checks failed`,
  );
} else {
  log("canvas node factory lifecycle checks passed");
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// `mountEmbeddableHost` is only a fix while the embeddable mount effect
// actually dispatches through it. The effect lives in a .tsx that imports the
// types-only `obsidian` package, so it cannot be loaded here; these checks pin
// the wiring at the call site instead. Deleting the dispatch and keeping the
// helper leaves scripts/check-embeddable-mount-plan.mjs green, which is exactly
// the regression this file exists to catch. #2931

const source = await readFile(
  new URL("../src/view/components/CustomEmbeddable.tsx", import.meta.url),
  "utf8",
);

const log = (message) => process.stdout.write(`${message}\n`);

assert.match(
  source,
  /import\s*\{\s*mountEmbeddableHost\s*\}\s*from\s*"src\/utils\/embeddableMountPlan"/,
  "the mount effect must import the mount-plan dispatch",
);

const dispatch = source.match(/mountEmbeddableHost\(\{[\s\S]*?\n\s*\}\);/);
assert.ok(dispatch, "the mount effect must call mountEmbeddableHost");

for (const [option, pattern] of [
  ["subpath", /\bsubpath\s*,/],
  ["fileExtension", /\bfileExtension:\s*file\.extension\s*,/],
  ["getHost", /\bgetHost:\s*\(\)\s*=>\s*view\.canvasNodeFactory\s*,/],
  ["isCancelled", /\bisCancelled:\s*\(\)\s*=>/],
  ["createCanvasNode", /\bcreateCanvasNode:\s*\(\)\s*=>\s*createNode\("markdown"\)\s*,/],
  ["createWorkspaceLeaf", /\bcreateWorkspaceLeaf:\s*/],
]) {
  assert.match(
    dispatch[0],
    pattern,
    `the dispatch must pass ${option} so the helper can decide the host`,
  );
}

assert.doesNotMatch(
  source,
  /subpath\s*&&\s*\n?\s*view\.canvasNodeFactory\.isInitialized\(\)/,
  "readiness must not be conjoined with the subpath test again: a subpath embed that mounts before the factory is ready would fall through to a whole-file workspace leaf",
);

// Re-conjoining the subpath test is only one way to restore the bug. Gating the
// dispatch itself on readiness — `if (view.canvasNodeFactory.isInitialized())
// void mountEmbeddableHost({...})` — reinstates #2931 just as completely while
// leaving every assertion above satisfied, so the dispatch must be reached
// unconditionally. The preceding statement is what decides that: an
// unconditional call follows a closed statement or block (`;`, `{`, `}`), while
// every guard form (`if (...)`, `... &&`, `... ?`) leaves the line open.
const statementsBeforeDispatch = source
  .slice(0, source.indexOf("void mountEmbeddableHost("))
  .split("\n")
  .map((line) => line.replace(/\/\/.*$/, "").trim())
  .filter(Boolean);

assert.match(
  statementsBeforeDispatch[statementsBeforeDispatch.length - 1],
  /[;{}]$/,
  "the mount dispatch must not be guarded on factory readiness: the wait for the factory lives inside mountEmbeddableHost, so a readiness gate in front of it skips the wait and restores the whole-file workspace leaf",
);

// The fallback the timeout relies on must stay reachable from the dispatch
// rather than being inlined back into the removed else branch.
assert.match(
  source,
  /const\s+mountWorkspaceLeaf\s*=\s*\(\)\s*=>\s*\{/,
  "the workspace leaf path must remain a callable the dispatch can fall back to",
);

log("embeddable mount call site checks passed");

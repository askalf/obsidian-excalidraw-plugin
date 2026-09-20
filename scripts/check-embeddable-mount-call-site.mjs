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

// The fallback the timeout relies on must stay reachable from the dispatch
// rather than being inlined back into the removed else branch.
assert.match(
  source,
  /const\s+mountWorkspaceLeaf\s*=\s*\(\)\s*=>\s*\{/,
  "the workspace leaf path must remain a callable the dispatch can fall back to",
);

log("embeddable mount call site checks passed");

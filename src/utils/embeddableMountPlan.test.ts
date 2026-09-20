/**
 * Regression tests for back-of-the-note embeddable host selection (#2931).
 *
 * Run with: node --experimental-strip-types --test src/utils/embeddableMountPlan.test.ts
 *
 * These exercise the mount decision in isolation from Obsidian. The repository
 * has no automated suite, so the module under test is deliberately free of
 * `obsidian` imports and can run under the bundled Node type stripper.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  awaitCanvasNodeHost,
  requiresCanvasNodeHost,
  type CanvasNodeHost,
} from "./embeddableMountPlan.ts";

/** Canvas node factory that reports ready after a given number of polls. */
function hostReadyAfter(polls: number): CanvasNodeHost & { reads: number } {
  const host = {
    reads: 0,
    isInitialized: () => {
      host.reads += 1;
      return host.reads > polls;
    },
  };
  return host;
}

test("a markdown subpath embed requires a canvas node host", () => {
  assert.equal(requiresCanvasNodeHost("#Section", "md"), true);
});

test("an uppercase markdown extension still requires a canvas node host", () => {
  assert.equal(requiresCanvasNodeHost("#Section", "MD"), true);
});

test("a block reference subpath requires a canvas node host", () => {
  assert.equal(requiresCanvasNodeHost("#^blockid", "md"), true);
});

test("a whole-file markdown embed does not require a canvas node host", () => {
  assert.equal(requiresCanvasNodeHost(null, "md"), false);
});

test("an empty subpath does not require a canvas node host", () => {
  assert.equal(requiresCanvasNodeHost("", "md"), false);
});

test("a subpath on a non-markdown file does not require a canvas node host", () => {
  assert.equal(requiresCanvasNodeHost("#page=2", "pdf"), false);
});

test("a subpath on a file without an extension does not require a canvas node host", () => {
  assert.equal(requiresCanvasNodeHost("#Section", undefined), false);
});

test("an already initialized factory is accepted without polling again", async () => {
  const host = hostReadyAfter(0);
  const ready = await awaitCanvasNodeHost(() => host, () => false, 1000, 1);
  assert.equal(ready, true);
  assert.equal(host.reads, 1);
});

test("a factory that initializes late is awaited rather than skipped", async () => {
  const host = hostReadyAfter(3);
  const ready = await awaitCanvasNodeHost(() => host, () => false, 1000, 1);
  assert.equal(ready, true);
  assert.ok(host.reads > 1, "expected the wait to poll more than once");
});

test("a factory absent at mount time is re-read until it appears", async () => {
  let host: CanvasNodeHost | null = null;
  setTimeout(() => {
    host = { isInitialized: () => true };
  }, 5);
  const ready = await awaitCanvasNodeHost(() => host, () => false, 1000, 1);
  assert.equal(ready, true);
});

test("a factory that never initializes times out so the caller can fall back", async () => {
  const host: CanvasNodeHost = { isInitialized: () => false };
  const ready = await awaitCanvasNodeHost(() => host, () => false, 20, 1);
  assert.equal(ready, false);
});

test("an embeddable that unmounts while waiting cancels the wait", async () => {
  const host: CanvasNodeHost = { isInitialized: () => false };
  let unmounted = false;
  setTimeout(() => {
    unmounted = true;
  }, 5);
  const ready = await awaitCanvasNodeHost(() => host, () => unmounted, 5000, 1);
  assert.equal(ready, false);
});

test("an already unmounted embeddable never reads the factory", async () => {
  const host = hostReadyAfter(0);
  const ready = await awaitCanvasNodeHost(() => host, () => true, 1000, 1);
  assert.equal(ready, false);
  assert.equal(host.reads, 0);
});

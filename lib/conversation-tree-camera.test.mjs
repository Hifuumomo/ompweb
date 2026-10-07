import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { zoomTreeCamera, panTreeCamera, treeZoomLimits, wheelTreeScale } = await jiti.import("./conversation-tree-camera.ts");

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}

function assertAnchorPreserved(before, after, anchor) {
  const graphX = (anchor.x - before.x) / before.scale;
  const graphY = (anchor.y - before.y) / before.scale;
  assertClose(after.x + graphX * after.scale, anchor.x);
  assertClose(after.y + graphY * after.scale, anchor.y);
}

test("zoom preserves the graph point beneath an off-center viewport anchor", () => {
  const camera = Object.freeze({ x: -120, y: 70, scale: 0.5 });
  const anchor = Object.freeze({ x: 300, y: 180 });
  const zoomed = zoomTreeCamera(camera, anchor, 2);
  assert.deepEqual(zoomed, { x: -1380, y: -260, scale: 2 });
  assertAnchorPreserved(camera, zoomed, anchor);
  assert.deepEqual(zoomTreeCamera(camera, anchor, camera.scale), camera);
});

test("pan uses screen-space deltas at every scale and leaves the original camera unchanged", () => {
  for (const scale of [0.01, 0.5, 1, 4]) {
    const camera = Object.freeze({ x: -120, y: 70, scale });
    const moved = panTreeCamera(camera, 35, -90);
    assert.deepEqual(moved, { x: -85, y: -20, scale });
    assert.deepEqual(panTreeCamera(moved, -35, 90), camera);
    assert.deepEqual(panTreeCamera(camera, 0, 0), camera);
  }
});

test("zoom remains anchored after panning rather than drifting toward the viewport center", () => {
  const moved = panTreeCamera({ x: -2400, y: 1300, scale: 0.25 }, 123, -87);
  const anchor = { x: 731, y: 29 };
  for (const scale of [0.02, 0.5, 1, 4]) {
    const zoomed = zoomTreeCamera(moved, anchor, scale);
    assertAnchorPreserved(moved, zoomed, anchor);
  }
});

test("sequential zooms and their reverse restore camera translation and scale", () => {
  const initial = { x: -345.25, y: 827.75, scale: 0.8 };
  const steps = [
    { anchor: { x: 50, y: 450 }, scale: 1.7 },
    { anchor: { x: 713, y: 41 }, scale: 0.03 },
    { anchor: { x: 391, y: 225 }, scale: 3.2 },
  ];
  let camera = initial;
  const previousScales = [];
  for (const step of steps) {
    previousScales.push(camera.scale);
    const next = zoomTreeCamera(camera, step.anchor, step.scale);
    assertAnchorPreserved(camera, next, step.anchor);
    camera = next;
  }
  for (let i = steps.length - 1; i >= 0; i--) {
    camera = zoomTreeCamera(camera, steps[i].anchor, previousScales[i]);
  }
  assertClose(camera.x, initial.x);
  assertClose(camera.y, initial.y);
  assertClose(camera.scale, initial.scale);
});

test("zoom limits retain the ordinary range but let unusually wide and deep trees fit", () => {
  const viewport = { width: 800, height: 600 };
  assert.deepEqual(treeZoomLimits(viewport, { width: 400, height: 300 }), { min: 0.1, max: 4 });
  for (const graph of [
    { width: 80_000_000, height: 300 },
    { width: 400, height: 240_000_000 },
    { width: 80_000_000, height: 240_000_000 },
  ]) {
    const limits = treeZoomLimits(viewport, graph);
    assert.equal(limits.min, Math.min(viewport.width / graph.width, viewport.height / graph.height));
    assert.ok(limits.min < 0.1);
    assert.equal(limits.max, 4);
    const scale = wheelTreeScale(1, 1e9, 0, viewport.height, limits);
    assert.equal(scale, limits.min);
    assert.ok(graph.width * scale <= viewport.width + 1e-9);
    assert.ok(graph.height * scale <= viewport.height + 1e-9);
  }
});

test("pixel, line, and page wheel modes produce the same scale for equivalent distances", () => {
  const limits = { min: 0.001, max: 4 };
  for (const direction of [-1, 1]) {
    const pixels = wheelTreeScale(1, direction * 160, 0, 640, limits);
    assertClose(wheelTreeScale(1, direction * 10, 1, 640, limits), pixels);
    assertClose(wheelTreeScale(1, direction * 0.25, 2, 640, limits), pixels);
  }
});

test("wheel down zooms out, wheel up zooms in, and unclamped opposite events reverse", () => {
  const limits = { min: 0.001, max: 4 };
  const initial = 0.7;
  const down = wheelTreeScale(initial, 120, 0, 600, limits);
  const up = wheelTreeScale(initial, -120, 0, 600, limits);
  assert.ok(down < initial);
  assert.ok(up > initial);
  assertClose(wheelTreeScale(down, -120, 0, 600, limits), initial);
  assertClose(wheelTreeScale(up, 120, 0, 600, limits), initial);
  assert.equal(wheelTreeScale(initial, 0, 0, 600, limits), initial);
});

test("extreme finite wheel deltas remain bounded in every unit mode", () => {
  const limits = { min: 0.0000025, max: 4 };
  for (const mode of [0, 1, 2]) {
    assert.equal(wheelTreeScale(1, Number.MAX_VALUE, mode, 600, limits), limits.min);
    assert.equal(wheelTreeScale(1, -Number.MAX_VALUE, mode, 600, limits), limits.max);
    assert.equal(wheelTreeScale(limits.min, 120, mode, 600, limits), limits.min);
    assert.equal(wheelTreeScale(limits.max, -120, mode, 600, limits), limits.max);
  }
});

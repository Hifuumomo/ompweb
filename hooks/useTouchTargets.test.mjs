import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_TOUCH_TARGETS,
  STORAGE_KEY,
  nextTouchTargetsPreference,
  storedTouchTargetsPreference,
} = await jiti.import("./useTouchTargets.ts");

test("has expected constants", () => {
  assert.equal(DEFAULT_TOUCH_TARGETS, "auto");
  assert.equal(STORAGE_KEY, "omp-touch-targets");
});

test("cycles touch targets preferences through auto -> compact -> accessible -> auto", () => {
  assert.equal(nextTouchTargetsPreference("auto"), "compact");
  assert.equal(nextTouchTargetsPreference("compact"), "accessible");
  assert.equal(nextTouchTargetsPreference("accessible"), "auto");
});

test("falls back safely on unknown preference input", () => {
  assert.equal(nextTouchTargetsPreference("unknown"), "auto");
});

test("stored preference returns default in non-browser environment", () => {
  assert.equal(storedTouchTargetsPreference(), "auto");
});

import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

// ChatInput is TSX; parse it as such. `tsconfigPaths` resolves the "@/…" alias.
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { queueAllowsAttachments } = await jiti.import("../components/ChatInput.tsx");

test("a queued message is text-only, run or not", () => {
  assert.equal(queueAllowsAttachments(0, 0), true);
  assert.equal(queueAllowsAttachments(1, 0), false, "an image blocks queueing");
  assert.equal(queueAllowsAttachments(0, 1), false, "a pasted text file blocks queueing");
  assert.equal(queueAllowsAttachments(3, 2), false);
});

test("the rule has no run-state input, so it cannot report the agent's state as the reason", () => {
  // Regression guard for the shipped copy: the toast once said attachments
  // "cannot be queued while the agent is running", which is narrower than the
  // rule it explains (omp refuses attachments regardless of `isStreaming`).
  assert.equal(queueAllowsAttachments.length, 2, "only the two attachment counts decide");
});

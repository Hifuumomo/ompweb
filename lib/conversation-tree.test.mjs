import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildConversationTree } = await jiti.import("./conversation-tree.ts");

function userEntry(id, parentId, content) {
  return {
    type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content },
  };
}

function assistantEntry(id, parentId, text = "assistant payload") {
  return {
    type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

test("retains every linear prompt and its full text across non-user entries", () => {
  const longText = "original prompt\n  with spacing  ".repeat(100);
  const entries = [
    { type: "model_change", id: "model", parentId: null },
    userEntry("u1", "model", longText),
    assistantEntry("a1", "u1"),
    { type: "message", id: "tool", parentId: "a1", message: { role: "toolResult", content: "secret tool payload" } },
    { type: "thinking_level_change", id: "thinking", parentId: "tool" },
    userEntry("u2", "thinking", [{ type: "text", text: "first block\n" }, { type: "text", text: "  second block" }]),
    { type: "compaction", id: "compact", parentId: "u2", summary: "compressed summary", firstKeptEntryId: "u2" },
    { type: "custom", id: "custom", parentId: "compact", data: "private custom payload" },
    userEntry("u3", "custom", "after compaction"),
    assistantEntry("a3", "u3"),
  ];

  assert.deepEqual(buildConversationTree(entries), {
    nodes: [
      { id: "u1", parentId: null, text: longText, leafId: "a3" },
      { id: "u2", parentId: "u1", text: "first block\n\n  second block", leafId: "a3" },
      { id: "u3", parentId: "u2", text: "after compaction", leafId: "a3" },
    ],
    activePromptIds: ["u1", "u2", "u3"],
  });
});

test("uses nearest prompt ancestors and preserves the selected branch target", () => {
  const entries = [
    userEntry("root", null, "root"),
    assistantEntry("answer", "root"),
    userEntry("left", "answer", "left prompt"),
    assistantEntry("leftTip", "left"),
    { type: "mode_change", id: "mode", parentId: "answer" },
    userEntry("right", "mode", "right prompt"),
    assistantEntry("rightTip", "right"),
  ];
  assert.deepEqual(buildConversationTree(entries, "leftTip"), {
    nodes: [
      { id: "root", parentId: null, text: "root", leafId: "leftTip" },
      { id: "left", parentId: "root", text: "left prompt", leafId: "leftTip" },
      { id: "right", parentId: "root", text: "right prompt", leafId: "rightTip" },
    ],
    activePromptIds: ["root", "left"],
  });
  assert.deepEqual(buildConversationTree(entries).activePromptIds, ["root", "right"]);

  const intermediate = buildConversationTree(entries, "answer");
  assert.deepEqual(intermediate.activePromptIds, ["root"]);
  assert.deepEqual(intermediate.nodes.map((node) => node.leafId), ["answer", "leftTip", "rightTip"]);
});

test("selects the latest terminal descendant in file order, not a later nonterminal", () => {
  const entries = [
    userEntry("root", null, "root"),
    assistantEntry("earlyTip", "intermediate"),
    assistantEntry("latestTip", "root"),
    assistantEntry("intermediate", "root"),
    userEntry("other", null, "unrelated selected prompt"),
  ];
  const tree = buildConversationTree(entries, "other");
  assert.equal(tree.nodes[0].leafId, "latestTip");
  assert.deepEqual(tree.activePromptIds, ["other"]);
  assert.equal(buildConversationTree(entries, "earlyTip").nodes[0].leafId, "earlyTip");
});

test("does not expose image, assistant, tool, or custom payloads", () => {
  const entries = [
    userEntry("image", null, [{ type: "image", data: "blob:sha256:private-image", source: { data: "private-base64" } }]),
    assistantEntry("answer", "image", "private assistant payload"),
    userEntry("mixed", "answer", [
      { type: "text", text: "describe this" },
      { type: "image", data: "private-inline-image" },
      { type: "text", text: "without losing words" },
    ]),
    { type: "message", id: "tool", parentId: "mixed", message: { role: "toolResult", content: "private tool payload" } },
    { type: "custom_message", id: "custom", parentId: "tool", content: "private custom payload" },
  ];
  const tree = buildConversationTree(entries);
  assert.deepEqual(tree.nodes, [
    { id: "image", parentId: null, text: "[Image attachment]", leafId: "custom" },
    { id: "mixed", parentId: "image", text: "describe this\nwithout losing words", leafId: "custom" },
  ]);
  assert.doesNotMatch(JSON.stringify(tree), /private|blob:sha256|base64/);
});

test("missing ancestors become roots and empty or unknown selections follow transcript behavior", () => {
  const entries = [
    userEntry("orphan", "missing", "orphan"),
    assistantEntry("answer", "orphan"),
    userEntry("child", "answer", "child"),
    userEntry("other", null, "other"),
  ];
  const tree = buildConversationTree(entries);
  assert.deepEqual(tree.nodes.map((node) => [node.id, node.parentId, node.leafId]), [
    ["orphan", null, "child"], ["child", "orphan", "child"], ["other", null, "other"],
  ]);
  assert.deepEqual(buildConversationTree(entries, "missing").activePromptIds, ["other"]);
  assert.deepEqual(buildConversationTree(entries, null).activePromptIds, []);
  assert.deepEqual(buildConversationTree([]), { nodes: [], activePromptIds: [] });
  assert.equal(buildConversationTree([userEntry("empty", null, [])]).nodes[0].text, "[Empty prompt]");
});

test("cycles retain prompts but cannot produce circular parent relationships", () => {
  const entries = [
    userEntry("one", "bridge", "one"),
    assistantEntry("bridge", "two"),
    userEntry("two", "one", "two"),
    userEntry("child", "one", "child"),
    userEntry("self", "self", "self"),
  ];
  const tree = buildConversationTree(entries, "child");
  assert.deepEqual(tree.nodes.map((node) => node.id), ["one", "two", "child", "self"]);
  const nodesById = new Map(tree.nodes.map((node) => [node.id, node]));
  for (const node of tree.nodes) {
    const seen = new Set();
    let current = node;
    while (current) {
      assert.equal(seen.has(current.id), false);
      seen.add(current.id);
      current = current.parentId === null ? undefined : nodesById.get(current.parentId);
    }
    assert.ok(entries.some((entry) => entry.id === node.leafId));
  }
  assert.equal(new Set(tree.activePromptIds).size, tree.activePromptIds.length);
});

test("deep chains remain flat, keep all prompts, and serialize without recursive depth", () => {
  const promptCount = 30_000;
  const entries = [];
  for (let i = 0; i < promptCount; i++) {
    entries.push(userEntry(`u${i}`, i === 0 ? null : `a${i - 1}`, `prompt ${i}`));
    entries.push(assistantEntry(`a${i}`, `u${i}`));
  }
  const tree = buildConversationTree(entries);
  assert.equal(tree.nodes.length, promptCount);
  assert.equal(tree.activePromptIds.length, promptCount);
  for (let i = 0; i < promptCount; i++) {
    assert.equal(tree.nodes[i].id, `u${i}`);
    assert.equal(tree.nodes[i].parentId, i === 0 ? null : `u${i - 1}`);
    assert.equal(tree.nodes[i].leafId, `a${promptCount - 1}`);
    assert.equal(tree.activePromptIds[i], `u${i}`);
  }
  assert.doesNotThrow(() => JSON.stringify(tree));
});

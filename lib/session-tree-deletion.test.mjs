import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  deleteSessionPromptSubtree,
  readSessionConversationTree,
  readSessionTreeRevision,
  SessionTreeDeletionError,
} = await jiti.import("./session-tree-deletion.ts");
const { loadSessionFile, serializeTitleSlot, MAX_SESSION_LOAD_BYTES } = await jiti.import("./omp/session-files.ts");

const timestamp = "2026-01-01T00:00:00.000Z";
const header = { type: "session", version: 3, id: "session", timestamp, cwd: "/project" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const user = (id, parentId, content = id) => ({ type: "message", id, parentId, timestamp, message: { role: "user", content } });
const entry = (id, parentId, type = "custom", extra = {}) => ({ type, id, parentId, timestamp, ...extra });
const journal = (entries, sessionHeader = header) => `${[sessionHeader, ...entries].map((value) => JSON.stringify(value)).join("\n")}\n`;

async function withJournal(bytes, run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-tree-delete-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, bytes);
  try { await run(path, dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function rejectsCode(code, status) {
  return (error) => error instanceof SessionTreeDeletionError && error.code === code && error.status === status;
}

async function assertRejectedUnchanged(path, promptId, code, status, revision = hash(readFileSync(path))) {
  const before = readFileSync(path);
  await assert.rejects(deleteSessionPromptSubtree(path, promptId, revision), rejectsCode(code, status));
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(`${path}.omp-web-tree-delete.lock`), false);
}

test("deletes the full raw descendant closure through branched non-user entries", async () => {
  const entries = [
    user("root", null),
    entry("selected", "root", "message", { message: { role: "user", content: "delete me" } }),
    entry("tool", "selected", "message", { message: { role: "toolResult", content: [] } }),
    entry("config", "tool", "model_change", { model: "provider/model" }),
    user("left", "config"),
    entry("leftTip", "left"),
    entry("forkConfig", "tool", "thinking_level_change", { thinkingLevel: "high" }),
    user("right", "forkConfig"),
    entry("summary", "right", "compaction", { firstKeptEntryId: "right", summary: "summary", tokensBefore: 1 }),
    user("keep", "root"),
    entry("keepTip", "keep"),
  ];
  await withJournal(journal(entries), async (path, dir) => {
    const artifacts = join(dir, "artifact.log");
    writeFileSync(artifacts, "must remain");
    const tree = await readSessionConversationTree(path, "leftTip");
    assert.equal(tree.revision, hash(readFileSync(path)));
    assert.equal(tree.persistedLeafId, "keepTip");
    assert.deepEqual(tree.activePromptIds, ["root", "selected", "left"]);
    const result = await deleteSessionPromptSubtree(path, "selected", tree.revision);
    assert.deepEqual(result, {
      deletedEntryCount: 8, deletedPromptCount: 3, persistedLeafId: "keepTip", revision: hash(readFileSync(path)),
    });
    const reopened = loadSessionFile(path);
    assert.equal(reopened.header.version, 3);
    assert.deepEqual(reopened.entries.map((value) => value.id), ["root", "keep", "keepTip"]);
    assert.equal(readFileSync(artifacts, "utf8"), "must remain");
  });
});

test("retains raw header, title padding, CRLF, Unicode, unknown fields and blob strings with only a final LF added", async () => {
  const title = serializeTitleSlot({ title: "保留 🧭", source: "user", updatedAt: timestamp });
  const rawHeader = ' { "type" : "session", "version":3, "id":"session", "cwd":"/项目", "opaque": {"x":1}, "timestamp":"' + timestamp + '" }\r\n';
  const first = JSON.stringify(user("keep", null, [
    { type: "text", text: "中文 🌲\nspace  " },
    { type: "image", data: `blob:sha256:${"a".repeat(64)}`, mimeType: "image/png" },
  ])) + "\r\n";
  const removed = JSON.stringify(user("delete", "keep")) + "\r\n";
  const descendant = JSON.stringify(entry("tip", "delete")) + "\r\n";
  const last = ' {"type":"future_native_entry","id":"retained","parentId":"keep","timestamp":"' + timestamp + '","opaque":{"nested":["blob:sha256:untouched","\\u4e2d"]}}';
  const before = Buffer.from(title + rawHeader + first + removed + descendant + last);
  const expected = Buffer.from(title + rawHeader + first + last + "\n");
  await withJournal(before, async (path) => {
    const result = await deleteSessionPromptSubtree(path, "delete", hash(before));
    assert.deepEqual(readFileSync(path), expected);
    assert.equal(result.revision, hash(expected));
    assert.equal(result.persistedLeafId, "retained");
    assert.equal(loadSessionFile(path).header.title, "保留 🧭");
  });
});

test("a retained final record without LF stays separately parseable after the next native append", async () => {
  const entries = [user("keep", null), user("delete", "keep"), entry("retained", "keep")];
  const before = journal(entries).slice(0, -1);
  await withJournal(before, async (path) => {
    const result = await deleteSessionPromptSubtree(path, "delete", hash(before));
    const expected = journal(entries.filter((value) => value.id !== "delete"));
    assert.deepEqual(readFileSync(path), Buffer.from(expected));
    assert.equal(result.revision, hash(expected));
    const appended = user("appended", "retained");
    appendFileSync(path, JSON.stringify(appended) + "\n");
    const records = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records, [header, entries[0], entries[2], appended]);
    assert.deepEqual(loadSessionFile(path).entries.map((value) => value.id), ["keep", "retained", "appended"]);
    assert.equal((await readSessionConversationTree(path)).persistedLeafId, "appended");
  });
});

test("deleting the current tail picks the last physical retained entry", async () => {
  const entries = [user("root", null), user("other", "root"), entry("otherTip", "other"), user("tail", "root"), entry("tailTip", "tail")];
  await withJournal(journal(entries).trimEnd(), async (path) => {
    const result = await deleteSessionPromptSubtree(path, "tail", await readSessionTreeRevision(path));
    assert.equal(result.persistedLeafId, "otherTip");
    assert.deepEqual((await readSessionConversationTree(path)).activePromptIds, ["root", "other"]);
    assert.deepEqual(loadSessionFile(path).entries.map((value) => value.id), ["root", "other", "otherTip"]);
  });
});

test("deleting the final prompt keeps the exact header and optional title slot", async () => {
  for (const title of ["", serializeTitleSlot({ title: "empty", updatedAt: timestamp })]) {
    const prefix = title + JSON.stringify(header) + "\r\n";
    await withJournal(prefix + JSON.stringify(user("only", null)), async (path) => {
      const result = await deleteSessionPromptSubtree(path, "only", hash(readFileSync(path)));
      assert.deepEqual(readFileSync(path), Buffer.from(prefix));
      assert.equal(result.persistedLeafId, null);
      assert.deepEqual(loadSessionFile(path).entries, []);
      assert.deepEqual((await readSessionConversationTree(path)).nodes, []);
    });
  }
});

test("malformed, duplicate, orphaned and cyclic graphs never mutate", async () => {
  const badJournals = [
    journal([user("u", null)]) + '{"type":"message","id":',
    journal([user("u", null), user("u", null)]),
    journal([user("u", "missing")]),
    journal([user("u", "b"), entry("b", "u")]),
    journal([user("u", null), header]),
    journal([{ type: "message", parentId: null, message: { role: "user", content: "no id" } }]),
    journal([{ ...user("u", null), parentId: undefined }]),
    Buffer.concat([Buffer.from(journal([user("u", null)])), Buffer.from([0xff, 10])]),
  ];
  for (const bytes of badJournals) {
    await withJournal(bytes, (path) => assertRejectedUnchanged(path, "u", "session_tree_invalid", 422));
  }
});

test("v1, v2 and future versions are not migrated for mutation", async () => {
  for (const version of [undefined, 1, 2, 4]) {
    await withJournal(journal([user("u", null)], { ...header, version }), (path) =>
      assertRejectedUnchanged(path, "u", "session_tree_unsupported_version", 422));
  }
});

test("legacy and torn-line browsing remains lenient and has the exact guarded revision", async () => {
  const legacy = journal([
    { type: "message", timestamp, message: { role: "user", content: "legacy prompt" } },
    { type: "message", timestamp, message: { role: "assistant", content: [] } },
  ], { ...header, version: undefined }) + '{"torn":';
  await withJournal(legacy, async (path) => {
    const tree = await readSessionConversationTree(path);
    assert.equal(tree.nodes.length, 1);
    assert.equal(tree.nodes[0].text, "legacy prompt");
    assert.equal(tree.revision, hash(Buffer.from(legacy)));
    assert.equal(typeof tree.persistedLeafId, "string");
    assert.deepEqual(readFileSync(path), Buffer.from(legacy));
  });
});

test("same-size source changes reject the captured revision", async () => {
  await withJournal(journal([user("u", null, "before")]), async (path) => {
    const tree = await readSessionConversationTree(path);
    const before = readFileSync(path, "utf8");
    writeFileSync(path, before.replace("before", "after!"));
    assert.equal(readFileSync(path).length, Buffer.byteLength(before));
    await assertRejectedUnchanged(path, "u", "session_tree_stale", 409, tree.revision);
  });
});

test("missing and non-user targets reject without writes", async () => {
  await withJournal(journal([user("u", null), entry("custom", "u")]), async (path) => {
    await assertRejectedUnchanged(path, "absent", "session_tree_target_not_found", 404);
    await assertRejectedUnchanged(path, "custom", "session_tree_invalid_target", 400);
    await assertRejectedUnchanged(path, "", "session_tree_invalid_target", 400);
  });
});

test("retained documented references cannot point into a deleted branch or outside the journal", async () => {
  const references = [
    entry("ref", "keep", "compaction", { firstKeptEntryId: "delete", summary: "x", tokensBefore: 1 }),
    entry("ref", "keep", "compaction", { firstKeptEntryId: "keep", providerReplayThroughEntryId: "delete", summary: "x", tokensBefore: 1 }),
    entry("ref", "keep", "compaction", { firstKeptEntryId: "", providerReplayThroughEntryId: "delete", summary: "x", tokensBefore: 1 }),
    entry("ref", "keep", "compaction", { firstKeptEntryId: "", providerReplayThroughEntryId: "missing", summary: "x", tokensBefore: 1 }),
    entry("ref", "keep", "compaction", { firstKeptEntryId: "missing", summary: "x", tokensBefore: 1 }),
    entry("ref", "keep", "branch_summary", { fromId: "delete", summary: "x" }),
    entry("ref", "keep", "label", { targetId: "delete", label: "bookmark" }),
    entry("ref", "keep", "label", { targetId: "missing", label: "bookmark" }),
  ];
  for (const ref of references) {
    await withJournal(journal([user("keep", null), user("delete", "keep"), ref]), (path) =>
      assertRejectedUnchanged(path, "delete", "session_tree_reference_conflict", 409));
  }
});

test("native empty firstKeptEntryId sentinel is valid in retained and removed compactions", async () => {
  const entries = [
    user("keep", null), user("delete", "keep"),
    entry("removedCompact", "delete", "compaction", { firstKeptEntryId: "", summary: "removed", tokensBefore: 1 }),
    entry("retainedCompact", "keep", "compaction", { firstKeptEntryId: "", providerReplayThroughEntryId: "keep", summary: "retained", tokensBefore: 1 }),
  ];
  await withJournal(journal(entries), async (path) => {
    const result = await deleteSessionPromptSubtree(path, "delete", hash(readFileSync(path)));
    const expected = Buffer.from(journal([entries[0], entries[3]]));
    assert.deepEqual(readFileSync(path), expected);
    assert.equal(result.deletedEntryCount, 2);
    assert.equal(result.persistedLeafId, "retainedCompact");
    assert.equal(result.revision, hash(expected));
    assert.deepEqual(loadSessionFile(path).entries.map((value) => value.id), ["keep", "retainedCompact"]);
  });
});

test("other reference fields remain strict about empty and nonstring values", async () => {
  const malformed = [
    entry("ref", "keep", "compaction", { firstKeptEntryId: null }),
    entry("ref", "keep", "compaction", { firstKeptEntryId: "", providerReplayThroughEntryId: "" }),
    entry("ref", "keep", "compaction", { firstKeptEntryId: "", providerReplayThroughEntryId: null }),
    entry("ref", "keep", "branch_summary", { fromId: "" }),
    entry("ref", "keep", "label", { targetId: "" }),
    entry("ref", "keep", "label", { targetId: null }),
  ];
  for (const ref of malformed) {
    await withJournal(journal([user("keep", null), user("delete", "keep"), ref]), (path) =>
      assertRejectedUnchanged(path, "delete", "session_tree_invalid", 422));
  }
});

test("retained valid references and native root branch-summary sentinel remain unchanged", async () => {
  const entries = [
    user("keep", null), user("delete", "keep"),
    entry("compact", "keep", "compaction", { firstKeptEntryId: "keep", providerReplayThroughEntryId: "keep", summary: "x", tokensBefore: 1 }),
    entry("summary", "compact", "branch_summary", { fromId: "root", summary: "x" }),
    entry("label", "summary", "label", { targetId: "keep", label: "bookmark" }),
  ];
  await withJournal(journal(entries), async (path) => {
    await deleteSessionPromptSubtree(path, "delete", hash(readFileSync(path)));
    assert.deepEqual(readFileSync(path), Buffer.from(journal(entries.filter((value) => value.id !== "delete"))));
  });
});

test("publication restores source POSIX access bits despite a restrictive umask", { skip: process.platform === "win32" }, async () => {
  await withJournal(journal([user("keep", null), user("delete", "keep")]), async (path) => {
    chmodSync(path, 0o666);
    const previousUmask = process.umask(0o077);
    try {
      await deleteSessionPromptSubtree(path, "delete", hash(readFileSync(path)));
    } finally {
      process.umask(previousUmask);
    }
    assert.equal(statSync(path).mode & 0o777, 0o666);
  });
});

for (const failure of ["close", "unlink", "both"]) {
  test(`postcommit lock ${failure} failure preserves success and runs independent cleanup`, async () => {
    const entries = [user("keep", null), user("delete", "keep")];
    await withJournal(journal(entries), async (path, dir) => {
      const open = fsPromises.open;
      const unlink = fsPromises.unlink;
      let unlinkAttempts = 0;
      fsPromises.open = async (name, flags, ...args) => {
        const handle = await open(name, flags, ...args);
        if (String(name).endsWith(".omp-web-tree-delete.lock") && failure !== "unlink") {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            await close();
            throw new Error("injected lock close failure");
          };
        }
        return handle;
      };
      fsPromises.unlink = async (name) => {
        if (String(name).endsWith(".omp-web-tree-delete.lock")) {
          unlinkAttempts++;
          if (failure !== "close") throw new Error("injected lock unlink failure");
        }
        return unlink(name);
      };
      syncBuiltinESMExports();
      let result;
      try {
        result = await deleteSessionPromptSubtree(path, "delete", hash(readFileSync(path)));
      } finally {
        fsPromises.open = open;
        fsPromises.unlink = unlink;
        syncBuiltinESMExports();
      }
      const expected = Buffer.from(journal([entries[0]]));
      assert.deepEqual(readFileSync(path), expected);
      assert.deepEqual(result, {
        deletedEntryCount: 1, deletedPromptCount: 1, persistedLeafId: "keep",
        revision: hash(expected), cleanupWarning: true,
      });
      assert.equal(unlinkAttempts, 1);
      const strandedLock = failure !== "close";
      assert.equal(existsSync(`${path}.omp-web-tree-delete.lock`), strandedLock);
      assert.deepEqual(readdirSync(dir).sort(), strandedLock
        ? ["session.jsonl", "session.jsonl.omp-web-tree-delete.lock"] : ["session.jsonl"]);
      if (strandedLock) {
        await assert.rejects(deleteSessionPromptSubtree(path, "keep", result.revision), rejectsCode("session_tree_stale", 409));
        assert.deepEqual(readFileSync(path), expected);
        assert.equal(existsSync(`${path}.omp-web-tree-delete.lock`), true);
      }
    });
  });
}

test("precommit primary failure survives cleanup failures and all cleanup actions are attempted", async () => {
  await withJournal(journal([user("keep", null), user("delete", "keep")]), async (path, dir) => {
    const before = readFileSync(path);
    const primaryError = new Error("publication denied");
    const open = fsPromises.open;
    const rename = fsPromises.rename;
    const unlink = fsPromises.unlink;
    let stageCleanupAttempts = 0;
    let lockCloseAttempts = 0;
    let lockUnlinkAttempts = 0;
    fsPromises.open = async (name, flags, ...args) => {
      const handle = await open(name, flags, ...args);
      if (String(name).endsWith(".omp-web-tree-delete.lock")) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          lockCloseAttempts++;
          await close();
          throw new Error("secondary close failure");
        };
      }
      return handle;
    };
    fsPromises.rename = async () => { throw primaryError; };
    fsPromises.unlink = async (name) => {
      if (String(name).endsWith(".tmp")) {
        stageCleanupAttempts++;
        throw new Error("secondary stage unlink failure");
      }
      if (String(name).endsWith(".omp-web-tree-delete.lock")) lockUnlinkAttempts++;
      return unlink(name);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(deleteSessionPromptSubtree(path, "delete", hash(before)), (error) => error === primaryError);
    } finally {
      fsPromises.open = open;
      fsPromises.rename = rename;
      fsPromises.unlink = unlink;
      syncBuiltinESMExports();
    }
    assert.deepEqual(readFileSync(path), before);
    assert.equal(stageCleanupAttempts, 1);
    assert.equal(lockCloseAttempts, 1);
    assert.equal(lockUnlinkAttempts, 1);
    assert.equal(existsSync(`${path}.omp-web-tree-delete.lock`), false);
    assert.equal(readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 1);
  });
});

test("publication failure preserves the original and cleans stage and lock files", async () => {
  await withJournal(journal([user("keep", null), user("delete", "keep")]), async (path, dir) => {
    const before = readFileSync(path);
    const rename = fsPromises.rename;
    fsPromises.rename = async () => { throw Object.assign(new Error("publication denied"), { code: "EACCES" }); };
    syncBuiltinESMExports();
    try {
      await assert.rejects(deleteSessionPromptSubtree(path, "delete", hash(before)), /publication denied/);
    } finally {
      fsPromises.rename = rename;
      syncBuiltinESMExports();
    }
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(readdirSync(dir), ["session.jsonl"]);
  });
});

test("an observed write before atomic publication aborts without overwriting it", async () => {
  await withJournal(journal([user("keep", null, "before"), user("delete", "keep")]), async (path, dir) => {
    const before = readFileSync(path);
    const external = Buffer.from(before.toString("utf8").replace("before", "after!"));
    const open = fsPromises.open;
    let reads = 0;
    fsPromises.open = async (name, flags, ...args) => {
      if (String(name) === path && flags === "r" && ++reads === 2) writeFileSync(path, external);
      return open(name, flags, ...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(deleteSessionPromptSubtree(path, "delete", hash(before)), rejectsCode("session_tree_stale", 409));
    } finally {
      fsPromises.open = open;
      syncBuiltinESMExports();
    }
    assert.deepEqual(readFileSync(path), external);
    assert.deepEqual(readdirSync(dir), ["session.jsonl"]);
  });
});

test("concurrent web deletion transactions have one winner and a fail-closed loser", async () => {
  await withJournal(journal([user("keep", null), user("delete", "keep")]), async (path, dir) => {
    const revision = hash(readFileSync(path));
    const results = await Promise.allSettled([
      deleteSessionPromptSubtree(path, "delete", revision),
      deleteSessionPromptSubtree(path, "delete", revision),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "session_tree_stale");
    assert.deepEqual(loadSessionFile(path).entries.map((value) => value.id), ["keep"]);
    assert.deepEqual(readdirSync(dir), ["session.jsonl"]);
  });
});

test("a pre-existing transaction sidecar is never stolen, even when stale", async () => {
  await withJournal(journal([user("u", null)]), async (path) => {
    const before = readFileSync(path);
    const lock = `${path}.omp-web-tree-delete.lock`;
    writeFileSync(lock, "stale previous owner");
    await assert.rejects(deleteSessionPromptSubtree(path, "u", hash(before)), rejectsCode("session_tree_stale", 409));
    assert.deepEqual(readFileSync(path), before);
    assert.equal(readFileSync(lock, "utf8"), "stale previous owner");
  });
});

test("the existing load ceiling rejects oversized journals before mutation", async () => {
  await withJournal(journal([user("u", null)]), async (path) => {
    truncateSync(path, MAX_SESSION_LOAD_BYTES + 1);
    await assert.rejects(readSessionConversationTree(path), rejectsCode("session_file_too_large", 413));
    await assert.rejects(deleteSessionPromptSubtree(path, "u", "a".repeat(64)), rejectsCode("session_file_too_large", 413));
    assert.equal(existsSync(`${path}.omp-web-tree-delete.lock`), false);
  });
});

test("chunk-boundary Unicode and a fixed-width CRLF title slot retain exact physical ranges plus a final LF", async () => {
  const slot = JSON.parse(serializeTitleSlot({ title: "跨块 🌳", updatedAt: timestamp }));
  slot.pad = slot.pad.slice(1);
  const title = JSON.stringify(slot) + "\r\n";
  assert.equal(Buffer.byteLength(title), 256);
  const prefix = title + JSON.stringify(header) + "\r\n";
  const keep = JSON.stringify(user("keep", null, "x".repeat(1024 * 1024 - 320) + "🌳中文".repeat(50))) + "\r\n";
  const remove = JSON.stringify(user("delete", "keep")) + "\r\n";
  const suffix = JSON.stringify(entry("retained", "keep", "custom", { data: "😀".repeat(100) }));
  const before = Buffer.from(prefix + keep + remove + suffix);
  await withJournal(before, async (path) => {
    const tree = await readSessionConversationTree(path);
    assert.equal(tree.revision, hash(before));
    assert.equal(tree.nodes[0].text, "x".repeat(1024 * 1024 - 320) + "🌳中文".repeat(50));
    const result = await deleteSessionPromptSubtree(path, "delete", tree.revision);
    const expected = Buffer.from(prefix + keep + suffix + "\n");
    assert.deepEqual(readFileSync(path), expected);
    assert.equal(result.revision, hash(expected));
    assert.equal(result.persistedLeafId, "retained");
  });
});

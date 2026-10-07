import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const sessionRoute = await jiti.import("../app/api/sessions/[id]/route.ts");
const contextRoute = await jiti.import("../app/api/sessions/[id]/context/route.ts");
const treeRoute = await jiti.import("../app/api/sessions/[id]/tree/route.ts");
const importRoute = await jiti.import("../app/api/sessions/import/route.ts");
const stateRoute = await jiti.import("../app/api/sessions/[id]/state/route.ts");
const { cacheSessionPath, invalidateSessionListCache, listAllSessions, resolveSessionPath } = await jiti.import("./session-reader.ts");
const { allowFileRoot, normalizeSlashes } = await jiti.import("./file-access.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

const getContext = (id, query = "") => contextRoute.GET(
  new Request(`http://localhost/api/sessions/${id}/context${query ? `?${query}` : ""}`),
  { params: Promise.resolve({ id }) },
);

const getState = (id) => stateRoute.GET(
  new Request(`http://localhost/api/sessions/${id}/state`),
  { params: Promise.resolve({ id }) },
);

const getTree = (id, query = "") => treeRoute.GET(
  new Request(`http://localhost/api/sessions/${id}/tree${query ? `?${query}` : ""}`),
  { params: Promise.resolve({ id }) },
);

const deleteTree = (id, body) => treeRoute.DELETE(
  new Request(`http://localhost/api/sessions/${id}/tree`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id }) },
);

const treeRevision = (bytes) => createHash("sha256").update(bytes).digest("hex");

// MAX_SESSION_LOAD_BYTES from lib/omp/session-files.ts (1 GiB).
const MAX_SESSION_LOAD_BYTES = 1024 * 1024 * 1024;

/** Point the omp agent dir at a throwaway location for the duration of `run`. */
async function withAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-routes-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // The global session-list cache (30s TTL) and the path cache could hold
  // entries from another test's agent dir; clear both so resolution sees only
  // THIS dir's files.
  invalidateSessionListCache();
  try {
    await run(projectDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  }
}
test("state reports a retained exit before the session file exists", async (t) => {
  const id = "exited-before-file";
  const previousExited = globalThis.__ompExitedSessions;
  const previousSessions = globalThis.__ompSessions;
  globalThis.__ompExitedSessions = new Map([[
    id,
    { id, cwd: "/tmp/project", at: 123, code: 1, signal: null, detail: "startup failed" },
  ]]);
  globalThis.__ompSessions = new Map();
  t.after(() => {
    globalThis.__ompExitedSessions = previousExited;
    globalThis.__ompSessions = previousSessions;
  });

  const response = await getState(id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    running: false,
    exited: { id, cwd: "/tmp/project", at: 123, code: 1, signal: null, detail: "startup failed" },
  });
});

function writeSessionFile(dir, name, header, entries = []) {
  const filePath = join(dir, name);
  const lines = [JSON.stringify({ type: "session", version: 3, ...header })];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

/** Turn a real small session file into a 1 GiB+1 sparse file WITHOUT losing
 * the (valid) header, mirroring a session that outgrew the load ceiling. */
function makeOversized(filePath) {
  truncateSync(filePath, MAX_SESSION_LOAD_BYTES + 1);
}

test("session route returns 413 session_file_too_large when a valid-header file exceeds the load ceiling", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "2026-01-01_giant.jsonl", {
      id: "giant-session",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } }]);
    makeOversized(filePath);

    const req = new Request("http://localhost/api/sessions/giant-session");
    const res = await sessionRoute.GET(req, { params: Promise.resolve({ id: "giant-session" }) });

    assert.equal(res.status, 413, "valid header must not degrade to 200 with an empty transcript");
    const body = await res.json();
    assert.equal(body.code, "session_file_too_large");
  });
});

test("context route returns 413 session_file_too_large when a valid-header file exceeds the load ceiling", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "2026-01-01_giant.jsonl", {
      id: "giant-context",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hi" } }]);
    makeOversized(filePath);

    const req = new Request("http://localhost/api/sessions/giant-context/context?leafId=u1");
    const res = await contextRoute.GET(req, { params: Promise.resolve({ id: "giant-context" }) });

    assert.equal(res.status, 413, "valid header must not degrade to 200 with an empty context");
    const body = await res.json();
    assert.equal(body.code, "session_file_too_large");
  });
});

test("oversized file with an INVALID header still 413s, not 404", async () => {
  await withAgentDir(async (dir) => {
    const filePath = join(dir, "2026-01-01_bad-giant.jsonl");
    writeFileSync(filePath, '{"type":"session","version":3,"id":"bad-giant","cwd":"/tmp","timestamp":"2026-01-01T00:00:00.000Z"}\n');
    makeOversized(filePath);

    const req = new Request("http://localhost/api/sessions/bad-giant");
    const res = await sessionRoute.GET(req, { params: Promise.resolve({ id: "bad-giant" }) });

    assert.equal(res.status, 413, "too large is reported as too large even when the header scan fails");
    const body = await res.json();
    assert.equal(body.code, "session_file_too_large");
  });
});

test("session and context routes still serve a normal-size file with 200", async () => {
  await withAgentDir(async (dir) => {
    writeSessionFile(dir, "2026-01-01_small.jsonl", {
      id: "small-session",
      cwd: join(tmpdir(), "omp-web-missing-project"),
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: "world" } },
    ]);

    const req = new Request("http://localhost/api/sessions/small-session");
    const res = await sessionRoute.GET(req, { params: Promise.resolve({ id: "small-session" }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.context.messages.length, 2, "normal file still yields its transcript");
    assert.equal(body.leafId, "a1", "leaf resolves to the last entry");

    // Branch semantics: the context for a leaf is the path TO that leaf.
    // `u1` is the root, so its context is just itself; `a1` (a child of u1)
    // is a sibling branch whose context is u1 -> a1.
    const ctxReq = new Request("http://localhost/api/sessions/small-session/context?leafId=u1");
    const ctxRes = await contextRoute.GET(ctxReq, { params: Promise.resolve({ id: "small-session" }) });
    assert.equal(ctxRes.status, 200);
    const ctxBody = await ctxRes.json();
    assert.equal(ctxBody.context.messages.length, 1, "leaf u1 is the root, so its context contains only itself");
    assert.deepEqual(ctxBody.context.entryIds, ["u1"]);

    const branchReq = new Request("http://localhost/api/sessions/small-session/context?leafId=a1");
    const branchRes = await contextRoute.GET(branchReq, { params: Promise.resolve({ id: "small-session" }) });
    assert.equal(branchRes.status, 200);
    const branchBody = await branchRes.json();
    assert.equal(branchBody.context.messages.length, 2, "leaf a1's context is the full u1 -> a1 branch");
    assert.deepEqual(branchBody.context.entryIds, ["u1", "a1"]);
  });
});

test("session and context routes map a missing session to 404, not 413", async () => {
  const req = new Request("http://localhost/api/sessions/no-such-session");
  const res = await sessionRoute.GET(req, { params: Promise.resolve({ id: "no-such-session" }) });
  assert.equal(res.status, 404);

  const ctxReq = new Request("http://localhost/api/sessions/no-such-session/context");
  const ctxRes = await contextRoute.GET(ctxReq, { params: Promise.resolve({ id: "no-such-session" }) });
  assert.equal(ctxRes.status, 404);
});

test("tree GET and DELETE retain the sibling branch, refresh history and invalidate session-list counts", async () => {
  await withAgentDir(async (dir) => {
    const id = "tree-branched-file-only";
    const timestamp = "2026-01-01T00:00:00.000Z";
    const entry = (id, parentId, type, extra = {}) => ({ type, id, parentId, timestamp, ...extra });
    const user = (id, parentId) => entry(id, parentId, "message", { message: { role: "user", content: id } });
    const entries = [
      user("root", null),
      user("keep", "root"),
      entry("keepAnswer", "keep", "message", { message: { role: "assistant", content: "retained answer" } }),
      user("selected", "root"),
      entry("tool", "selected", "message", { message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [] } }),
      entry("config", "tool", "model_change", { model: "provider/model" }),
      user("left", "config"),
      entry("leftTip", "left", "custom", { customType: "native-metadata", data: { preserved: false } }),
      entry("forkConfig", "tool", "thinking_level_change", { thinkingLevel: "high" }),
      user("right", "forkConfig"),
      entry("rightTip", "right", "message", { message: { role: "assistant", content: "deleted answer" } }),
    ];
    const filePath = writeSessionFile(dir, "2026-01-01_tree-branched.jsonl", { id, cwd: dir, timestamp }, entries);
    const before = readFileSync(filePath);
    const response = await getTree(id, "leafId=leftTip");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const tree = await response.json();
    assert.equal(tree.revision, treeRevision(before));
    assert.equal(tree.persistedLeafId, "rightTip", "viewing another branch must not change the persisted tip");
    assert.deepEqual(tree.activePromptIds, ["root", "selected", "left"]);
    assert.deepEqual(tree.nodes.map(({ id, parentId, text }) => ({ id, parentId, text })), [
      { id: "root", parentId: null, text: "root" },
      { id: "keep", parentId: "root", text: "keep" },
      { id: "selected", parentId: "root", text: "selected" },
      { id: "left", parentId: "selected", text: "left" },
      { id: "right", parentId: "selected", text: "right" },
    ]);
    assert.equal(tree.nodes.find((node) => node.id === "keep").leafId, "keepAnswer");
    assert.deepEqual(readFileSync(filePath), before, "tree browsing must be read-only");

    /** Warm every consumer cache before publication, not just the tree reader. */
    const opened = await sessionRoute.GET(new Request(`http://localhost/api/sessions/${id}`), { params: Promise.resolve({ id }) });
    assert.equal(opened.status, 200);
    assert.deepEqual((await opened.json()).context.entryIds, ["root", "selected", "tool", "right", "rightTip"]);
    const history = await getContext(id, "sync=1");
    assert.equal(history.status, 200);
    const priorHistory = await history.json();
    assert.deepEqual(priorHistory.context.entryIds, ["root", "selected", "tool", "right", "rightTip"]);
    assert.equal((await listAllSessions()).find((session) => session.id === id)?.messageCount, 8);

    const deleted = await deleteTree(id, { promptId: "selected", expectedRevision: tree.revision });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.headers.get("Cache-Control"), "no-store");
    const result = await deleted.json();
    assert.equal(result.deletedEntryCount, 8, "metadata and both descendant branches must be removed, not just visible prompts");
    assert.equal(result.deletedPromptCount, 3);
    assert.equal(result.persistedLeafId, "keepAnswer");
    const after = readFileSync(filePath);
    assert.equal(result.revision, treeRevision(after));
    assert.notEqual(result.revision, tree.revision);
    /** Retained raw lines must survive unchanged, including the session header. */
    const retainedBytes = Buffer.from(before.toString("utf8").split("\n").slice(0, 4).join("\n") + "\n");
    assert.deepEqual(after, retainedBytes);
    const raw = after.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.equal(raw[0].version, 3, "the result remains a native v3 journal");
    assert.deepEqual(raw.slice(1), entries.slice(0, 3));

    const reopened = await sessionRoute.GET(new Request(`http://localhost/api/sessions/${id}`), { params: Promise.resolve({ id }) });
    assert.equal(reopened.status, 200);
    const session = await reopened.json();
    assert.equal(session.leafId, "keepAnswer");
    assert.equal(session.info.messageCount, 3);
    assert.deepEqual(session.context.entryIds, ["root", "keep", "keepAnswer"]);
    assert.deepEqual(session.context.messages.map((message) => message.content), ["root", "keep", "retained answer"]);
    const context = await getContext(id);
    assert.equal(context.status, 200);
    assert.deepEqual((await context.json()).context.entryIds, ["root", "keep", "keepAnswer"]);
    const refreshed = await getContext(id, `sync=1&cursor=${encodeURIComponent(JSON.stringify(priorHistory.cursor))}`);
    assert.equal(refreshed.status, 200);
    const refreshedHistory = await refreshed.json();
    assert.equal(refreshedHistory.mode, "replace", "a cursor in the deleted branch must reset rather than append stale history");
    assert.deepEqual(refreshedHistory.context.entryIds, ["root", "keep", "keepAnswer"]);
    assert.equal(refreshedHistory.leafId, "keepAnswer");
    assert.equal((await listAllSessions()).find((session) => session.id === id)?.messageCount, 3, "the warmed list must refresh immediately");
    const nextTree = await getTree(id);
    assert.equal(nextTree.status, 200);
    const retainedTree = await nextTree.json();
    assert.deepEqual(retainedTree.nodes.map((node) => node.id), ["root", "keep"]);
    assert.deepEqual(retainedTree.activePromptIds, ["root", "keep"]);
    assert.equal(retainedTree.persistedLeafId, "keepAnswer");
    assert.equal(retainedTree.revision, result.revision);
    assert.equal(globalThis.__ompSessions?.has(id) ?? false, false, "file-only tree and history operations must not create a native wrapper");
  });
});

test("tree DELETE reports committed cleanup warnings, refreshes cached consumers and leaves the next deletion blocked", async () => {
  await withAgentDir(async (dir) => {
    const id = "tree-cleanup-warning-file-only";
    const timestamp = "2026-01-01T00:00:00.000Z";
    const entry = (id, parentId, type, extra = {}) => ({ type, id, parentId, timestamp, ...extra });
    const user = (id, parentId) => entry(id, parentId, "message", { message: { role: "user", content: id } });
    const entries = [
      user("root", null),
      user("keep", "root"),
      entry("keepAnswer", "keep", "message", { message: { role: "assistant", content: "retained answer" } }),
      user("selected", "root"),
      entry("config", "selected", "model_change", { model: "provider/model" }),
      user("left", "config"),
      entry("leftAnswer", "left", "message", { message: { role: "assistant", content: "deleted left answer" } }),
      user("right", "config"),
      entry("rightAnswer", "right", "message", { message: { role: "assistant", content: "deleted right answer" } }),
    ];
    const filePath = writeSessionFile(dir, "2026-01-01_tree-cleanup-warning.jsonl", { id, cwd: dir, timestamp }, entries);
    const before = readFileSync(filePath);
    const expected = Buffer.from(before.toString("utf8").split("\n").slice(0, 4).join("\n") + "\n");

    /** Prime history and list caches so a committed warning must still invalidate them. */
    const opened = await sessionRoute.GET(new Request(`http://localhost/api/sessions/${id}`), { params: Promise.resolve({ id }) });
    assert.equal(opened.status, 200);
    assert.deepEqual((await opened.json()).context.entryIds, ["root", "selected", "right", "rightAnswer"]);
    const history = await getContext(id, "sync=1");
    assert.equal(history.status, 200);
    const priorHistory = await history.json();
    assert.deepEqual(priorHistory.context.entryIds, ["root", "selected", "right", "rightAnswer"]);
    assert.equal((await listAllSessions()).find((session) => session.id === id)?.messageCount, 8);
    const response = await getTree(id);
    assert.equal(response.status, 200);
    const tree = await response.json();
    assert.equal(tree.revision, treeRevision(before));

    const unlink = fs.promises.unlink;
    let unlinkAttempts = 0;
    let bytesAtCleanup;
    let deleted;
    /** Fail only sidecar removal; observe publication before reporting the cleanup failure. */
    fs.promises.unlink = async (name) => {
      if (String(name).endsWith(".omp-web-tree-delete.lock")) {
        unlinkAttempts++;
        bytesAtCleanup = readFileSync(filePath);
        throw Object.assign(new Error("injected lock unlink failure"), { code: "EACCES" });
      }
      return unlink(name);
    };
    syncBuiltinESMExports();
    try {
      deleted = await deleteTree(id, { promptId: "selected", expectedRevision: tree.revision });
    } finally {
      fs.promises.unlink = unlink;
      syncBuiltinESMExports();
    }
    assert.equal(unlinkAttempts, 1);
    assert.deepEqual(bytesAtCleanup, expected, "the warning occurs after the replacement journal has been published");
    assert.equal(deleted.status, 200);
    assert.equal(deleted.headers.get("Cache-Control"), "no-store");
    const result = await deleted.json();
    assert.deepEqual(result, {
      deletedEntryCount: 6,
      deletedPromptCount: 3,
      persistedLeafId: "keepAnswer",
      revision: treeRevision(expected),
      cleanupWarning: true,
    });
    assert.deepEqual(readFileSync(filePath), expected, "only the selected subtree, including metadata and both branches, is removed");

    const reopened = await sessionRoute.GET(new Request(`http://localhost/api/sessions/${id}`), { params: Promise.resolve({ id }) });
    assert.equal(reopened.status, 200);
    const session = await reopened.json();
    assert.equal(session.leafId, "keepAnswer");
    assert.equal(session.info.messageCount, 3);
    assert.deepEqual(session.context.entryIds, ["root", "keep", "keepAnswer"]);
    const context = await getContext(id);
    assert.equal(context.status, 200);
    assert.deepEqual((await context.json()).context.entryIds, ["root", "keep", "keepAnswer"]);
    const refreshed = await getContext(id, `sync=1&cursor=${encodeURIComponent(JSON.stringify(priorHistory.cursor))}`);
    assert.equal(refreshed.status, 200);
    const refreshedHistory = await refreshed.json();
    assert.equal(refreshedHistory.mode, "replace");
    assert.deepEqual(refreshedHistory.context.entryIds, ["root", "keep", "keepAnswer"]);
    assert.equal((await listAllSessions()).find((session) => session.id === id)?.messageCount, 3);
    const nextTree = await getTree(id);
    assert.equal(nextTree.status, 200);
    const retainedTree = await nextTree.json();
    assert.deepEqual(retainedTree.nodes.map((node) => node.id), ["root", "keep"]);
    assert.deepEqual(retainedTree.activePromptIds, ["root", "keep"]);
    assert.equal(retainedTree.persistedLeafId, "keepAnswer");
    assert.equal(retainedTree.revision, result.revision);

    const lockPath = `${filePath}.omp-web-tree-delete.lock`;
    assert.equal(existsSync(lockPath), true);
    const lockBytes = readFileSync(lockPath);
    const blocked = await deleteTree(id, { promptId: "keep", expectedRevision: retainedTree.revision });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, "session_tree_stale");
    assert.deepEqual(readFileSync(filePath), expected, "the stranded lock must block a fresh-revision deletion without changing committed bytes");
    assert.deepEqual(readFileSync(lockPath), lockBytes, "a later request must not steal or remove the stranded lock");
  });
});

test("tree DELETE rejects a captured revision after a same-size edit without overwriting the edit", async () => {
  await withAgentDir(async (dir) => {
    const id = "tree-stale-file-only";
    const filePath = writeSessionFile(dir, "2026-01-01_tree-stale.jsonl", { id, cwd: dir }, [
      { type: "message", id: "prompt", parentId: null, message: { role: "user", content: "before" } },
    ]);
    const response = await getTree(id);
    assert.equal(response.status, 200);
    const tree = await response.json();
    const before = readFileSync(filePath);
    const edited = Buffer.from(before.toString("utf8").replace("before", "after!"));
    assert.equal(edited.length, before.length);
    writeFileSync(filePath, edited);
    const rejected = await deleteTree(id, { promptId: "prompt", expectedRevision: tree.revision });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.headers.get("Cache-Control"), "no-store");
    assert.equal((await rejected.json()).code, "session_tree_stale");
    assert.deepEqual(readFileSync(filePath), edited);
    const fresh = await getTree(id);
    assert.equal(fresh.status, 200);
    const freshTree = await fresh.json();
    assert.equal(freshTree.revision, treeRevision(edited));
    assert.notEqual(freshTree.revision, tree.revision);
    assert.equal(freshTree.nodes[0].text, "after!");
  });
});

test("tree DELETE rejects missing or invalid bodies and absent or non-user targets without writes", async () => {
  await withAgentDir(async (dir) => {
    const id = "tree-invalid-target-file-only";
    const filePath = writeSessionFile(dir, "2026-01-01_tree-invalid-target.jsonl", { id, cwd: dir }, [
      { type: "message", id: "prompt", parentId: null, message: { role: "user", content: "keep" } },
      { type: "custom", id: "metadata", parentId: "prompt", customType: "native-metadata" },
    ]);
    const response = await getTree(id);
    assert.equal(response.status, 200);
    const { revision } = await response.json();
    const before = readFileSync(filePath);
    const invalidBodies = [
      null, [], {}, { expectedRevision: revision }, { promptId: "prompt" },
      { promptId: 1, expectedRevision: revision },
      { promptId: "", expectedRevision: revision },
      { promptId: "prompt", expectedRevision: null },
      { promptId: "prompt", expectedRevision: "" },
      { promptId: "prompt", expectedRevision: "not-a-revision" },
      { promptId: "metadata", expectedRevision: revision },
    ];
    for (const body of invalidBodies) {
      const rejected = await deleteTree(id, body);
      assert.equal(rejected.status, 400, JSON.stringify(body));
      assert.equal(rejected.headers.get("Cache-Control"), "no-store");
      assert.equal((await rejected.json()).code, "session_tree_invalid_target");
      assert.deepEqual(readFileSync(filePath), before);
    }
    for (const body of [undefined, "{broken"]) {
      const rejected = await treeRoute.DELETE(new Request(`http://localhost/api/sessions/${id}/tree`, {
        method: "DELETE", headers: { "content-type": "application/json" }, body,
      }), { params: Promise.resolve({ id }) });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).code, "invalid_json");
      assert.deepEqual(readFileSync(filePath), before);
    }
    const absentPrompt = await deleteTree(id, { promptId: "absent", expectedRevision: revision });
    assert.equal(absentPrompt.status, 404);
    assert.equal((await absentPrompt.json()).code, "session_tree_target_not_found");
    assert.deepEqual(readFileSync(filePath), before);
    assert.equal((await getTree("tree-missing-session")).status, 404);
    assert.equal((await deleteTree("tree-missing-session", { promptId: "prompt", expectedRevision: revision })).status, 404);
    assert.deepEqual(readFileSync(filePath), before);
  });
});

test("tree browsing remains lenient for torn and legacy journals but DELETE rejects them without migration", async () => {
  for (const version of [3, 1, 2]) {
    await withAgentDir(async (dir) => {
      const id = `tree-read-only-v${version}`;
      const prompt = { type: "message", message: { role: "user", content: "readable prompt" } };
      if (version >= 2) Object.assign(prompt, { id: "prompt", parentId: null });
      const filePath = writeSessionFile(dir, `2026-01-01_tree-v${version}.jsonl`, { id, cwd: dir, version }, [prompt]);
      if (version === 3) writeFileSync(filePath, readFileSync(filePath, "utf8") + '{"type":"message","id":');
      const before = readFileSync(filePath);
      const response = await getTree(id);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const tree = await response.json();
      assert.equal(tree.nodes.length, 1);
      assert.equal(tree.nodes[0].text, "readable prompt");
      assert.equal(typeof tree.persistedLeafId, "string");
      assert.deepEqual(tree.activePromptIds, [tree.nodes[0].id]);
      assert.equal(tree.revision, treeRevision(before), "guard the original bytes, not a leniently reconstructed journal");
      const context = await getContext(id);
      assert.equal(context.status, 200);
      assert.equal((await context.json()).context.messages[0].content, "readable prompt");
      assert.deepEqual(readFileSync(filePath), before, "legacy browsing must not migrate the file on disk");
      const rejected = await deleteTree(id, { promptId: tree.nodes[0].id, expectedRevision: tree.revision });
      assert.equal(rejected.status, 422);
      assert.equal((await rejected.json()).code, version === 3 ? "session_tree_invalid" : "session_tree_unsupported_version");
      assert.deepEqual(readFileSync(filePath), before);
    });
  }
});

test("tree DELETE preserves the journal when a retained native reference points into the selected branch", async () => {
  await withAgentDir(async (dir) => {
    const id = "tree-reference-file-only";
    const filePath = writeSessionFile(dir, "2026-01-01_tree-reference.jsonl", { id, cwd: dir }, [
      { type: "message", id: "root", parentId: null, message: { role: "user", content: "keep" } },
      { type: "message", id: "selected", parentId: "root", message: { role: "user", content: "referenced prompt" } },
      { type: "label", id: "bookmark", parentId: "root", targetId: "selected", label: "native bookmark" },
    ]);
    const before = readFileSync(filePath);
    const response = await getTree(id);
    assert.equal(response.status, 200);
    const tree = await response.json();
    const rejected = await deleteTree(id, { promptId: "selected", expectedRevision: tree.revision });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.headers.get("Cache-Control"), "no-store");
    assert.equal((await rejected.json()).code, "session_tree_reference_conflict");
    assert.deepEqual(readFileSync(filePath), before);
    const reopened = await getTree(id);
    assert.equal(reopened.status, 200);
    assert.deepEqual(await reopened.json(), tree, "conflict rejection must retain both the referenced prompt and its bookmark");
  });
});
// ============================================================================
// Route-level integration: DELETE re-parenting + import invalidation
// (TODO §3 leftover — fork itself is RPC-gated behind the omp binary and is
// exercised by the live RPC manager, not these Node-only route tests).
// ============================================================================

test("DELETE /api/sessions/[id] re-parents children to the grandparent and stops resolving the deleted id", async () => {
  await withAgentDir(async (dir) => {
    const cwd = join(tmpdir(), "omp-web-missing-project");
    const gpPath = writeSessionFile(dir, "2026-01-01_gp.jsonl", {
      id: "gp-id",
      cwd,
      timestamp: "2026-01-01T00:00:00.000Z",
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "gp" } }]);
    const parentPath = writeSessionFile(dir, "2026-01-02_parent.jsonl", {
      id: "parent-del",
      cwd,
      timestamp: "2026-01-02T00:00:00.000Z",
      parentSession: gpPath,
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "parent" } }]);
    writeSessionFile(dir, "2026-01-03_child.jsonl", {
      id: "child-del",
      cwd,
      timestamp: "2026-01-03T00:00:00.000Z",
      parentSession: parentPath,
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-03T00:00:00.000Z", message: { role: "user", content: "child" } }]);
    writeSessionFile(dir, "2026-01-04_childid.jsonl", {
      id: "child-id-del",
      cwd,
      timestamp: "2026-01-04T00:00:00.000Z",
      parentSession: "parent-del",
    }, [{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-04T00:00:00.000Z", message: { role: "user", content: "child-id" } }]);

    // Warm the list so id/path resolution is exercised the way the UI does.
    await listAllSessions();

    const res = await sessionRoute.DELETE(new Request("http://localhost/api/sessions/parent-del"), {
      params: Promise.resolve({ id: "parent-del" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    assert.equal(existsSync(parentPath), false, "deleted session's file must be gone");
    assert.equal(await resolveSessionPath("parent-del"), null, "deleted session must no longer resolve (stale cache would make omp create a new session on --resume)");

    const after = new Map((await listAllSessions()).map((s) => [s.id, s]));
    assert.equal(after.get("child-del")?.parentSessionId, "gp-id", "child linked by PATH form must re-attach to the grandparent path");
    assert.equal(after.get("child-id-del")?.parentSessionId, "gp-id", "child linked by ID form must re-attach to the grandparent id");
  });
});

test("POST /api/sessions/import writes a fresh-id copy and makes it visible immediately", async () => {
  await withAgentDir(async () => {
    const workspace = mkdtempSync(join(tmpdir(), "omp-web-import-ws-"));
    try {
      allowFileRoot(workspace);
      const content = [
        JSON.stringify({ type: "session", version: 3, id: "src-id", cwd: workspace, timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "imported hello" } }),
        JSON.stringify({ type: "message", id: "b1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "bashExecution", content: "ls", fullOutputPath: "/tmp/pi-bash-evil.log" } }),
      ].join("\n") + "\n";

      const res = await importRoute.POST(new Request("http://localhost/api/sessions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: "src.jsonl", content }),
      }));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.ok(existsSync(body.sessionFile), "imported file must exist at the reported path");

      // Fresh id: an imported copy must never keep the source id, or opening
      // / deleting the import would hit the ORIGINAL session file.
      const sessions = await listAllSessions();
      const imported = sessions.find((s) => s.firstMessage === "imported hello");
      assert.ok(imported, "imported session must appear in the list right away (list invalidation)");
      assert.notEqual(imported.id, "src-id", "imported copy must get a fresh session id");

      // The imported bashExecution must not carry fullOutputPath: it could
      // otherwise forge a reference the bash-output route would trust.
      const written = readFileSync(body.sessionFile, "utf8").split("\n");
      const bashLine = written.find((line) => line.includes("bashExecution"));
      assert.ok(bashLine, "bashExecution entry is preserved");
      assert.equal(JSON.parse(bashLine).message.fullOutputPath, undefined, "fullOutputPath must be stripped on import");
    } finally {
      // Don't leak the allowed root into other tests in this process.
      globalThis.__piAdditionalAllowedRoots?.delete(normalizeSlashes(workspace));
      globalThis.__piAllowedRootsCache?.roots.delete(normalizeSlashes(workspace));
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

test("POST /api/sessions/import rejects unauthorized workspaces and malformed files", async () => {
  await withAgentDir(async () => {
    const unauthorized = mkdtempSync(join(tmpdir(), "omp-web-import-denied-"));
    try {
      const goodEntries = [
        JSON.stringify({ type: "session", version: 3, id: "any", cwd: unauthorized, timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "x" } }),
      ];

      const post = (body) => importRoute.POST(new Request("http://localhost/api/sessions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));

      // Workspace never authorized through projects/sessions/cwd selection.
      const denied = await post({ fileName: "x.jsonl", content: goodEntries.join("\n") + "\n" });
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).code, "import_cwd_not_authorized");

      // Malformed JSON line.
      const malformed = await post({
        fileName: "x.jsonl",
        content: goodEntries[0] + "\n{not json}\n",
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).code, "invalid_session_file");

      // Missing session header (no cwd anywhere).
      const noHeader = await post({
        fileName: "x.jsonl",
        content: JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "x" } }) + "\n",
      });
      assert.equal(noHeader.status, 400);
      assert.equal((await noHeader.json()).code, "invalid_session_file");

      // Path traversal in fileName.
      const traversal = await post({ fileName: "../escape.jsonl", content: goodEntries.join("\n") + "\n" });
      assert.equal(traversal.status, 400);
      assert.equal((await traversal.json()).code, "invalid_file_name");
    } finally {
      globalThis.__piAdditionalAllowedRoots?.delete(normalizeSlashes(unauthorized));
      globalThis.__piAllowedRootsCache?.roots.delete(normalizeSlashes(unauthorized));
      rmSync(unauthorized, { recursive: true, force: true });
    }
  });
});

test("sync serves paged file-only history and preserves the legacy context shape", async () => {
  await withAgentDir(async (dir) => {
    const id = "sync-file-only";
    writeSessionFile(dir, "2026-01-01_sync.jsonl", { id, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }, [
      { type: "message", id: "one", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "one" } },
      { type: "message", id: "two", parentId: "one", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "two" }] } },
    ]);
    const legacy = await (await getContext(id)).json();
    assert.deepEqual(Object.keys(legacy), ["context"]);
    const response = await getContext(id, "sync=1&limit=1&deferThinking");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const first = await response.json();
    assert.equal(first.sessionId, id);
    assert.equal(first.leafId, "two");
    assert.equal(first.live, null);
    assert.equal(globalThis.__ompSessions?.has(id) ?? false, false, "history browsing creates no native wrapper");
    assert.equal(first.mode, "replace");
    assert.deepEqual(first.context.entryIds, ["one"]);
    assert.equal(first.hasMore, true);
    const second = await (await getContext(id, `sync=1&deferThinking&cursor=${encodeURIComponent(JSON.stringify(first.cursor))}`)).json();
    assert.equal(second.mode, "append");
    assert.equal(second.baseEntryId, "one");
    assert.deepEqual(second.context.entryIds, ["two"]);
    assert.deepEqual(second.context.messages[0].content, [{ type: "thinking", thinking: "", deferred: true }, { type: "text", text: "two" }]);
    assert.equal(second.hasMore, false);
    assert.equal("tree" in second, false);
    assert.equal("messages" in second, false);
  });
});

test("boundary returns only the latest compaction-aware active context IDs without a native wrapper", async () => {
  await withAgentDir(async (dir) => {
    const id = "boundary-file-only";
    const filePath = writeSessionFile(dir, "boundary-file-only.jsonl", { id, cwd: dir }, [
      { type: "message", id: "old", parentId: null, message: { role: "user", content: "omitted" } },
      { type: "message", id: "kept", parentId: "old", message: { role: "user", content: "retained" } },
      { type: "compaction", id: "summary", parentId: "kept", summary: "condensed", firstKeptEntryId: "kept", tokensBefore: 50 },
      { type: "message", id: "inactive", parentId: "summary", message: { role: "assistant", content: "other branch" } },
      { type: "message", id: "active", parentId: "summary", message: { role: "assistant", content: "current branch" } },
    ]);
    const response = await getContext(id, "boundary=1");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const boundary = await response.json();
    assert.deepEqual(boundary, { entryIds: ["summary", "kept", "active"] });
    const full = await (await getContext(id)).json();
    assert.deepEqual(boundary.entryIds, full.context.entryIds);
    assert.deepEqual(await (await getContext(id, "boundary=1")).json(), boundary);
    assert.equal(globalThis.__ompSessions?.has(id) ?? false, false, "boundary browsing creates no native wrapper");
    writeFileSync(filePath, JSON.stringify({ type: "session", version: 3, id, cwd: dir }) + "\n");
    assert.deepEqual(await (await getContext(id, "boundary=1")).json(), { entryIds: [] });
  });
});

test("boundary rejects invalid modes and incompatible options before resolving a session", async () => {
  for (const query of ["boundary=", "boundary=0", "boundary=true", "boundary=1&boundary=0"]) {
    const response = await getContext("missing-boundary", query);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_boundary");
  }
  for (const option of ["sync=1", "leafId=", "includePreCompaction", "cursor=", "limit=1"]) {
    const response = await getContext("missing-boundary", `boundary=1&${option}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_boundary_options");
  }
  assert.equal((await getContext("missing-boundary", "boundary=1")).status, 404);
});

test("boundary preserves malformed-header and oversized-file errors", async () => {
  await withAgentDir(async (dir) => {
    const id = "boundary-errors";
    const filePath = writeSessionFile(dir, "boundary-errors.jsonl", { id, cwd: dir });
    cacheSessionPath(id, filePath);
    makeOversized(filePath);
    const validHeader = await getContext(id, "boundary=1");
    assert.equal(validHeader.status, 413);
    assert.equal((await validHeader.json()).code, "session_file_too_large");
    writeFileSync(filePath, "not a session\n");
    const malformed = await getContext(id, "boundary=1");
    assert.equal(malformed.status, 404);
    assert.equal((await malformed.json()).code, "session_file_malformed");
    makeOversized(filePath);
    const invalidHeader = await getContext(id, "boundary=1");
    assert.equal(invalidHeader.status, 413);
    assert.equal((await invalidHeader.json()).code, "session_file_too_large");
  });
});

test("sync samples current live output after the history read and excludes pinned historical views", async (t) => {
  await withAgentDir(async (dir) => {
    const id = "sync-live";
    const filePath = writeSessionFile(dir, "2026-01-01_live.jsonl", { id, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }, [
      { type: "message", id: "old", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "history-read" } },
      { type: "message", id: "tip", parentId: "old", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [] } },
    ]);
    let emit;
    const wrapper = new AgentSessionWrapper({
      isAlive: true,
      onFrame(listener) { emit = listener; return () => {}; },
      sendCommand: async () => { throw new Error("sync must not query or start the native process"); },
      sendFrame() {},
      dispose: async () => {},
    }, dir);
    wrapper.start();
    globalThis.__ompSessions ??= new Map();
    globalThis.__ompSessions.set(id, wrapper);
    emit({ type: "agent_start" });
    emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "before read" }] } });
    // Prime only identity resolution, not the entry cache: the observed read
    // must belong to this context request rather than a directory-list scan.
    cacheSessionPath(id, filePath);
    let emittedDuringRead = false;
    const originalRead = fs.readSync;
    const readMock = t.mock.method(fs, "readSync", (...args) => {
      const count = originalRead(...args);
      if (!emittedDuringRead && Buffer.isBuffer(args[1]) && args[1].toString("utf8", 0, count).includes("history-read")) {
        emittedDuringRead = true;
        queueMicrotask(() => emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "during read" }] } }));
      }
      return count;
    });
    syncBuiltinESMExports();
    t.after(() => { readMock.mock.restore(); syncBuiltinESMExports(); });
    const isolated = createJiti(import.meta.url, {
      moduleCache: false,
      tryNative: false,
      alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
    });
    try {
      const observedRoute = await isolated.import("../app/api/sessions/[id]/context/route.ts");
      const readContext = (query) => observedRoute.GET(
        new Request(`http://localhost/api/sessions/${id}/context?${query}`),
        { params: Promise.resolve({ id }) },
      );
      const initial = await (await readContext("sync=1")).json();
      assert.equal(emittedDuringRead, true);
      assert.equal(initial.live.streamingMessage.content[0].text, "during read");
      assert.deepEqual(initial.live.cursor, wrapper.getStreamSnapshot().cursor);
      const quiet = await (await readContext(`sync=1&cursor=${encodeURIComponent(JSON.stringify(initial.cursor))}`)).json();
      assert.deepEqual(quiet.context.messages, []);
      assert.deepEqual(quiet.live, initial.live, "no new tokens are needed to recover partial output");
      const pinned = await (await readContext("sync=1&leafId=old")).json();
      assert.deepEqual(pinned.context.entryIds, ["old"]);
      assert.equal(pinned.live, null);
      const current = await (await readContext("sync=1&leafId=tip")).json();
      assert.equal(current.live.streamingMessage.content[0].text, "during read");
    } finally {
      await wrapper.destroyAndWait();
      globalThis.__ompSessions.delete(id);
    }
  });
});

test("sync rejects malformed cursor, page bounds and mode before reading a session", async () => {
  for (const cursor of ["{", "null", "[]", "{}", '{"firstEntryId":"","lastEntryId":""}', JSON.stringify({ firstEntryId: "x", lastEntryId: "x".repeat(257) })]) {
    const response = await getContext("missing", `sync=1&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_sync_cursor");
  }
  for (const limit of ["", "0", "-1", "201", "1.5", "1e2", "Infinity", " 2"]) {
    const response = await getContext("missing", `sync=1&limit=${encodeURIComponent(limit)}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_sync_limit");
  }
  const mode = await getContext("missing", "sync=wrong");
  assert.equal(mode.status, 400);
  assert.equal((await mode.json()).code, "invalid_sync");
  const missing = await getContext("missing-sync-session", "sync=1");
  assert.equal(missing.status, 404);
});

test("sync preserves the too-large and malformed-file error contracts", async () => {
  await withAgentDir(async (dir) => {
    const filePath = writeSessionFile(dir, "2026-01-01_big-sync.jsonl", {
      id: "big-sync", cwd: dir, timestamp: "2026-01-01T00:00:00.000Z",
    });
    makeOversized(filePath);
    const large = await getContext("big-sync", "sync=1");
    assert.equal(large.status, 413);
    assert.equal((await large.json()).code, "session_file_too_large");
    const { cacheSessionPath } = await jiti.import("./session-reader.ts");
    const malformedPath = join(dir, "2026-01-01_malformed-sync.jsonl");
    writeFileSync(malformedPath, "not a session\n");
    cacheSessionPath("malformed-sync", malformedPath);
    const malformed = await getContext("malformed-sync", "sync=1");
    assert.equal(malformed.status, 404);
    assert.equal((await malformed.json()).code, "session_file_malformed");
  });
});

test("sync recovers the first live reply before persistence without erasing an established cursor", async () => {
  await withAgentDir(async (dir) => {
    const id = "not-yet-persisted";
    const filePath = join(dir, "2026-01-01_not-yet-persisted.jsonl");
    let emit;
    let stateLoaded = false;
    const wrapper = new AgentSessionWrapper({
      isAlive: true,
      onFrame(listener) { emit = listener; return () => {}; },
      sendCommand: async () => {
        if (stateLoaded) throw new Error("sync must not call native RPC");
        stateLoaded = true;
        return { sessionId: id, sessionFile: filePath, isStreaming: false, isCompacting: false };
      },
      sendFrame() {},
      dispose: async () => {},
    }, dir);
    wrapper.start();
    await wrapper.send({ type: "get_state" });
    globalThis.__ompSessions ??= new Map();
    globalThis.__ompSessions.set(id, wrapper);
    emit({ type: "agent_start" });
    emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "first partial reply" }] } });
    try {
      const response = await getContext(id, "sync=1");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const first = await response.json();
      assert.equal(first.mode, "replace");
      assert.deepEqual(first.context.entryIds, []);
      assert.deepEqual(first.context.messages, []);
      assert.deepEqual(first.cursor, { firstEntryId: null, lastEntryId: null });
      assert.equal(first.leafId, null);
      assert.equal(first.live.streamingMessage.content[0].text, "first partial reply");
      assert.equal(first.live.isPromptRunning, true);
      assert.equal(existsSync(filePath), false);
      const quiet = await (await getContext(id, `sync=1&cursor=${encodeURIComponent(JSON.stringify(first.cursor))}`)).json();
      assert.equal(quiet.mode, "append");
      assert.deepEqual(quiet.live, first.live);
      const establishedCursor = { firstEntryId: "saved-first", lastEntryId: "saved-last" };
      const unavailable = await getContext(id, `sync=1&cursor=${encodeURIComponent(JSON.stringify(establishedCursor))}`);
      assert.equal(unavailable.status, 404);
      assert.equal("context" in await unavailable.json(), false, "an unavailable file is not an empty-history reset");
      assert.equal((await getContext(id, "sync=1&leafId=saved-branch")).status, 404);
      assert.equal((await getContext(id)).status, 404, "legacy no-sync existence rules remain unchanged");
      // A live session that has not persisted anything yet has an empty boundary:
      // the next prompt must be dispatchable (a 404 here aborted the send).
      const emptyBoundary = await getContext(id, "boundary=1");
      assert.equal(emptyBoundary.status, 200);
      assert.equal(emptyBoundary.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await emptyBoundary.json(), { entryIds: [] }, "an unpersisted live session has an empty boundary");
      writeFileSync(filePath, "malformed existing file\n");
      assert.equal((await getContext(id, "boundary=1")).status, 404, "an existing unresolvable file is not an empty boundary");
      const { cacheSessionPath } = await jiti.import("./session-reader.ts");
      cacheSessionPath(id, filePath);
      const malformedBoundary = await getContext(id, "boundary=1");
      assert.equal(malformedBoundary.status, 404);
      assert.equal((await malformedBoundary.json()).code, "session_file_malformed");
      const malformed = await getContext(id, "sync=1");
      assert.equal(malformed.status, 404);
      assert.equal((await malformed.json()).code, "session_file_malformed", "an existing bad file cannot masquerade as not-yet-persisted");
      globalThis.__ompSessions.delete(id);
      assert.equal((await getContext("file-only-missing", "sync=1")).status, 404);
      assert.equal((await getContext("file-only-missing", "boundary=1")).status, 404, "without a live wrapper a missing file stays 404");
    } finally {
      await wrapper.destroyAndWait();
      globalThis.__ompSessions.delete(id);
    }
  });
});

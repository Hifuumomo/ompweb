import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { buildConversationTree, type ConversationTree } from "./conversation-tree";
import { isRecord } from "./type-guards";
import {
  loadSessionFile,
  MAX_SESSION_LOAD_BYTES,
  parseTitleSlotLine,
  SESSION_TITLE_SLOT_BYTES,
} from "./omp/session-files";
import type { SessionEntry } from "./types";

const CHUNK_BYTES = 1024 * 1024;

type TreeErrorCode =
  | "session_tree_stale"
  | "session_tree_invalid"
  | "session_tree_reference_conflict"
  | "session_tree_unsupported_version"
  | "session_file_too_large"
  | "session_tree_target_not_found"
  | "session_tree_invalid_target";

export class SessionTreeDeletionError extends Error {
  constructor(public readonly code: TreeErrorCode, public readonly status: number, message: string) {
    super(message);
    this.name = "SessionTreeDeletionError";
  }
}

function invalid(message: string): never {
  throw new SessionTreeDeletionError("session_tree_invalid", 422, message);
}

function stale(): never {
  throw new SessionTreeDeletionError("session_tree_stale", 409, "Session changed or another tree deletion holds its transaction lock; reload before deleting");
}

function checkSize(size: number): void {
  if (size > MAX_SESSION_LOAD_BYTES) {
    throw new SessionTreeDeletionError("session_file_too_large", 413, "Session file is too large to open in omp-web");
  }
}

/** Project only ancestry and original user text, never resolving blob references. */
function projectEntry(entry: SessionEntry): SessionEntry {
  const base = { type: entry.type, id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp };
  if (entry.type !== "message" || entry.message?.role !== "user") return base as SessionEntry;
  const content = entry.message.content;
  return {
    ...base,
    type: "message",
    message: {
      role: "user",
      content: typeof content === "string" ? content : Array.isArray(content)
        ? content.filter((block) => block?.type === "text" || block?.type === "image")
          .map((block) => block.type === "text" ? { type: "text", text: block.text } : { type: "image" })
        : [],
    },
  } as SessionEntry;
}

interface IndexedEntry {
  id: string;
  parentId: string | null;
  isPrompt: boolean;
  start: number;
  end: number;
  references: string[];
  projection?: SessionEntry;
}

interface Snapshot {
  entries: IndexedEntry[];
  positions: Map<string, number>;
  revision: string;
  size: number;
}

/** Read and hash the exact same physical bytes used for the projection/index.
 * Only one JSONL record is decoded at a time; raw journals are never collected
 * or reserialized. UTF-8 errors and torn records fail closed for mutation. */
async function scanSnapshot(source: FileHandle, includeProjection: boolean): Promise<Snapshot> {
  checkSize((await source.stat()).size);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const fragments: string[] = [];
  const entries: IndexedEntry[] = [];
  const positions = new Map<string, number>();
  let size = 0;
  let lineStart = 0;
  let physicalLine = 0;
  let hasHeader = false;

  function onLine(end: number): void {
    let raw: string;
    try {
      fragments.push(decoder.decode());
      raw = fragments.join("");
    } catch (error) {
      if (error instanceof RangeError) checkSize(MAX_SESSION_LOAD_BYTES + 1);
      invalid("Session contains an invalid UTF-8 record");
    }
    fragments.length = 0;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { invalid("Session contains a malformed or torn JSONL record"); }
    if (!isRecord(parsed)) invalid("Session records must be JSON objects");
    const record = parsed;
    if (physicalLine++ === 0 && record.type === "title") {
      if (end - lineStart !== SESSION_TITLE_SLOT_BYTES || !parseTitleSlotLine(raw)) invalid("Session title slot is malformed");
      return;
    }
    if (!hasHeader) {
      if (record.type !== "session" || typeof record.id !== "string" || !record.id) invalid("Session header is missing or malformed");
      if (record.version !== 3) {
        throw new SessionTreeDeletionError("session_tree_unsupported_version", 422, "Only native v3 session journals can be edited");
      }
      hasHeader = true;
      return;
    }
    if (record.type === "session" || record.type === "title") invalid("Session contains more than one header or title slot");
    if (typeof record.type !== "string" || !record.type || typeof record.id !== "string" || !record.id
      || !(record.parentId === null || (typeof record.parentId === "string" && record.parentId.length > 0))) {
      invalid("Session entry has a missing or unstable ID or parent reference");
    }
    if (positions.has(record.id)) invalid("Session contains duplicate entry IDs");
    const references: string[] = [];
    function reference(key: string, sentinel?: string): void {
      const value = record[key];
      if (typeof value !== "string" || (!value && sentinel !== "")) invalid(`Session entry has an invalid ${key} reference`);
      // Native compaction uses ""; appendBranchSummary uses "root" for a null origin.
      if (value !== sentinel) references.push(value);
    }
    if (record.type === "compaction") {
      reference("firstKeptEntryId", "");
      if (record.providerReplayThroughEntryId !== undefined) reference("providerReplayThroughEntryId");
    } else if (record.type === "branch_summary") reference("fromId", "root");
    else if (record.type === "label") reference("targetId");
    const isPrompt = record.type === "message" && isRecord(record.message) && record.message.role === "user";
    if (isPrompt) {
      const content = (record.message as Record<string, unknown>).content;
      if (!(typeof content === "string" || (Array.isArray(content) && content.every((block) =>
        isRecord(block) && typeof block.type === "string" && (block.type !== "text" || typeof block.text === "string"))))) {
        invalid("Session user message has malformed content");
      }
    }
    positions.set(record.id, entries.length);
    entries.push({
      id: record.id, parentId: record.parentId, isPrompt, start: lineStart, end, references,
      ...(includeProjection ? { projection: projectEntry(record as unknown as SessionEntry) } : {}),
    });
  }

  for (;;) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, size);
    if (!bytesRead) break;
    checkSize(size + bytesRead);
    hash.update(buffer.subarray(0, bytesRead));
    let start = 0;
    while (start < bytesRead) {
      const newline = buffer.indexOf(10, start);
      const end = newline >= 0 && newline < bytesRead ? newline : bytesRead;
      try { fragments.push(decoder.decode(buffer.subarray(start, end), { stream: true })); }
      catch { invalid("Session contains an invalid UTF-8 record"); }
      if (end < bytesRead) {
        onLine(size + end + 1);
        lineStart = size + end + 1;
      }
      start = end + 1;
    }
    size += bytesRead;
  }
  if (lineStart < size) onLine(size);
  if (!hasHeader) invalid("Session header is missing");

  /** Resolve the full entry graph iteratively, including non-message branches. */
  const state = new Uint8Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    if (state[i] === 2) continue;
    const path: number[] = [];
    let current: number | undefined = i;
    while (current !== undefined && state[current] === 0) {
      state[current] = 1;
      path.push(current);
      const parentId: string | null = entries[current].parentId;
      current = parentId === null ? undefined : positions.get(parentId);
      if (parentId !== null && current === undefined) invalid("Session contains an orphaned parent reference");
    }
    if (current !== undefined && state[current] === 1) invalid("Session contains an ancestry cycle");
    for (const index of path) state[index] = 2;
  }
  return { entries, positions, revision: hash.digest("hex"), size };
}

/** Hash source bytes in bounded chunks, including title padding and line endings. */
export async function readSessionTreeRevision(filePath: string): Promise<string> {
  const source = await fs.open(filePath, "r");
  try {
    checkSize((await source.stat()).size);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      checkSize(offset);
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally { await source.close(); }
}

export interface SessionConversationTree extends ConversationTree {
  revision: string;
  persistedLeafId: string | null;
}

/** Normal v3 browsing uses a single snapshot; preserve lenient legacy browsing
 * without ever feeding migrated or sanitized records into the mutation path. */
export async function readSessionConversationTree(filePath: string, leafId?: string): Promise<SessionConversationTree> {
  const source = await fs.open(filePath, "r");
  let snapshot: Snapshot | undefined;
  try { snapshot = await scanSnapshot(source, true); }
  catch (error) {
    if (!(error instanceof SessionTreeDeletionError)
      || (error.code !== "session_tree_invalid" && error.code !== "session_tree_unsupported_version")) throw error;
  } finally { await source.close(); }
  if (snapshot) {
    return {
      ...buildConversationTree(snapshot.entries.map((entry) => entry.projection!), leafId),
      revision: snapshot.revision,
      persistedLeafId: snapshot.entries.at(-1)?.id ?? null,
    };
  }
  const revision = await readSessionTreeRevision(filePath);
  const loaded = loadSessionFile(filePath, { resolveBlobs: false, projectEntry });
  if (await readSessionTreeRevision(filePath) !== revision) stale();
  if (loaded.error === "too_large") checkSize(MAX_SESSION_LOAD_BYTES + 1);
  if (!loaded.header) invalid("Session file is missing or malformed");
  return {
    ...buildConversationTree(loaded.entries, leafId), revision,
    persistedLeafId: loaded.entries.at(-1)?.id ?? null,
  };
}

export interface SessionTreeDeletionResult {
  deletedEntryCount: number;
  deletedPromptCount: number;
  persistedLeafId: string | null;
  revision: string;
  /** Publication succeeded, but one or more transaction cleanup actions failed. */
  cleanupWarning?: boolean;
}

/** Permanently remove the selected user entry and all graph descendants.
 * Retained bytes are unchanged except for a missing final LF needed by native
 * append. Publishing restores POSIX access bits, not ownership or ACLs.
 * The exclusive sidecar coordinates web transactions only, never native omp.
 * A stale sidecar is deliberately not stolen. Native writes after the final
 * hash check remain an accepted external-write race, not concurrency safety. */
export async function deleteSessionPromptSubtree(
  filePath: string, promptId: string, expectedRevision: string,
): Promise<SessionTreeDeletionResult> {
  if (typeof promptId !== "string" || !promptId || typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new SessionTreeDeletionError("session_tree_invalid_target", 400, "promptId and a valid expectedRevision are required");
  }
  const canonicalPath = await fs.realpath(filePath);
  const lockPath = `${canonicalPath}.omp-web-tree-delete.lock`;
  let lock: FileHandle;
  try { lock = await fs.open(lockPath, "wx", 0o600); }
  catch (error) {
    if (isRecord(error) && error.code === "EEXIST") stale();
    throw error;
  }
  let source: FileHandle | undefined;
  let stage: FileHandle | undefined;
  let stagePath: string | undefined;
  let committedResult: SessionTreeDeletionResult | undefined;
  try {
    source = await fs.open(canonicalPath, "r");
    const mode = (await source.stat()).mode;
    const snapshot = await scanSnapshot(source, false);
    if (snapshot.revision !== expectedRevision) stale();
    const target = snapshot.positions.get(promptId);
    if (target === undefined) {
      throw new SessionTreeDeletionError("session_tree_target_not_found", 404, "Selected prompt no longer exists");
    }
    if (!snapshot.entries[target].isPrompt) {
      throw new SessionTreeDeletionError("session_tree_invalid_target", 400, "Only user prompts can be deleted");
    }
    const children = new Map<string, number[]>();
    for (let i = 0; i < snapshot.entries.length; i++) {
      const parent = snapshot.entries[i].parentId;
      if (parent === null) continue;
      const siblings = children.get(parent);
      if (siblings) siblings.push(i);
      else children.set(parent, [i]);
    }
    const deleted = new Set<number>();
    const pending = [target];
    while (pending.length) {
      const index = pending.pop()!;
      deleted.add(index);
      for (const child of children.get(snapshot.entries[index].id) ?? []) pending.push(child);
    }
    let deletedPromptCount = 0;
    let persistedLeafId: string | null = null;
    const removed: { start: number; end: number }[] = [];
    for (let i = 0; i < snapshot.entries.length; i++) {
      const entry = snapshot.entries[i];
      if (deleted.has(i)) {
        removed.push({ start: entry.start, end: entry.end });
        if (entry.isPrompt) deletedPromptCount++;
      } else {
        persistedLeafId = entry.id;
        for (const reference of entry.references) {
          const referencedIndex = snapshot.positions.get(reference);
          if (referencedIndex === undefined || deleted.has(referencedIndex)) {
            throw new SessionTreeDeletionError("session_tree_reference_conflict", 409, "A retained entry references a missing or deleted entry");
          }
        }
      }
    }
    const temporaryPath = `${canonicalPath}.omp-web-tree-delete-${randomUUID()}.tmp`;
    stage = await fs.open(temporaryPath, "wx", mode & 0o777);
    stagePath = temporaryPath;
    const sourceHash = createHash("sha256");
    const retainedHash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let offset = 0;
    let rangeIndex = 0;
    let lastKeptByte: number | undefined;
    /** Copy untouched physical ranges, hashing the entire source again so
     * observed writes during staging cannot publish a mixed journal. */
    while (offset < snapshot.size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, snapshot.size - offset), offset);
      if (!bytesRead) stale();
      sourceHash.update(buffer.subarray(0, bytesRead));
      let cursor = offset;
      const end = offset + bytesRead;
      while (cursor < end) {
        while (rangeIndex < removed.length && removed[rangeIndex].end <= cursor) rangeIndex++;
        const range = removed[rangeIndex];
        if (range && range.start <= cursor) {
          cursor = Math.min(end, range.end);
          continue;
        }
        const keepEnd = Math.min(end, range?.start ?? end);
        const bytes = buffer.subarray(cursor - offset, keepEnd - offset);
        retainedHash.update(bytes);
        lastKeptByte = bytes[bytes.length - 1];
        let written = 0;
        while (written < bytes.length) {
          const result = await stage.write(bytes, written, bytes.length - written, null);
          if (!result.bytesWritten) throw new Error("Failed to write staged session journal");
          written += result.bytesWritten;
        }
        cursor = keepEnd;
      }
      offset = end;
    }
    if (sourceHash.digest("hex") !== snapshot.revision) stale();
    /** Preserve retained bytes verbatim, adding only the delimiter native append needs. */
    if (lastKeptByte !== 10) {
      const newline = Buffer.from("\n");
      const { bytesWritten } = await stage.write(newline, 0, 1, null);
      if (bytesWritten !== 1) throw new Error("Failed to terminate staged session journal");
      retainedHash.update(newline);
    }
    // Explicitly restore POSIX access bits; creation mode alone is filtered by umask.
    await stage.chmod(mode & 0o777);
    await stage.sync();
    await stage.close();
    stage = undefined;
    await source.close();
    source = undefined;
    if (await readSessionTreeRevision(canonicalPath) !== snapshot.revision) stale();
    await fs.rename(stagePath, canonicalPath);
    stagePath = undefined;
    committedResult = { deletedEntryCount: deleted.size, deletedPromptCount, persistedLeafId, revision: retainedHash.digest("hex") };
  } finally {
    /** Each cleanup runs independently; secondary errors never replace a primary
     * failure or turn an already published journal into a reported rollback. */
    let cleanupWarning = false;
    try { if (stage) await stage.close(); } catch { cleanupWarning = true; }
    try { if (source) await source.close(); } catch { cleanupWarning = true; }
    try { if (stagePath) await fs.unlink(stagePath); } catch { cleanupWarning = true; }
    try { await lock.close(); } catch { cleanupWarning = true; }
    try { await fs.unlink(lockPath); } catch { cleanupWarning = true; }
    if (committedResult && cleanupWarning) committedResult.cleanupWarning = true;
  }
  return committedResult;
}

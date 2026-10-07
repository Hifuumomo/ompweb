import type { SessionEntry, UserMessage } from "./types";

export interface ConversationPromptNode {
  id: string;
  parentId: string | null;
  text: string;
  leafId: string;
}

export interface ConversationTree {
  nodes: ConversationPromptNode[];
  activePromptIds: string[];
}

/** Preserve original text blocks without including image data or previews. */
function promptText(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  const text = content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
  return text || (content.some((block) => block?.type === "image") ? "[Image attachment]" : "[Empty prompt]");
}

/**
 * Build a flat prompt-only forest in O(entries + text) time. Non-user entries
 * remain in the ancestry index so tool/config/compaction steps cannot sever
 * prompt relationships or become branch targets prematurely.
 */
export function buildConversationTree(
  entries: readonly SessionEntry[],
  leafId?: string | null,
): ConversationTree {
  const count = entries.length;
  if (count === 0) return { nodes: [], activePromptIds: [] };

  const positions = new Map<string, number>();
  const isPrompt = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const entry = entries[i];
    positions.set(entry.id, i);
    if (entry.type === "message" && entry.message?.role === "user") isPrompt[i] = 1;
  }

  const parents = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    const parentId = entries[i].parentId;
    if (parentId !== null) parents[i] = positions.get(parentId) ?? -1;
  }

  const state = new Uint8Array(count);
  const nearestPrompt = new Int32Array(count).fill(-1);
  const order: number[] = [];
  const path: number[] = [];

  /** Resolve each ancestry once; cut a corrupt cycle into a rooted path. */
  for (let i = 0; i < count; i++) {
    if (state[i] === 2) continue;
    let current = i;
    while (current !== -1 && state[current] === 0) {
      state[current] = 1;
      path.push(current);
      current = parents[current];
    }
    if (current !== -1 && state[current] === 1) {
      parents[path[path.length - 1]] = -1;
    }
    while (path.length > 0) {
      const index = path.pop()!;
      const parent = parents[index];
      nearestPrompt[index] = isPrompt[index] ? index : parent === -1 ? -1 : nearestPrompt[parent];
      state[index] = 2;
      order.push(index);
    }
  }

  const hasChildren = new Uint8Array(count);
  for (const parent of parents) {
    if (parent !== -1) hasChildren[parent] = 1;
  }
  const latestLeaf = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    if (!hasChildren[i]) latestLeaf[i] = i;
  }
  /** Reverse ancestry order propagates terminal file positions only once. */
  for (let i = order.length - 1; i >= 0; i--) {
    const index = order[i];
    const parent = parents[index];
    if (parent !== -1 && latestLeaf[index] > latestLeaf[parent]) {
      latestLeaf[parent] = latestLeaf[index];
    }
  }

  // Match transcript selection: omitted/unknown IDs use the last appended
  // entry, while an explicit null denotes the empty pre-prompt context.
  const activeLeaf = leafId === null ? -1 : (leafId ? positions.get(leafId) : undefined) ?? count - 1;
  const activePrompts = new Set<number>();
  let current = activeLeaf;
  const activePromptIds: string[] = [];
  while (current !== -1) {
    if (isPrompt[current]) {
      activePrompts.add(current);
      activePromptIds.push(entries[current].id);
    }
    current = parents[current];
  }
  activePromptIds.reverse();

  const nodes: ConversationPromptNode[] = [];
  for (let i = 0; i < count; i++) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const parent = parents[i] === -1 ? -1 : nearestPrompt[parents[i]];
    nodes.push({
      id: entry.id,
      parentId: parent === -1 ? null : entries[parent].id,
      text: promptText(entry.message.content),
      leafId: entries[activePrompts.has(i) ? activeLeaf : latestLeaf[i]].id,
    });
  }
  return { nodes, activePromptIds };
}

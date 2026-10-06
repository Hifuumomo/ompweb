import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

/** Tool ids are shared by native RPC snapshots and persisted assistant entries. */
export function getAssistantToolIdentity(message: Partial<AgentMessage>) {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const tool = message.content.find((block) => block.type === "toolCall" && block.toolCallId);
  return tool?.type === "toolCall" ? `assistant-tool:${tool.toolCallId}` : undefined;
}

import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { CommittedTranscript } = await jiti.import("./ChatWindow.tsx");
const { MessageView } = await jiti.import("./MessageView.tsx");
const { TranscriptExpansionProvider } = await jiti.import("./TranscriptExpansion.tsx");
afterEach(cleanup);
const user = (content = "Question") => ({ role: "user", content });
const thinking = (thinking = "Plan") => ({ type: "thinking", thinking });
const tool = (toolCallId) => ({ type: "toolCall", toolCallId, toolName: "bash", input: { command: toolCallId } });
const text = (text) => ({ type: "text", text });
const assistant = (...content) => ({ role: "assistant", provider: "test", model: "test", content });
const noop = () => {};

function transcript(messages, entryIds, options = {}) {
  const refs = { current: [] };
  const results = new Map();
  let lastAnchorIdx = 0;
  messages.forEach((message, index) => {
    if (message.role === "user") lastAnchorIdx = index;
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  });
  return React.createElement(TranscriptExpansionProvider, null, React.createElement(CommittedTranscript, {
    messages, entryIds,
    conversationMeta: { toolResultsMap: results, lastAnchorIdx, visibleRefIndexByMessage: new Map(messages.map((_, i) => [i, i])) },
    messageRefs: refs, isStreaming: false, sessionBusy: false, externalRunActive: false,
    isNew: false, forkingEntryId: null, handleFork: noop, handleNavigate: noop, handleEditContent: noop,
    modelNames: {}, sessionId: "expansion-test", toolCallsDefaultCollapsed: true, hideThinkingBlock: false,
    visibleCount: 100, nearBottom: true, sentinelRef: { current: null }, handleLoadMoreClick: noop, ...options,
  }));
}

const outer = (view) => [...view.container.querySelectorAll(".process-details-toggle")];
const thinkingTrigger = (view) => view.container.querySelector(".activity-row-trigger");
const group = (view) => view.container.querySelector(".activity-group-header");
const groupTools = (view) => [...view.container.querySelectorAll(".activity-group-item-trigger")];
const open = (button) => button.getAttribute("aria-expanded");

test("process choices survive appended activity, final text, live/idle and hidden thinking", () => {
  const messages = [user(), assistant(thinking(), tool("first"))];
  const ids = ["prompt", "reply"];
  const view = render(transcript(messages, ids));
  fireEvent.click(outer(view)[0]);
  fireEvent.click(thinkingTrigger(view));
  assert.equal(open(outer(view)[0]), "true");
  const updated = [user(), assistant(thinking("Updated plan"), tool("first")), assistant(tool("second"), text("Answer always visible"))];
  view.rerender(transcript(updated, [...ids, "reply-2"], { sessionBusy: true }));
  assert.equal(open(outer(view)[0]), "true");
  assert.equal(open(thinkingTrigger(view)), "true");
  assert.match(view.container.textContent, /Updated plan/);
  assert.match(view.container.textContent, /Answer always visible/);
  fireEvent.click(outer(view)[0]);
  view.rerender(transcript(updated, [...ids, "reply-2"], { isStreaming: true }));
  assert.equal(open(outer(view)[0]), "false", "live defaults cannot override a manual close");
  assert.equal(thinkingTrigger(view), null, "outer details remain lazy");
  assert.match(view.container.textContent, /Answer always visible/);
  view.rerender(transcript(updated, [...ids, "reply-2"], { hideThinkingBlock: true }));
  assert.equal(open(outer(view)[0]), "false");
  view.rerender(transcript(updated, [...ids, "reply-2"]));
  fireEvent.click(outer(view)[0]);
  assert.equal(open(thinkingTrigger(view)), "true");
  fireEvent.click(thinkingTrigger(view));
  view.rerender(transcript([...updated, assistant(thinking("new independent plan"))], [...ids, "reply-2", "reply-3"]));
  assert.equal(open(thinkingTrigger(view)), "false", "new activity does not reopen the old thought");
});

test("single tools stay visible when wrapped and group choices survive growth and lazy unmounts", () => {
  const base = [user(), assistant(tool("one"))];
  const view = render(transcript(base, ["prompt", "a"]));
  fireEvent.click(outer(view)[0]);
  // A single row has the activity-row-trigger class as well as tool-call styling.
  const firstTrigger = view.container.querySelector(".activity-row-trigger");
  fireEvent.click(firstTrigger);
  const grouped = [user(), assistant(tool("one"), tool("two"))];
  view.rerender(transcript(grouped, ["prompt", "a"]));
  assert.equal(open(group(view)), "true", "a new wrapper must not hide an opened tool");
  assert.equal(open(groupTools(view)[0]), "true");
  assert.equal(open(groupTools(view)[1]), "false");
  fireEvent.click(group(view));
  view.rerender(transcript([user(), assistant(tool("one"), tool("two"), tool("three"))], ["prompt", "a"], { sessionBusy: true }));
  assert.equal(open(group(view)), "false");
  fireEvent.click(group(view));
  assert.equal(open(groupTools(view)[0]), "true");
  fireEvent.click(outer(view)[0]);
  assert.equal(group(view), null);
  fireEvent.click(outer(view)[0]);
  assert.equal(open(group(view)), "true");
  assert.equal(open(groupTools(view)[0]), "true");
  view.rerender(transcript(base, ["prompt", "a"]));
  assert.equal(open(view.container.querySelector(".activity-row-trigger")), "true", "a split group restores its tool choice");
});

test("entry choices survive paging and index shifts but do not leak to another entry or session host", () => {
  const base = [user("older"), assistant(thinking("older thought")), user("newer"), assistant(text("new answer"))];
  const ids = ["old-u", "old-a", "new-u", "new-a"];
  const view = render(transcript(base, ids));
  fireEvent.click(outer(view)[0]);
  fireEvent.click(thinkingTrigger(view));
  view.rerender(transcript(base, ids, { visibleCount: 1 }));
  assert.equal(outer(view).length, 0);
  view.rerender(transcript([user("prepended"), assistant(text("earlier")), ...base], ["prepend-u", "prepend-a", ...ids]));
  assert.equal(open(outer(view)[0]), "true");
  assert.equal(open(thinkingTrigger(view)), "true");
  view.rerender(transcript([user("other branch"), assistant(thinking("different"))], ["branch-u", "branch-a"]));
  assert.equal(open(outer(view)[0]), "false");
  view.rerender(React.createElement(React.Fragment, { key: "other-session" }, transcript(base, ids)));
  assert.equal(open(outer(view)[0]), "false");
});

test("restored deferred thinking loads the correct original block after outer unmount", async (t) => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify({ thinking: "Deferred original block" }), { headers: { "Content-Type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const messages = [user(), assistant(text("Before"), tool("defer-tool"), { type: "thinking", thinking: "", deferred: true }, text("After"))];
  const view = render(transcript(messages, ["defer-prompt", "defer-reply"]));
  fireEvent.click(outer(view)[0]);
  fireEvent.click(view.getByRole("button", { name: /Thinking/ }));
  fireEvent.click(outer(view)[0]);
  fireEvent.click(outer(view)[0]);
  await waitFor(() => assert.match(view.container.textContent, /Deferred original block/));
  fireEvent.click(outer(view)[0]);
  fireEvent.click(outer(view)[0]);
  await waitFor(() => assert.match(view.container.textContent, /Deferred original block/));
  assert.doesNotMatch(view.container.textContent, /Loading thinking/);
  assert.equal(requested.length, 1, "remount reuses the pending/cached source request");
  assert.match(requested[0], /entries\/defer-reply\/thinking\?blockIndex=2$/);
});

for (const historyFirst of [true, false]) {
  test(`tool identity crosses streaming and committed parents (${historyFirst ? "history first" : "message_end first"})`, () => {
    const streamed = assistant(tool("handoff-one"));
    const saved = [user(), assistant(tool("handoff-one"), tool("handoff-two"), text("Saved answer"))];
    const tree = (history, live) => React.createElement(TranscriptExpansionProvider, null,
      history ? transcript(saved, ["handoff-prompt", "handoff-reply"]) : null,
      live ? React.createElement(MessageView, { key: "native-msg-1", message: streamed, messageIdentity: "epoch:msg-1", isStreaming: true }) : null);
    const view = render(tree(false, true));
    fireEvent.click(view.container.querySelector(".activity-row-trigger"));
    if (historyFirst) view.rerender(tree(true, true));
    else view.rerender(tree(false, false));
    view.rerender(tree(true, false));
    assert.equal(open(outer(view)[0]), "true", "saved activity inherits already-open descendant visibility");
    assert.equal(open(group(view)), "true");
    assert.equal(open(groupTools(view)[0]), "true");
  });
}

test("manual tool close wins over later running defaults and input expansion survives a wrapper", () => {
  const result = { role: "toolResult", toolCallId: "manual-tool", partial: true, content: [{ type: "text", text: "Live output" }] };
  const props = (content, results) => ({ message: assistant(...content), messageIdentity: "epoch:manual", toolCallsDefaultCollapsed: false, toolResults: results });
  const view = render(React.createElement(MessageView, props([tool("manual-tool")])));
  const trigger = view.container.querySelector(".activity-row-trigger");
  fireEvent.click(trigger);
  fireEvent.click(view.getByRole("button", { name: /Show full input/ }));
  fireEvent.click(trigger);
  view.rerender(React.createElement(MessageView, props([tool("manual-tool")], new Map([["manual-tool", result]]))));
  assert.equal(open(view.container.querySelector(".activity-row-trigger")), "false");
  view.rerender(React.createElement(MessageView, props([tool("manual-tool"), tool("manual-two")], new Map([["manual-tool", result]]))));
  assert.equal(open(groupTools(view)[0]), "false");
  fireEvent.click(groupTools(view)[0]);
  assert.ok(view.getByRole("button", { name: /Collapse input/ }));
});

test("same live message keeps thought choices across snapshots; a new native identity is independent", () => {
  const props = (messageIdentity, body) => ({ message: assistant(thinking(body), text("visible")), messageIdentity, isStreaming: true });
  const view = render(React.createElement(MessageView, props("epoch:msg-1", "first")));
  fireEvent.click(thinkingTrigger(view));
  view.rerender(React.createElement(MessageView, props("epoch:msg-1", "continued")));
  assert.equal(open(thinkingTrigger(view)), "true");
  assert.match(view.container.textContent, /continued/);
  view.rerender(React.createElement(MessageView, props("epoch:msg-2", "first")));
  assert.equal(open(thinkingTrigger(view)), "false", "identical text is not an identity");
});

for (const historyFirst of [true, false]) {
  test(`a newly produced tool id hands off an opened source thought (${historyFirst ? "history first" : "end first"})`, () => {
    const liveIdentity = `epoch:thought-${historyFirst}`;
    const callId = `thought-tool-${historyFirst}`;
    const initial = assistant(thinking("Opened before any tool exists"));
    const completed = assistant(thinking("Opened before any tool exists"), tool(callId), text("Committed answer"));
    const canonicalIdentity = `assistant-tool:${callId}`;
    const tree = (history, live, links) => React.createElement(TranscriptExpansionProvider, { messageIdentities: links },
      history ? transcript([user(), completed], [`thought-u-${historyFirst}`, `thought-a-${historyFirst}`]) : null,
      live ? React.createElement(MessageView, { message: initial, messageIdentity: liveIdentity, isStreaming: true }) : null);
    const view = render(tree(false, true));
    fireEvent.click(thinkingTrigger(view));
    if (historyFirst) view.rerender(tree(true, true));
    else view.rerender(tree(false, false));
    // This is the production association obtained from native message_end's
    // messageId plus its toolCallId, not an invented live-to-entry-id mapping.
    view.rerender(tree(true, false, new Map([[liveIdentity, canonicalIdentity]])));
    assert.equal(open(outer(view)[0]), "true");
    assert.equal(open(thinkingTrigger(view)), "true");
    assert.match(view.container.textContent, /Opened before any tool exists/);
  });
}

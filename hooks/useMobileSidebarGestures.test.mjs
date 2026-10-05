import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useMobileSidebarGestures } = await jiti.import("./useMobileSidebarGestures.ts");
afterEach(() => { cleanup(); document.body.replaceChildren(); });

function mount(initial = {}) {
  return renderHook(({ enabled }) => {
    const [leftOpen, onLeftOpenChange] = React.useState(initial.leftOpen ?? false);
    const [rightOpen, onRightOpenChange] = React.useState(initial.rightOpen ?? false);
    useMobileSidebarGestures({ enabled, leftOpen, rightOpen, onLeftOpenChange, onRightOpenChange });
    return { leftOpen, rightOpen };
  }, { initialProps: { enabled: true } });
}

function touch(type, x, y, { target = document.body, count = 1, identifier = 1, cancelable = true } = {}) {
  const point = { identifier, clientX: x, clientY: y };
  const event = new window.Event(type, { bubbles: true, cancelable });
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : Array.from({ length: count }, (_, index) => ({ ...point, identifier: identifier + index })) },
    changedTouches: { value: [point] },
  });
  act(() => target.dispatchEvent(event));
  return event;
}
function swipe(x1, x2, { y1 = 300, y2 = 302, ...options } = {}) {
  touch("touchstart", x1, y1, options);
  const move = touch("touchmove", x2, y2, options);
  const end = touch("touchend", x2, y2, options);
  return { move, end };
}

// jsdom covers recognition and state transitions; real browser touch input
// must verify native scrolling, synthesized clicks, and drawer animations.
test("edge pulls open and reverse pulls close each sidebar without opening the other", () => {
  const hook = mount();
  const width = window.innerWidth;
  const openLeft = swipe(14, 100);
  assert.deepEqual(hook.result.current, { leftOpen: true, rightOpen: false });
  assert.equal(openLeft.move.defaultPrevented, true);
  assert.equal(openLeft.end.defaultPrevented, true);
  swipe(width - 14, width - 100);
  assert.deepEqual(hook.result.current, { leftOpen: false, rightOpen: false });
  swipe(width - 14, width - 100);
  assert.deepEqual(hook.result.current, { leftOpen: false, rightOpen: true });
  swipe(14, 100);
  assert.deepEqual(hook.result.current, { leftOpen: false, rightOpen: false });
});

test("non-edge, short, wrong-direction and vertical pulls do not open drawers or steal scrolling", () => {
  const hook = mount();
  assert.equal(swipe(120, 240).move.defaultPrevented, false);
  assert.equal(swipe(14, 50).end.defaultPrevented, true);
  assert.equal(swipe(20, 1).move.defaultPrevented, false);
  assert.equal(swipe(14, 22, { y2: 410 }).move.defaultPrevented, false);
  assert.equal(swipe(14, 100, { y2: 450 }).move.defaultPrevented, false);
  assert.deepEqual(hook.result.current, { leftOpen: false, rightOpen: false });
});

test("multi-touch, cancellation and a scroll already claimed by the browser abort a pending pull", () => {
  const hook = mount();
  touch("touchstart", 14, 300);
  touch("touchmove", 100, 302, { count: 2 });
  touch("touchend", 100, 302);
  touch("touchstart", 14, 300);
  touch("touchstart", 20, 300, { count: 2 });
  touch("touchmove", 100, 302);
  touch("touchend", 100, 302);
  touch("touchstart", 14, 300);
  touch("touchmove", 100, 302);
  touch("touchcancel", 100, 302);
  touch("touchend", 100, 302);
  touch("touchstart", 14, 300);
  touch("touchmove", 100, 302, { cancelable: false });
  touch("touchend", 100, 302);
  assert.deepEqual(hook.result.current, { leftOpen: false, rightOpen: false });
});

test("form editing and another visible dialog win over edge gestures", () => {
  const hook = mount();
  const input = document.createElement("textarea");
  document.body.append(input);
  assert.equal(swipe(14, 100, { target: input }).move.defaultPrevented, false);
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  assert.equal(swipe(14, 100).move.defaultPrevented, false);
  assert.deepEqual(hook.result.current, { leftOpen: false, rightOpen: false });
  dialog.style.display = "none";
  swipe(14, 100);
  assert.equal(hook.result.current.leftOpen, true);
});

test("the foreground drawer owns the closing gesture, and disabling during a pull cancels it", () => {
  const hook = mount({ leftOpen: true, rightOpen: true });
  const drawer = document.createElement("div");
  drawer.id = "workspace-file-panel";
  drawer.setAttribute("role", "dialog");
  document.body.append(drawer);
  swipe(window.innerWidth - 14, window.innerWidth - 100, { target: drawer });
  assert.deepEqual(hook.result.current, { leftOpen: true, rightOpen: true });
  swipe(14, 100, { target: drawer });
  assert.deepEqual(hook.result.current, { leftOpen: true, rightOpen: false });
  drawer.remove();
  touch("touchstart", window.innerWidth - 14, 300);
  touch("touchmove", window.innerWidth - 100, 302);
  hook.rerender({ enabled: false });
  touch("touchend", window.innerWidth - 100, 302);
  assert.equal(hook.result.current.leftOpen, true);
  assert.equal(swipe(window.innerWidth - 14, window.innerWidth - 100).move.defaultPrevented, false);
});

test("an edge tap preserves its click while a closed drawer does not block later swipes", () => {
  const hook = mount();
  touch("touchstart", 14, 300);
  assert.equal(touch("touchend", 14, 300).defaultPrevented, false);
  const drawer = document.createElement("div");
  drawer.id = "workspace-sidebar";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-hidden", "true");
  drawer.setAttribute("inert", "");
  document.body.append(drawer);
  swipe(14, 100);
  assert.equal(hook.result.current.leftOpen, true);
  drawer.removeAttribute("aria-hidden");
  drawer.removeAttribute("inert");
  swipe(window.innerWidth - 14, window.innerWidth - 100, { target: drawer });
  assert.equal(hook.result.current.leftOpen, false);
});

test("a dialog inside the inert background does not block the foreground drawer's close gesture", () => {
  const hook = mount({ rightOpen: true });
  const background = document.createElement("main");
  background.setAttribute("inert", "");
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  background.append(dialog);
  document.body.append(background);
  swipe(14, 100);
  assert.equal(hook.result.current.rightOpen, false);
});

test("an edge pull inside the open header tools does not open a drawer over those controls", () => {
  const hook = mount();
  const tools = document.createElement("details");
  tools.className = "shell-topbar-overflow";
  tools.open = true;
  document.body.append(tools);
  assert.equal(swipe(14, 100, { target: tools }).move.defaultPrevented, false);
  assert.equal(hook.result.current.leftOpen, false);
});

test("composer menus and pickers block drawer gestures until dismissed", () => {
  const hook = mount();
  const popup = document.createElement("div");
  document.body.append(popup);
  for (const role of ["menu", "listbox"]) {
    popup.setAttribute("role", role);
    assert.equal(swipe(14, 100).move.defaultPrevented, false);
    assert.equal(hook.result.current.leftOpen, false);
  }
  popup.remove();
  swipe(14, 100);
  assert.equal(hook.result.current.leftOpen, true);
});

test("the drawer's persistent Git list allows closing while a nested popup still blocks it", () => {
  const hook = mount({ rightOpen: true });
  const drawer = document.createElement("div");
  drawer.id = "workspace-file-panel";
  drawer.setAttribute("role", "dialog");
  const files = document.createElement("div");
  files.setAttribute("role", "listbox");
  const popup = document.createElement("div");
  popup.setAttribute("role", "menu");
  drawer.append(files, popup);
  document.body.append(drawer);
  assert.equal(swipe(14, 100, { target: files }).move.defaultPrevented, false);
  assert.equal(hook.result.current.rightOpen, true);
  popup.remove();
  assert.equal(swipe(14, 100, { target: files }).move.defaultPrevented, true);
  assert.equal(hook.result.current.rightOpen, false);
});

import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useMobileSidebarGestures } = await jiti.import("./useMobileSidebarGestures.ts");
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

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
  touch("touchmove", x1 + (x2 - x1) * 0.05, y1 + (y2 - y1) * 0.05, options);
  touch("touchmove", x1 + (x2 - x1) * 0.1, y1 + (y2 - y1) * 0.1, options);
  const move = touch("touchmove", x2, y2, options);
  const end = touch("touchend", x2, y2, options);
  return { move, end };
}

// jsdom covers recognition and state transitions; real browser touch input
// must verify native scrolling, synthesized clicks, and drawer animations.
test("intentional swipes from the screen interior open and reverse swipes close each sidebar", () => {
  const hook = mount();
  const openLeft = swipe(140, 240);
  assert.deepEqual(hook.result.current, { leftOpen: true, rightOpen: false });
  assert.equal(openLeft.move.defaultPrevented, true);
  assert.equal(openLeft.end.defaultPrevented, true);
  const wrongDirection = swipe(140, 240);
  assert.equal(wrongDirection.move.defaultPrevented, false);
  assert.equal(wrongDirection.end.defaultPrevented, false);
  assert.equal(hook.result.current.leftOpen, true);
  swipe(240, 140);
  assert.deepEqual(hook.result.current, { leftOpen: false, rightOpen: false });
  swipe(240, 140);
  assert.deepEqual(hook.result.current, { leftOpen: false, rightOpen: true });
  swipe(140, 240);
  assert.deepEqual(hook.result.current, { leftOpen: false, rightOpen: false });
});

test("short, vertical and diagonal pulls do not open drawers or steal scrolling", () => {
  const hook = mount();
  assert.equal(swipe(140, 176).end.defaultPrevented, true);
  assert.equal(swipe(140, 148, { y2: 410 }).move.defaultPrevented, false);
  assert.equal(swipe(140, 226, { y2: 450 }).move.defaultPrevented, false);
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
  for (const tag of ["input", "select", "div"]) {
    const control = document.createElement(tag);
    if (tag === "div") control.setAttribute("contenteditable", "true");
    document.body.append(control);
    assert.equal(swipe(140, 240, { target: control }).move.defaultPrevented, false);
    control.remove();
  }
  const topPanel = document.createElement("div");
  topPanel.setAttribute("data-top-panel", "");
  document.body.append(topPanel);
  assert.equal(swipe(140, 240, { target: topPanel }).move.defaultPrevented, false);
  topPanel.remove();
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

test("native horizontal scrollers own their swipes while fitting or clipped content permits navigation", () => {
  const hook = mount();
  const scroller = document.createElement("div");
  scroller.style.overflowX = "auto";
  // jsdom has no layout; declared widths cover fitting and overflowing scroll surfaces.
  Object.defineProperties(scroller, { clientWidth: { value: 200 }, scrollWidth: { value: 200, writable: true } });
  const content = document.createElement("span");
  scroller.append(content);
  document.body.append(scroller);
  swipe(140, 240, { target: scroller });
  assert.equal(hook.result.current.leftOpen, true);
  swipe(240, 140, { target: scroller });
  assert.equal(hook.result.current.leftOpen, false);
  scroller.scrollWidth = 800;
  assert.equal(swipe(140, 240, { target: content }).move.defaultPrevented, false);
  assert.equal(hook.result.current.leftOpen, false);
  scroller.style.overflowX = "scroll";
  assert.equal(swipe(140, 240, { target: scroller }).move.defaultPrevented, false);
  assert.equal(hook.result.current.leftOpen, false);
  scroller.style.overflowX = "hidden";
  swipe(140, 240, { target: content });
  assert.equal(hook.result.current.leftOpen, true);
});

test("adjusting selected text does not trigger a sidebar swipe", () => {
  const hook = mount();
  const text = document.createElement("span");
  text.textContent = "Selected conversation text";
  document.body.append(text);
  const range = document.createRange();
  range.selectNodeContents(text);
  window.getSelection().addRange(range);
  assert.equal(swipe(140, 240, { target: text }).move.defaultPrevented, false);
  assert.equal(hook.result.current.leftOpen, false);
});

test("a popup present at touchstart retains priority when that touch dismisses it", () => {
  const hook = mount();
  const popup = document.createElement("div");
  popup.setAttribute("role", "menu");
  document.body.append(popup);
  document.addEventListener("touchstart", () => popup.remove(), { once: true });
  assert.equal(swipe(140, 240).move.defaultPrevented, false);
  assert.equal(hook.result.current.leftOpen, false);
});

test("text selection begun during a swipe cancels navigation before or after intent lock", () => {
  const hook = mount();
  const text = document.createElement("span");
  text.textContent = "Selectable message";
  document.body.append(text);
  const select = () => {
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection().addRange(range);
  };
  touch("touchstart", 140, 300, { target: text });
  select();
  assert.equal(touch("touchmove", 240, 302, { target: text }).defaultPrevented, false);
  touch("touchend", 240, 302, { target: text });
  assert.equal(hook.result.current.leftOpen, false);
  window.getSelection().removeAllRanges();
  touch("touchstart", 140, 300, { target: text });
  touch("touchmove", 160, 301, { target: text });
  select();
  assert.equal(touch("touchmove", 240, 302, { target: text }).defaultPrevented, false);
  touch("touchend", 240, 302, { target: text });
  assert.equal(hook.result.current.leftOpen, false);
});

test("a horizontal start that curves into a mostly vertical drag does not navigate", () => {
  const hook = mount();
  touch("touchstart", 140, 300);
  touch("touchmove", 160, 301);
  touch("touchmove", 240, 520);
  touch("touchend", 240, 520);
  assert.deepEqual(hook.result.current, { leftOpen: false, rightOpen: false });
});

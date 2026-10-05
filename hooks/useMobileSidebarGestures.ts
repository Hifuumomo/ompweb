"use client";

import { useEffect } from "react";

const SWIPE_DISTANCE = 64;
const DIRECTION_SLOP = 12;

type Options = {
  enabled: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  onLeftOpenChange: (open: boolean) => void;
  onRightOpenChange: (open: boolean) => void;
};

/** Intentional horizontal swipes reuse drawer state without taking over native gestures. */
export function useMobileSidebarGestures({ enabled, leftOpen, rightOpen, onLeftOpenChange, onRightOpenChange }: Options) {
  useEffect(() => {
    if (!enabled) return;
    let gesture: { id: number; x: number; y: number; target: Element; direction: number; side: "left" | "right" | null; open: boolean } | null = null;
    const cancel = () => { gesture = null; };
    const hasBlockingOverlay = () => {
      const owner = rightOpen ? "workspace-file-panel" : leftOpen ? "workspace-sidebar" : null;
      const ownerElement = owner ? document.getElementById(owner) : null;
      for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], dialog[open]')) {
        if (dialog.id === owner || dialog.closest('[inert], [hidden], [aria-hidden="true"]')) continue;
        if (dialog.getAttribute("role") === "listbox" && ownerElement?.contains(dialog)) continue;
        const style = getComputedStyle(dialog);
        if (style.display !== "none" && style.visibility !== "hidden") return true;
      }
      return false;
    };
    const start = (event: TouchEvent) => {
      cancel();
      if (event.touches.length !== 1 || !(event.target instanceof Element)) return;
      if (event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .shell-topbar-overflow[open], [data-top-panel]')) return;
      if (window.getSelection()?.isCollapsed === false) return;
      // Outside-touch handlers may dismiss a popup before the first move.
      if (hasBlockingOverlay()) return;
      const touch = event.touches[0];
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, target: event.target, direction: 0, side: null, open: false };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1 || event.touches[0].identifier !== gesture.id || !event.cancelable || window.getSelection()?.isCollapsed === false) {
        cancel();
        return;
      }
      const dx = event.touches[0].clientX - gesture.x;
      const dy = Math.abs(event.touches[0].clientY - gesture.y);
      if (!gesture.side) {
        if (Math.max(Math.abs(dx), dy) < DIRECTION_SLOP) return;
        if (Math.abs(dx) < dy * 1.5) {
          cancel();
          return;
        }
        const direction = dx > 0 ? 1 : -1;
        if ((rightOpen && direction < 0) || (!rightOpen && leftOpen && direction > 0)) {
          cancel();
          return;
        }
        // Let code blocks, tab strips and other horizontal scrollers keep their pans.
        for (let element: Element | null = gesture.target; element; element = element.parentElement) {
          if (element.scrollWidth <= element.clientWidth + 1) continue;
          const overflow = getComputedStyle(element).overflowX;
          if (overflow === "auto" || overflow === "scroll") {
            cancel();
            return;
          }
        }
        if (hasBlockingOverlay()) {
          cancel();
          return;
        }
        gesture.direction = direction;
        gesture.side = rightOpen ? "right" : leftOpen ? "left" : direction > 0 ? "left" : "right";
        gesture.open = !leftOpen && !rightOpen;
      }
      event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      const current = gesture;
      cancel();
      if (!current || !current.side || window.getSelection()?.isCollapsed === false) return;
      // Suppress the compatibility click, including a pull released before the threshold.
      if (event.cancelable) event.preventDefault();
      const touch = event.changedTouches[0];
      if (event.touches.length || !touch || touch.identifier !== current.id) return;
      const dx = touch.clientX - current.x;
      const dy = Math.abs(touch.clientY - current.y);
      if (dx * current.direction < SWIPE_DISTANCE || Math.abs(dx) < dy * 1.5) return;
      if (current.side === "left") onLeftOpenChange(current.open);
      else onRightOpenChange(current.open);
    };
    document.addEventListener("touchstart", start, { capture: true, passive: true });
    document.addEventListener("touchmove", move, { capture: true, passive: false });
    document.addEventListener("touchend", end, { capture: true, passive: false });
    document.addEventListener("touchcancel", cancel, true);
    return () => {
      document.removeEventListener("touchstart", start, true);
      document.removeEventListener("touchmove", move, true);
      document.removeEventListener("touchend", end, true);
      document.removeEventListener("touchcancel", cancel, true);
    };
  }, [enabled, leftOpen, rightOpen, onLeftOpenChange, onRightOpenChange]);
}

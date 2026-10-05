"use client";

import { useEffect } from "react";

const EDGE_WIDTH = 24;
const SWIPE_DISTANCE = 64;
const DIRECTION_SLOP = 12;

type Options = {
  enabled: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  onLeftOpenChange: (open: boolean) => void;
  onRightOpenChange: (open: boolean) => void;
};

/** Edge pulls reuse drawer state and motion without taking over vertical scrolling. */
export function useMobileSidebarGestures({ enabled, leftOpen, rightOpen, onLeftOpenChange, onRightOpenChange }: Options) {
  useEffect(() => {
    if (!enabled) return;
    let gesture: { id: number; x: number; y: number; direction: number; side: "left" | "right"; open: boolean; claimed: boolean } | null = null;
    const cancel = () => { gesture = null; };
    const start = (event: TouchEvent) => {
      cancel();
      if (event.touches.length !== 1 || !(event.target instanceof Element)) return;
      if (event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .shell-topbar-overflow[open], [data-top-panel]')) return;
      const touch = event.touches[0];
      const fromLeft = touch.clientX <= EDGE_WIDTH;
      const fromRight = touch.clientX >= window.innerWidth - EDGE_WIDTH;
      let side: "left" | "right";
      let direction: number;
      let open: boolean;
      if (rightOpen && fromLeft) {
        side = "right"; direction = 1; open = false;
      } else if (!rightOpen && leftOpen && fromRight) {
        side = "left"; direction = -1; open = false;
      } else if (!leftOpen && !rightOpen && (fromLeft || fromRight)) {
        side = fromLeft ? "left" : "right";
        direction = fromLeft ? 1 : -1;
        open = true;
      } else return;
      // A nested dialog or its backdrop must not open/close the drawer behind it.
      const owner = rightOpen ? "workspace-file-panel" : leftOpen ? "workspace-sidebar" : null;
      for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], dialog[open]')) {
        if (dialog.id === owner || dialog.closest('[inert], [hidden], [aria-hidden="true"]')) continue;
        const style = getComputedStyle(dialog);
        if (style.display !== "none" && style.visibility !== "hidden") return;
      }
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, direction, side, open, claimed: false };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1 || event.touches[0].identifier !== gesture.id || !event.cancelable) {
        cancel();
        return;
      }
      const dx = event.touches[0].clientX - gesture.x;
      const dy = Math.abs(event.touches[0].clientY - gesture.y);
      if (!gesture.claimed) {
        if (Math.max(Math.abs(dx), dy) < DIRECTION_SLOP) return;
        if (dx * gesture.direction <= 0 || Math.abs(dx) < dy * 1.5) {
          cancel();
          return;
        }
        gesture.claimed = true;
      }
      event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      const current = gesture;
      cancel();
      if (!current || !current.claimed) return;
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

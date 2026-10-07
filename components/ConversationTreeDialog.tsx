"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { GitBranch, RotateCcw, X } from "lucide-react";
import type { ConversationPromptNode, ConversationTree } from "@/lib/conversation-tree";
import { panTreeCamera, treeZoomLimits, wheelTreeScale, zoomTreeCamera } from "@/lib/conversation-tree-camera";
import type { TreeCamera } from "@/lib/conversation-tree-camera";
import { useI18n } from "@/lib/i18n";
import { Dialog, DialogClose, DialogContent, DialogTitle, Tooltip } from "./ui/primitives";
import styles from "./ConversationTreeDialog.module.css";

interface ConversationTreeDialogProps {
  sessionId: string;
  activeLeafId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLeafChange: (leafId: string | null) => void;
  busy: boolean;
  cwd?: string;
}

const CARD_WIDTH = 200;
const CARD_HEIGHT = 76;
const COLUMN_GAP = 24;
const ROW_GAP = 44;
const PADDING = 24;

interface PositionedPrompt {
  node: ConversationPromptNode;
  children: PositionedPrompt[];
  depth: number;
  span: number;
  offset: number;
  x: number;
  y: number;
}

interface PromptLayout {
  items: PositionedPrompt[];
  byId: Map<string, PositionedPrompt>;
  width: number;
  height: number;
}

/** Lay out every prompt in flat DOM order, reserving a column for each terminal path without recursion. */
function layoutPrompts(nodes: ConversationPromptNode[]): PromptLayout {
  const byId = new Map(nodes.map((node) => [node.id, {
    node, children: [], depth: 0, span: 1, offset: 0, x: 0, y: 0,
  } as PositionedPrompt]));
  const roots: PositionedPrompt[] = [];
  for (const item of byId.values()) {
    const parent = item.node.parentId === null ? undefined : byId.get(item.node.parentId);
    if (parent) parent.children.push(item);
    else roots.push(item);
  }

  const ordered: PositionedPrompt[] = [];
  const stack = [...roots].reverse();
  let maxDepth = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    ordered.push(item);
    maxDepth = Math.max(maxDepth, item.depth);
    for (let i = item.children.length - 1; i >= 0; i--) {
      item.children[i].depth = item.depth + 1;
      stack.push(item.children[i]);
    }
  }
  for (let i = ordered.length - 1; i >= 0; i--) {
    const item = ordered[i];
    if (item.children.length > 0) item.span = item.children.reduce((sum, child) => sum + child.span, 0);
  }

  let columns = 0;
  for (const root of roots) {
    root.offset = columns;
    columns += root.span;
  }
  for (const item of ordered) {
    item.x = PADDING + (item.offset + item.span / 2) * (CARD_WIDTH + COLUMN_GAP) - (CARD_WIDTH + COLUMN_GAP) / 2;
    item.y = PADDING + item.depth * (CARD_HEIGHT + ROW_GAP);
    let offset = item.offset;
    for (const child of item.children) {
      child.offset = offset;
      offset += child.span;
    }
  }
  return {
    items: ordered,
    byId,
    width: PADDING * 2 + columns * (CARD_WIDTH + COLUMN_GAP) - COLUMN_GAP,
    height: PADDING * 2 + (maxDepth + 1) * (CARD_HEIGHT + ROW_GAP) - ROW_GAP,
  };
}

type LoadState =
  | { key: string; status: "loading" | "error" }
  | { key: string; status: "ready"; tree: ConversationTree };

/** Update only the transformed layer during navigation, leaving the prompt DOM and tooltips intact. */
function useTreeViewport(graph: PromptLayout | null, activePromptId: string | undefined) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    const initial = (activePromptId ? graph?.byId.get(activePromptId) : undefined) ?? graph?.items[0];
    if (!viewport || !canvas || !graph || !initial) return;

    let camera: TreeCamera = {
      x: viewport.clientWidth / 2 - initial.x - CARD_WIDTH / 2,
      y: viewport.clientHeight / 2 - initial.y - CARD_HEIGHT / 2,
      scale: 1,
    };
    let frame: number | null = null;
    let drag: { id: number; x: number; y: number; startX: number; startY: number; moved: boolean } | null = null;
    let suppressClick = false;

    const applyCamera = () => {
      frame = null;
      canvas.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    };
    const scheduleCamera = () => {
      if (frame === null) frame = requestAnimationFrame(applyCamera);
    };

    /** Pointer coordinates must be converted back through any app-level CSS zoom or scaling. */
    const localPoint = (clientX: number, clientY: number) => {
      const rect = viewport.getBoundingClientRect();
      return {
        x: (clientX - rect.left) / (rect.width / viewport.offsetWidth) - viewport.clientLeft,
        y: (clientY - rect.top) / (rect.height / viewport.offsetHeight) - viewport.clientTop,
      };
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const limits = treeZoomLimits({ width: viewport.clientWidth, height: viewport.clientHeight }, graph);
      const nextScale = wheelTreeScale(camera.scale, event.deltaY, event.deltaMode, viewport.clientHeight, limits);
      camera = zoomTreeCamera(camera, localPoint(event.clientX, event.clientY), nextScale);
      scheduleCamera();
    };

    const endDrag = () => {
      if (!drag) return;
      const { id, moved } = drag;
      drag = null;
      suppressClick = moved;
      delete viewport.dataset.dragging;
      if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
    };

    const onPointerDown = (event: PointerEvent) => {
      suppressClick = false;
      if (!event.isPrimary || event.button !== 0 || drag) return;
      if (event.target instanceof Element && event.target.closest("[data-prompt-id], button, a, input, textarea, select, [role='tooltip'], [contenteditable='true']")) return;
      const point = localPoint(event.clientX, event.clientY);
      drag = { id: event.pointerId, x: point.x, y: point.y, startX: point.x, startY: point.y, moved: false };
      viewport.setPointerCapture(event.pointerId);
      viewport.focus({ preventScroll: true });
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const point = localPoint(event.clientX, event.clientY);
      if (!drag.moved && Math.hypot(point.x - drag.startX, point.y - drag.startY) < 3) return;
      drag.moved = true;
      viewport.dataset.dragging = "true";
      event.preventDefault();
      camera = panTreeCamera(camera, point.x - drag.x, point.y - drag.y);
      drag.x = point.x;
      drag.y = point.y;
      scheduleCamera();
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (event.pointerId === drag?.id) endDrag();
    };
    const onClick = (event: MouseEvent) => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };

    /** Retain scroll-like arrow navigation without intercepting a focused card's keyboard actions. */
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== viewport) return;
      const deltas: Record<string, [number, number]> = {
        ArrowLeft: [48, 0], ArrowRight: [-48, 0], ArrowUp: [0, 48], ArrowDown: [0, -48],
      };
      const delta = deltas[event.key];
      if (!delta) return;
      event.preventDefault();
      camera = panTreeCamera(camera, delta[0], delta[1]);
      scheduleCamera();
    };

    /** Tab navigation reveals offscreen cards while retaining the current zoom. */
    const onFocus = (event: FocusEvent) => {
      if (!(event.target instanceof Element)) return;
      const id = event.target.closest<HTMLElement>("[data-prompt-id]")?.dataset.promptId;
      const item = id ? graph.byId.get(id) : undefined;
      if (!item) return;
      const left = camera.x + item.x * camera.scale;
      const top = camera.y + item.y * camera.scale;
      const width = CARD_WIDTH * camera.scale;
      const height = CARD_HEIGHT * camera.scale;
      const reveal = (start: number, size: number, available: number) => {
        if (size > available - 24) return available / 2 - start - size / 2;
        if (start < 12) return 12 - start;
        if (start + size > available - 12) return available - 12 - start - size;
        return 0;
      };
      camera = panTreeCamera(camera, reveal(left, width, viewport.clientWidth), reveal(top, height, viewport.clientHeight));
      scheduleCamera();
    };

    applyCamera();
    viewport.addEventListener("wheel", onWheel, { passive: false });
    viewport.addEventListener("pointerdown", onPointerDown);
    viewport.addEventListener("pointermove", onPointerMove);
    viewport.addEventListener("pointerup", onPointerEnd);
    viewport.addEventListener("pointercancel", onPointerEnd);
    viewport.addEventListener("lostpointercapture", onPointerEnd);
    viewport.addEventListener("click", onClick, true);
    viewport.addEventListener("keydown", onKeyDown);
    viewport.addEventListener("focusin", onFocus);
    return () => {
      endDrag();
      if (frame !== null) cancelAnimationFrame(frame);
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("pointermove", onPointerMove);
      viewport.removeEventListener("pointerup", onPointerEnd);
      viewport.removeEventListener("pointercancel", onPointerEnd);
      viewport.removeEventListener("lostpointercapture", onPointerEnd);
      viewport.removeEventListener("click", onClick, true);
      viewport.removeEventListener("keydown", onKeyDown);
      viewport.removeEventListener("focusin", onFocus);
    };
  }, [graph, activePromptId]);

  return { viewportRef, canvasRef };
}

/** Mount only while the dialog is open; cancel old requests and never display a previous session's tree. */
function ConversationTreeContent({ sessionId, activeLeafId, onLeafChange, onOpenChange, busy, cwd }: Omit<ConversationTreeDialogProps, "open">) {
  const { t } = useI18n();
  const busyId = useId();
  const hintId = useId();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState | null>(null);
  const requestKey = JSON.stringify([sessionId, activeLeafId, attempt]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setState({ key: requestKey, status: "loading" });
    const query = activeLeafId === null ? "" : `?${new URLSearchParams({ leafId: activeLeafId })}`;
    void (async () => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tree${query}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Conversation tree request failed");
        const tree: ConversationTree = await response.json();
        if (!cancelled) setState({ key: requestKey, status: "ready", tree });
      } catch {
        if (!cancelled) setState({ key: requestKey, status: "error" });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sessionId, activeLeafId, requestKey]);

  const tree = state?.key === requestKey && state.status === "ready" ? state.tree : null;
  const graph = useMemo(() => tree ? layoutPrompts(tree.nodes) : null, [tree]);
  const activeIds = useMemo(() => new Set(tree?.activePromptIds), [tree]);
  const loading = state?.key !== requestKey || state.status === "loading";
  const failed = state?.key === requestKey && state.status === "error";

  const { viewportRef, canvasRef } = useTreeViewport(graph, tree?.activePromptIds[tree.activePromptIds.length - 1]);

  /** Branch switching stays on the existing read-only navigation callback. */
  const selectPrompt = (leafId: string) => {
    if (busy) return;
    onLeafChange(leafId);
    onOpenChange(false);
  };

  return (
    <DialogContent ariaLabel={t("conversationTree.title")} className={styles.dialog} style={{ padding: 0, overflow: "hidden", width: "min(1080px, calc(100vw - 24px))", maxWidth: "calc(100vw - 24px)" }}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <DialogTitle style={{ margin: 0, fontSize: 20 }}>{t("conversationTree.title")}</DialogTitle>
          {cwd && <div className={styles.cwd}>{cwd}</div>}
        </div>
        <DialogClose className={styles.iconButton} aria-label={t("conversationTree.close")}>
          <X size={18} aria-hidden="true" />
        </DialogClose>
      </header>
      <div className={styles.instructions}>
        <p id={hintId}>{t("conversationTree.hint")}</p>
        <span className={styles.legend}><GitBranch size={14} aria-hidden="true" />{t("conversationTree.activeBranch")}</span>
        {busy && <p id={busyId} className={styles.busy} role="status">{t("conversationTree.busy")}</p>}
      </div>
      <div ref={viewportRef} className={styles.viewport} role="region" aria-label={t("conversationTree.title")} aria-describedby={hintId} aria-busy={loading} tabIndex={0}>
        {loading && <div className={styles.state} role="status">{t("conversationTree.loading")}</div>}
        {failed && <div className={styles.state}>
          <p role="alert">{t("conversationTree.error")}</p>
          <button type="button" className={styles.retry} onClick={() => setAttempt((value) => value + 1)}><RotateCcw size={14} aria-hidden="true" />{t("conversationTree.retry")}</button>
        </div>}
        {tree && tree.nodes.length === 0 && <div className={styles.state} role="status">{t("conversationTree.empty")}</div>}
        {tree && graph && tree.nodes.length > 0 && <div ref={canvasRef} className={styles.canvas} style={{ width: graph.width, height: graph.height }}>
          <div aria-hidden="true">
            {graph.items.flatMap((parent) => parent.children.map((child) => {
              const parentX = parent.x + CARD_WIDTH / 2;
              const childX = child.x + CARD_WIDTH / 2;
              return <div key={child.node.id} className={styles.edge} data-active={activeIds.has(parent.node.id) && activeIds.has(child.node.id)} style={{ left: Math.min(parentX, childX), top: parent.y + CARD_HEIGHT, width: Math.abs(parentX - childX), height: ROW_GAP }}>
                <span className={styles.edgeTop} style={{ left: parentX <= childX ? 0 : "100%" }} />
                <span className={styles.edgeAcross} />
                <span className={styles.edgeBottom} style={{ left: parentX <= childX ? "100%" : 0 }} />
              </div>;
            }))}
          </div>
          <ol className={styles.nodes}>
            {graph.items.map(({ node, x, y }) => {
              const text = node.text || t("conversationTree.imagePrompt");
              const active = activeIds.has(node.id);
              return <li key={node.id} className={styles.node} data-prompt-id={node.id} style={{ left: x, top: y, width: CARD_WIDTH, height: CARD_HEIGHT }}>
                <Tooltip content={<div className={styles.fullPrompt} tabIndex={0}>{text}</div>}>
                  <button type="button" className={styles.card} data-active={active} aria-current={active ? "true" : undefined} aria-disabled={busy} aria-describedby={busy ? busyId : undefined} onClick={() => selectPrompt(node.leafId)}>
                    <span className={styles.cardHeading}><GitBranch size={13} aria-hidden="true" />{active && <span>{t("conversationTree.activeBranch")}</span>}</span>
                    <span className={styles.preview}>{text}</span>
                  </button>
                </Tooltip>
              </li>;
            })}
          </ol>
        </div>}
      </div>
    </DialogContent>
  );
}

/** Visualize prompt ancestry inside one session; opening never starts or mutates an agent session. */
export function ConversationTreeDialog({ open, ...props }: ConversationTreeDialogProps) {
  return <Dialog open={open} onOpenChange={props.onOpenChange}>
    {open && <ConversationTreeContent {...props} />}
  </Dialog>;
}

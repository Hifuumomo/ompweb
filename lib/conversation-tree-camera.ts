export interface TreeCamera {
  x: number;
  y: number;
  scale: number;
}

/** Keep the graph point under a local viewport anchor fixed while zooming. */
export function zoomTreeCamera(
  camera: TreeCamera,
  anchor: { x: number; y: number },
  nextScale: number,
): TreeCamera {
  const ratio = nextScale / camera.scale;
  return {
    x: anchor.x - (anchor.x - camera.x) * ratio,
    y: anchor.y - (anchor.y - camera.y) * ratio,
    scale: nextScale,
  };
}

/** Apply viewport-space drag deltas without changing the graph scale. */
export function panTreeCamera(camera: TreeCamera, dx: number, dy: number): TreeCamera {
  return { x: camera.x + dx, y: camera.y + dy, scale: camera.scale };
}

/** Allow even very wide or deep trees to fit entirely inside the viewport. */
export function treeZoomLimits(
  viewport: { width: number; height: number },
  graph: { width: number; height: number },
): { min: number; max: number } {
  return {
    min: Math.min(0.1, viewport.width / graph.width, viewport.height / graph.height),
    max: 4,
  };
}

/** Normalize wheel units and bound the exponent before clamping the scale. */
export function wheelTreeScale(
  scale: number,
  deltaY: number,
  deltaMode: number,
  viewportHeight: number,
  limits: { min: number; max: number },
): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? viewportHeight : 1);
  const exponent = Math.max(-50, Math.min(50, -pixels * 0.002));
  return Math.max(limits.min, Math.min(limits.max, scale * Math.exp(exponent)));
}

/**
 * Viewport maths: the mapping between document space and screen space.
 *
 * Kept as pure functions with no canvas or DOM dependency so the tricky parts, * zoom anchoring especially, are testable without a browser. Every editor gets
 * zoom-at-cursor subtly wrong at least once, and it is immediately obvious to
 * users when the artwork slides out from under the pointer.
 */

import type { Viewport } from "../store";

export interface Size {
  width: number;
  height: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 64;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Document point -> screen point. */
export function toScreen(vp: Viewport, x: number, y: number): [number, number] {
  return [x * vp.scale + vp.x, y * vp.scale + vp.y];
}

/** Screen point -> document point. */
export function toDocument(
  vp: Viewport,
  x: number,
  y: number,
): [number, number] {
  return [(x - vp.x) / vp.scale, (y - vp.y) / vp.scale];
}

/**
 * Zoom about a fixed screen point.
 *
 * The invariant, and the thing worth testing: the document point under the
 * cursor before the zoom is under the cursor after it. Solving for the new
 * translation directly is what guarantees that; nudging the pan by a delta
 * derived from the scale ratio accumulates error over a scroll gesture.
 */
export function zoomAt(
  vp: Viewport,
  nextScale: number,
  screenX: number,
  screenY: number,
): Viewport {
  const scale = clampScale(nextScale);
  // The document point that must stay put.
  const [docX, docY] = toDocument(vp, screenX, screenY);
  return {
    scale,
    x: screenX - docX * scale,
    y: screenY - docY * scale,
  };
}

/** Multiply the current zoom, anchored at a screen point. */
export function zoomBy(
  vp: Viewport,
  factor: number,
  screenX: number,
  screenY: number,
): Viewport {
  return zoomAt(vp, vp.scale * factor, screenX, screenY);
}

export function pan(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, x: vp.x + dx, y: vp.y + dy };
}

/**
 * Fit a document-space rect inside the viewport with padding.
 *
 * `padding` is in screen pixels so the visual margin stays constant regardless
 * of how large the artboard is.
 */
export function fitToRect(
  view: Size,
  rect: { x: number; y: number; width: number; height: number },
  padding = 48,
): Viewport {
  const availableW = Math.max(1, view.width - padding * 2);
  const availableH = Math.max(1, view.height - padding * 2);
  const scale = clampScale(
    Math.min(
      availableW / Math.max(1, rect.width),
      availableH / Math.max(1, rect.height),
    ),
  );
  return {
    scale,
    x: (view.width - rect.width * scale) / 2 - rect.x * scale,
    y: (view.height - rect.height * scale) / 2 - rect.y * scale,
  };
}

/** Centre the document at 100% without changing zoom. */
export function centerOn(
  view: Size,
  rect: { x: number; y: number; width: number; height: number },
  scale: number,
): Viewport {
  return {
    scale,
    x: (view.width - rect.width * scale) / 2 - rect.x * scale,
    y: (view.height - rect.height * scale) / 2 - rect.y * scale,
  };
}

/**
 * Snap a coordinate so a 1px line lands on a device pixel rather than straddling
 * two. Without this every hairline in the overlay renders as a 2px blur.
 */
export function sharp(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr + 0.5 / dpr;
}

/**
 * The document-space rectangle currently visible.
 *
 * Used to reject off-screen paths before drawing them, which is what keeps a
 * 500-path frame cheap when zoomed in.
 */
export function visibleRect(
  vp: Viewport,
  view: Size,
): { x: number; y: number; width: number; height: number } {
  const [x0, y0] = toDocument(vp, 0, 0);
  const [x1, y1] = toDocument(vp, view.width, view.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function rectsIntersect(
  a: [number, number, number, number],
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return !(
    a[2] < b.x ||
    a[0] > b.x + b.width ||
    a[3] < b.y ||
    a[1] > b.y + b.height
  );
}

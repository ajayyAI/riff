/**
 * Selection-handle geometry in screen space.
 *
 * Pure functions over the selection's screen rect, so the math is testable
 * without a canvas. The canvas overlay draws the handles and hit-tests the
 * pointer against the same positions, one definition, two consumers, which
 * is what keeps the hover target exactly on the drawn square.
 */

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Generous grab radius: the glyph stays 7px, the target is bigger. */
export const HANDLE_HIT_RADIUS = 8;

const ORDER: HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Centre of every handle for a screen rect, in fixed order. */
export function handlePositions(
  rect: ScreenRect,
): Record<HandleId, { x: number; y: number }> {
  const { x, y, width, height } = rect;
  const cx = x + width / 2;
  const cy = y + height / 2;
  return {
    nw: { x, y },
    n: { x: cx, y },
    ne: { x: x + width, y },
    e: { x: x + width, y: cy },
    se: { x: x + width, y: y + height },
    s: { x: cx, y: y + height },
    sw: { x, y: y + height },
    w: { x, y: cy },
  };
}

/** Handle under a screen point, or null. First match wins; corners are distinct points so order is irrelevant. */
export function hitHandle(
  rect: ScreenRect,
  px: number,
  py: number,
  radius = HANDLE_HIT_RADIUS,
): HandleId | null {
  const positions = handlePositions(rect);
  for (const id of ORDER) {
    const h = positions[id];
    if (Math.abs(px - h.x) <= radius && Math.abs(py - h.y) <= radius) {
      return id;
    }
  }
  return null;
}

/** Resize cursor per handle, matching every design tool. */
export function cursorForHandle(id: HandleId): string {
  switch (id) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
  }
}

/** The anchor stays put while this handle moves: the opposite corner/edge. */
export function anchorForHandle(
  rect: ScreenRect,
  id: HandleId,
): { x: number; y: number } {
  const positions = handlePositions(rect);
  switch (id) {
    case "nw":
      return positions.se;
    case "n":
      return positions.s;
    case "ne":
      return positions.sw;
    case "e":
      return positions.w;
    case "se":
      return positions.nw;
    case "s":
      return positions.n;
    case "sw":
      return positions.ne;
    case "w":
      return positions.e;
  }
}

/**
 * The rotate grip: a circle floating above the top edge.
 *
 * Outside the box rather than just inside a corner, because inside-the-corner
 * rotation is a convention you have to be told about, and the point of this
 * editor is that nobody has to be told anything.
 */
export const ROTATE_HANDLE_OFFSET = 22;
export const ROTATE_HANDLE_RADIUS = 7;

export function rotateHandlePosition(rect: ScreenRect): {
  x: number;
  y: number;
} {
  return { x: rect.x + rect.width / 2, y: rect.y - ROTATE_HANDLE_OFFSET };
}

export function hitRotateHandle(
  rect: ScreenRect,
  px: number,
  py: number,
  radius = ROTATE_HANDLE_RADIUS + 4,
): boolean {
  const p = rotateHandlePosition(rect);
  return Math.hypot(px - p.x, py - p.y) <= radius;
}

/** Which axes a handle drives. Corners drive both (uniform unless Shift). */
export function axesForHandle(id: HandleId): { x: boolean; y: boolean } {
  switch (id) {
    case "nw":
    case "ne":
    case "se":
    case "sw":
      return { x: true, y: true };
    case "n":
    case "s":
      return { x: false, y: true };
    case "e":
    case "w":
      return { x: true, y: false };
  }
}

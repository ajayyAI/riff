/**
 * 2D vector helpers.
 *
 * Ported from `ref/animation-editor/src/util/math.ts` and
 * `src/util/math/vec2.ts`, MIT, Copyright (c) 2021 Alex Harri Jónsson.
 *
 * What changed: the donor's `Vec2` class becomes a plain `{ x, y }` object. The
 * class keeps an `atOrigin` cache behind getters and setters and allocates on
 * every operation; a vertex editor moving thousands of points per drag cannot
 * pay for that, and riff stores vertices in Float64Arrays regardless.
 */

export interface Vec {
  x: number;
  y: number;
}

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x * (1 - t) + b.x * t,
  y: a.y * (1 - t) + b.y * t,
});
export const distance = (a: Vec, b: Vec): number =>
  Math.hypot(b.x - a.x, b.y - a.y);
export const interpolate = (a: number, b: number, t: number): number =>
  a * (1 - t) + b * t;
export const capToRange = (low: number, high: number, value: number): number =>
  Math.min(high, Math.max(low, value));

/** Rotate `vec` counter-clockwise by `angle` radians about `anchor`. */
export function rotateCCW(
  vec: Vec,
  angle: number,
  anchor: Vec = { x: 0, y: 0 },
): Vec {
  if (angle === 0) return vec;
  const x = vec.x - anchor.x;
  const y = vec.y - anchor.y;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - y * sin + anchor.x, y: x * sin + y * cos + anchor.y };
}

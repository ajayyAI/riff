/**
 * Cubic bezier helpers.
 *
 * Ported from `ref/animation-editor`, MIT, Copyright (c) 2021 Alex Harri
 * Jónsson: `src/util/math/splitCubicBezier.ts` (de Casteljau, credited there to
 * https://stackoverflow.com/a/8405756), `src/util/math.ts`
 * (`interpolateCubicBezier`), and `src/util/math/closestPoint.ts` (coarse scan
 * then golden-section refine, credited there to https://stackoverflow.com/a/44993719).
 *
 * What changed: `Vec2` becomes `{ x, y }` (see `vec.ts`), and `cubicBounds` is
 * new, the donor bounds control polygons, and an editor that draws a selection
 * box around the control points instead of the curve looks broken.
 */

import { distance, type Vec } from "./vec";

export type CubicBezier = [Vec, Vec, Vec, Vec];

export function interpolateCubicBezier(c: CubicBezier, t: number): Vec {
  const [p0, p1, p2, p3] = c;
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * t * u * u;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * p0.x + b * p1.x + d * p2.x + e * p3.x,
    y: a * p0.y + b * p1.y + d * p2.y + e * p3.y,
  };
}

export function splitCubicBezier(
  c: CubicBezier,
  t: number,
): [CubicBezier, CubicBezier] {
  const [p1, p2, p3, p4] = c;
  const x12 = (p2.x - p1.x) * t + p1.x;
  const y12 = (p2.y - p1.y) * t + p1.y;
  const x23 = (p3.x - p2.x) * t + p2.x;
  const y23 = (p3.y - p2.y) * t + p2.y;
  const x34 = (p4.x - p3.x) * t + p3.x;
  const y34 = (p4.y - p3.y) * t + p3.y;
  const x123 = (x23 - x12) * t + x12;
  const y123 = (y23 - y12) * t + y12;
  const x234 = (x34 - x23) * t + x23;
  const y234 = (y34 - y23) * t + y23;
  const x1234 = (x234 - x123) * t + x123;
  const y1234 = (y234 - y123) * t + y123;
  return [
    [p1, { x: x12, y: y12 }, { x: x123, y: y123 }, { x: x1234, y: y1234 }],
    [{ x: x1234, y: y1234 }, { x: x234, y: y234 }, { x: x34, y: y34 }, p4],
  ];
}

export function closestPointOnCubicBezier(
  c: CubicBezier,
  p: Vec,
): { t: number; point: Vec } {
  const scans = 25;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i <= scans; i++) {
    const t = i / scans;
    const d = distance(p, interpolateCubicBezier(c, t));
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  // Golden-section refine inside the winning bracket.
  let lo = Math.max(best - 1 / scans, 0);
  let hi = Math.min(best + 1 / scans, 1);
  const phi = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 40 && hi - lo > 1e-5; i++) {
    const a = hi - (hi - lo) * phi;
    const b = lo + (hi - lo) * phi;
    if (
      distance(p, interpolateCubicBezier(c, a)) <
      distance(p, interpolateCubicBezier(c, b))
    ) {
      hi = b;
    } else {
      lo = a;
    }
  }
  const t = (lo + hi) / 2;
  return { t, point: interpolateCubicBezier(c, t) };
}

/** Tight bounds of the curve itself, from its axis-aligned extrema. */
export function cubicBounds(c: CubicBezier): [number, number, number, number] {
  const ts = [0, 1];
  for (const axis of ["x", "y"] as const) {
    const [p0, p1, p2, p3] = c.map((p) => p[axis]);
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const d = p1 - p0;
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) ts.push(-d / b);
    } else {
      const disc = b * b - 4 * a * d;
      if (disc >= 0) {
        const root = Math.sqrt(disc);
        ts.push((-b + root) / (2 * a), (-b - root) / (2 * a));
      }
    }
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const t of ts) {
    if (t < 0 || t > 1) continue;
    const p = interpolateCubicBezier(c, t);
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return [x0, y0, x1, y1];
}

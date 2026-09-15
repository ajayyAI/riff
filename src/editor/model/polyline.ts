/**
 * Polyline geometry: flatten, simplify, smooth, and join.
 *
 * Everything a rig editor does to freehand marks happens here, on flat
 * `[x0,y0,x1,y1,...]` arrays. Curves are flattened once, at the door, because
 * every useful operation on a hand-drawn shape (join two strokes, union two
 * shapes, decimate a 900-sample stroke) is defined on points and not on beziers,
 * and converting back and forth mid-algorithm is how rounding errors compound.
 *
 * `simplify` is the Ramer-Douglas-Peucker algorithm, written from the standard
 * description rather than ported: it is twenty lines and every port carries the
 * same recursion.
 */

import {
  newId,
  type PathGeometry,
  type PathId,
  type RiffDocument,
} from "./document";

/** A flat run of interleaved x,y coordinates, plus whether it closes. */
export interface Contour {
  points: number[];
  closed: boolean;
  /** Per-point pen pressure in [0,1]. Absent on anything but a brush stroke. */
  pressure?: number[];
}

export const pointCount = (contour: Contour): number =>
  contour.points.length / 2;

// ------------------------------------------------------------------ flattening

/** One cubic bezier, sampled at `steps` even parameter intervals. */
function sampleCubic(
  out: number[],
  x0: number,
  y0: number,
  cx1: number,
  cy1: number,
  cx2: number,
  cy2: number,
  x1: number,
  y1: number,
  steps: number,
): void {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push(
      a * x0 + b * cx1 + c * cx2 + d * x1,
      a * y0 + b * cy1 + c * cy2 + d * y1,
    );
  }
}

/**
 * How many straight segments a curve needs.
 *
 * Chord length over `tolerance`, clamped. Sampling every curve at a fixed count
 * either wastes points on a near-straight segment or visibly facets a tight one.
 */
function stepsFor(chord: number, tolerance: number): number {
  return Math.max(2, Math.min(48, Math.ceil(chord / Math.max(0.5, tolerance))));
}

/** Flatten a path's contours to polylines, in the path's own space. */
export function flattenGeometry(geo: PathGeometry, tolerance = 2): Contour[] {
  const { vertices, tangentsIn, tangentsOut, subpathStarts, subpathClosed } =
    geo;
  const total = vertices.length / 2;
  const out: Contour[] = [];

  for (let s = 0; s < subpathStarts.length; s++) {
    const start = subpathStarts[s];
    const end = s + 1 < subpathStarts.length ? subpathStarts[s + 1] : total;
    const count = end - start;
    if (count <= 0) continue;
    const closed = subpathClosed[s] === 1;

    const points: number[] = [vertices[start * 2], vertices[start * 2 + 1]];
    const segments = closed ? count : count - 1;
    for (let k = 0; k < segments; k++) {
      const a = start + k;
      const b = start + ((k + 1) % count);
      const ax = vertices[a * 2];
      const ay = vertices[a * 2 + 1];
      const bx = vertices[b * 2];
      const by = vertices[b * 2 + 1];
      const o1x = tangentsOut[a * 2];
      const o1y = tangentsOut[a * 2 + 1];
      const i2x = tangentsIn[b * 2];
      const i2y = tangentsIn[b * 2 + 1];
      if (o1x === 0 && o1y === 0 && i2x === 0 && i2y === 0) {
        points.push(bx, by);
        continue;
      }
      sampleCubic(
        points,
        ax,
        ay,
        ax + o1x,
        ay + o1y,
        bx + i2x,
        by + i2y,
        bx,
        by,
        stepsFor(Math.hypot(bx - ax, by - ay), tolerance),
      );
    }
    // A closed contour's last sample is its first; the closed flag says so.
    if (closed && points.length >= 4) {
      points.length -= 2;
    }
    out.push({ points, closed });
  }
  return out;
}

/** Every contour of every path a variant draws, flattened into one list. */
export function flattenPaths(
  doc: RiffDocument,
  pathIds: readonly PathId[],
  tolerance = 2,
): Contour[] {
  const out: Contour[] = [];
  for (const id of pathIds) {
    const geo = doc.paths[id];
    if (geo) out.push(...flattenGeometry(geo, tolerance));
  }
  return out;
}

// ---------------------------------------------------------------- conversion

function boundsOf(
  contours: readonly Contour[],
): [number, number, number, number] {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const contour of contours) {
    for (let i = 0; i < contour.points.length; i += 2) {
      const x = contour.points[i];
      const y = contour.points[i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

/** `d` for a set of polyline contours. Straight segments only, by definition. */
export function contoursToPathData(
  contours: readonly Contour[],
  precision = 2,
): string {
  const f = (v: number) => {
    const r = Number(v.toFixed(precision));
    return Object.is(r, -0) ? "0" : String(r);
  };
  const parts: string[] = [];
  for (const contour of contours) {
    const n = contour.points.length;
    if (n < 4) continue;
    parts.push(`M${f(contour.points[0])} ${f(contour.points[1])}`);
    for (let i = 2; i < n; i += 2) {
      parts.push(`L${f(contour.points[i])} ${f(contour.points[i + 1])}`);
    }
    if (contour.closed) parts.push("Z");
  }
  return parts.join("");
}

/**
 * Build a path from polyline contours.
 *
 * Tangents stay zero: these are straight segments and pretending otherwise would
 * mean inventing curvature the user did not draw. The pen tool is where beziers
 * come from.
 */
export function contoursToGeometry(
  contours: readonly Contour[],
  id: PathId = newId("Path"),
): PathGeometry {
  const usable = contours.filter((c) => c.points.length >= 4);
  let total = 0;
  for (const contour of usable) total += contour.points.length / 2;

  const vertices = new Float64Array(total * 2);
  const zeros = new Float64Array(total * 2);
  const starts = new Uint32Array(usable.length);
  const closed = new Uint8Array(usable.length);
  const hasPressure = usable.some((c) => c.pressure);
  const pressure = hasPressure ? new Float64Array(total) : undefined;

  let cursor = 0;
  usable.forEach((contour, index) => {
    starts[index] = cursor;
    closed[index] = contour.closed ? 1 : 0;
    for (let i = 0; i < contour.points.length; i += 2) {
      vertices[cursor * 2] = contour.points[i];
      vertices[cursor * 2 + 1] = contour.points[i + 1];
      if (pressure) pressure[cursor] = contour.pressure?.[i / 2] ?? 0.5;
      cursor += 1;
    }
  });

  return {
    id,
    d: contoursToPathData(usable),
    vertices,
    tangentsIn: zeros,
    tangentsOut: zeros.slice(),
    subpathStarts: starts,
    subpathClosed: closed,
    bounds: boundsOf(usable),
    ...(pressure ? { pressure } : {}),
  };
}

// ------------------------------------------------------------------ simplify

/** Perpendicular distance from (px,py) to the segment (ax,ay)-(bx,by). */
function segmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq),
  );
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Ramer-Douglas-Peucker, iterative.
 *
 * Iterative rather than recursive because a 4000-sample stroke on a nearly
 * straight line recurses once per point, and a blown stack in a drawing tool
 * loses the drawing.
 */
export function simplifyPoints(
  points: readonly number[],
  epsilon: number,
): number[] {
  const n = points.length / 2;
  if (n < 3 || epsilon <= 0) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];

  while (stack.length > 0) {
    const span = stack.pop();
    if (!span) break;
    const [first, last] = span;
    if (last <= first + 1) continue;
    let worst = 0;
    let worstIndex = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = segmentDistance(
        points[i * 2],
        points[i * 2 + 1],
        points[first * 2],
        points[first * 2 + 1],
        points[last * 2],
        points[last * 2 + 1],
      );
      if (distance > worst) {
        worst = distance;
        worstIndex = i;
      }
    }
    if (worst > epsilon && worstIndex > 0) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  }
  return out;
}

export function simplifyContour(contour: Contour, epsilon: number): Contour {
  return {
    ...contour,
    pressure: undefined,
    points: simplifyPoints(contour.points, epsilon),
  };
}

// -------------------------------------------------------------------- smooth

/**
 * Chaikin corner cutting, one pass per `iterations`.
 *
 * Chosen over a spline fit because it never overshoots: a smoothed silhouette
 * that bulges outside the drawn one reads as the tool having its own opinion.
 */
export function smoothPoints(
  points: readonly number[],
  closed: boolean,
  iterations = 1,
): number[] {
  let current = points.slice();
  for (let pass = 0; pass < iterations; pass++) {
    const n = current.length / 2;
    if (n < 3) return current;
    const next: number[] = [];
    if (!closed) next.push(current[0], current[1]);
    const segments = closed ? n : n - 1;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % n;
      const ax = current[i * 2];
      const ay = current[i * 2 + 1];
      const bx = current[j * 2];
      const by = current[j * 2 + 1];
      next.push(
        ax * 0.75 + bx * 0.25,
        ay * 0.75 + by * 0.25,
        ax * 0.25 + bx * 0.75,
        ay * 0.25 + by * 0.75,
      );
    }
    if (!closed) next.push(current[(n - 1) * 2], current[(n - 1) * 2 + 1]);
    current = next;
  }
  return current;
}

export function smoothContour(contour: Contour, iterations = 1): Contour {
  return {
    ...contour,
    pressure: undefined,
    points: smoothPoints(contour.points, contour.closed, iterations),
  };
}

/**
 * Freehand samples to a drawable line: quadratics through segment midpoints.
 *
 * Ported from the `smoothSamples` of the single-file prototype riff grew out
 * of. Each raw sample becomes a control point and the curve passes through the
 * midpoints, which is the
 * standard way to make a pointer trail read as one confident mark instead of a
 * polyline. Pressure interpolates alongside position.
 */
export function smoothSamples(
  points: readonly number[],
  pressure: readonly number[],
  closed: boolean,
): { points: number[]; pressure: number[] } {
  const n = points.length / 2;
  if (n < 3) {
    return { points: points.slice(), pressure: pressure.slice() };
  }

  const srcX: number[] = [];
  const srcY: number[] = [];
  const srcP: number[] = [];
  for (let i = 0; i < n; i++) {
    srcX.push(points[i * 2]);
    srcY.push(points[i * 2 + 1]);
    srcP.push(pressure[i] ?? 0.5);
  }
  if (closed) {
    srcX.push(srcX[0], srcX[1]);
    srcY.push(srcY[0], srcY[1]);
    srcP.push(srcP[0], srcP[1]);
  }

  const outPoints: number[] = [srcX[0], srcY[0]];
  const outPressure: number[] = [srcP[0]];
  let cx = srcX[0];
  let cy = srcY[0];
  let cp = srcP[0];

  for (let i = 1; i < srcX.length - 1; i++) {
    const mx = (srcX[i] + srcX[i + 1]) / 2;
    const my = (srcY[i] + srcY[i + 1]) / 2;
    const mp = (srcP[i] + srcP[i + 1]) / 2;
    const steps = Math.max(
      2,
      Math.min(
        12,
        Math.ceil(
          (Math.hypot(srcX[i] - cx, srcY[i] - cy) +
            Math.hypot(mx - srcX[i], my - srcY[i])) /
            4,
        ),
      ),
    );
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      outPoints.push(
        u * u * cx + 2 * u * t * srcX[i] + t * t * mx,
        u * u * cy + 2 * u * t * srcY[i] + t * t * my,
      );
      outPressure.push(u * cp + t * mp);
    }
    cx = mx;
    cy = my;
    cp = mp;
  }

  if (!closed) {
    outPoints.push(srcX[srcX.length - 1], srcY[srcY.length - 1]);
    outPressure.push(srcP[srcP.length - 1]);
  }
  return { points: outPoints, pressure: outPressure };
}

// ---------------------------------------------------------------------- join

function endpoints(points: readonly number[]) {
  const n = points.length;
  return {
    startX: points[0],
    startY: points[1],
    endX: points[n - 2],
    endY: points[n - 1],
  };
}

function reversePoints(points: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = points.length - 2; i >= 0; i -= 2) {
    out.push(points[i], points[i + 1]);
  }
  return out;
}

/**
 * Chain open strokes into one closed contour, end to nearest end.
 *
 * This is the answer to "one line cannot finish a body part". Draw the silhouette
 * in three or four passes, select them, and Join walks greedily from the first
 * stroke's tail to whichever remaining endpoint is nearest, reversing strokes as
 * needed, then closes the ring.
 *
 * Greedy rather than optimal on purpose: the strokes were drawn in roughly the
 * order they connect, so nearest-endpoint is right essentially always, and an
 * exact solution to an open travelling-salesman problem is not what anyone wants
 * a drawing tool to spend its time on.
 */
export function joinContours(
  contours: readonly Contour[],
  options: { close?: boolean } = {},
): Contour | null {
  const usable = contours.filter((c) => c.points.length >= 4);
  if (usable.length === 0) return null;
  if (usable.length === 1) {
    return {
      points: usable[0].points.slice(),
      closed: options.close ?? true,
    };
  }

  const remaining = usable.map((c) => c.points.slice());
  const chain = remaining.shift();
  if (!chain) return null;

  while (remaining.length > 0) {
    const tail = endpoints(chain);
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestReversed = false;
    remaining.forEach((candidate, index) => {
      const ends = endpoints(candidate);
      const toStart = Math.hypot(
        ends.startX - tail.endX,
        ends.startY - tail.endY,
      );
      const toEnd = Math.hypot(ends.endX - tail.endX, ends.endY - tail.endY);
      if (toStart < bestDistance) {
        bestDistance = toStart;
        bestIndex = index;
        bestReversed = false;
      }
      if (toEnd < bestDistance) {
        bestDistance = toEnd;
        bestIndex = index;
        bestReversed = true;
      }
    });
    const [next] = remaining.splice(bestIndex, 1);
    chain.push(...(bestReversed ? reversePoints(next) : next));
  }

  return { points: chain, closed: options.close ?? true };
}

// ------------------------------------------------------------------- measures

/** Signed area, doubled. Positive is counter-clockwise in a y-down space. */
export function signedArea(points: readonly number[]): number {
  const n = points.length / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum +=
      points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  return sum / 2;
}

/** Winding-rule containment. Used to decide which boolean result is a hole. */
export function pointInPolygon(
  points: readonly number[],
  x: number,
  y: number,
): boolean {
  const n = points.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Polygon booleans on flattened contours: union, subtract, intersect.
 *
 * Greiner-Hormann, following the structure of Alexander Milevski's MIT
 * implementation (https://github.com/w8r/GreinerHormann), which is itself a
 * direct transcription of the 1998 paper "Efficient clipping of arbitrary
 * polygons" by Gunther Greiner and Kai Hormann. Ported rather than imported:
 * that package returns bare point arrays and knows nothing about riff's path
 * table, and the degeneracy retry below is ours.
 *
 * The known weakness of the algorithm is degenerate contact -- a vertex exactly
 * on the other polygon's edge, or two collinear overlapping edges. Two shapes
 * drawn by hand hit that essentially never; two shapes snapped to a grid hit it
 * constantly. `clipPolygons` therefore retries with a sub-pixel jitter before
 * giving up, which is the standard practical answer and costs nothing when the
 * first attempt succeeds.
 */

import type { Contour } from "./polyline";
import { pointInPolygon, signedArea } from "./polyline";

export type BooleanOp = "union" | "subtract" | "intersect";

interface Vertex {
  x: number;
  y: number;
  next: Vertex;
  prev: Vertex;
  /** The same point on the other polygon. */
  corresponding: Vertex | null;
  isIntersection: boolean;
  isEntry: boolean;
  visited: boolean;
  alpha: number;
}

function makeVertex(x: number, y: number, alpha = 0): Vertex {
  const v = {
    x,
    y,
    corresponding: null,
    isIntersection: alpha > 0,
    isEntry: true,
    visited: false,
    alpha,
  } as unknown as Vertex;
  v.next = v;
  v.prev = v;
  return v;
}

/** Build a circular doubly-linked ring. Returns the first vertex. */
function buildRing(points: readonly number[]): Vertex | null {
  const n = points.length / 2;
  if (n < 3) return null;
  let first: Vertex | null = null;
  let previous: Vertex | null = null;
  for (let i = 0; i < n; i++) {
    const v = makeVertex(points[i * 2], points[i * 2 + 1]);
    if (!first) first = v;
    if (previous) {
      previous.next = v;
      v.prev = previous;
    }
    previous = v;
  }
  if (!first || !previous) return null;
  previous.next = first;
  first.prev = previous;
  return first;
}

function ringToPoints(first: Vertex): number[] {
  const out: number[] = [];
  let v = first;
  do {
    out.push(v.x, v.y);
    v = v.next;
  } while (v !== first);
  return out;
}

/** The next vertex that is not an inserted intersection. */
function nextReal(v: Vertex): Vertex {
  let current = v;
  while (current.isIntersection) current = current.next;
  return current;
}

interface Hit {
  x: number;
  y: number;
  toSource: number;
  toClip: number;
}

function intersectSegments(
  a1: Vertex,
  a2: Vertex,
  b1: Vertex,
  b2: Vertex,
): Hit | null {
  const d = (b2.y - b1.y) * (a2.x - a1.x) - (b2.x - b1.x) * (a2.y - a1.y);
  if (d === 0) return null;
  const toSource =
    ((b2.x - b1.x) * (a1.y - b1.y) - (b2.y - b1.y) * (a1.x - b1.x)) / d;
  const toClip =
    ((a2.x - a1.x) * (a1.y - b1.y) - (a2.y - a1.y) * (a1.x - b1.x)) / d;
  if (toSource <= 0 || toSource >= 1 || toClip <= 0 || toClip >= 1) return null;
  return {
    x: a1.x + toSource * (a2.x - a1.x),
    y: a1.y + toSource * (a2.y - a1.y),
    toSource,
    toClip,
  };
}

/** Splice an intersection into the run between `start` and the next real vertex. */
function insertIntersection(vertex: Vertex, start: Vertex, end: Vertex): void {
  let previous = start;
  while (previous !== end && previous.alpha < vertex.alpha) {
    previous = previous.next;
  }
  vertex.next = previous;
  vertex.prev = previous.prev;
  vertex.prev.next = vertex;
  previous.prev = vertex;
}

function firstUnvisitedIntersection(first: Vertex): Vertex | null {
  let v = first;
  do {
    if (v.isIntersection && !v.visited) return v;
    v = v.next;
  } while (v !== first);
  return null;
}

function markVisited(v: Vertex): void {
  v.visited = true;
  if (v.corresponding && !v.corresponding.visited) {
    v.corresponding.visited = true;
  }
}

function inside(v: Vertex, ring: Vertex): boolean {
  return pointInPolygon(ringToPoints(ring), v.x, v.y);
}

/**
 * One boolean over two simple rings.
 *
 * Returns null when the trace degenerated, which is the caller's signal to
 * retry with a jitter rather than to hand back a broken shape.
 */
function clipRings(
  sourcePoints: readonly number[],
  clipPoints: readonly number[],
  op: BooleanOp,
): number[][] | null {
  const source = buildRing(sourcePoints);
  const clip = buildRing(clipPoints);
  if (!source || !clip) return null;

  // Phase one: find every crossing and splice it into both rings.
  let crossings = 0;
  let sv: Vertex = source;
  do {
    if (!sv.isIntersection) {
      let cv: Vertex = clip;
      do {
        if (!cv.isIntersection) {
          const hit = intersectSegments(
            sv,
            nextReal(sv.next),
            cv,
            nextReal(cv.next),
          );
          if (hit) {
            const a = makeVertex(hit.x, hit.y, hit.toSource);
            const b = makeVertex(hit.x, hit.y, hit.toClip);
            a.corresponding = b;
            b.corresponding = a;
            insertIntersection(a, sv, nextReal(sv.next));
            insertIntersection(b, cv, nextReal(cv.next));
            crossings += 1;
          }
        }
        cv = cv.next;
      } while (cv !== clip);
    }
    sv = sv.next;
  } while (sv !== source);

  const sourceInClip = inside(source, clip);
  const clipInSource = inside(clip, source);

  // Phase two: alternate entry and exit around each ring. The starting parity
  // is the operation's rule XOR whether the ring begins inside the other.
  let sourceForwards = op === "intersect";
  let clipForwards = op !== "union";
  sourceForwards = sourceForwards !== sourceInClip;
  clipForwards = clipForwards !== clipInSource;

  sv = source;
  do {
    if (sv.isIntersection) {
      sv.isEntry = sourceForwards;
      sourceForwards = !sourceForwards;
    }
    sv = sv.next;
  } while (sv !== source);

  let cv2: Vertex = clip;
  do {
    if (cv2.isIntersection) {
      cv2.isEntry = clipForwards;
      clipForwards = !clipForwards;
    }
    cv2 = cv2.next;
  } while (cv2 !== clip);

  // Phase three: walk forwards through entries and backwards through exits,
  // hopping to the other ring at every crossing.
  const rings: number[][] = [];
  const budget = (sourcePoints.length + clipPoints.length) * 4 + 64;
  for (;;) {
    const start = firstUnvisitedIntersection(source);
    if (!start) break;
    let current = start;
    const out: number[] = [current.x, current.y];
    let steps = 0;
    do {
      markVisited(current);
      if (current.isEntry) {
        do {
          current = current.next;
          out.push(current.x, current.y);
          steps += 1;
        } while (!current.isIntersection && steps < budget);
      } else {
        do {
          current = current.prev;
          out.push(current.x, current.y);
          steps += 1;
        } while (!current.isIntersection && steps < budget);
      }
      if (steps >= budget) return null;
      const hop = current.corresponding;
      if (!hop) return null;
      current = hop;
    } while (!current.visited);
    if (out.length >= 6) rings.push(out);
  }

  if (rings.length > 0) return rings;
  if (crossings > 0) return null;

  // No crossings at all: the answer is one of containment or disjointness, and
  // the operation decides which of the two inputs survives.
  const sourceRing = ringToPoints(source);
  const clipRing = ringToPoints(clip);
  if (op === "union") {
    if (sourceInClip) return [clipRing];
    if (clipInSource) return [sourceRing];
    return [sourceRing, clipRing];
  }
  if (op === "intersect") {
    if (sourceInClip) return [sourceRing];
    if (clipInSource) return [clipRing];
    return [];
  }
  if (clipInSource) return [sourceRing, clipRing];
  if (sourceInClip) return [];
  return [sourceRing];
}

function jitter(points: readonly number[], amount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    // Deterministic, so a retry is reproducible and a failing case can be
    // reduced to a test rather than to a shrug.
    const k = i / 2;
    out.push(
      points[i] + Math.sin(k * 12.9898) * amount,
      points[i + 1] + Math.cos(k * 78.233) * amount,
    );
  }
  return out;
}

/**
 * Boolean two sets of closed contours.
 *
 * Each input is treated as one shape under the even-odd rule, which is also how
 * the result is returned: nested rings read as holes without anyone having to
 * agree about winding direction.
 */
export function clipPolygons(
  subject: readonly Contour[],
  clip: readonly Contour[],
  op: BooleanOp,
): Contour[] {
  const subjectRings = subject
    .filter((c) => c.points.length >= 6)
    .map((c) => c.points);
  const clipShapes = clip
    .filter((c) => c.points.length >= 6)
    .map((c) => c.points);
  if (subjectRings.length === 0) {
    return op === "union" ? clipShapes.map(toContour) : [];
  }
  if (clipShapes.length === 0) return subjectRings.map(toContour);

  let accumulated = subjectRings;
  for (const other of clipShapes) {
    const next: number[][] = [];
    for (const ring of accumulated) {
      const result = runWithRetries(ring, other, op);
      next.push(...result);
    }
    accumulated = next;
    if (accumulated.length === 0) break;
  }
  return accumulated
    .filter((ring) => Math.abs(signedArea(ring)) > 1e-6)
    .map(toContour);
}

function toContour(points: number[]): Contour {
  return { points, closed: true };
}

function runWithRetries(
  subject: readonly number[],
  clip: readonly number[],
  op: BooleanOp,
): number[][] {
  for (let attempt = 0; attempt < 4; attempt++) {
    const clipped = attempt === 0 ? clip : jitter(clip, 0.0007 * attempt);
    const result = clipRings(subject, clipped, op);
    if (result) return result;
  }
  // Four failures means genuinely degenerate input. Returning the subject
  // unchanged loses the operation but never loses the artwork.
  return [subject.slice()];
}

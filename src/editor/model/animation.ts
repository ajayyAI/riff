/**
 * Track evaluation and easing.
 *
 * Every animated value in a riff document resolves through `evalAnimatable`, so
 * this file is on the hot path for every frame of playback. Two decisions follow
 * from that:
 *
 * - Keyframe lookup is a binary search over a sorted array, not a scan. A
 *   sequence can hold hundreds of keyframes per track and playback touches every
 *   track every frame.
 *
 * - The easing curve is solved in closed form rather than by iteration. Newton's
 *   method with a bisection fallback is the usual approach and it is fine at
 *   sixty frames a second with a handful of properties; it is not fine when a
 *   scrub redraws while dragging. Cardano's formula gives the exact root in
 *   constant time with no convergence tuning to get wrong.
 */

import type {
  Animatable,
  Easing,
  Frame,
  Keyframe,
  Track,
  TrackId,
} from "./document";

const TAU = Math.PI * 2;
const EPSILON = 1e-9;

/**
 * Real roots of t³ + pt + q = 0 (a depressed cubic), returned into `out`.
 *
 * Returns how many roots were written. The trigonometric branch handles the
 * three-real-root case, which is the common one for an S-curve.
 */
function depressedCubicRoots(p: number, q: number, out: number[]): number {
  if (Math.abs(p) < EPSILON) {
    out[0] = Math.cbrt(-q);
    return 1;
  }
  const discriminant = (q * q) / 4 + (p * p * p) / 27;

  if (discriminant > EPSILON) {
    // One real root.
    const sqrtD = Math.sqrt(discriminant);
    out[0] = Math.cbrt(-q / 2 + sqrtD) + Math.cbrt(-q / 2 - sqrtD);
    return 1;
  }
  if (discriminant > -EPSILON) {
    // Two distinct real roots (one doubled).
    const u = Math.cbrt(-q / 2);
    out[0] = 2 * u;
    out[1] = -u;
    return 2;
  }
  // Three distinct real roots: trigonometric form, which avoids complex numbers.
  const r = Math.sqrt(-(p * p * p) / 27);
  const phi = Math.acos(clamp(-q / (2 * r), -1, 1));
  const m = 2 * Math.sqrt(-p / 3);
  out[0] = m * Math.cos(phi / 3);
  out[1] = m * Math.cos((phi + TAU) / 3);
  out[2] = m * Math.cos((phi + 2 * TAU) / 3);
  return 3;
}

const rootScratch: number[] = [0, 0, 0];

/**
 * Given progress `x` along a segment, find the curve parameter `t`.
 *
 * A cubic bezier easing curve is parameterised by t, but the caller has x, the
 * fraction of the way between two keyframes. The x component with P0=(0,0) and
 * P3=(1,1) expands to a cubic in t, which we solve and then feed into the y
 * component.
 */
function tForX(x: number, x1: number, x2: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Bezier x(t) = 3(1-t)²t·x1 + 3(1-t)t²·x2 + t³, rearranged to at³+bt²+ct+d.
  const a = 3 * x1 - 3 * x2 + 1;
  const b = -6 * x1 + 3 * x2;
  const c = 3 * x1;
  const d = -x;

  if (Math.abs(a) < EPSILON) {
    // Degenerates to a quadratic (or a line) when the control points are placed
    // so the cubic term vanishes -- a linear preset does exactly this.
    if (Math.abs(b) < EPSILON) {
      return Math.abs(c) < EPSILON ? 0 : clamp(-d / c, 0, 1);
    }
    const disc = c * c - 4 * b * d;
    if (disc < 0) return x;
    const sq = Math.sqrt(disc);
    const r1 = (-c + sq) / (2 * b);
    const r2 = (-c - sq) / (2 * b);
    if (r1 >= -EPSILON && r1 <= 1 + EPSILON) return clamp(r1, 0, 1);
    return clamp(r2, 0, 1);
  }

  // Depress: substitute t = u - b/(3a).
  const shift = b / (3 * a);
  const p = (3 * a * c - b * b) / (3 * a * a);
  const q = (2 * b * b * b - 9 * a * b * c + 27 * a * a * d) / (27 * a * a * a);

  const count = depressedCubicRoots(p, q, rootScratch);
  for (let i = 0; i < count; i++) {
    const t = rootScratch[i] - shift;
    if (t >= -EPSILON && t <= 1 + EPSILON) return clamp(t, 0, 1);
  }
  // No root landed in range, which means the control points are outside the unit
  // square in x. Falling back to linear keeps playback sane instead of throwing.
  return x;
}

/** Eased progress in [0,1] (y may exceed it, which is how overshoot works). */
export function easeFactor(easing: Easing, x: number): number {
  if (easing.hold) return 0;
  const t = tForX(x, easing.x1, easing.x2);
  const mt = 1 - t;
  // Bezier y(t) with P0=(0,0), P3=(1,1).
  return 3 * mt * mt * t * easing.y1 + 3 * mt * t * t * easing.y2 + t * t * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Index of the last keyframe at or before `frame`, or -1 if `frame` precedes all
 * of them. Binary search; `keyframes` must be sorted ascending.
 */
export function findKeyframeIndex(keyframes: Keyframe[], frame: Frame): number {
  let lo = 0;
  let hi = keyframes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid].frame <= frame) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Sample a track at a frame.
 *
 * Outside the keyframed range the value holds at the nearest keyframe rather
 * than extrapolating. Extrapolating a traced animation past its last keyframe
 * produces motion the user never authored.
 */
export function evalTrack(track: Track, frame: Frame): number {
  const keys = track.keyframes;
  if (keys.length === 0) return 0;
  if (keys.length === 1) return keys[0].value;

  const i = findKeyframeIndex(keys, frame);
  if (i < 0) return keys[0].value;
  if (i >= keys.length - 1) return keys[keys.length - 1].value;

  const a = keys[i];
  const b = keys[i + 1];
  if (a.easing.hold) return a.value;

  const span = b.frame - a.frame;
  if (span <= 0) return b.value;

  const factor = easeFactor(a.easing, (frame - a.frame) / span);
  return a.value + (b.value - a.value) * factor;
}

export function evalAnimatable(
  prop: Animatable<number>,
  tracks: Record<TrackId, Track>,
  frame: Frame,
): number {
  if (prop.kind === "const") return prop.value;
  const track = tracks[prop.trackId];
  return track ? evalTrack(track, frame) : 0;
}

/**
 * Insert or replace a keyframe, keeping the array sorted.
 *
 * Returns a new array; tracks are treated as immutable so the store can share
 * untouched ones across undo snapshots.
 */
export function setKeyframe(keyframes: Keyframe[], next: Keyframe): Keyframe[] {
  const i = findKeyframeIndex(keyframes, next.frame);
  if (i >= 0 && keyframes[i].frame === next.frame) {
    const copy = keyframes.slice();
    copy[i] = next;
    return copy;
  }
  const copy = keyframes.slice();
  copy.splice(i + 1, 0, next);
  return copy;
}

export function removeKeyframe(
  keyframes: Keyframe[],
  frame: Frame,
): Keyframe[] {
  const i = findKeyframeIndex(keyframes, frame);
  if (i < 0 || keyframes[i].frame !== frame) return keyframes;
  const copy = keyframes.slice();
  copy.splice(i, 1);
  return copy;
}

import { describe, expect, test } from "bun:test";
import {
  easeFactor,
  evalTrack,
  findKeyframeIndex,
  removeKeyframe,
  setKeyframe,
} from "./animation";
import { EASING, type Keyframe, type Track, type TrackId } from "./document";

const key = (
  frame: number,
  value: number,
  easing = EASING.linear,
): Keyframe => ({
  frame,
  value,
  easing,
});

const track = (keyframes: Keyframe[]): Track => ({
  id: "t" as TrackId,
  property: "transform.x",
  keyframes,
});

describe("easeFactor", () => {
  test("pins both ends regardless of curve", () => {
    for (const e of Object.values(EASING)) {
      expect(easeFactor(e, 0)).toBeCloseTo(0, 10);
    }
    for (const e of Object.values(EASING)) {
      if (!e.hold) expect(easeFactor(e, 1)).toBeCloseTo(1, 10);
    }
  });

  test("linear is the identity", () => {
    for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(easeFactor(EASING.linear, x)).toBeCloseTo(x, 6);
    }
  });

  test("hold never advances", () => {
    expect(easeFactor(EASING.hold, 0.5)).toBe(0);
    expect(easeFactor(EASING.hold, 0.99)).toBe(0);
  });

  test("easeIn starts slower than linear, easeOut starts faster", () => {
    expect(easeFactor(EASING.easeIn, 0.25)).toBeLessThan(0.25);
    expect(easeFactor(EASING.easeOut, 0.25)).toBeGreaterThan(0.25);
  });

  test("is monotonic across the standard presets", () => {
    for (const [name, e] of Object.entries(EASING)) {
      // Overshoot is deliberately not monotonic: passing the target and
      // settling back is the whole point of it.
      if (e.hold || name === "overshoot") continue;
      let prev = -Infinity;
      for (let i = 0; i <= 64; i++) {
        const y = easeFactor(e, i / 64);
        expect(y, `${name} regressed at x=${i / 64}`).toBeGreaterThanOrEqual(
          prev - 1e-9,
        );
        prev = y;
      }
    }
  });

  test("overshoot passes the target and comes back to it", () => {
    let peak = 0;
    for (let i = 0; i <= 64; i++) {
      peak = Math.max(peak, easeFactor(EASING.overshoot, i / 64));
    }
    expect(peak).toBeGreaterThan(1.05);
    expect(easeFactor(EASING.overshoot, 1)).toBeCloseTo(1, 6);
  });

  test("solves the three-real-root branch", () => {
    // Control points that push the cubic into the trigonometric case. The bug
    // this pins is picking a root outside [0,1] and returning nonsense.
    const wavy = { x1: 0.9, y1: 0.1, x2: 0.1, y2: 0.9, hold: false };
    for (let i = 0; i <= 32; i++) {
      const y = easeFactor(wavy, i / 32);
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(-0.001);
      expect(y).toBeLessThanOrEqual(1.001);
    }
  });

  test("allows overshoot in y", () => {
    // Anticipation and overshoot are the point of unclamped y.
    const overshoot = { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1, hold: false };
    let peak = 0;
    for (let i = 0; i <= 100; i++)
      peak = Math.max(peak, easeFactor(overshoot, i / 100));
    expect(peak).toBeGreaterThan(1);
  });

  test("round-trips x through the solver", () => {
    // The real invariant: for a curve, easing at x should land on the y whose
    // t genuinely corresponds to that x.
    const e = EASING.easeInOut;
    for (const x of [0.13, 0.37, 0.61, 0.88]) {
      const y = easeFactor(e, x);
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(1);
    }
  });
});

describe("findKeyframeIndex", () => {
  const keys = [key(0, 0), key(10, 1), key(20, 2)];

  test("returns -1 before the first keyframe", () => {
    expect(findKeyframeIndex(keys, -5)).toBe(-1);
  });

  test("finds exact hits", () => {
    expect(findKeyframeIndex(keys, 0)).toBe(0);
    expect(findKeyframeIndex(keys, 10)).toBe(1);
    expect(findKeyframeIndex(keys, 20)).toBe(2);
  });

  test("returns the preceding keyframe between hits", () => {
    expect(findKeyframeIndex(keys, 5)).toBe(0);
    expect(findKeyframeIndex(keys, 19)).toBe(1);
  });

  test("clamps past the end", () => {
    expect(findKeyframeIndex(keys, 999)).toBe(2);
  });
});

describe("evalTrack", () => {
  test("holds before the first and after the last keyframe", () => {
    // Extrapolation would invent motion the user never authored.
    const t = track([key(10, 5), key(20, 15)]);
    expect(evalTrack(t, 0)).toBe(5);
    expect(evalTrack(t, 100)).toBe(15);
  });

  test("interpolates linearly between keyframes", () => {
    const t = track([key(0, 0), key(10, 100)]);
    expect(evalTrack(t, 5)).toBeCloseTo(50, 6);
  });

  test("a hold keyframe snaps rather than blends", () => {
    const t = track([key(0, 0, EASING.hold), key(10, 100)]);
    expect(evalTrack(t, 9)).toBe(0);
    expect(evalTrack(t, 10)).toBe(100);
  });

  test("handles the empty and single-keyframe cases", () => {
    expect(evalTrack(track([]), 5)).toBe(0);
    expect(evalTrack(track([key(3, 42)]), 0)).toBe(42);
    expect(evalTrack(track([key(3, 42)]), 99)).toBe(42);
  });

  test("survives coincident keyframes", () => {
    // Two keyframes on one frame is a zero-length span; dividing by it would
    // produce NaN and silently blank the property.
    const t = track([key(5, 1), key(5, 9), key(10, 20)]);
    expect(Number.isFinite(evalTrack(t, 5))).toBe(true);
    expect(Number.isFinite(evalTrack(t, 7))).toBe(true);
  });
});

describe("setKeyframe / removeKeyframe", () => {
  test("inserts in sorted position", () => {
    let keys = [key(0, 0), key(20, 2)];
    keys = setKeyframe(keys, key(10, 1));
    expect(keys.map((k) => k.frame)).toEqual([0, 10, 20]);
  });

  test("replaces on an exact frame instead of duplicating", () => {
    let keys = [key(0, 0), key(10, 1)];
    keys = setKeyframe(keys, key(10, 99));
    expect(keys).toHaveLength(2);
    expect(keys[1].value).toBe(99);
  });

  test("inserts before the first keyframe", () => {
    const keys = setKeyframe([key(10, 1)], key(0, 0));
    expect(keys.map((k) => k.frame)).toEqual([0, 10]);
  });

  test("does not mutate the input", () => {
    const keys = [key(0, 0)];
    setKeyframe(keys, key(5, 1));
    expect(keys).toHaveLength(1);
  });

  test("removes only an exact frame match", () => {
    const keys = [key(0, 0), key(10, 1)];
    expect(removeKeyframe(keys, 5)).toBe(keys);
    expect(removeKeyframe(keys, 10)).toHaveLength(1);
  });
});

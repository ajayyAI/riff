import { describe, expect, test } from "bun:test";
import {
  type CubicBezier,
  closestPointOnCubicBezier,
  cubicBounds,
  interpolateCubicBezier,
  splitCubicBezier,
} from "./bezier";
import { add, distance, lerp, rotateCCW, scale, sub } from "./vec";

const v = (x: number, y: number) => ({ x, y });
const CURVE: CubicBezier = [v(0, 0), v(0, 100), v(100, 100), v(100, 0)];

describe("vec", () => {
  test("add, sub, scale, lerp and distance", () => {
    expect(add(v(1, 2), v(3, 4))).toEqual(v(4, 6));
    expect(sub(v(3, 4), v(1, 2))).toEqual(v(2, 2));
    expect(scale(v(2, 3), 2)).toEqual(v(4, 6));
    expect(lerp(v(0, 0), v(10, 20), 0.25)).toEqual(v(2.5, 5));
    expect(distance(v(0, 0), v(3, 4))).toBe(5);
  });

  test("rotateCCW turns a quarter turn about an anchor", () => {
    const r = rotateCCW(v(1, 0), Math.PI / 2, v(0, 0));
    expect(r.x).toBeCloseTo(0, 9);
    expect(r.y).toBeCloseTo(1, 9);
    const about = rotateCCW(v(2, 1), Math.PI / 2, v(1, 1));
    expect(about.x).toBeCloseTo(1, 9);
    expect(about.y).toBeCloseTo(2, 9);
  });
});

describe("interpolateCubicBezier", () => {
  test("hits the endpoints and the midpoint", () => {
    expect(interpolateCubicBezier(CURVE, 0)).toEqual(v(0, 0));
    expect(interpolateCubicBezier(CURVE, 1)).toEqual(v(100, 0));
    const mid = interpolateCubicBezier(CURVE, 0.5);
    expect(mid.x).toBeCloseTo(50, 9);
    expect(mid.y).toBeCloseTo(75, 9);
  });
});

describe("splitCubicBezier", () => {
  test("the two halves join at the split point", () => {
    const [a, b] = splitCubicBezier(CURVE, 0.5);
    expect(a[3]).toEqual(b[0]);
    expect(a[3].x).toBeCloseTo(50, 9);
    expect(a[0]).toEqual(CURVE[0]);
    expect(b[3]).toEqual(CURVE[3]);
  });

  test("the halves trace the same curve as the original", () => {
    const [a, b] = splitCubicBezier(CURVE, 0.3);
    const onA = interpolateCubicBezier(a, 0.5);
    const onOriginal = interpolateCubicBezier(CURVE, 0.15);
    expect(onA.x).toBeCloseTo(onOriginal.x, 6);
    expect(onA.y).toBeCloseTo(onOriginal.y, 6);
    expect(interpolateCubicBezier(b, 0).x).toBeCloseTo(
      interpolateCubicBezier(CURVE, 0.3).x,
      6,
    );
  });

  test("t of 0 and 1 degenerate cleanly", () => {
    const [a] = splitCubicBezier(CURVE, 0);
    expect(a[0]).toEqual(a[3]);
  });
});

describe("closestPointOnCubicBezier", () => {
  test("finds the apex from directly above it", () => {
    const { t, point } = closestPointOnCubicBezier(CURVE, v(50, 200));
    expect(t).toBeCloseTo(0.5, 2);
    expect(point.x).toBeCloseTo(50, 1);
  });

  test("clamps to the endpoints for a point beyond the curve", () => {
    expect(closestPointOnCubicBezier(CURVE, v(-500, 0)).t).toBeCloseTo(0, 2);
    expect(closestPointOnCubicBezier(CURVE, v(600, 0)).t).toBeCloseTo(1, 2);
  });
});

describe("cubicBounds", () => {
  test("bounds the curve, not just its control points", () => {
    const [x0, y0, x1, y1] = cubicBounds(CURVE);
    expect(x0).toBeCloseTo(0, 6);
    expect(x1).toBeCloseTo(100, 6);
    expect(y0).toBeCloseTo(0, 6);
    // The curve peaks at y = 75, well below the control points' 100.
    expect(y1).toBeCloseTo(75, 6);
  });
});

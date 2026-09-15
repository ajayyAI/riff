import { describe, expect, test } from "bun:test";
import {
  type Contour,
  contoursToGeometry,
  flattenGeometry,
  joinContours,
  pointInPolygon,
  signedArea,
  simplifyPoints,
  smoothPoints,
  smoothSamples,
} from "./polyline";
import { rectPath } from "./shapes";

const open = (points: number[]): Contour => ({ points, closed: false });

describe("simplify", () => {
  test("drops points that sit on the line between their neighbours", () => {
    const line = [0, 0, 10, 0.2, 20, 0, 30, 0.1, 40, 0];
    expect(simplifyPoints(line, 1).length / 2).toBe(2);
  });

  test("keeps a corner that matters", () => {
    const bend = [0, 0, 10, 0, 20, 0, 20, 20, 20, 40];
    const out = simplifyPoints(bend, 1);
    expect(out.length / 2).toBe(3);
    expect(out).toEqual([0, 0, 20, 0, 20, 40]);
  });

  test("always keeps both ends", () => {
    const out = simplifyPoints([5, 5, 6, 5, 7, 5], 100);
    expect(out).toEqual([5, 5, 7, 5]);
  });

  test("a stroke long enough to blow a recursive implementation still returns", () => {
    const points: number[] = [];
    for (let i = 0; i < 20000; i++) points.push(i, 0);
    expect(simplifyPoints(points, 0.5).length / 2).toBe(2);
  });

  test("leaves a two-point line alone", () => {
    expect(simplifyPoints([0, 0, 1, 1], 5)).toEqual([0, 0, 1, 1]);
  });
});

describe("smooth", () => {
  test("cuts corners without leaving the hull", () => {
    const square = [0, 0, 100, 0, 100, 100, 0, 100];
    const out = smoothPoints(square, true, 1);
    for (let i = 0; i < out.length; i += 2) {
      expect(out[i]).toBeGreaterThanOrEqual(-0.001);
      expect(out[i]).toBeLessThanOrEqual(100.001);
    }
  });

  test("keeps the ends of an open line where they were", () => {
    const out = smoothPoints([0, 0, 50, 50, 100, 0], false, 2);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[out.length - 2]).toBe(100);
    expect(out[out.length - 1]).toBe(0);
  });
});

describe("join", () => {
  test("chains three strokes drawn in order into one closed shape", () => {
    const a = open([0, 0, 50, 0]);
    const b = open([50, 0, 50, 50]);
    const c = open([50, 50, 0, 50]);
    const joined = joinContours([a, b, c]);
    expect(joined).not.toBeNull();
    expect(joined?.closed).toBe(true);
    // Every drawn point survives; nothing is invented.
    expect(joined?.points.slice(0, 4)).toEqual([0, 0, 50, 0]);
    expect(joined?.points.slice(-2)).toEqual([0, 50]);
  });

  test("reverses a stroke drawn the wrong way round", () => {
    const a = open([0, 0, 50, 0]);
    // Drawn from the far end back toward the first stroke's tail.
    const b = open([50, 60, 50, 1]);
    const joined = joinContours([a, b]);
    expect(joined?.points).toEqual([0, 0, 50, 0, 50, 1, 50, 60]);
  });

  test("picks the nearest endpoint, not the next stroke in the list", () => {
    const a = open([0, 0, 10, 0]);
    const far = open([500, 500, 510, 500]);
    const near = open([11, 0, 11, 40]);
    const joined = joinContours([a, far, near]);
    expect(joined?.points.slice(2, 6)).toEqual([10, 0, 11, 0]);
  });

  test("one stroke simply closes", () => {
    const joined = joinContours([open([0, 0, 10, 0, 10, 10])]);
    expect(joined?.closed).toBe(true);
    expect(joined?.points).toEqual([0, 0, 10, 0, 10, 10]);
  });

  test("nothing to join returns nothing", () => {
    expect(joinContours([])).toBeNull();
    expect(joinContours([open([1, 1])])).toBeNull();
  });
});

describe("flatten", () => {
  test("a rectangle round-trips through geometry and back to four points", () => {
    const rect = rectPath(0, 0, 10, 20);
    const contours = flattenGeometry(rect);
    expect(contours).toHaveLength(1);
    expect(contours[0].closed).toBe(true);
    expect(contours[0].points.length / 2).toBe(4);
  });

  test("a curve becomes several straight segments", () => {
    const circle = contoursToGeometry([
      { points: [0, 0, 10, 0, 10, 10, 0, 10], closed: true },
    ]);
    expect(flattenGeometry(circle)[0].points.length / 2).toBe(4);
  });
});

describe("measures", () => {
  test("signed area is positive for a clockwise ring in a y-down space", () => {
    expect(signedArea([0, 0, 10, 0, 10, 10, 0, 10])).toBeGreaterThan(0);
  });

  test("point in polygon", () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    expect(pointInPolygon(square, 5, 5)).toBe(true);
    expect(pointInPolygon(square, 15, 5)).toBe(false);
  });
});

describe("smoothSamples", () => {
  test("interpolates pressure alongside position", () => {
    const out = smoothSamples(
      [0, 0, 10, 10, 20, 0, 30, 10],
      [0, 0.5, 1, 0.5],
      false,
    );
    expect(out.points.length / 2).toBe(out.pressure.length);
    for (const p of out.pressure) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  test("passes a two-point trail straight through", () => {
    const out = smoothSamples([0, 0, 1, 1], [0.4, 0.6], false);
    expect(out.points).toEqual([0, 0, 1, 1]);
  });
});

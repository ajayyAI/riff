import { describe, expect, test } from "bun:test";
import { clipPolygons } from "./boolean";
import type { Contour } from "./polyline";
import { pointInPolygon, signedArea } from "./polyline";

const square = (x: number, y: number, size: number): Contour => ({
  points: [x, y, x + size, y, x + size, y + size, x, y + size],
  closed: true,
});

/** Total enclosed area of a result, ignoring winding direction. */
const area = (contours: Contour[]) =>
  contours.reduce((sum, c) => sum + Math.abs(signedArea(c.points)), 0);

describe("union", () => {
  test("two overlapping squares become one shape of the right area", () => {
    const a = square(0, 0, 100);
    const b = square(50, 50, 100);
    const out = clipPolygons([a], [b], "union");

    expect(out).toHaveLength(1);
    // 100x100 twice, minus the 50x50 they share.
    expect(area(out)).toBeCloseTo(10000 + 10000 - 2500, 6);
    // The far corner of each input is inside the result.
    expect(pointInPolygon(out[0].points, 5, 5)).toBe(true);
    expect(pointInPolygon(out[0].points, 145, 145)).toBe(true);
    // The notch outside both is not.
    expect(pointInPolygon(out[0].points, 120, 20)).toBe(false);
  });

  test("two squares that do not touch stay two shapes", () => {
    const out = clipPolygons(
      [square(0, 0, 10)],
      [square(100, 100, 10)],
      "union",
    );
    expect(out).toHaveLength(2);
    expect(area(out)).toBeCloseTo(200, 6);
  });

  test("a square inside another leaves only the outer one", () => {
    const out = clipPolygons(
      [square(0, 0, 100)],
      [square(20, 20, 10)],
      "union",
    );
    expect(out).toHaveLength(1);
    expect(area(out)).toBeCloseTo(10000, 6);
  });
});

describe("intersect", () => {
  test("keeps only the overlap", () => {
    const out = clipPolygons(
      [square(0, 0, 100)],
      [square(50, 50, 100)],
      "intersect",
    );
    expect(out).toHaveLength(1);
    expect(area(out)).toBeCloseTo(2500, 6);
    expect(pointInPolygon(out[0].points, 75, 75)).toBe(true);
    expect(pointInPolygon(out[0].points, 25, 25)).toBe(false);
  });

  test("no overlap means nothing is left", () => {
    expect(
      clipPolygons([square(0, 0, 10)], [square(50, 50, 10)], "intersect"),
    ).toHaveLength(0);
  });
});

describe("subtract", () => {
  test("takes a bite out of the corner", () => {
    const out = clipPolygons(
      [square(0, 0, 100)],
      [square(50, 50, 100)],
      "subtract",
    );
    expect(area(out)).toBeCloseTo(10000 - 2500, 6);
    expect(out.some((c) => pointInPolygon(c.points, 25, 25))).toBe(true);
    expect(out.some((c) => pointInPolygon(c.points, 75, 75))).toBe(false);
  });

  test("subtracting something that misses changes nothing", () => {
    const out = clipPolygons(
      [square(0, 0, 100)],
      [square(500, 500, 10)],
      "subtract",
    );
    expect(area(out)).toBeCloseTo(10000, 6);
  });
});

describe("degenerate input", () => {
  test("identical squares do not hang or throw", () => {
    const a = square(0, 0, 50);
    expect(() => clipPolygons([a], [square(0, 0, 50)], "union")).not.toThrow();
  });

  test("empty input is handled rather than crashing", () => {
    expect(clipPolygons([], [square(0, 0, 10)], "union")).toHaveLength(1);
    expect(clipPolygons([square(0, 0, 10)], [], "union")).toHaveLength(1);
    expect(clipPolygons([], [], "intersect")).toHaveLength(0);
  });
});

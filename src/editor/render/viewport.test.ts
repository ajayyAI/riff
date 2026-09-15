import { describe, expect, test } from "bun:test";
import {
  centerOn,
  clampScale,
  fitToRect,
  MAX_SCALE,
  MIN_SCALE,
  rectsIntersect,
  toDocument,
  toScreen,
  visibleRect,
  zoomAt,
  zoomBy,
} from "./viewport";

const vp = (x: number, y: number, scale: number) => ({ x, y, scale });

describe("coordinate mapping", () => {
  test("screen and document are inverses", () => {
    const v = vp(37, -14, 2.5);
    for (const [x, y] of [
      [0, 0],
      [100, 250],
      [-40, 17.5],
    ]) {
      const [sx, sy] = toScreen(v, x, y);
      const [dx, dy] = toDocument(v, sx, sy);
      expect(dx).toBeCloseTo(x, 9);
      expect(dy).toBeCloseTo(y, 9);
    }
  });

  test("identity viewport is a no-op", () => {
    expect(toScreen(vp(0, 0, 1), 10, 20)).toEqual([10, 20]);
  });
});

describe("zoomAt", () => {
  test("keeps the anchored document point under the cursor", () => {
    // This is the whole contract. If it fails, artwork slides away from the
    // pointer during a scroll-zoom and the editor feels broken.
    const before = vp(120, -60, 1.3);
    const anchorX = 640;
    const anchorY = 400;
    const docBefore = toDocument(before, anchorX, anchorY);

    const after = zoomAt(before, 4.2, anchorX, anchorY);
    const docAfter = toDocument(after, anchorX, anchorY);

    expect(docAfter[0]).toBeCloseTo(docBefore[0], 9);
    expect(docAfter[1]).toBeCloseTo(docBefore[1], 9);
  });

  test("holds the anchor across a long gesture without drifting", () => {
    // Repeated relative nudges accumulate error; solving for translation does
    // not. Simulate a real scroll: many small steps at one cursor position.
    let v = vp(0, 0, 1);
    const ax = 512;
    const ay = 300;
    const doc0 = toDocument(v, ax, ay);
    // 100 steps of 1.03 reaches ~19x, comfortably inside MAX_SCALE -- going
    // further would clamp, and a clamped round trip is legitimately asymmetric.
    for (let i = 0; i < 100; i++) v = zoomBy(v, 1.03, ax, ay);
    for (let i = 0; i < 100; i++) v = zoomBy(v, 1 / 1.03, ax, ay);
    const doc1 = toDocument(v, ax, ay);

    expect(doc1[0]).toBeCloseTo(doc0[0], 6);
    expect(doc1[1]).toBeCloseTo(doc0[1], 6);
    expect(v.scale).toBeCloseTo(1, 6);
  });

  test("a clamped zoom still holds its anchor", () => {
    // Clamping changes the scale but must not move the anchored point.
    let v = vp(0, 0, 1);
    const doc0 = toDocument(v, 300, 200);
    for (let i = 0; i < 400; i++) v = zoomBy(v, 1.05, 300, 200);
    expect(v.scale).toBe(MAX_SCALE);
    const doc1 = toDocument(v, 300, 200);
    expect(doc1[0]).toBeCloseTo(doc0[0], 6);
    expect(doc1[1]).toBeCloseTo(doc0[1], 6);
  });

  test("clamps scale at both ends and still respects the anchor", () => {
    const v = zoomAt(vp(0, 0, 1), 1e9, 100, 100);
    expect(v.scale).toBe(MAX_SCALE);
    expect(toDocument(v, 100, 100)[0]).toBeCloseTo(100, 6);

    const w = zoomAt(vp(0, 0, 1), 1e-9, 100, 100);
    expect(w.scale).toBe(MIN_SCALE);
  });
});

describe("clampScale", () => {
  test("bounds the range", () => {
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(1e6)).toBe(MAX_SCALE);
    expect(clampScale(2)).toBe(2);
  });
});

describe("fitToRect", () => {
  const view = { width: 1000, height: 600 };

  test("fits by the constraining axis", () => {
    // A wide rect in a wide view is limited by height here.
    const v = fitToRect(view, { x: 0, y: 0, width: 2000, height: 2000 }, 50);
    expect(v.scale).toBeCloseTo(500 / 2000, 6);
  });

  test("centres the rect", () => {
    const rect = { x: 0, y: 0, width: 400, height: 400 };
    const v = fitToRect(view, rect, 0);
    const [x0, y0] = toScreen(v, rect.x, rect.y);
    const [x1, y1] = toScreen(v, rect.x + rect.width, rect.y + rect.height);
    expect((x0 + x1) / 2).toBeCloseTo(view.width / 2, 6);
    expect((y0 + y1) / 2).toBeCloseTo(view.height / 2, 6);
  });

  test("honours a non-zero rect origin", () => {
    const rect = { x: 100, y: 250, width: 400, height: 400 };
    const v = fitToRect(view, rect, 0);
    const [x0, y0] = toScreen(v, rect.x, rect.y);
    const [x1, y1] = toScreen(v, rect.x + rect.width, rect.y + rect.height);
    expect((x0 + x1) / 2).toBeCloseTo(view.width / 2, 6);
    expect((y0 + y1) / 2).toBeCloseTo(view.height / 2, 6);
  });

  test("survives a degenerate rect instead of dividing by zero", () => {
    const v = fitToRect(view, { x: 0, y: 0, width: 0, height: 0 });
    expect(Number.isFinite(v.scale)).toBe(true);
    expect(Number.isFinite(v.x)).toBe(true);
  });
});

describe("centerOn", () => {
  test("centres without altering scale", () => {
    const v = centerOn(
      { width: 800, height: 800 },
      { x: 0, y: 0, width: 100, height: 100 },
      3,
    );
    expect(v.scale).toBe(3);
    const [cx] = toScreen(v, 50, 50);
    expect(cx).toBeCloseTo(400, 6);
  });
});

describe("visibleRect and culling", () => {
  test("reports the document area on screen", () => {
    const r = visibleRect(vp(0, 0, 2), { width: 800, height: 600 });
    expect(r).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  test("accounts for pan", () => {
    const r = visibleRect(vp(-100, -50, 1), { width: 800, height: 600 });
    expect(r.x).toBe(100);
    expect(r.y).toBe(50);
  });

  test("rejects only genuinely off-screen bounds", () => {
    const view = { x: 0, y: 0, width: 100, height: 100 };
    expect(rectsIntersect([10, 10, 20, 20], view)).toBe(true);
    expect(rectsIntersect([-50, -50, -10, -10], view)).toBe(false);
    expect(rectsIntersect([150, 10, 200, 20], view)).toBe(false);
    // Touching the edge counts as visible; excluding it pops shapes at the border.
    expect(rectsIntersect([-10, -10, 0, 0], view)).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import {
  anchorForHandle,
  axesForHandle,
  cursorForHandle,
  handlePositions,
  hitHandle,
  type ScreenRect,
} from "./handles";

const RECT: ScreenRect = { x: 10, y: 20, width: 100, height: 60 };

describe("handlePositions", () => {
  test("corners sit on the rect corners, edges at midpoints", () => {
    const p = handlePositions(RECT);
    expect(p.nw).toEqual({ x: 10, y: 20 });
    expect(p.se).toEqual({ x: 110, y: 80 });
    expect(p.n).toEqual({ x: 60, y: 20 });
    expect(p.e).toEqual({ x: 110, y: 50 });
  });
});

describe("hitHandle", () => {
  test("finds corners and edges", () => {
    expect(hitHandle(RECT, 10, 20)).toBe("nw");
    expect(hitHandle(RECT, 110, 80)).toBe("se");
    expect(hitHandle(RECT, 60, 20)).toBe("n");
    expect(hitHandle(RECT, 110, 50)).toBe("e");
  });

  test("tolerates a few pixels of miss", () => {
    expect(hitHandle(RECT, 14, 24)).toBe("nw");
    expect(hitHandle(RECT, 60, 80)).toBe("s");
  });

  test("returns null away from every handle", () => {
    expect(hitHandle(RECT, 60, 50)).toBeNull();
    expect(hitHandle(RECT, 0, 0)).toBeNull();
  });
});

describe("cursorForHandle", () => {
  test("opposite handles share a cursor", () => {
    expect(cursorForHandle("nw")).toBe(cursorForHandle("se"));
    expect(cursorForHandle("ne")).toBe(cursorForHandle("sw"));
    expect(cursorForHandle("n")).toBe("ns-resize");
    expect(cursorForHandle("e")).toBe("ew-resize");
  });
});

describe("anchorForHandle", () => {
  test("anchors are the opposite corner or edge", () => {
    const p = handlePositions(RECT);
    expect(anchorForHandle(RECT, "nw")).toEqual(p.se);
    expect(anchorForHandle(RECT, "se")).toEqual(p.nw);
    expect(anchorForHandle(RECT, "n")).toEqual(p.s);
    expect(anchorForHandle(RECT, "e")).toEqual(p.w);
  });
});

describe("axesForHandle", () => {
  test("corners drive both axes, edges drive one", () => {
    expect(axesForHandle("se")).toEqual({ x: true, y: true });
    expect(axesForHandle("n")).toEqual({ x: false, y: true });
    expect(axesForHandle("w")).toEqual({ x: true, y: false });
  });
});

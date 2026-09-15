import { describe, expect, test } from "bun:test";
import { collectCandidates, snapAxis, spanOf } from "./snapping";

describe("snapAxis", () => {
  test("snaps the nearest of the two edges and the centre", () => {
    const span = spanOf(98, 198);
    const result = snapAxis(span, [100], 6);
    expect(result.delta).toBe(2);
    expect(result.guide).toBe(100);
  });

  test("the centre can win over an edge", () => {
    const span = spanOf(0, 100);
    // The centre is at 50 and is one away; the left edge is four away.
    const result = snapAxis(span, [51, 4], 6);
    expect(result.delta).toBe(1);
    expect(result.guide).toBe(51);
  });

  test("applies only one correction, never two", () => {
    const span = spanOf(0, 100);
    const result = snapAxis(span, [2, 98], 6);
    expect(Math.abs(result.delta)).toBe(2);
  });

  test("nothing within the tolerance leaves the drag alone", () => {
    expect(snapAxis(spanOf(0, 10), [900], 6)).toEqual({
      delta: 0,
      guide: null,
    });
  });

  test("a zero tolerance turns snapping off", () => {
    expect(snapAxis(spanOf(0, 10), [1], 0).delta).toBe(0);
  });

  test("no candidates is not an error", () => {
    expect(snapAxis(spanOf(0, 10), [], 6).guide).toBeNull();
  });
});

describe("collectCandidates", () => {
  test("offers both edges and the centre of every box", () => {
    const { x, y } = collectCandidates([[0, 10, 100, 30]], null);
    expect(x).toEqual([0, 50, 100]);
    expect(y).toEqual([10, 20, 30]);
  });

  test("includes the artboard, so centring a character is possible", () => {
    const { x, y } = collectCandidates([], { width: 900, height: 600 });
    expect(x).toEqual([0, 450, 900]);
    expect(y).toEqual([0, 300, 600]);
  });
});

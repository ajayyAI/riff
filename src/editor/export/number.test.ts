import { describe, expect, test } from "bun:test";
import { numString, roundTo } from "./number";

describe("roundTo", () => {
  test("rounds to the requested decimal places", () => {
    expect(roundTo(1.2345, 1)).toBe(1.2);
    expect(roundTo(1.2345, 2)).toBe(1.23);
    expect(roundTo(1.6, 0)).toBe(2);
  });

  test("normalises -0 so no output ever contains the string '-0'", () => {
    expect(Object.is(roundTo(-0.04, 1), 0)).toBe(true);
    expect(Object.is(roundTo(-0, 2), 0)).toBe(true);
  });

  test("non-finite input becomes 0 rather than 'NaN' in a file", () => {
    expect(roundTo(Number.NaN, 1)).toBe(0);
    expect(roundTo(Number.POSITIVE_INFINITY, 1)).toBe(0);
  });
});

describe("numString", () => {
  test("emits the shortest round trip, never trailing zeros", () => {
    expect(numString(1.0, 2)).toBe("1");
    expect(numString(1.25, 2)).toBe("1.25");
    expect(numString(-0.001, 1)).toBe("0");
  });
});

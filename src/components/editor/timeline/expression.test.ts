import { describe, expect, test } from "bun:test";
import { parseNumericExpression } from "./expression";

describe("parseNumericExpression", () => {
  test("plain numbers", () => {
    expect(parseNumericExpression("3")).toBe(3);
    expect(parseNumericExpression(" 3.25 ")).toBe(3.25);
    expect(parseNumericExpression(".5")).toBe(0.5);
    expect(parseNumericExpression("-2")).toBe(-2);
  });

  test("arithmetic, with precedence and parentheses", () => {
    expect(parseNumericExpression("120/2")).toBe(60);
    expect(parseNumericExpression("1+2*3")).toBe(7);
    expect(parseNumericExpression("(1+2)*3")).toBe(9);
    expect(parseNumericExpression("10 - 2 - 3")).toBe(5);
    expect(parseNumericExpression("-(2+3)")).toBe(-5);
  });

  test("rejects anything it cannot evaluate rather than guessing", () => {
    for (const bad of [
      "",
      "   ",
      "abc",
      "1+",
      "(1+2",
      "1/0",
      "3s",
      "1 2",
      "alert(1)",
    ]) {
      expect(parseNumericExpression(bad)).toBeNull();
    }
  });
});

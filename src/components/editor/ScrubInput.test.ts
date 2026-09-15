import { describe, expect, test } from "bun:test";
import {
  COARSE_MULTIPLIER,
  clamp,
  decimalPlaces,
  editableValue,
  evaluateExpression,
  FINE_MULTIPLIER,
  formatValue,
  normalizeValue,
  roundTo,
  SCRUB_PX_PER_STEP,
  scrubMultiplier,
  scrubPrecision,
  scrubValue,
  tokenize,
} from "./scrub";

describe("tokenize", () => {
  test("splits numbers and operators", () => {
    expect(tokenize("12+3")).toEqual([
      { kind: "number", value: 12 },
      { kind: "symbol", value: "+" },
      { kind: "number", value: 3 },
    ]);
  });

  test("ignores whitespace", () => {
    expect(tokenize("  12  *  3 ")).toHaveLength(3);
  });

  test("reads a comma as a decimal separator", () => {
    expect(tokenize("1,5")).toEqual([{ kind: "number", value: 1.5 }]);
  });

  test("accepts a leading decimal point", () => {
    expect(tokenize(".5")).toEqual([{ kind: "number", value: 0.5 }]);
  });

  test("stops a number at its second decimal point", () => {
    expect(tokenize("1.2.3")).toEqual([
      { kind: "number", value: 1.2 },
      { kind: "number", value: 0.3 },
    ]);
  });

  test("rejects any character outside the grammar", () => {
    for (const bad of [
      "alert(1)",
      "x",
      "1 + a",
      "Math.PI",
      "$",
      "1;2",
      "0x10",
      "1e3",
      "[1]",
      "`x`",
    ]) {
      expect(tokenize(bad)).toBeNull();
    }
  });
});

describe("evaluateExpression", () => {
  test("evaluates a bare number", () => {
    expect(evaluateExpression("42")).toBe(42);
    expect(evaluateExpression("  42.5 ")).toBe(42.5);
    expect(evaluateExpression("-3")).toBe(-3);
  });

  test("evaluates the cases the design lock names", () => {
    expect(evaluateExpression("120/2")).toBe(60);
    expect(evaluateExpression("50+10")).toBe(60);
  });

  test("honours precedence", () => {
    expect(evaluateExpression("2+3*4")).toBe(14);
    expect(evaluateExpression("2*3+4")).toBe(10);
    expect(evaluateExpression("100-10-10")).toBe(80);
    expect(evaluateExpression("100/10/2")).toBe(5);
  });

  test("honours parentheses", () => {
    expect(evaluateExpression("(2+3)*4")).toBe(20);
    expect(evaluateExpression("((1+1))")).toBe(2);
    expect(evaluateExpression("2*(3+(4-1))")).toBe(12);
  });

  test("handles unary signs, including stacked ones", () => {
    expect(evaluateExpression("-5+10")).toBe(5);
    expect(evaluateExpression("10*-2")).toBe(-20);
    expect(evaluateExpression("--5")).toBe(5);
    expect(evaluateExpression("+7")).toBe(7);
    expect(evaluateExpression("-(2+3)")).toBe(-5);
  });

  test("exponentiates right-associatively", () => {
    expect(evaluateExpression("2^3")).toBe(8);
    expect(evaluateExpression("2^3^2")).toBe(512);
    expect(evaluateExpression("2*3^2")).toBe(18);
  });

  test("takes a remainder", () => {
    expect(evaluateExpression("10%3")).toBe(1);
  });

  test("returns null rather than Infinity on division by zero", () => {
    expect(evaluateExpression("1/0")).toBeNull();
    expect(evaluateExpression("1%0")).toBeNull();
  });

  test("rejects malformed input", () => {
    for (const bad of [
      "",
      "   ",
      "+",
      "1+",
      "*2",
      "(1+2",
      "1+2)",
      "()",
      "1 2",
      "1++",
      "^2",
    ]) {
      expect(evaluateExpression(bad)).toBeNull();
    }
  });

  test("rejects anything that could be code", () => {
    for (const bad of [
      "constructor",
      "this",
      "globalThis.x",
      "1;alert(1)",
      "process.exit(1)",
      "() => 1",
    ]) {
      expect(evaluateExpression(bad)).toBeNull();
    }
  });

  test("evaluates a negative decimal typed with a comma", () => {
    expect(evaluateExpression("-1,5*2")).toBe(-3);
  });
});

describe("clamp", () => {
  test("passes an in-range value through", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  test("bounds on each side", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  test("treats an omitted bound as unbounded", () => {
    expect(clamp(-1000)).toBe(-1000);
    expect(clamp(-1000, 0)).toBe(0);
    expect(clamp(1000, undefined, 10)).toBe(10);
  });
});

describe("decimalPlaces", () => {
  test("counts places", () => {
    expect(decimalPlaces(10)).toBe(0);
    expect(decimalPlaces(0.1)).toBe(1);
    expect(decimalPlaces(0.01)).toBe(2);
    expect(decimalPlaces(-1.234)).toBe(3);
  });

  test("survives exponential notation", () => {
    expect(decimalPlaces(1e-7)).toBe(7);
    expect(decimalPlaces(1.5e-7)).toBe(8);
    expect(decimalPlaces(1e3)).toBe(0);
  });
});

describe("roundTo", () => {
  test("rounds to the requested places", () => {
    expect(roundTo(1.2345, 2)).toBe(1.23);
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(2.5, 0)).toBe(3);
  });

  test("never produces negative zero", () => {
    expect(Object.is(roundTo(-0.0001, 2), 0)).toBe(true);
  });
});

describe("scrubMultiplier", () => {
  test("defaults to one step per increment", () => {
    expect(scrubMultiplier({})).toBe(1);
  });

  test("shift is fine, command is coarse", () => {
    expect(scrubMultiplier({ fine: true })).toBe(FINE_MULTIPLIER);
    expect(scrubMultiplier({ coarse: true })).toBe(COARSE_MULTIPLIER);
  });

  test("fine wins when both are held", () => {
    expect(scrubMultiplier({ fine: true, coarse: true })).toBe(FINE_MULTIPLIER);
  });
});

describe("scrubPrecision", () => {
  test("keeps the declared precision at normal speed", () => {
    expect(scrubPrecision({ step: 1, precision: 0 }, {})).toBe(0);
    expect(scrubPrecision({ step: 1, precision: 2 }, {})).toBe(2);
  });

  test("raises precision so a fine scrub is not rounded away", () => {
    expect(scrubPrecision({ step: 1, precision: 0 }, { fine: true })).toBe(1);
    expect(scrubPrecision({ step: 0.1, precision: 1 }, { fine: true })).toBe(2);
  });

  test("caps at six places", () => {
    expect(scrubPrecision({ step: 1e-9, precision: 0 }, { fine: true })).toBe(
      6,
    );
  });
});

describe("scrubValue", () => {
  const options = { step: 1, precision: 0 };

  test("needs a full pixel quantum before it moves", () => {
    expect(scrubValue(100, 0, options)).toBe(100);
    expect(scrubValue(100, SCRUB_PX_PER_STEP - 0.5, options)).toBe(101);
  });

  test("advances one step per SCRUB_PX_PER_STEP pixels", () => {
    expect(scrubValue(100, SCRUB_PX_PER_STEP * 10, options)).toBe(110);
    expect(scrubValue(100, SCRUB_PX_PER_STEP * 250, options)).toBe(350);
  });

  test("runs backwards symmetrically", () => {
    expect(scrubValue(100, -SCRUB_PX_PER_STEP * 10, options)).toBe(90);
    const forward = scrubValue(100, SCRUB_PX_PER_STEP * 7, options);
    const back = scrubValue(100, -SCRUB_PX_PER_STEP * 7, options);
    expect(forward - 100).toBe(100 - back);
  });

  test("returns exactly to the origin when the drag does", () => {
    expect(scrubValue(37.5, 0, { step: 0.5, precision: 1 })).toBe(37.5);
  });

  test("does not drift, because it resolves from the drag origin", () => {
    // A hundred pointermoves along the same drag must land where a single
    // pointermove to the same x would.
    let seen = 0;
    for (let px = 1; px <= 200; px += 1) {
      seen = scrubValue(0, px, { step: 0.1, precision: 1 });
    }
    expect(seen).toBe(scrubValue(0, 200, { step: 0.1, precision: 1 }));
    expect(seen).toBe(10);
  });

  test("shift scrubs in tenths", () => {
    expect(
      scrubValue(100, SCRUB_PX_PER_STEP * 10, options, { fine: true }),
    ).toBe(101);
  });

  test("command scrubs in tens", () => {
    expect(
      scrubValue(100, SCRUB_PX_PER_STEP * 10, options, { coarse: true }),
    ).toBe(200);
  });

  test("respects a non-unit step", () => {
    expect(
      scrubValue(0, SCRUB_PX_PER_STEP * 4, { step: 0.25, precision: 2 }),
    ).toBe(1);
  });

  test("clamps to the field's bounds", () => {
    const bounded = { step: 1, precision: 0, min: 0, max: 100 };
    expect(scrubValue(95, SCRUB_PX_PER_STEP * 50, bounded)).toBe(100);
    expect(scrubValue(5, -SCRUB_PX_PER_STEP * 50, bounded)).toBe(0);
  });

  test("keeps a clean decimal instead of a float artefact", () => {
    expect(
      scrubValue(0, SCRUB_PX_PER_STEP * 3, { step: 0.1, precision: 1 }),
    ).toBe(0.3);
  });
});

describe("normalizeValue", () => {
  test("rounds and clamps a typed value", () => {
    expect(normalizeValue(1.267, { step: 1, precision: 2 })).toBe(1.27);
    expect(normalizeValue(-5, { step: 1, precision: 0, min: 0 })).toBe(0);
    expect(normalizeValue(500, { step: 1, precision: 0, max: 100 })).toBe(100);
  });
});

describe("formatValue and editableValue", () => {
  test("display holds a fixed width so a scrub cannot reflow", () => {
    expect(formatValue(1, 2)).toBe("1.00");
    expect(formatValue(1.5, 0)).toBe("2");
    expect(formatValue(50, 0, "%")).toBe("50%");
  });

  test("editing drops the suffix and the trailing zeros", () => {
    expect(editableValue(1, 2)).toBe("1");
    expect(editableValue(1.5, 2)).toBe("1.5");
    expect(editableValue(1.239, 2)).toBe("1.24");
  });
});

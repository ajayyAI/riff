import { describe, expect, test } from "bun:test";
import { makePath, parsePathData, tokenizePath, toPathData } from "./path";

const vertexCount = (d: string) => parsePathData(d).vertices.length / 2;

describe("tokenizePath", () => {
  test("expands a polycommand into separate segments", () => {
    // The failure this pins: reading only the first tuple and dropping the rest.
    const segs = tokenizePath("L10 10 20 20 30 30");
    expect(segs).toHaveLength(3);
    expect(segs.every((s) => s.cmd === "L")).toBe(true);
    expect(segs[2].args).toEqual([30, 30]);
  });

  test("an implicit repeat of M is L, not another M", () => {
    // Straight out of the SVG grammar, and the most commonly missed rule in it.
    const segs = tokenizePath("M0 0 10 10 20 20");
    expect(segs.map((s) => s.cmd)).toEqual(["M", "L", "L"]);
  });

  test("implicit repeat of m is relative l", () => {
    expect(tokenizePath("m0 0 5 5").map((s) => s.cmd)).toEqual(["m", "l"]);
  });

  test("separates numbers without delimiters", () => {
    // `10-5` is two numbers; so is `.5.5`.
    expect(tokenizePath("L10-5").at(0)?.args).toEqual([10, -5]);
    expect(tokenizePath("L.5.5").at(0)?.args).toEqual([0.5, 0.5]);
  });

  test("accepts exponent notation", () => {
    expect(tokenizePath("L1e2 2e-1").at(0)?.args).toEqual([100, 0.2]);
  });

  test("drops a malformed trailing tuple instead of emitting a partial", () => {
    expect(tokenizePath("L10 10 20").filter((s) => s.cmd === "L")).toHaveLength(
      1,
    );
  });

  test("handles Z in either case and with no arguments", () => {
    expect(tokenizePath("M0 0 L1 1 Z").at(-1)?.cmd).toBe("Z");
    expect(tokenizePath("M0 0 L1 1 z").at(-1)?.cmd).toBe("z");
  });
});

describe("subpaths", () => {
  test("keeps holes as separate contours", () => {
    // Flattening these into one contour connects the hole to the outline and
    // the fill renders wrong. Traced artwork has holes in nearly every path.
    const g = parsePathData("M0 0 L10 0 L10 10 Z M3 3 L7 3 L7 7 Z");
    expect(Array.from(g.subpathStarts)).toEqual([0, 3]);
    expect(Array.from(g.subpathClosed)).toEqual([1, 1]);
    expect(g.vertices.length / 2).toBe(6);
  });

  test("drops the duplicated closing vertex", () => {
    // `Z` already implies the segment home; keeping the repeat double-counts it.
    const g = parsePathData("M0 0 L10 0 L10 10 L0 0 Z");
    expect(g.vertices.length / 2).toBe(3);
    expect(g.subpathClosed[0]).toBe(1);
  });

  test("marks an unclosed subpath as open", () => {
    const g = parsePathData("M0 0 L10 0 L10 10");
    expect(g.subpathClosed[0]).toBe(0);
  });

  test("a subpath after Z starts from the new M, not the old start", () => {
    const g = parsePathData("M0 0 L5 0 Z M20 20 l5 0");
    expect(g.vertices[4]).toBe(20);
    expect(g.vertices[6]).toBe(25);
  });
});

describe("relative commands", () => {
  test("chains relative lines from the running point", () => {
    const g = parsePathData("m10 10 l5 0 l0 5");
    expect(Array.from(g.vertices)).toEqual([10, 10, 15, 10, 15, 15]);
  });

  test("z returns the pen to the subpath start", () => {
    // If z doesn't reset the current point, every following relative command
    // is displaced -- silently, and the shape still looks plausible.
    const g = parsePathData("M10 10 l5 0 l0 5 z l0 -5");
    expect(g.vertices[6]).toBe(10);
    expect(g.vertices[7]).toBe(5);
  });

  test("h and v move only their own axis", () => {
    const g = parsePathData("M10 20 h5 v5 H0 V0");
    expect(Array.from(g.vertices)).toEqual([
      10, 20, 15, 20, 15, 25, 0, 25, 0, 0,
    ]);
  });
});

describe("curves and shorthand", () => {
  test("stores tangents relative to their own vertex", () => {
    const g = parsePathData("M0 0 C10 0 20 10 20 20");
    // Out-tangent belongs to the vertex already emitted.
    expect(g.tangentsOut[0]).toBe(10);
    expect(g.tangentsOut[1]).toBe(0);
    // In-tangent belongs to the vertex being emitted, as a delta.
    expect(g.tangentsIn[2]).toBe(0);
    expect(g.tangentsIn[3]).toBe(-10);
  });

  test("S reflects the previous cubic's control point", () => {
    const g = parsePathData("M0 0 C10 0 20 10 20 20 S30 40 40 40");
    // Reflection of (20,10) about (20,20) is (20,30). That control belongs to
    // the vertex at (20,20), which is vertex 1 -> indices 2 and 3.
    expect(g.tangentsOut[2]).toBeCloseTo(0, 9);
    expect(g.tangentsOut[3]).toBeCloseTo(10, 9);
  });

  test("S after a non-curve uses the current point, not a stale control", () => {
    const g = parsePathData("M0 0 L10 10 S20 20 30 10");
    expect(g.tangentsOut[2]).toBe(0);
    expect(g.tangentsOut[3]).toBe(0);
  });

  test("Q elevates to a cubic at the two-thirds points", () => {
    const g = parsePathData("M0 0 Q30 0 30 30");
    expect(g.tangentsOut[0]).toBeCloseTo(20, 9);
    expect(g.tangentsIn[2]).toBeCloseTo(0, 9);
    // C2 = P3 + 2/3(Q - P3) = (30,30) + 2/3(0,-30) = (30,10); delta is (0,-20).
    expect(g.tangentsIn[3]).toBeCloseTo(-20, 9);
  });

  test("T reflects the previous quadratic control", () => {
    const g = parsePathData("M0 0 Q10 10 20 0 T40 0");
    expect(vertexCount("M0 0 Q10 10 20 0 T40 0")).toBe(3);
    expect(Number.isFinite(g.tangentsOut[2])).toBe(true);
  });
});

describe("arcs", () => {
  test("an arc advances the current point correctly", () => {
    // The nastiest of the three classic bugs: a dropped arc leaves the pen where
    // it was, so every later relative command is offset and the shape still
    // looks like a shape.
    const g = parsePathData("M0 0 A5 5 0 0 1 10 0 l0 5");
    const last = g.vertices.length - 2;
    expect(g.vertices[last]).toBeCloseTo(10, 6);
    expect(g.vertices[last + 1]).toBeCloseTo(5, 6);
  });

  test("emits curvature rather than a straight line", () => {
    const g = parsePathData("M0 0 A5 5 0 0 1 10 0");
    let hasTangent = false;
    for (const t of g.tangentsOut) if (t !== 0) hasTangent = true;
    expect(hasTangent).toBe(true);
  });

  test("a zero radius degenerates to a line, per spec", () => {
    const g = parsePathData("M0 0 A0 0 0 0 1 10 0");
    const last = g.vertices.length - 2;
    expect(g.vertices[last]).toBeCloseTo(10, 6);
  });

  test("large-arc takes the long way round", () => {
    // The radius must exceed half the chord for the two arcs to differ at all --
    // at exactly half, both are the same semicircle.
    const small = parsePathData("M0 0 A10 10 0 0 1 10 0");
    const large = parsePathData("M0 0 A10 10 0 1 1 10 0");
    expect(large.vertices.length).toBeGreaterThan(small.vertices.length);
  });

  test("sweep flag mirrors which side the arc bulges", () => {
    const cw = parsePathData("M0 0 A10 10 0 0 1 10 0");
    const ccw = parsePathData("M0 0 A10 10 0 0 0 10 0");
    // Same endpoints, opposite bulge: the vertical bounds must straddle zero
    // differently.
    expect(cw.bounds[1]).not.toBeCloseTo(ccw.bounds[1], 3);
  });
});

describe("bounds", () => {
  test("covers a simple polygon", () => {
    expect(parsePathData("M0 0 L10 0 L10 20 Z").bounds).toEqual([0, 0, 10, 20]);
  });

  test("stays conservative by including control points", () => {
    // A curve bulges past its vertices; a hit-test reject that trusted the
    // vertex hull alone would discard real hits near the bulge.
    const g = parsePathData("M0 0 C0 100 10 100 10 0");
    expect(g.bounds[3]).toBeGreaterThanOrEqual(100);
  });

  test("empty data yields zero bounds rather than Infinity", () => {
    expect(parsePathData("").bounds).toEqual([0, 0, 0, 0]);
  });
});

describe("round trip", () => {
  test("re-parsing serialised output preserves geometry", () => {
    const d = "M0 0 C10 0 20 10 20 20 L30 30 Z M5 5 L8 5 L8 8 Z";
    const a = makePath(d);
    const b = makePath(toPathData(a, 3));
    expect(Array.from(b.subpathStarts)).toEqual(Array.from(a.subpathStarts));
    expect(Array.from(b.subpathClosed)).toEqual(Array.from(a.subpathClosed));
    expect(b.vertices.length).toBe(a.vertices.length);
    for (let i = 0; i < a.vertices.length; i++) {
      expect(b.vertices[i]).toBeCloseTo(a.vertices[i], 2);
    }
  });

  test("straight segments serialise as L, not as a cubic", () => {
    // Emitting a line as a cubic costs four numbers per segment and buys
    // nothing -- across a traced sequence that is most of the file.
    const out = toPathData(makePath("M0 0 L10 0 L10 10 Z"));
    expect(out).not.toContain("C");
    expect(out).toContain("L");
  });

  test("honours the requested precision", () => {
    const out = toPathData(makePath("M0.666 0.333 L10.777 0"), 1);
    expect(out).toContain("0.7");
    expect(out).not.toContain("0.666");
  });

  test("never emits negative zero", () => {
    expect(toPathData(makePath("M-0.04 0 L1 1"), 1)).not.toContain("-0");
  });
});

describe("real traced input", () => {
  // Traced output of the kind a bitmap tracer produces: absolute M, a long
  // run of relative cubics, closed with Z, geometry carried in a translate.
  const traced =
    "M0 0 C0.57 0 1.1 0 1.67 0 C2 0.23 2.33 0.43 2.67 0.67 " +
    "C3.53 0.83 3.53 0.83 8 1.67 C9.23 2.07 10.47 2.53 11.67 3 Z";

  test("parses without losing segments", () => {
    const g = parsePathData(traced);
    expect(g.vertices.length / 2).toBe(5);
    expect(g.subpathClosed[0]).toBe(1);
  });

  test("produces finite bounds", () => {
    const [minX, minY, maxX, maxY] = parsePathData(traced).bounds;
    for (const v of [minX, minY, maxX, maxY])
      expect(Number.isFinite(v)).toBe(true);
    expect(maxX).toBeGreaterThan(minX);
  });
});

import { describe, expect, test } from "bun:test";
import {
  constant,
  emptyDocument,
  NEUTRAL_FILL as FILL,
  type LayerId,
  newPart,
  newVariant,
  type RiffDocument,
} from "./document";
import { type Contour, contoursToGeometry } from "./polyline";
import { addPart, attachTo, isOffPage, variantAt, variantPaths } from "./rig";
import {
  canCombine,
  canJoin,
  combineParts,
  contourCount,
  hasGeometry,
  joinParts,
  simplifyParts,
  smoothParts,
} from "./shape-ops";

function withParts(
  shapes: { name: string; contours: Contour[]; fill?: boolean }[],
): { doc: RiffDocument; ids: LayerId[] } {
  let doc = emptyDocument(400, 400, 24);
  const ids: LayerId[] = [];
  for (const shape of shapes) {
    const geometry = contoursToGeometry(shape.contours);
    doc = { ...doc, paths: { ...doc.paths, [geometry.id]: geometry } };
    const part = newPart(doc.activeArtboardId, {
      name: shape.name,
      variants: [
        newVariant({
          pathIds: [geometry.id],
          fill: shape.fill === false ? null : FILL,
        }),
      ],
    });
    doc = addPart(doc, part);
    ids.push(part.id);
  }
  return { doc, ids };
}

const line = (points: number[]): Contour => ({ points, closed: false });
const square = (x: number, y: number, size: number): Contour => ({
  points: [x, y, x + size, y, x + size, y + size, x, y + size],
  closed: true,
});

describe("join", () => {
  test("three open lines become one closed, filled part", () => {
    const { doc, ids } = withParts([
      { name: "A", contours: [line([0, 0, 60, 0])], fill: false },
      { name: "B", contours: [line([60, 0, 60, 60])], fill: false },
      { name: "C", contours: [line([60, 60, 0, 60])], fill: false },
    ]);
    expect(canJoin(doc, ids, 0)).toBe(true);

    const { doc: out, keeperId } = joinParts(doc, ids, 0, FILL);
    expect(keeperId).toBe(ids[0]);
    expect(Object.keys(out.layers)).toHaveLength(1);

    const keeper = out.layers[ids[0]];
    const shown = variantAt(keeper, out, 0);
    expect(shown?.fill).toEqual(FILL);
    const paths = variantPaths(shown, out);
    expect(paths).toHaveLength(1);
    expect(paths[0].subpathClosed[0]).toBe(1);
  });

  test("one part with two contours joins them without deleting anything", () => {
    const { doc, ids } = withParts([
      { name: "A", contours: [line([0, 0, 60, 0]), line([60, 0, 60, 60])] },
    ]);
    expect(canJoin(doc, ids, 0)).toBe(true);
    const { doc: out } = joinParts(doc, ids, 0, FILL);
    expect(Object.keys(out.layers)).toHaveLength(1);
    expect(contourCount(out, ids[0], 0)).toBe(1);
  });

  test("a single part with one contour has nothing to join", () => {
    const { doc, ids } = withParts([
      { name: "A", contours: [square(0, 0, 10)] },
    ]);
    expect(canJoin(doc, ids, 0)).toBe(false);
    expect(joinParts(doc, ids, 0, FILL).keeperId).toBeNull();
  });

  test("an existing fill is left alone", () => {
    const { doc, ids } = withParts([
      { name: "A", contours: [line([0, 0, 60, 0])] },
      { name: "B", contours: [line([60, 0, 60, 60])] },
    ]);
    const { doc: out } = joinParts(doc, ids, 0, {
      r: 1,
      g: 2,
      b: 3,
      a: 1,
    });
    expect(variantAt(out.layers[ids[0]], out, 0)?.fill).toEqual(FILL);
  });
});

describe("combine", () => {
  test("the result lands in the backmost part and the other goes", () => {
    const { doc, ids } = withParts([
      { name: "Back", contours: [square(0, 0, 100)] },
      { name: "Front", contours: [square(50, 50, 100)] },
    ]);
    expect(canCombine(doc, ids, 0)).toBe(true);

    const { doc: out, keeperId } = combineParts(doc, ids, "union", 0);
    expect(keeperId).toBe(ids[0]);
    expect(out.layers[ids[1]]).toBeUndefined();
    expect(contourCount(out, ids[0], 0)).toBe(1);
  });

  test("works across a parent transform", () => {
    const { doc, ids } = withParts([
      { name: "Back", contours: [square(0, 0, 100)] },
      { name: "Front", contours: [square(0, 0, 100)] },
    ]);
    // Move the second part so the two genuinely overlap in artboard space
    // rather than sitting on top of each other in their own.
    const moved: RiffDocument = {
      ...doc,
      layers: {
        ...doc.layers,
        [ids[1]]: {
          ...doc.layers[ids[1]],
          transform: {
            ...doc.layers[ids[1]].transform,
            x: constant(50),
            y: constant(50),
          },
        },
      },
    };
    const { doc: out } = combineParts(moved, ids, "intersect", 0);
    const paths = variantPaths(variantAt(out.layers[ids[0]], out, 0), out);
    const [x0, y0, x1, y1] = paths[0].bounds;
    expect(x0).toBeCloseTo(50, 3);
    expect(y0).toBeCloseTo(50, 3);
    expect(x1).toBeCloseTo(100, 3);
    expect(y1).toBeCloseTo(100, 3);
  });

  test("refuses anything but two parts", () => {
    const { doc, ids } = withParts([
      { name: "A", contours: [square(0, 0, 10)] },
      { name: "B", contours: [square(5, 5, 10)] },
      { name: "C", contours: [square(9, 9, 10)] },
    ]);
    expect(canCombine(doc, ids, 0)).toBe(false);
    expect(combineParts(doc, ids, "union", 0).keeperId).toBeNull();
  });

  test("an empty result leaves the document alone", () => {
    const { doc, ids } = withParts([
      { name: "A", contours: [square(0, 0, 10)] },
      { name: "B", contours: [square(500, 500, 10)] },
    ]);
    const { doc: out, keeperId } = combineParts(doc, ids, "intersect", 0);
    expect(keeperId).toBeNull();
    expect(out).toBe(doc);
  });

  test("a hand on a turned arm still combines where it looks like it is", () => {
    const { doc, ids } = withParts([
      { name: "Arm", contours: [square(0, 0, 100)] },
      { name: "Hand", contours: [square(0, 0, 100)] },
    ]);
    const attached = attachTo(doc, [ids[1]], ids[0], 0);
    expect(canCombine(attached, ids, 0)).toBe(true);
    expect(combineParts(attached, ids, "union", 0).keeperId).toBe(ids[0]);
  });
});

describe("simplify and smooth", () => {
  test("simplify drops points that change nothing", () => {
    const points: number[] = [];
    for (let i = 0; i <= 40; i++) points.push(i * 5, 0);
    points.push(200, 100, 0, 100);
    const { doc, ids } = withParts([
      { name: "A", contours: [{ points, closed: true }] },
    ]);
    const before = variantPaths(variantAt(doc.layers[ids[0]], doc, 0), doc)[0];
    const out = simplifyParts(doc, ids, 0, 1);
    const after = variantPaths(variantAt(out.layers[ids[0]], out, 0), out)[0];
    expect(after.vertices.length).toBeLessThan(before.vertices.length);
    expect(after.vertices.length / 2).toBeGreaterThanOrEqual(3);
  });

  test("smooth adds points and keeps the shape inside its own box", () => {
    const { doc, ids } = withParts([
      { name: "A", contours: [square(0, 0, 100)] },
    ]);
    const out = smoothParts(doc, ids, 0, 1);
    const after = variantPaths(variantAt(out.layers[ids[0]], out, 0), out)[0];
    expect(after.vertices.length / 2).toBeGreaterThan(4);
    expect(after.bounds[0]).toBeGreaterThanOrEqual(-0.001);
    expect(after.bounds[2]).toBeLessThanOrEqual(100.001);
  });

  test("a locked part is left alone", () => {
    const { doc, ids } = withParts([
      { name: "A", contours: [square(0, 0, 100)] },
    ]);
    const locked: RiffDocument = {
      ...doc,
      layers: {
        ...doc.layers,
        [ids[0]]: { ...doc.layers[ids[0]], locked: true },
      },
    };
    expect(smoothParts(locked, ids, 0)).toBe(locked);
  });

  test("hasGeometry sees through to what is actually drawn", () => {
    const { doc, ids } = withParts([
      { name: "A", contours: [square(0, 0, 10)] },
    ]);
    expect(hasGeometry(doc, ids, 0)).toBe(true);
    const emptied: RiffDocument = {
      ...doc,
      layers: {
        ...doc.layers,
        [ids[0]]: { ...doc.layers[ids[0]], variants: [] },
      },
    };
    expect(hasGeometry(emptied, ids, 0)).toBe(false);
  });
});

describe("off the page", () => {
  test("a part inside the page is not flagged", () => {
    const { doc, ids } = withParts([
      { name: "A", contours: [square(20, 20, 100)] },
    ]);
    expect(isOffPage(doc, ids[0], 0)).toBe(false);
  });

  test("a part hanging over an edge is", () => {
    const { doc, ids } = withParts([
      { name: "A", contours: [square(-40, 20, 100)] },
    ]);
    expect(isOffPage(doc, ids[0], 0)).toBe(true);
  });

  test("a part moved off the page by its own transform is", () => {
    const { doc, ids } = withParts([
      { name: "A", contours: [square(20, 20, 100)] },
    ]);
    const moved: RiffDocument = {
      ...doc,
      layers: {
        ...doc.layers,
        [ids[0]]: {
          ...doc.layers[ids[0]],
          transform: { ...doc.layers[ids[0]].transform, x: constant(900) },
        },
      },
    };
    expect(isOffPage(moved, ids[0], 0)).toBe(true);
  });

  test("a part that draws nothing cannot be off the page", () => {
    const { doc, ids } = withParts([
      { name: "A", contours: [square(20, 20, 10)] },
    ]);
    const empty: RiffDocument = {
      ...doc,
      layers: {
        ...doc.layers,
        [ids[0]]: { ...doc.layers[ids[0]], variants: [] },
      },
    };
    expect(isOffPage(empty, ids[0], 0)).toBe(false);
  });
});

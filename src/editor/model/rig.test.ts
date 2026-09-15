import { describe, expect, test } from "bun:test";
import {
  constant,
  emptyDocument,
  type LayerId,
  newPart,
  type RiffDocument,
} from "./document";
import {
  addPart,
  ancestors,
  attachTo,
  composeLayerMatrix,
  deleteParts,
  duplicateParts,
  isDescendant,
  jointPosition,
  mirrorAxisFor,
  moveInDrawOrder,
  treeOrder,
  variantAt,
  worldMatrix,
} from "./rig";
import { sampleDocument } from "./sample";

/** Three parts in a chain: torso at the origin, arm on it, hand on the arm. */
function chain() {
  let doc = emptyDocument(400, 400, 24);
  const artboardId = doc.activeArtboardId;

  const torso = newPart(artboardId, {
    name: "Torso",
    pivot: { x: 0, y: 0 },
    variants: [],
  });
  const arm = newPart(artboardId, {
    name: "Arm",
    parentLayerId: torso.id,
    pivot: { x: 100, y: 0 },
    variants: [],
  });
  const hand = newPart(artboardId, {
    name: "Hand",
    parentLayerId: arm.id,
    pivot: { x: 200, y: 0 },
    variants: [],
  });

  doc = addPart(doc, torso);
  doc = addPart(doc, arm);
  doc = addPart(doc, hand);
  return { doc, torso: torso.id, arm: arm.id, hand: hand.id };
}

function rotate(doc: RiffDocument, id: LayerId, degrees: number): RiffDocument {
  const layer = doc.layers[id];
  if (!layer) throw new Error("no layer");
  return {
    ...doc,
    layers: {
      ...doc.layers,
      [id]: {
        ...layer,
        transform: { ...layer.transform, rotation: constant(degrees) },
      },
    },
  };
}

describe("composeLayerMatrix", () => {
  test("puts the joint at position plus joint, whatever the joint is", () => {
    const m = composeLayerMatrix(10, 20, 0, 1, 1, 55, -7);
    expect(m.e + 55).toBeCloseTo(10 + 55, 10);
    expect(m.f - 7).toBeCloseTo(20 - 7, 10);
  });

  test("moving the joint alone never moves the artwork at rest", () => {
    const a = composeLayerMatrix(3, 4, 0, 1, 1, 0, 0);
    const b = composeLayerMatrix(3, 4, 0, 1, 1, 90, 120);
    expect(b.e).toBeCloseTo(a.e, 10);
    expect(b.f).toBeCloseTo(a.f, 10);
  });

  test("rotates about the joint, not the origin", () => {
    const m = composeLayerMatrix(0, 0, 90, 1, 1, 100, 0);
    // The joint is the fixed point of the rotation.
    expect(m.a * 100 + m.c * 0 + m.e).toBeCloseTo(100, 10);
    expect(m.b * 100 + m.d * 0 + m.f).toBeCloseTo(0, 10);
  });
});

describe("forward kinematics", () => {
  test("a child follows its parent's rotation", () => {
    const { doc, arm, hand } = chain();
    const posed = rotate(doc, arm, 90);

    // The arm turns about its own joint at (100, 0). The hand's joint at
    // (200, 0) therefore swings to (100, 100) in a y-down space.
    const [hx, hy] = jointPosition(posed.layers[hand], posed, 0);
    expect(hx).toBeCloseTo(100, 6);
    expect(hy).toBeCloseTo(100, 6);
  });

  test("a parent does not move when its child rotates", () => {
    const { doc, arm, hand } = chain();
    const posed = rotate(doc, hand, 75);
    const [ax, ay] = jointPosition(posed.layers[arm], posed, 0);
    expect(ax).toBeCloseTo(100, 6);
    expect(ay).toBeCloseTo(0, 6);
  });

  test("rotations compose down the chain", () => {
    const { doc, arm, hand } = chain();
    let posed = rotate(doc, arm, 90);
    posed = rotate(posed, hand, 90);
    const m = worldMatrix(posed.layers[hand], posed, 0);
    // Two right angles about the y-down z axis make a half turn.
    expect(m.a).toBeCloseTo(-1, 6);
    expect(m.d).toBeCloseTo(-1, 6);
  });

  test("a parent cycle resolves instead of hanging", () => {
    const { doc, arm, torso } = chain();
    const broken: RiffDocument = {
      ...doc,
      layers: {
        ...doc.layers,
        [torso]: { ...doc.layers[torso], parentLayerId: arm },
      },
    };
    expect(() => worldMatrix(broken.layers[arm], broken, 0)).not.toThrow();
  });
});

describe("the skeleton", () => {
  test("ancestors run nearest first", () => {
    const { doc, torso, arm, hand } = chain();
    expect(ancestors(doc, hand)).toEqual([arm, torso]);
  });

  test("attaching refuses a cycle", () => {
    const { doc, arm, hand } = chain();
    const out = attachTo(doc, [arm], hand, 0);
    expect(out.layers[arm].parentLayerId).toBe(doc.layers[arm].parentLayerId);
  });

  test("attaching keeps the part where it was on screen", () => {
    let { doc, torso, hand } = chain();
    doc = rotate(doc, torso, 30);
    const before = jointPosition(doc.layers[hand], doc, 0);
    const after = attachTo(doc, [hand], null, 0);
    const moved = jointPosition(after.layers[hand], after, 0);
    expect(moved[0]).toBeCloseTo(before[0], 6);
    expect(moved[1]).toBeCloseTo(before[1], 6);
  });

  test("isDescendant sees the whole chain", () => {
    const { doc, torso, hand } = chain();
    expect(isDescendant(doc, hand, torso)).toBe(true);
    expect(isDescendant(doc, torso, hand)).toBe(false);
  });

  test("deleting a part re-attaches its children to its own parent", () => {
    const { doc, torso, arm, hand } = chain();
    const out = deleteParts(doc, [arm], 0);
    expect(out.layers[arm]).toBeUndefined();
    expect(out.layers[hand].parentLayerId).toBe(torso);
  });
});

describe("draw order", () => {
  test("is independent of the skeleton", () => {
    const { doc, torso, hand } = chain();
    const out = moveInDrawOrder(doc, [hand], "back");
    const ids = out.artboards[out.activeArtboardId].layerIds;
    expect(ids[0]).toBe(hand);
    // The hand still hangs off the arm even though it now draws behind it.
    expect(out.layers[hand].parentLayerId).not.toBe(null);
    expect(isDescendant(out, hand, torso)).toBe(true);
  });

  test("to front puts the selection on top", () => {
    const { doc, torso } = chain();
    const out = moveInDrawOrder(doc, [torso], "front");
    const ids = out.artboards[out.activeArtboardId].layerIds;
    expect(ids[ids.length - 1]).toBe(torso);
  });
});

describe("variants", () => {
  test("an out-of-range index clamps rather than blanking the part", () => {
    const doc = emptyDocument();
    const part = newPart(doc.activeArtboardId, { variant: constant(9) });
    const withPart = addPart(doc, part);
    expect(variantAt(part, withPart, 0)).toBe(part.variants[0]);
  });
});

describe("slant", () => {
  test("no slant composes exactly as before", () => {
    const plain = composeLayerMatrix(3, 4, 30, 1.5, 0.5, 10, 20);
    const zeroed = composeLayerMatrix(3, 4, 30, 1.5, 0.5, 10, 20, 0, 0);
    expect(zeroed).toEqual(plain);
  });

  test("shears along x without moving the joint", () => {
    const m = composeLayerMatrix(0, 0, 0, 1, 1, 50, 50, 45, 0);
    // The joint is still the fixed point.
    expect(m.a * 50 + m.c * 50 + m.e).toBeCloseTo(50, 6);
    expect(m.b * 50 + m.d * 50 + m.f).toBeCloseTo(50, 6);
    // A point below the joint slides sideways by its distance at 45 degrees.
    expect(m.a * 50 + m.c * 100 + m.e).toBeCloseTo(100, 6);
  });

  test("clamps short of the angle where a part would vanish", () => {
    const m = composeLayerMatrix(0, 0, 0, 1, 1, 0, 0, 89.999, 0);
    expect(Number.isFinite(m.c)).toBe(true);
    expect(Math.abs(m.c)).toBeLessThan(10);
  });
});

describe("the parts tree", () => {
  test("nests the sample the way the rig is built", () => {
    const doc = sampleDocument();
    const byName = (id: LayerId) => doc.layers[id]?.name ?? "?";
    const shown = treeOrder(doc).map(
      (node) => `${"  ".repeat(node.depth)}${byName(node.id)}`,
    );
    expect(shown).toEqual([
      "Torso",
      "  Head",
      "    Face",
      "  Leg",
      "  Upper arm",
      "    Forearm",
      "      Hand",
    ]);
  });

  test("marks exactly the parts something hangs off", () => {
    const doc = sampleDocument();
    const withChildren = treeOrder(doc)
      .filter((node) => node.hasChildren)
      .map((node) => doc.layers[node.id]?.name);
    expect(withChildren).toEqual(["Torso", "Head", "Upper arm", "Forearm"]);
  });

  test("siblings are listed front of the stack first", () => {
    const { doc, torso, arm, hand } = chain();
    // Detach both so they are siblings, then put the hand in front.
    let flat = attachTo(doc, [arm, hand], null, 0);
    flat = moveInDrawOrder(flat, [hand], "front");
    expect(treeOrder(flat).map((n) => n.id)).toEqual([hand, arm, torso]);
  });

  test("a part whose parent is missing is shown rather than dropped", () => {
    const { doc, hand } = chain();
    const orphaned: RiffDocument = {
      ...doc,
      layers: {
        ...doc.layers,
        [hand]: {
          ...doc.layers[hand],
          parentLayerId: "Layer_missing" as LayerId,
        },
      },
    };
    expect(treeOrder(orphaned).map((n) => n.id)).toContain(hand);
    expect(treeOrder(orphaned)).toHaveLength(3);
  });

  test("a parent cycle does not hang or lose a part", () => {
    const { doc, torso, arm } = chain();
    const looped: RiffDocument = {
      ...doc,
      layers: {
        ...doc.layers,
        [torso]: { ...doc.layers[torso], parentLayerId: arm },
      },
    };
    expect(treeOrder(looped)).toHaveLength(3);
  });
});

describe("mirror", () => {
  test("carries the whole chain, nested the same way", () => {
    const { doc, torso, arm, hand } = chain();
    const { doc: out, created } = duplicateParts(doc, [arm], {
      frame: 0,
      mirrorAxis: mirrorAxisFor(doc, arm),
    });

    expect(created).toHaveLength(2);
    const names = created.map((id) => out.layers[id]?.name);
    expect(names).toContain("Arm mirrored");
    expect(names).toContain("Hand mirrored");

    const copiedArm = created.find(
      (id) => out.layers[id]?.name === "Arm mirrored",
    );
    const copiedHand = created.find(
      (id) => out.layers[id]?.name === "Hand mirrored",
    );
    if (!copiedArm || !copiedHand) throw new Error("missing copy");

    // The copied hand hangs off the copied arm, not the original one.
    expect(out.layers[copiedHand].parentLayerId).toBe(copiedArm);
    expect(out.layers[copiedArm].parentLayerId).toBe(torso);
    // The original chain is untouched.
    expect(out.layers[hand].parentLayerId).toBe(arm);
  });

  test("puts the copied chain on the other side of the joint", () => {
    const { doc, arm, hand } = chain();
    const axis = mirrorAxisFor(doc, arm); // the torso's joint, at x = 0
    const { doc: out, created } = duplicateParts(doc, [arm], {
      frame: 0,
      mirrorAxis: axis,
    });
    const copiedHand = created.find(
      (id) => out.layers[id]?.name === "Hand mirrored",
    );
    if (!copiedHand) throw new Error("missing copy");

    const [hx] = jointPosition(out.layers[hand], out, 0);
    const [mx, my] = jointPosition(out.layers[copiedHand], out, 0);
    expect(mx).toBeCloseTo(2 * axis - hx, 6);
    expect(my).toBeCloseTo(jointPosition(out.layers[hand], out, 0)[1], 6);
  });

  test("a mirrored chain still poses from its own joints", () => {
    const { doc, arm } = chain();
    const { doc: out, created } = duplicateParts(doc, [arm], {
      frame: 0,
      mirrorAxis: mirrorAxisFor(doc, arm),
    });
    const copiedArm = created.find(
      (id) => out.layers[id]?.name === "Arm mirrored",
    );
    const copiedHand = created.find(
      (id) => out.layers[id]?.name === "Hand mirrored",
    );
    if (!copiedArm || !copiedHand) throw new Error("missing copy");

    const before = jointPosition(out.layers[copiedArm], out, 0);
    const posed = rotate(out, copiedArm, 90);
    // The copy's own joint is the fixed point of its own rotation.
    const after = jointPosition(posed.layers[copiedArm], posed, 0);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
    // And the copied hand moved with it.
    const handBefore = jointPosition(out.layers[copiedHand], out, 0);
    const handAfter = jointPosition(posed.layers[copiedHand], posed, 0);
    expect(handAfter[0]).not.toBeCloseTo(handBefore[0], 3);
  });

  test("a plain duplicate still copies only what was asked for", () => {
    const { doc, arm } = chain();
    const { created } = duplicateParts(doc, [arm], { frame: 0 });
    expect(created).toHaveLength(1);
  });
});

import { describe, expect, test } from "bun:test";
import { evalAnimatable } from "@/editor/model/animation";
import {
  applyMatrix,
  constant,
  emptyDocument,
  invert,
  type Layer,
  newId,
  newPart,
} from "@/editor/model/document";
import { composeLayerMatrix } from "@/editor/model/rig";
import {
  addKeyframeAt,
  deleteKeyframes,
  ensureTrack,
  moveLayers,
  type ScaleOrigin,
  scaleLayers,
  setDocumentFrameCount,
  upsertKeyframe,
} from "./edits";

function shapeLayer(): Layer {
  const artboardId = emptyDocument().activeArtboardId;
  return newPart(artboardId, { name: "Part", outFrame: 1, variants: [] });
}

function docWith(layer: Layer) {
  const doc = emptyDocument();
  doc.layers[layer.id] = layer;
  doc.artboards[doc.activeArtboardId].layerIds = [layer.id];
  return doc;
}

describe("ensureTrack", () => {
  test("creates a track seeded with the value under the playhead", () => {
    const layer = shapeLayer();
    const doc = docWith(layer);
    const { doc: next, trackId } = ensureTrack(doc, layer.id, "transform.x", 4);
    const track = next.tracks[trackId];
    expect(track).toBeDefined();
    expect(track.property).toBe("transform.x");
    expect(track.keyframes).toHaveLength(1);
    expect(track.keyframes[0].frame).toBe(4);
    expect(track.keyframes[0].value).toBe(0);
    const updated = next.layers[layer.id];
    expect(updated.transform.x).toEqual({ kind: "track", trackId });
  });

  test("returns the existing track instead of duplicating it", () => {
    const layer = shapeLayer();
    const first = ensureTrack(docWith(layer), layer.id, "opacity", 0);
    const second = ensureTrack(first.doc, layer.id, "opacity", 7);
    expect(second.trackId).toBe(first.trackId);
    expect(Object.keys(second.doc.tracks)).toHaveLength(1);
  });

  test("leaves the document untouched for an unknown layer", () => {
    const doc = emptyDocument();
    const { doc: next } = ensureTrack(doc, newId("Layer"), "opacity", 0);
    expect(next).toBe(doc);
  });
});

describe("upsertKeyframe", () => {
  test("inserts a keyframe holding the written value", () => {
    const layer = shapeLayer();
    const { doc, trackId } = ensureTrack(
      docWith(layer),
      layer.id,
      "opacity",
      0,
    );
    const next = upsertKeyframe(doc, trackId, 3, 0.5);
    expect(next.tracks[trackId].keyframes.map((k) => k.frame)).toEqual([0, 3]);
    expect(next.tracks[trackId].keyframes[1].value).toBe(0.5);
  });

  test("replaces the value in place, preserving easing", () => {
    const layer = shapeLayer();
    const ensured = ensureTrack(docWith(layer), layer.id, "opacity", 0);
    const keyed = addKeyframeAt(ensured.doc, ensured.trackId, 2, 0.2);
    const next = upsertKeyframe(keyed, ensured.trackId, 2, 0.9);
    expect(next.tracks[ensured.trackId].keyframes).toHaveLength(2);
    expect(
      next.tracks[ensured.trackId].keyframes.find((k) => k.frame === 2)?.value,
    ).toBe(0.9);
  });

  test("a keyed-then-deleted property toggles cleanly", () => {
    const layer = shapeLayer();
    const { doc, trackId } = ensureTrack(
      docWith(layer),
      layer.id,
      "transform.y",
      1,
    );
    const removed = deleteKeyframes(doc, [{ trackId, frame: 1 }]);
    expect(removed.tracks[trackId].keyframes).toHaveLength(0);
  });
});

describe("moveLayers", () => {
  test("rewrites constants in place without minting tracks", () => {
    const layer = shapeLayer();
    const doc = docWith(layer);
    const next = moveLayers(
      doc,
      [{ layerId: layer.id, x: 10, y: 20 }],
      5,
      -4,
      0,
    );
    const moved = next.layers[layer.id];
    expect(moved.transform.x).toEqual({ kind: "const", value: 15 });
    expect(moved.transform.y).toEqual({ kind: "const", value: 16 });
    expect(Object.keys(next.tracks)).toHaveLength(0);
  });

  test("keys tracked axes at the drag frame", () => {
    const layer = shapeLayer();
    const withTrack = ensureTrack(docWith(layer), layer.id, "transform.x", 0);
    const next = moveLayers(
      withTrack.doc,
      [{ layerId: layer.id, x: 0, y: 0 }],
      8,
      3,
      2,
    );
    const track = next.tracks[withTrack.trackId];
    expect(track.keyframes.map((k) => [k.frame, k.value])).toEqual([
      [0, 0],
      [2, 8],
    ]);
    // y stayed constant and moved with the drag.
    expect(next.layers[layer.id].transform.y).toEqual({
      kind: "const",
      value: 3,
    });
    expect(
      evalAnimatable(next.layers[layer.id].transform.x, next.tracks, 2),
    ).toBe(8);
  });

  test("resolves from the origin, so repeated moves do not accumulate", () => {
    const layer = shapeLayer();
    const doc = docWith(layer);
    const origin = [{ layerId: layer.id, x: 10, y: 10 }];
    const once = moveLayers(doc, origin, 5, 5, 0);
    const twice = moveLayers(once, origin, 5, 5, 0);
    expect(twice.layers[layer.id].transform.x).toEqual({
      kind: "const",
      value: 15,
    });
    expect(twice).toBe(once);
  });

  test("skips locked and missing layers, no-ops on zero delta", () => {
    const layer = { ...shapeLayer(), locked: true };
    const doc = docWith(layer);
    expect(moveLayers(doc, [{ layerId: layer.id, x: 0, y: 0 }], 9, 9, 0)).toBe(
      doc,
    );
    expect(moveLayers(doc, [], 9, 9, 0)).toBe(doc);
    const unlocked = { ...shapeLayer(), locked: false };
    const doc2 = docWith(unlocked);
    expect(
      moveLayers(doc2, [{ layerId: unlocked.id, x: 1, y: 1 }], 0, 0, 0),
    ).toBe(doc2);
  });
});

const FLAT = {
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  pivotX: 0,
  pivotY: 0,
};

function originFor(layer: Layer, over: Partial<ScaleOrigin> = {}): ScaleOrigin {
  return { ...FLAT, layerId: layer.id, ...over };
}

describe("scaleLayers", () => {
  test("uniform corner drag doubles an unrotated layer about the anchor", () => {
    const layer = shapeLayer();
    const next = scaleLayers(
      docWith(layer),
      [originFor(layer)],
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 200, y: 200 },
      { axes: { x: true, y: true }, uniform: true },
      0,
    );
    const moved = next.layers[layer.id];
    expect(moved.transform.scaleX).toEqual({ kind: "const", value: 2 });
    expect(moved.transform.scaleY).toEqual({ kind: "const", value: 2 });
    // Anchor was the layer origin: position holds, no tracks minted.
    expect(moved.transform.x).toEqual({ kind: "const", value: 0 });
    expect(moved.transform.y).toEqual({ kind: "const", value: 0 });
    expect(Object.keys(next.tracks)).toHaveLength(0);
  });

  test("edge handle drives one axis only", () => {
    const layer = shapeLayer();
    const next = scaleLayers(
      docWith(layer),
      [originFor(layer)],
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { axes: { x: true, y: false }, uniform: false },
      0,
    );
    const moved = next.layers[layer.id];
    expect(moved.transform.scaleX).toEqual({ kind: "const", value: 2 });
    expect(moved.transform.scaleY).toEqual({ kind: "const", value: 1 });
  });

  test("anchor stays fixed on a rotated layer", () => {
    const base = shapeLayer();
    const layer: Layer = {
      ...base,
      transform: { ...base.transform, rotation: constant(90) },
    };
    const o = originFor(layer, { rotation: 90 });
    const anchor = { x: 40, y: 60 };
    const start = { x: 140, y: 60 };
    const current = { x: 240, y: 60 };
    const doc = docWith(layer);
    const next = scaleLayers(
      doc,
      [o],
      anchor,
      start,
      current,
      { axes: { x: true, y: true }, uniform: true },
      0,
    );
    const moved = next.layers[layer.id];
    const sx = (moved.transform.scaleX as { value: number }).value;
    const sy = (moved.transform.scaleY as { value: number }).value;
    expect(sx).toBeCloseTo(2, 9);
    expect(sy).toBeCloseTo(2, 9);
    expect(
      Number.isFinite((moved.transform.x as { value: number }).value),
    ).toBe(true);
    // The written matrix must map the origin-local anchor back to the anchor.
    const m0 = composeLayerMatrix(
      o.x,
      o.y,
      o.rotation,
      o.scaleX,
      o.scaleY,
      o.pivotX,
      o.pivotY,
    );
    const inv = invert(m0);
    expect(inv).not.toBeNull();
    if (!inv) throw new Error("unreachable: singular test matrix");
    const [plx, ply] = applyMatrix(inv, anchor.x, anchor.y);
    const m1 = composeLayerMatrix(
      (moved.transform.x as { value: number }).value,
      (moved.transform.y as { value: number }).value,
      o.rotation,
      sx,
      sy,
      o.pivotX,
      o.pivotY,
    );
    const [qx, qy] = applyMatrix(m1, plx, ply);
    expect(qx).toBeCloseTo(anchor.x, 9);
    expect(qy).toBeCloseTo(anchor.y, 9);
  });

  test("tracked scale keys at the frame, constants rewrite", () => {
    const layer = shapeLayer();
    const withTrack = ensureTrack(
      docWith(layer),
      layer.id,
      "transform.scaleX",
      0,
    );
    const next = scaleLayers(
      withTrack.doc,
      [originFor(layer, { scaleX: 1 })],
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { axes: { x: true, y: false }, uniform: false },
      3,
    );
    const track = next.tracks[withTrack.trackId];
    expect(track.keyframes.map((k) => [k.frame, k.value])).toEqual([
      [0, 1],
      [3, 2],
    ]);
    expect(next.layers[layer.id].transform.scaleY).toEqual({
      kind: "const",
      value: 1,
    });
    expect(next.layers[layer.id].transform.x).toEqual({
      kind: "const",
      value: 0,
    });
  });

  test("zero-size drag and identical positions are no-ops", () => {
    const layer = shapeLayer();
    const doc = docWith(layer);
    const o = originFor(layer);
    expect(
      scaleLayers(
        doc,
        [o],
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 50, y: 50 },
        { axes: { x: true, y: true }, uniform: true },
        0,
      ),
    ).toBe(doc);
    expect(
      scaleLayers(
        doc,
        [o],
        { x: 10, y: 10 },
        { x: 20, y: 20 },
        { x: 20, y: 20 },
        { axes: { x: true, y: true }, uniform: true },
        0,
      ),
    ).toBe(doc);
  });
});

// --------------------------------------------------- setDocumentFrameCount

describe("setDocumentFrameCount", () => {
  function docWithClip(frameCount: number, inFrame: number, outFrame: number) {
    const layer: Layer = { ...shapeLayer(), inFrame, outFrame };
    const doc = { ...docWith(layer), frameCount };
    return { doc, layerId: layer.id };
  }

  test("never lets the document fall below one frame", () => {
    const { doc } = docWithClip(96, 0, 96);
    expect(setDocumentFrameCount(doc, 0).frameCount).toBe(1);
    expect(setDocumentFrameCount(doc, -5).frameCount).toBe(1);
  });

  test("shortening the document trims clips that would dangle past its end", () => {
    const { doc, layerId } = docWithClip(96, 0, 96);
    const next = setDocumentFrameCount(doc, 24);
    expect(next.frameCount).toBe(24);
    expect(next.layers[layerId].outFrame).toBe(24);
    expect(next.layers[layerId].inFrame).toBe(0);
  });

  test("a clip that starts past the new end keeps at least one frame", () => {
    const { doc, layerId } = docWithClip(96, 90, 96);
    const next = setDocumentFrameCount(doc, 10);
    expect(next.layers[layerId].inFrame).toBeLessThan(
      next.layers[layerId].outFrame,
    );
    expect(next.layers[layerId].outFrame).toBeLessThanOrEqual(10);
  });

  test("growing the document leaves every clip untouched", () => {
    const { doc, layerId } = docWithClip(24, 2, 20);
    const next = setDocumentFrameCount(doc, 96);
    expect(next.frameCount).toBe(96);
    expect(next.layers[layerId].inFrame).toBe(2);
    expect(next.layers[layerId].outFrame).toBe(20);
  });

  test("returns the same object when nothing changes", () => {
    const { doc } = docWithClip(24, 0, 24);
    expect(setDocumentFrameCount(doc, 24)).toBe(doc);
  });
});

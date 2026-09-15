/**
 * Sampling a drawing track.
 *
 * A part's shown drawing is an index on a track like any other number, which is
 * the whole reason it can be posed at all. What makes it different is that it
 * must step rather than blend: halfway between an open hand and a fist is not a
 * drawing. These tests pin that down, because it is the one place where the
 * general machinery would silently do the wrong thing.
 */

import { describe, expect, test } from "bun:test";
import { evalAnimatable, evalTrack } from "@/editor/model/animation";
import {
  EASING,
  emptyDocument,
  type LayerId,
  newId,
  newPart,
  newVariant,
  type RiffDocument,
  type Track,
  type TrackId,
} from "@/editor/model/document";
import { addPart, variantAt } from "@/editor/model/rig";
import {
  defaultEasing,
  ensureTrack,
  neighbourKeyFrames,
  upsertKeyframe,
} from "./edits";

function riggedPart(): {
  doc: RiffDocument;
  layerId: LayerId;
  trackId: TrackId;
} {
  const base = emptyDocument();
  const trackId = newId("Track");
  const track: Track = {
    id: trackId,
    property: "variant",
    keyframes: [
      { frame: 0, value: 0, easing: EASING.hold },
      { frame: 10, value: 2, easing: EASING.hold },
      { frame: 20, value: 1, easing: EASING.hold },
    ],
  };
  const part = newPart(base.activeArtboardId, {
    name: "Hand",
    variants: [
      newVariant({ name: "Open" }),
      newVariant({ name: "Fist" }),
      newVariant({ name: "Point" }),
    ],
    variant: { kind: "track", trackId },
  });
  const doc = addPart({ ...base, tracks: { [trackId]: track } }, part);
  return { doc, layerId: part.id, trackId };
}

describe("sampling a drawing track", () => {
  const { doc, layerId } = riggedPart();
  const part = doc.layers[layerId];

  test("holds the drawing between keys instead of blending", () => {
    expect(evalAnimatable(part.variant, doc.tracks, 0)).toBe(0);
    expect(evalAnimatable(part.variant, doc.tracks, 5)).toBe(0);
    expect(evalAnimatable(part.variant, doc.tracks, 9)).toBe(0);
    expect(evalAnimatable(part.variant, doc.tracks, 10)).toBe(2);
    expect(evalAnimatable(part.variant, doc.tracks, 19)).toBe(2);
    expect(evalAnimatable(part.variant, doc.tracks, 20)).toBe(1);
  });

  test("resolves to the right drawing at each frame", () => {
    expect(variantAt(part, doc, 0)?.name).toBe("Open");
    expect(variantAt(part, doc, 9)?.name).toBe("Open");
    expect(variantAt(part, doc, 12)?.name).toBe("Point");
    expect(variantAt(part, doc, 25)?.name).toBe("Fist");
  });

  test("holds at the ends rather than running off", () => {
    expect(variantAt(part, doc, -5)?.name).toBe("Open");
    expect(variantAt(part, doc, 999)?.name).toBe("Fist");
  });

  test("a blink wins over whatever the sequence says", () => {
    const blinking = { ...part, blinkVariant: 1 };
    expect(variantAt(blinking, doc, 12, true)?.name).toBe("Fist");
    expect(variantAt(blinking, doc, 12, false)?.name).toBe("Point");
  });

  test("a drawing that was deleted clamps instead of blanking the part", () => {
    const shortened = { ...part, variants: part.variants.slice(0, 2) };
    expect(variantAt(shortened, doc, 12)?.name).toBe("Fist");
  });
});

describe("keying a drawing", () => {
  test("a new drawing key holds; a new rotation key does not", () => {
    expect(defaultEasing("variant").hold).toBe(true);
    expect(defaultEasing("transform.rotation").hold).toBe(false);
  });

  test("keying an unkeyed drawing seeds a held key at the playhead", () => {
    const base = emptyDocument();
    const part = newPart(base.activeArtboardId, {
      variants: [newVariant({ name: "A" }), newVariant({ name: "B" })],
    });
    const doc = addPart(base, part);
    const { doc: next, trackId } = ensureTrack(doc, part.id, "variant", 6);
    expect(next.tracks[trackId].keyframes[0].frame).toBe(6);
    expect(next.tracks[trackId].keyframes[0].easing.hold).toBe(true);

    const swapped = upsertKeyframe(next, trackId, 12, 1);
    expect(evalTrack(swapped.tracks[trackId], 11)).toBe(0);
    expect(evalTrack(swapped.tracks[trackId], 12)).toBe(1);
    expect(variantAt(swapped.layers[part.id], swapped, 12)?.name).toBe("B");
  });
});

describe("the poses either side of the playhead", () => {
  test("finds the nearest key before and after", () => {
    const { doc } = riggedPart();
    expect(neighbourKeyFrames(doc, 5)).toEqual({ before: 0, after: 10 });
    expect(neighbourKeyFrames(doc, 15)).toEqual({ before: 10, after: 20 });
  });

  test("a key exactly under the playhead is neither before nor after", () => {
    const { doc } = riggedPart();
    expect(neighbourKeyFrames(doc, 10)).toEqual({ before: 0, after: 20 });
  });

  test("returns null past either end", () => {
    const { doc } = riggedPart();
    expect(neighbourKeyFrames(doc, 0).before).toBeNull();
    expect(neighbourKeyFrames(doc, 99).after).toBeNull();
  });

  test("a document with nothing animated has no ghosts", () => {
    expect(neighbourKeyFrames(emptyDocument(), 5)).toEqual({
      before: null,
      after: null,
    });
  });
});

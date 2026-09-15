import { describe, expect, test } from "bun:test";
import { evalAnimatable } from "../model/animation";
import { variantAt } from "../model/rig";
import { importLegacyStudio, isLegacyStudioFile } from "./legacy-studio";

/**
 * A cut-down v3 file in the shape the prototype writes: a two-part chain, two
 * drawings on the child, and a three-step sequence with a hold.
 */
const project = {
  v: 3,
  parts: [
    {
      id: "eyes",
      name: "Eyes",
      parent: "face",
      pivot: [140, 130],
      x: 0,
      y: 0,
      sx: 1,
      sy: 1,
      rot: 0,
      overlap: 0,
      blink: "closed",
      variants: [
        {
          name: "open",
          kind: "path",
          d: "M0 0 L10 0 L10 10 Z",
          fill: "#161719",
          ink: 0,
        },
        { name: "closed", kind: "path", d: "M0 5 L10 5", ink: 4, open: true },
      ],
    },
    {
      id: "face",
      name: "Face",
      parent: null,
      pivot: [150, 250],
      x: 5,
      y: -3,
      sx: 1.2,
      sy: 1.2,
      rot: Math.PI / 4,
      overlap: 2,
      variants: [
        {
          name: "default",
          kind: "draw",
          closed: true,
          ink: 7,
          fill: "#B85527",
          pts: [
            [0, 0, 0.4],
            [100, 0, 0.6],
            [100, 100, 0.8],
            [0, 100, 0.5],
          ],
        },
      ],
    },
  ],
  poses: {
    rest: { angles: {}, variants: { eyes: "open" } },
    tilt: {
      angles: { face: -Math.PI / 6 },
      variants: { eyes: "closed" },
    },
  },
  anim: [
    { pose: "rest", hold: 200, duration: 500 },
    { pose: "tilt", hold: 0, duration: 500 },
  ],
  play: { speed: 1, ease: "smooth", loop: true },
};

describe("recognising a prototype file", () => {
  test("accepts a v3 project", () => {
    expect(isLegacyStudioFile(project)).toBe(true);
  });

  test("rejects a riff project and anything else", () => {
    expect(isLegacyStudioFile({ layers: {}, artboards: {} })).toBe(false);
    expect(isLegacyStudioFile(null)).toBe(false);
    expect(isLegacyStudioFile("nope")).toBe(false);
  });
});

describe("importing a prototype project", () => {
  const { doc } = importLegacyStudio(project, { fps: 24 });
  const parts = Object.values(doc.layers);
  const face = parts.find((p) => p.name === "Face");
  const eyes = parts.find((p) => p.name === "Eyes");

  test("every part arrives", () => {
    expect(parts).toHaveLength(2);
    expect(face).toBeDefined();
    expect(eyes).toBeDefined();
  });

  test("draw order follows the file's own order", () => {
    const order = doc.artboards[doc.activeArtboardId].layerIds;
    expect(order).toHaveLength(2);
    expect(doc.layers[order[0]].name).toBe("Eyes");
  });

  test("the skeleton is rebuilt with riff ids, not the file's", () => {
    expect(eyes?.parentLayerId).toBe(face?.id);
    expect(eyes?.parentLayerId).not.toBe("face");
    expect(face?.parentLayerId).toBeNull();
  });

  test("the joint carries over", () => {
    expect(face?.pivot).toEqual({ x: 150, y: 250 });
  });

  test("radians become degrees", () => {
    if (!face) throw new Error("no face");
    expect(evalAnimatable(face.transform.scaleX, doc.tracks, 0)).toBeCloseTo(
      1.2,
      9,
    );
    // The face is also posed, so its rotation is a curve: sample it at rest.
    expect(evalAnimatable(face.transform.rotation, doc.tracks, 0)).toBeCloseTo(
      0,
      6,
    );
  });

  test("overlap carries over", () => {
    expect(face?.overlap).toBe(2);
  });

  test("a drawn variant keeps its pressure", () => {
    if (!face) throw new Error("no face");
    const geometry = doc.paths[face.variants[0].pathIds[0]];
    expect(geometry).toBeDefined();
    expect(geometry.pressure).toBeDefined();
    expect(geometry.pressure?.length).toBe(geometry.vertices.length / 2);
  });

  test("the blink drawing is found by name", () => {
    expect(eyes?.blinkVariant).toBe(1);
  });

  test("the sequence becomes keys, with the hold closed off", () => {
    if (!face) throw new Error("no face");
    expect(face.transform.rotation.kind).toBe("track");
    const track =
      face.transform.rotation.kind === "track"
        ? doc.tracks[face.transform.rotation.trackId]
        : undefined;
    if (!track) throw new Error("no rotation keys");
    // rest holds for 200ms (about 5 frames at 24fps), then eases to tilt.
    expect(track.keyframes.map((k) => k.frame)).toEqual([0, 5, 17, 29]);
    expect(track.keyframes[0].value).toBe(0);
    expect(track.keyframes[2].value).toBeCloseTo(-30, 6);
    // It loops back to the first pose.
    expect(track.keyframes[3].value).toBe(0);
  });

  test("drawing swaps become a stepped set of keys", () => {
    if (!eyes) throw new Error("no eyes");
    expect(eyes.variant.kind).toBe("track");
    const track =
      eyes.variant.kind === "track"
        ? doc.tracks[eyes.variant.trackId]
        : undefined;
    if (!track) throw new Error("no drawing keys");
    expect(track.property).toBe("variant");
    expect(track.keyframes.every((k) => k.easing.hold)).toBe(true);
    expect(variantAt(eyes, doc, 0)?.name).toBe("open");
    expect(variantAt(eyes, doc, 20)?.name).toBe("closed");
  });

  test("the page is resized around what arrived", () => {
    const artboard = doc.artboards[doc.activeArtboardId];
    // The file carries no page, so one is made that contains the artwork with
    // a margin rather than leaving it hanging off a default square.
    expect(artboard.width).toBeGreaterThan(0);
    expect(artboard.height).toBeGreaterThan(0);
    expect(artboard.width).toBeLessThan(900);
    const roots = Object.values(doc.layers).filter((l) => !l.parentLayerId);
    expect(roots).toHaveLength(1);
    // Everything sits inside the page it was given.
    for (const layer of Object.values(doc.layers)) {
      expect(Number.isFinite(layer.pivot.x)).toBe(true);
    }
  });

  test("the document is as long as the sequence", () => {
    expect(doc.fps).toBe(24);
    expect(doc.frameCount).toBe(30);
    expect(doc.loopOut).toBe(30);
  });

  test("a file with no parts at all still opens", () => {
    const { doc: bare } = importLegacyStudio({ v: 3, parts: [] });
    expect(Object.keys(bare.layers)).toHaveLength(0);
  });
});

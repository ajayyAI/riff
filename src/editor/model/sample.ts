/**
 * The sample character.
 *
 * Deliberately anonymous: a figure made of neutral capsules that belongs to no
 * product, exists so the rig tree, the joints, the overlap tuck, the variant
 * swap and a two-second loop are all visible within a second of opening the
 * editor, and is meant to be drawn over rather than kept.
 *
 * Every part's geometry is authored in artboard coordinates with its joint at
 * the real joint position. At rest every transform is identity, so a parent's
 * local space and the artboard agree and the numbers in this file are the
 * numbers on screen.
 */

import {
  EASING,
  type Easing,
  emptyDocument,
  INK,
  type LayerId,
  newId,
  newPart,
  newVariant,
  type PartLayer,
  type PathGeometry,
  type PathId,
  type RGBA,
  type RiffDocument,
  type Track,
  type TrackId,
} from "./document";
import { type Contour, contoursToGeometry } from "./polyline";

const BODY: RGBA = { r: 199, g: 205, b: 214, a: 1 };
const HEAD: RGBA = { r: 215, g: 220, b: 227, a: 1 };

/**
 * The figure below is authored at a comfortable reading scale and then moved
 * onto a page that fits it. Keeping the two apart means the numbers in this
 * file stay legible as a drawing while the artboard stays the size of the
 * character, which is what the exported player uses as its canvas.
 */
const PAGE_WIDTH = 400;
const PAGE_HEIGHT = 720;
const OFFSET_X = -240;
const OFFSET_Y = -128;

const px = (x: number) => x + OFFSET_X;
const py = (y: number) => y + OFFSET_Y;

function circle(cx: number, cy: number, r: number, segments = 28): Contour {
  const points: number[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    points.push(px(cx + Math.cos(t) * r), py(cy + Math.sin(t) * r));
  }
  return { points, closed: true };
}

/** A rounded limb between two joints. The cutout rig's workhorse shape. */
function capsule(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  segments = 12,
): Contour {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const points: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = angle - Math.PI / 2 + (i / segments) * Math.PI;
    points.push(px(x1 + Math.cos(t) * r), py(y1 + Math.sin(t) * r));
  }
  for (let i = 0; i <= segments; i++) {
    const t = angle + Math.PI / 2 + (i / segments) * Math.PI;
    points.push(px(x0 + Math.cos(t) * r), py(y0 + Math.sin(t) * r));
  }
  return { points, closed: true };
}

function torsoContour(): Contour {
  const raw = [
    388, 366, 400, 348, 500, 348, 512, 366, 506, 470, 498, 548, 402, 548, 394,
    470,
  ];
  const points: number[] = [];
  for (let i = 0; i < raw.length; i += 2)
    points.push(px(raw[i]), py(raw[i + 1]));
  return { points, closed: true };
}

function lozenge(cx: number, cy: number, w: number, h: number): Contour {
  return circleToEllipse(circle(cx, cy, 1, 20), cx, cy, w, h);
}

function circleToEllipse(
  base: Contour,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): Contour {
  // `base` is already offset, so squash about the offset centre.
  const ox = px(cx);
  const oy = py(cy);
  const points: number[] = [];
  for (let i = 0; i < base.points.length; i += 2) {
    points.push(
      ox + (base.points[i] - ox) * rx,
      oy + (base.points[i + 1] - oy) * ry,
    );
  }
  return { points, closed: true };
}

interface Built {
  paths: Record<PathId, PathGeometry>;
  ids: PathId[];
}

function buildPaths(contours: Contour[][]): Built {
  const paths: Record<PathId, PathGeometry> = {};
  const ids: PathId[] = [];
  for (const group of contours) {
    const geometry = contoursToGeometry(group);
    paths[geometry.id] = geometry;
    ids.push(geometry.id);
  }
  return { paths, ids };
}

interface KeySpec {
  frame: number;
  value: number;
  easing?: Easing;
}

function track(property: string, keys: KeySpec[]): Track {
  return {
    id: newId("Track"),
    property,
    keyframes: keys.map((key) => ({
      frame: key.frame,
      value: key.value,
      easing: key.easing ?? EASING.easeInOut,
    })),
  };
}

/**
 * Build the sample rig: seven parts, one skeleton, one two-second wave.
 *
 * Returns a whole document rather than mutating one, so "Load sample" is a
 * single undoable replacement and nothing of the user's survives half-merged.
 */
export function sampleDocument(): RiffDocument {
  const base = emptyDocument(PAGE_WIDTH, PAGE_HEIGHT, 24);
  const artboardId = base.activeArtboardId;

  const torsoPaths = buildPaths([[torsoContour()]]);
  const headPaths = buildPaths([[circle(450, 268, 80)]]);
  const eyesOpen = buildPaths([[circle(424, 258, 9), circle(476, 258, 9)]]);
  const eyesClosed = buildPaths([
    [lozenge(424, 258, 13, 3), lozenge(476, 258, 13, 3)],
  ]);
  const upperArmPaths = buildPaths([[capsule(398, 372, 372, 468, 19)]]);
  const forearmPaths = buildPaths([[capsule(372, 468, 356, 560, 16)]]);
  const handPaths = buildPaths([[circle(352, 578, 22)]]);
  const legPaths = buildPaths([[capsule(438, 540, 428, 726, 23)]]);

  const paths: Record<PathId, PathGeometry> = {
    ...torsoPaths.paths,
    ...headPaths.paths,
    ...eyesOpen.paths,
    ...eyesClosed.paths,
    ...upperArmPaths.paths,
    ...forearmPaths.paths,
    ...handPaths.paths,
    ...legPaths.paths,
  };

  const limb = (
    name: string,
    pathIds: PathId[],
    pivot: [number, number],
    overlap: number,
  ) =>
    newPart(artboardId, {
      name,
      pivot: { x: px(pivot[0]), y: py(pivot[1]) },
      overlap,
      variants: [
        newVariant({
          name: "Default",
          pathIds,
          fill: BODY,
          stroke: INK,
          strokeWidth: 7,
        }),
      ],
    });

  const torso = newPart(artboardId, {
    name: "Torso",
    pivot: { x: px(450), y: py(545) },
    variants: [
      newVariant({
        name: "Default",
        pathIds: torsoPaths.ids,
        fill: BODY,
        stroke: INK,
        strokeWidth: 7,
      }),
    ],
  });

  const head = newPart(artboardId, {
    name: "Head",
    pivot: { x: px(450), y: py(350) },
    overlap: 1,
    parentLayerId: torso.id,
    variants: [
      newVariant({
        name: "Default",
        pathIds: headPaths.ids,
        fill: HEAD,
        stroke: INK,
        strokeWidth: 7,
      }),
    ],
  });

  const face = newPart(artboardId, {
    name: "Face",
    pivot: { x: px(450), y: py(268) },
    parentLayerId: head.id,
    blinkVariant: 1,
    variants: [
      newVariant({
        name: "Eyes open",
        pathIds: eyesOpen.ids,
        fill: INK,
        stroke: null,
        strokeWidth: 0,
      }),
      newVariant({
        name: "Eyes closed",
        pathIds: eyesClosed.ids,
        fill: INK,
        stroke: null,
        strokeWidth: 0,
      }),
    ],
  });

  const upperArm = limb("Upper arm", upperArmPaths.ids, [398, 372], 2);
  upperArm.parentLayerId = torso.id;
  const forearm = limb("Forearm", forearmPaths.ids, [372, 468], 2);
  forearm.parentLayerId = upperArm.id;
  const hand = limb("Hand", handPaths.ids, [356, 560], 2);
  hand.parentLayerId = forearm.id;
  const leg = limb("Leg", legPaths.ids, [438, 540], 2);
  leg.parentLayerId = torso.id;

  // Draw order, back to front. The arm is the far arm, so it draws behind the
  // torso and its overlap tucks the shoulder under the body.
  const order = [upperArm, forearm, hand, leg, torso, head, face];

  const armTrack = track("transform.rotation", [
    { frame: 0, value: 0 },
    { frame: 10, value: -112 },
    { frame: 38, value: -112 },
    { frame: 47, value: 0 },
  ]);
  const forearmTrack = track("transform.rotation", [
    { frame: 0, value: 0 },
    { frame: 10, value: -28 },
    { frame: 17, value: 24 },
    { frame: 24, value: -24 },
    { frame: 31, value: 24 },
    { frame: 38, value: -24 },
    { frame: 47, value: 0 },
  ]);
  const headTrack = track("transform.rotation", [
    { frame: 0, value: 0 },
    { frame: 12, value: -6 },
    { frame: 32, value: 5 },
    { frame: 47, value: 0 },
  ]);
  const faceTrack = track("variant", [
    { frame: 0, value: 0, easing: EASING.hold },
    { frame: 20, value: 1, easing: EASING.hold },
    { frame: 23, value: 0, easing: EASING.hold },
  ]);

  upperArm.transform = {
    ...upperArm.transform,
    rotation: { kind: "track", trackId: armTrack.id },
  };
  forearm.transform = {
    ...forearm.transform,
    rotation: { kind: "track", trackId: forearmTrack.id },
  };
  head.transform = {
    ...head.transform,
    rotation: { kind: "track", trackId: headTrack.id },
  };
  face.variant = { kind: "track", trackId: faceTrack.id };

  const layers: Record<LayerId, PartLayer> = {};
  for (const part of order) layers[part.id] = part;

  const tracks: Record<TrackId, Track> = {};
  for (const t of [armTrack, forearmTrack, headTrack, faceTrack]) {
    tracks[t.id] = t;
  }

  return {
    ...base,
    name: "Sample character",
    frameCount: 48,
    loopIn: 0,
    loopOut: 48,
    paths,
    layers,
    tracks,
    artboards: {
      ...base.artboards,
      [artboardId]: {
        ...base.artboards[artboardId],
        layerIds: order.map((part) => part.id),
      },
    },
  };
}

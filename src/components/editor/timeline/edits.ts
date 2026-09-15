/**
 * Document edits the timeline performs.
 *
 * Pure `doc -> doc` functions, so a drag can recompute from the snapshot taken
 * at pointer-down on every move instead of accumulating deltas. Accumulating is
 * how a drag that crosses a clamp ends up off by the amount it was clamped by,
 * which is a bug that only shows up when someone drags into an edge and back.
 */

import {
  evalAnimatable,
  evalTrack,
  removeKeyframe,
  setKeyframe,
} from "@/editor/model/animation";
import {
  type AnimatableNumber,
  applyMatrix,
  EASING,
  type Easing,
  type Frame,
  invert,
  type Keyframe,
  type Layer,
  type LayerId,
  newId,
  type RiffDocument,
  type Track,
  type TrackId,
} from "@/editor/model/document";
import { composeLayerMatrix } from "@/editor/model/rig";

/**
 * The easing a new keyframe starts with.
 *
 * Ease in out for anything continuous, because that is what a pose-to-pose
 * cutout animation wants nine times out of ten and nobody should have to set it
 * every time. A variant is a swap, not a blend, so its keys hold.
 */
export function defaultEasing(propertyPath: string): Easing {
  // A drawing swap and a draw-order change are both steps, not blends: halfway
  // between an open hand and a fist is not a drawing, and halfway in front of
  // the body is not a place.
  return propertyPath === "variant" || propertyPath === "depth"
    ? EASING.hold
    : EASING.easeInOut;
}

export interface KeyRef {
  trackId: TrackId;
  frame: Frame;
}

/** Stable identity for a keyframe in a selection set. */
export function keyId(trackId: TrackId, frame: Frame): string {
  return `${trackId}:${frame}`;
}

function groupByTrack(refs: readonly KeyRef[]): Map<TrackId, Set<Frame>> {
  const byTrack = new Map<TrackId, Set<Frame>>();
  for (const ref of refs) {
    let frames = byTrack.get(ref.trackId);
    if (!frames) {
      frames = new Set();
      byTrack.set(ref.trackId, frames);
    }
    frames.add(ref.frame);
  }
  return byTrack;
}

/**
 * Shift a set of keyframes by whole frames.
 *
 * Remove-then-insert rather than mutate-in-place, because a shift can reorder
 * the array and can land on top of a keyframe that was already there. Landing on
 * one replaces it, which is what every other editor does and what the user
 * expects when they drop a key onto an occupied frame.
 */
export function moveKeyframes(
  doc: RiffDocument,
  refs: readonly KeyRef[],
  offset: number,
): RiffDocument {
  if (offset === 0 || refs.length === 0) return doc;

  const tracks = { ...doc.tracks };
  let changed = false;

  for (const [trackId, frames] of groupByTrack(refs)) {
    const track = doc.tracks[trackId];
    if (!track) continue;

    const moving: Keyframe[] = [];
    const staying: Keyframe[] = [];
    for (const key of track.keyframes) {
      (frames.has(key.frame) ? moving : staying).push(key);
    }
    if (moving.length === 0) continue;

    let next = staying;
    for (const key of moving) {
      next = setKeyframe(next, { ...key, frame: key.frame + offset });
    }
    tracks[trackId] = { ...track, keyframes: next };
    changed = true;
  }

  return changed ? { ...doc, tracks } : doc;
}

export function deleteKeyframes(
  doc: RiffDocument,
  refs: readonly KeyRef[],
): RiffDocument {
  if (refs.length === 0) return doc;

  const tracks = { ...doc.tracks };
  let changed = false;

  for (const [trackId, frames] of groupByTrack(refs)) {
    const track = doc.tracks[trackId];
    if (!track) continue;
    let next = track.keyframes;
    for (const frame of frames) next = removeKeyframe(next, frame);
    if (next !== track.keyframes) {
      tracks[trackId] = { ...track, keyframes: next };
      changed = true;
    }
  }

  return changed ? { ...doc, tracks } : doc;
}

/**
 * Easing presets in cycle order.
 *
 * Hold first because a variant swap is a hold by nature: a mouth shape does not
 * blend into the next one. The interpolating curves are what the joints use.
 */
export const EASING_CYCLE: { name: string; easing: Easing }[] = [
  { name: "Hold", easing: EASING.hold },
  { name: "Linear", easing: EASING.linear },
  { name: "Ease", easing: EASING.ease },
  { name: "Ease in out", easing: EASING.easeInOut },
  { name: "Overshoot", easing: EASING.overshoot },
];

export function easingName(easing: Easing): string {
  const match = EASING_CYCLE.find(
    (entry) =>
      entry.easing.hold === easing.hold &&
      entry.easing.x1 === easing.x1 &&
      entry.easing.y1 === easing.y1 &&
      entry.easing.x2 === easing.x2 &&
      entry.easing.y2 === easing.y2,
  );
  return match ? match.name : "Custom";
}

/** Advance a keyframe's outgoing easing to the next preset. */
export function cycleEasing(
  doc: RiffDocument,
  trackId: TrackId,
  frame: Frame,
): RiffDocument {
  const track = doc.tracks[trackId];
  if (!track) return doc;
  const key = track.keyframes.find((k) => k.frame === frame);
  if (!key) return doc;

  const index = EASING_CYCLE.findIndex(
    (entry) =>
      entry.easing.hold === key.easing.hold &&
      entry.easing.x1 === key.easing.x1 &&
      entry.easing.y1 === key.easing.y1 &&
      entry.easing.x2 === key.easing.x2 &&
      entry.easing.y2 === key.easing.y2,
  );
  const next = EASING_CYCLE[(index + 1) % EASING_CYCLE.length].easing;

  return {
    ...doc,
    tracks: {
      ...doc.tracks,
      [trackId]: {
        ...track,
        keyframes: setKeyframe(track.keyframes, { ...key, easing: next }),
      },
    },
  };
}

/**
 * Add a keyframe at `frame` holding the track's current value.
 *
 * Sampling the current value means "key this" never moves anything, which is the
 * only behaviour that lets a user key a pose they are already looking at.
 */
export function addKeyframeAt(
  doc: RiffDocument,
  trackId: TrackId,
  frame: Frame,
  value: number,
): RiffDocument {
  const track = doc.tracks[trackId];
  if (!track) return doc;
  if (track.keyframes.some((k) => k.frame === frame)) return doc;

  // A new key inherits the easing of the segment it lands in, so inserting a
  // keyframe in the middle of a curve does not change the motion around it.
  const previous = [...track.keyframes].reverse().find((k) => k.frame < frame);
  const easing = previous ? previous.easing : defaultEasing(track.property);

  return {
    ...doc,
    tracks: {
      ...doc.tracks,
      [trackId]: {
        ...track,
        keyframes: setKeyframe(track.keyframes, { frame, value, easing }),
      },
    },
  };
}

/**
 * Read one animatable property off a layer by its timeline path
 * (`transform.x`, `opacity`, …). Every layer kind carries the same
 * `TransformProps` + `opacity`, so this is total over layers.
 */
export function readAnimatable(
  layer: Layer,
  propertyPath: string,
): AnimatableNumber {
  if (propertyPath === "opacity") return layer.opacity;
  if (propertyPath === "variant") return layer.variant;
  if (propertyPath === "depth") return layer.depth;
  const key = propertyPath.split(".")[1] as keyof Layer["transform"];
  // A programmer error, not user input: fail loudly rather than keying
  // `undefined` into a track.
  if (!(key in layer.transform)) {
    throw new Error(`Unknown animatable property: ${propertyPath}`);
  }
  return layer.transform[key];
}

function writeAnimatable(
  layer: Layer,
  propertyPath: string,
  value: AnimatableNumber,
): Layer {
  if (propertyPath === "opacity") return { ...layer, opacity: value };
  if (propertyPath === "variant") return { ...layer, variant: value };
  if (propertyPath === "depth") return { ...layer, depth: value };
  const key = propertyPath.split(".")[1] as keyof Layer["transform"];
  if (!(key in layer.transform)) {
    throw new Error(`Unknown animatable property: ${propertyPath}`);
  }
  return { ...layer, transform: { ...layer.transform, [key]: value } };
}

export interface MoveOrigin {
  layerId: LayerId;
  /** Evaluated x/y at the drag's frame, so tracked layers move from screen truth. */
  x: number;
  y: number;
}

/**
 * Move layers by a document-space delta, resolved from the drag origin.
 *
 * Constant properties are rewritten in place (no track is minted by merely
 * moving); tracked properties are keyed at `frame`, per the M8 ruling. Locked
 * or missing layers are skipped. Like every scrub in this codebase the result
 * is computed from the origin snapshot, never accumulated.
 */
export function moveLayers(
  doc: RiffDocument,
  origins: readonly MoveOrigin[],
  dx: number,
  dy: number,
  frame: Frame,
): RiffDocument {
  if (origins.length === 0 || (dx === 0 && dy === 0)) return doc;
  const layers = { ...doc.layers };
  let tracks = doc.tracks;
  let changed = false;

  for (const { layerId, x, y } of origins) {
    const layer = layers[layerId];
    if (!layer || layer.locked) continue;
    const nextX = x + dx;
    const nextY = y + dy;
    let dirty = false;

    let next = layer;
    const px = readAnimatable(layer, "transform.x");
    if (px.kind === "const") {
      if (px.value !== nextX) {
        next = writeAnimatable(next, "transform.x", {
          kind: "const",
          value: nextX,
        });
        dirty = true;
      }
    }
    const py = readAnimatable(layer, "transform.y");
    if (py.kind === "const") {
      if (py.value !== nextY) {
        next = writeAnimatable(next, "transform.y", {
          kind: "const",
          value: nextY,
        });
        dirty = true;
      }
    }
    if (next !== layer) layers[layerId] = next;

    // Tracked axes are keyed at the drag frame (M8: edits key at the playhead).
    for (const [path, value] of [
      ["transform.x", nextX],
      ["transform.y", nextY],
    ] as const) {
      const prop = readAnimatable(layer, path);
      if (prop.kind !== "track" || !tracks[prop.trackId]) continue;
      const track = tracks[prop.trackId];
      const previous = [...track.keyframes]
        .reverse()
        .find((k) => k.frame < frame);
      const existing = track.keyframes.find((k) => k.frame === frame);
      if (existing && existing.value === value) continue;
      const easing = existing
        ? existing.easing
        : (previous?.easing ?? defaultEasing(track.property));
      tracks = {
        ...tracks,
        [prop.trackId]: {
          ...track,
          keyframes: setKeyframe(track.keyframes, { frame, value, easing }),
        },
      };
      dirty = true;
    }
    if (dirty) changed = true;
  }

  return changed ? { ...doc, layers, tracks } : doc;
}

export interface ScaleOrigin {
  layerId: LayerId;
  /**
   * Evaluated transform at the drag frame, must agree with the layer's
   * actual properties (the canvas snapshots them via evalAnimatable).
   * Ratios are measured against these, so a stale origin scales from the
   * wrong place.
   */
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** The joint, in the part's own space. Not animated, but needed to compose. */
  pivotX: number;
  pivotY: number;
}

export interface ScaleOptions {
  /** Corners scale both axes; edges drive one. */
  axes: { x: boolean; y: boolean };
  /** Corners lock aspect unless Shift is held. */
  uniform: boolean;
}

/**
 * Scale layers about a document-space anchor, resolved from the drag origin.
 *
 * Ratios are measured in each layer's *local* space (pointer positions run
 * through the inverse origin matrix), so the anchor truly stays put even on
 * rotated layers, the position is recomputed with the same composition the
 * renderer draws. Like `moveLayers`: constants rewrite in place, tracked
 * properties key at `frame`, locked layers skip, no-ops return the input doc.
 *
 * Flips are clamped to a small positive scale in this version; dragging past
 * the anchor stops at a sliver rather than mirroring.
 */
export function scaleLayers(
  doc: RiffDocument,
  origins: readonly ScaleOrigin[],
  anchor: { x: number; y: number },
  start: { x: number; y: number },
  current: { x: number; y: number },
  options: ScaleOptions,
  frame: Frame,
): RiffDocument {
  if (origins.length === 0) return doc;
  const layers = { ...doc.layers };
  let tracks = doc.tracks;
  let changed = false;

  for (const o of origins) {
    const layer = layers[o.layerId];
    if (!layer || layer.locked) continue;

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
    if (!inv) continue;
    const [ax, ay] = [anchor.x, anchor.y];
    const [plx, ply] = applyMatrix(inv, ax, ay);
    const [slx, sly] = applyMatrix(inv, start.x, start.y);
    const [clx, cly] = applyMatrix(inv, current.x, current.y);

    const denomX = slx - plx;
    const denomY = sly - ply;
    // A zero-size layer has no extent to ratio against; any drag then just
    // holds its scale rather than producing NaN.
    let rx = Math.abs(denomX) < 1e-6 ? 1 : (clx - plx) / denomX;
    let ry = Math.abs(denomY) < 1e-6 ? 1 : (cly - ply) / denomY;
    if (!options.axes.x) rx = 1;
    if (!options.axes.y) ry = 1;
    if (options.uniform && options.axes.x && options.axes.y) {
      // The dominant axis wins: dragging outward always grows, inward
      // always shrinks, and the box never collapses along one axis.
      const r = Math.max(rx, ry);
      rx = r;
      ry = r;
    }
    rx = Math.max(0.01, rx);
    ry = Math.max(0.01, ry);

    const nextSX = o.scaleX * rx;
    const nextSY = o.scaleY * ry;
    // Position the layer so the anchor maps back onto itself.
    const n1 = composeLayerMatrix(
      0,
      0,
      o.rotation,
      nextSX,
      nextSY,
      o.pivotX,
      o.pivotY,
    );
    const [vx, vy] = applyMatrix(n1, plx, ply);
    const nextX = ax - vx;
    const nextY = ay - vy;

    let dirty = false;
    const writes: {
      path:
        | "transform.x"
        | "transform.y"
        | "transform.scaleX"
        | "transform.scaleY";
      value: number;
    }[] = [
      { path: "transform.x", value: nextX },
      { path: "transform.y", value: nextY },
      { path: "transform.scaleX", value: nextSX },
      { path: "transform.scaleY", value: nextSY },
    ];

    let next = layer;
    for (const { path, value } of writes) {
      const prop = readAnimatable(layer, path);
      if (prop.kind === "const") {
        if (prop.value !== value) {
          next = writeAnimatable(next, path, { kind: "const", value });
          dirty = true;
        }
        continue;
      }
      if (!tracks[prop.trackId]) continue;
      const track = tracks[prop.trackId];
      const previous = [...track.keyframes]
        .reverse()
        .find((k) => k.frame < frame);
      const existing = track.keyframes.find((k) => k.frame === frame);
      if (existing && existing.value === value) continue;
      const easing = existing
        ? existing.easing
        : (previous?.easing ?? defaultEasing(track.property));
      tracks = {
        ...tracks,
        [prop.trackId]: {
          ...track,
          keyframes: setKeyframe(track.keyframes, { frame, value, easing }),
        },
      };
      dirty = true;
    }
    if (next !== layer) layers[o.layerId] = next;
    if (dirty) changed = true;
  }

  return changed ? { ...doc, layers, tracks } : doc;
}

/**
 * Give a part's property a track, creating it when the property is constant.
 *
 * A freshly drawn part holds every property as a constant, so keyframing has to
 * be able to *create* the track, seeded with the value the user is already
 * looking at, so "key this" never moves anything.
 *
 * The seed key uses the property's default easing, so the first key a user sets
 * already interpolates the way a pose-to-pose rig wants.
 */
export function ensureTrack(
  doc: RiffDocument,
  layerId: LayerId,
  propertyPath: string,
  frame: Frame,
): { doc: RiffDocument; trackId: TrackId } {
  const layer = doc.layers[layerId];
  if (!layer) return { doc, trackId: "" as TrackId };
  const current = readAnimatable(layer, propertyPath);
  if (current.kind === "track" && doc.tracks[current.trackId]) {
    return { doc, trackId: current.trackId };
  }
  const trackId = newId("Track");
  const track: Track = {
    id: trackId,
    property: propertyPath,
    keyframes: [
      {
        frame,
        value: evalAnimatable(current, doc.tracks, frame),
        easing: defaultEasing(propertyPath),
      },
    ],
  };
  return {
    doc: {
      ...doc,
      tracks: { ...doc.tracks, [trackId]: track },
      layers: {
        ...doc.layers,
        [layerId]: writeAnimatable(layer, propertyPath, {
          kind: "track",
          trackId,
        }),
      },
    },
    trackId,
  };
}

/**
 * Write a value into a track at `frame`, creating the keyframe when absent.
 *
 * M8 ruling: typing into a keyframed property in the inspector keys the value
 * at the playhead (Figma Motion's auto-key behaviour) instead of being refused.
 * An existing key keeps its easing; a new one inherits the segment's.
 */
export function upsertKeyframe(
  doc: RiffDocument,
  trackId: TrackId,
  frame: Frame,
  value: number,
): RiffDocument {
  const track = doc.tracks[trackId];
  if (!track) return doc;
  const existing = track.keyframes.find((k) => k.frame === frame);
  const previous = [...track.keyframes].reverse().find((k) => k.frame < frame);
  const easing = existing
    ? existing.easing
    : (previous?.easing ?? defaultEasing(track.property));
  return {
    ...doc,
    tracks: {
      ...doc.tracks,
      [trackId]: {
        ...track,
        keyframes: setKeyframe(track.keyframes, { frame, value, easing }),
      },
    },
  };
}

/**
 * Properties a part gets keyed on when it animates nothing yet.
 *
 * A cutout pose is angles first, then where the part sits. Keying all nine
 * properties would leave seven nobody asked for.
 */
export const POSE_DEFAULTS = [
  "transform.rotation",
  "transform.x",
  "transform.y",
];

/**
 * Key parts at a frame.
 *
 * Every property a part already animates is keyed, so pressing K in two places
 * makes a pose-to-pose move out of whatever was already moving. Lives here
 * rather than in the timeline because K has to work wherever the user is
 * looking, and a shortcut that depends on which panel has focus is a shortcut
 * that looks broken.
 */
export function keyPartsAt(
  doc: RiffDocument,
  ids: readonly LayerId[],
  frame: Frame,
  properties: readonly {
    path: string;
    read: (layer: Layer) => AnimatableNumber;
  }[],
): RiffDocument {
  let out = doc;
  for (const layerId of ids) {
    const layer = out.layers[layerId];
    if (!layer || layer.locked) continue;
    const animated = properties
      .filter((prop) => prop.read(layer).kind === "track")
      .map((prop) => prop.path);
    const targets = animated.length > 0 ? animated : POSE_DEFAULTS;
    for (const path of targets) {
      const ensured = ensureTrack(out, layerId, path, frame);
      out = ensured.doc;
      const track = out.tracks[ensured.trackId];
      if (!track) continue;
      out = addKeyframeAt(out, ensured.trackId, frame, evalTrack(track, frame));
    }
  }
  return out;
}

/**
 * The nearest keyed frames either side of `frame`, across the whole document.
 *
 * What the ghost poses are drawn at. Document-wide rather than per selection,
 * because the thing you pose against is the rest of the character, not the one
 * part you happen to have clicked.
 */
export function neighbourKeyFrames(
  doc: RiffDocument,
  frame: Frame,
): { before: Frame | null; after: Frame | null } {
  let before: Frame | null = null;
  let after: Frame | null = null;
  for (const track of Object.values(doc.tracks)) {
    for (const key of track.keyframes) {
      if (key.frame < frame && (before === null || key.frame > before)) {
        before = key.frame;
      }
      if (key.frame > frame && (after === null || key.frame < after)) {
        after = key.frame;
      }
    }
  }
  return { before, after };
}

export interface ClipPatch {
  inFrame?: Frame;
  outFrame?: Frame;
  timeOffset?: Frame;
}

/** Retime or trim a layer's clip, keeping `inFrame < outFrame`. */
export function setLayerClip(
  doc: RiffDocument,
  layerId: LayerId,
  patch: ClipPatch,
): RiffDocument {
  const layer = doc.layers[layerId];
  if (!layer) return doc;

  const inFrame = patch.inFrame ?? layer.inFrame;
  const outFrame = patch.outFrame ?? layer.outFrame;
  const next = {
    ...layer,
    inFrame: Math.min(inFrame, outFrame - 1),
    outFrame: Math.max(outFrame, inFrame + 1),
    timeOffset: patch.timeOffset ?? layer.timeOffset,
  };

  if (
    next.inFrame === layer.inFrame &&
    next.outFrame === layer.outFrame &&
    next.timeOffset === layer.timeOffset
  ) {
    return doc;
  }
  return { ...doc, layers: { ...doc.layers, [layerId]: next } };
}

/** Collapse state is persisted document state, but it is not an edit worth undoing. */
export function setLayerCollapsed(
  doc: RiffDocument,
  layerId: LayerId,
  collapsed: boolean,
): RiffDocument {
  const layer = doc.layers[layerId];
  if (!layer || layer.collapsed === collapsed) return doc;
  return {
    ...doc,
    layers: { ...doc.layers, [layerId]: { ...layer, collapsed } },
  };
}

export function setLayerVisible(
  doc: RiffDocument,
  layerId: LayerId,
  visible: boolean,
): RiffDocument {
  const layer = doc.layers[layerId];
  if (!layer || layer.visible === visible) return doc;
  return {
    ...doc,
    layers: { ...doc.layers, [layerId]: { ...layer, visible } },
  };
}

// ------------------------------------------------------ document frame count

/**
 * Set the document's length, keeping every layer clip inside it.
 *
 * Shortening the document used to leave clips dangling past the end: the
 * timeline would report a layer as "frames 0 to 96" while the playhead read
 * "frame 0 of 1", and the exporters would walk frames that no longer exist.
 * A clip is trimmed to the new end, and a clip that starts past the end is
 * pulled back so it still covers at least one frame -- a zero-length clip is
 * not a thing the rest of the editor knows how to draw.
 *
 * The floor is one frame. A document with no frames has nothing to show.
 */
export function setDocumentFrameCount(
  doc: RiffDocument,
  frameCount: Frame,
): RiffDocument {
  const next = Math.max(
    1,
    Math.round(Number.isFinite(frameCount) ? frameCount : 1),
  );
  if (next === doc.frameCount) return doc;

  let layers = doc.layers;
  let touched = false;
  for (const layer of Object.values(doc.layers)) {
    const outFrame = Math.min(layer.outFrame, next);
    const inFrame = Math.min(layer.inFrame, Math.max(0, outFrame - 1));
    if (outFrame === layer.outFrame && inFrame === layer.inFrame) continue;
    if (!touched) {
      layers = { ...doc.layers };
      touched = true;
    }
    layers[layer.id] = { ...layer, inFrame, outFrame };
  }

  const loopIn = Math.min(doc.loopIn, next - 1);
  const loopOut = Math.min(Math.max(doc.loopOut, loopIn + 1), next);
  return { ...doc, frameCount: next, loopIn, loopOut, layers };
}

/** Set the playback loop range, keeping it inside the document and non-empty. */
export function setLoopRange(
  doc: RiffDocument,
  loopIn: Frame,
  loopOut: Frame,
): RiffDocument {
  const count = Math.max(1, doc.frameCount);
  const start = Math.min(Math.max(0, Math.round(loopIn)), count - 1);
  const end = Math.min(Math.max(start + 1, Math.round(loopOut)), count);
  if (start === doc.loopIn && end === doc.loopOut) return doc;
  return { ...doc, loopIn: start, loopOut: end };
}

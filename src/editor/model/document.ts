/**
 * riff document model: a 2D cutout character rig.
 *
 * Three rules, and every awkward-looking decision below follows from one of them:
 *
 * 1. Flat normalized tables keyed by id, never nested trees. The skeleton lives
 *    in `parentLayerId`; the draw order lives in one flat array on the artboard.
 *    Keeping them apart is the whole point of a cutout rig: a back arm hangs off
 *    the torso but draws behind it, and a model that forces one list to mean both
 *    cannot say that.
 *
 * 2. Paths are numeric data, not entity graphs. A part carries several contours
 *    and a brush stroke carries hundreds of samples; modelling each vertex as an
 *    object is how an editor ends up with fifty thousand live entities. Vertices
 *    live in typed arrays and only the path being edited is ever materialised.
 *
 * 3. Subpaths are first class. A closed shape has holes, so a path is a list of
 *    contours and code that assumes one contour per path is wrong here.
 *
 * Time is an integer frame index throughout. A pose is a set of keyframes at one
 * frame, and floating-point seconds in a frame-by-frame tool only create
 * rounding disputes about which frame the playhead is on.
 */

// ---------------------------------------------------------------- identifiers

/**
 * Branded ids. Plain strings at runtime, distinct types at compile time, so a
 * LayerId cannot be passed where a PathId is expected.
 */
export type Id<T extends string> = string & { readonly __brand: T };

export type DocumentId = Id<"Document">;
export type ArtboardId = Id<"Artboard">;
export type LayerId = Id<"Layer">;
export type PathId = Id<"Path">;
export type TrackId = Id<"Track">;
export type VariantId = Id<"Variant">;

/** Integer frame index. riff's canonical unit of time. */
export type Frame = number;

let idCounter = 0;

/** Monotonic per-session id. Not globally unique; documents are re-keyed on load. */
export function newId<T extends string>(prefix: T): Id<T> {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36)}` as Id<T>;
}

// --------------------------------------------------------------------- colour

/** Straight (non-premultiplied) alpha, channels 0-255, alpha 0-1. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function rgbaToCss({ r, g, b, a }: RGBA): string {
  return a >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${a})`;
}

/**
 * Parse `#rgb`, `#rrggbb`, or `#rrggbbaa`.
 *
 * Hand-edited documents and pasted values use all three forms, and silently
 * failing on a shorthand hex is a uniquely annoying bug to track down.
 */
export function parseHex(hex: string): RGBA | null {
  const h = hex.trim().replace(/^#/, "");
  const expand = (s: string) => Number.parseInt(s, 16);
  if (h.length === 3) {
    return {
      r: expand(h[0] + h[0]),
      g: expand(h[1] + h[1]),
      b: expand(h[2] + h[2]),
      a: 1,
    };
  }
  if (h.length === 6 || h.length === 8) {
    return {
      r: expand(h.slice(0, 2)),
      g: expand(h.slice(2, 4)),
      b: expand(h.slice(4, 6)),
      a: h.length === 8 ? expand(h.slice(6, 8)) / 255 : 1,
    };
  }
  return null;
}

export function toHex({ r, g, b }: RGBA): string {
  const pair = (n: number) =>
    Math.round(Math.min(Math.max(n, 0), 255))
      .toString(16)
      .padStart(2, "0");
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

// ------------------------------------------------------------------ animation

/**
 * A property that is either a constant or driven by a track, never both.
 *
 * Storing a fallback value alongside a track is the classic version of this type
 * and it rots: the two disagree, and which one wins becomes a question of which
 * code path read it. A discriminated union makes the question unaskable.
 */
export type Animatable<T> =
  | { kind: "const"; value: T }
  | { kind: "track"; trackId: TrackId };

export type AnimatableNumber = Animatable<number>;

export const constant = <T>(value: T): Animatable<T> => ({
  kind: "const",
  value,
});

/**
 * Easing for the segment *leaving* this keyframe, as a cubic in the unit square.
 *
 * Owning the curve on the earlier keyframe (rather than storing an "in" and an
 * "out" per keyframe) means x is already a fraction of the segment, so the curve
 * needs no rescaling when a neighbouring keyframe moves.
 *
 * y is deliberately unclamped: values outside [0,1] are what overshoot and
 * anticipation are made of.
 */
export interface Easing {
  /** Control point 1, x in [0,1]. */
  x1: number;
  y1: number;
  /** Control point 2, x in [0,1]. */
  x2: number;
  y2: number;
  /** Hold: no interpolation, snap at the next keyframe. Variant tracks use it. */
  hold: boolean;
}

export const EASING: Record<string, Easing> = {
  hold: { x1: 0, y1: 0, x2: 1, y2: 1, hold: true },
  linear: { x1: 0, y1: 0, x2: 1, y2: 1, hold: false },
  ease: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1, hold: false },
  easeIn: { x1: 0.42, y1: 0, x2: 1, y2: 1, hold: false },
  easeOut: { x1: 0, y1: 0, x2: 0.58, y2: 1, hold: false },
  easeInOut: { x1: 0.42, y1: 0, x2: 0.58, y2: 1, hold: false },
  /** Settles past the target and comes back. The cutout rig's snap. */
  overshoot: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1, hold: false },
};

export interface Keyframe {
  frame: Frame;
  value: number;
  /** Applies to the span from this keyframe to the next one. */
  easing: Easing;
}

export interface Track {
  id: TrackId;
  /** Human-facing property path, e.g. `transform.rotation`. Used by the timeline. */
  property: string;
  /** Sorted by `frame`, ascending. Every reader may rely on this. */
  keyframes: Keyframe[];
}

// ------------------------------------------------------------------ transform

/**
 * Transform stored as separable scalars rather than a matrix.
 *
 * A matrix cannot be keyframed usefully (interpolating two matrices gives shear
 * where a rotation was intended) and it cannot be shown in an inspector without
 * being decomposed first. Keeping the scalars authoritative and composing on
 * demand means the inspector, the timeline, and the renderer read the same
 * numbers.
 *
 * The joint is not here: it is a rig fact, not an animated one, so it lives on
 * the layer as two plain numbers.
 */
export interface TransformProps {
  x: AnimatableNumber;
  y: AnimatableNumber;
  /** Degrees, clockwise, to match every design tool a user has already learned. */
  rotation: AnimatableNumber;
  scaleX: AnimatableNumber;
  scaleY: AnimatableNumber;
  /**
   * Shear, in degrees, on each axis. Shown as "Slant".
   *
   * This is the one control that buys a flat cutout a sense of depth: a head
   * that leans and shears at once reads as turning rather than as sliding, and
   * a torso that shears under a swinging arm reads as twisting. Every rig tool
   * that looks three-dimensional and is not has this.
   */
  skewX: AnimatableNumber;
  skewY: AnimatableNumber;
}

export function identityTransform(): TransformProps {
  return {
    x: constant(0),
    y: constant(0),
    rotation: constant(0),
    scaleX: constant(1),
    scaleY: constant(1),
    skewX: constant(0),
    skewY: constant(0),
  };
}

/** Row-major 2D affine, matching the argument order of `setTransform`. */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function multiply(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

export function invert(m: Matrix): Matrix | null {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

// ----------------------------------------------------------------------- style

export type FillRule = "nonzero" | "evenodd";

// ------------------------------------------------------------------- geometry

/**
 * One path's geometry, stored as flat numeric arrays.
 *
 * `d` is kept verbatim alongside the parsed form because `new Path2D(d)` is the
 * fastest way to get artwork onto a canvas: the browser parses it in native code
 * and we never touch the vertices during playback. The parsed arrays exist for
 * editing, hit-refinement and export; they become the source of truth the moment
 * a user edits, at which point `d` is regenerated.
 */
export interface PathGeometry {
  id: PathId;
  /** SVG path data. Authoritative until the path is edited. */
  d: string;
  /** Interleaved x,y vertex positions. */
  vertices: Float64Array;
  /** In-tangent per vertex, relative to that vertex. Zero for corners. */
  tangentsIn: Float64Array;
  /** Out-tangent per vertex, relative to that vertex. */
  tangentsOut: Float64Array;
  /** Index into `vertices` (in vertex units) where each subpath begins. */
  subpathStarts: Uint32Array;
  /** Whether each subpath is closed. Parallel to `subpathStarts`. */
  subpathClosed: Uint8Array;
  /** Axis-aligned bounds in the path's own space: [minX, minY, maxX, maxY]. */
  bounds: [number, number, number, number];
  /**
   * Per-vertex pen pressure in [0,1], for marker strokes drawn with the brush.
   * Absent on every other path, and absent means "stroke at one weight".
   */
  pressure?: Float64Array;
}

// --------------------------------------------------------------------- layers

/**
 * One drawing a part can wear.
 *
 * Variants share the part's transform and joint, so swapping one is a swap of
 * geometry alone: an eye blinks, a mouth changes shape, a hand opens, and the
 * arm it hangs off never notices.
 */
export interface Variant {
  id: VariantId;
  name: string;
  /** Drawn in order, as one shape with one style. */
  pathIds: PathId[];
  /** null means an open ink line with no fill. */
  fill: RGBA | null;
  fillRule: FillRule;
  /** The part's own outline. null means no outline. */
  stroke: RGBA | null;
  strokeWidth: number;
  /** A raster attachment instead of paths. Imported art lands here. */
  image: { src: string; width: number; height: number } | null;
}

export type LayerKind = "part";

/**
 * A rig part: one layer, one joint, one parent, one stack of variants.
 *
 * A part with no variants is a null joint, the rig equivalent of a group, and
 * that is deliberately the same type. Two layer kinds where one would do is how
 * an editor ends up with "this action is not available for a group".
 */
export interface PartLayer {
  id: LayerId;
  artboardId: ArtboardId;
  kind: "part";
  name: string;

  /** The joint this part hangs off. null means it is a root. */
  parentLayerId: LayerId | null;

  /** First frame this part renders on. */
  inFrame: Frame;
  /** Exclusive. */
  outFrame: Frame;
  /** Local time = globalFrame - timeOffset. Overlapping action lives here. */
  timeOffset: Frame;

  visible: boolean;
  locked: boolean;
  /** UI state, persisted because collapse surviving a reload is expected. */
  collapsed: boolean;

  transform: TransformProps;
  /** The joint, in the part's own coordinates. Rotation and scale happen here. */
  pivot: { x: number; y: number };
  opacity: AnimatableNumber;

  /**
   * How far fill-only copies of this part are pushed toward its parent, 0 to 3.
   *
   * This is what hides the gap at a joint: the child's fill is repeated a few
   * pixels under the parent, and the parent's own outline covers the seam.
   */
  overlap: number;

  /**
   * Draw order offset, animatable.
   *
   * The artboard's list settles what is in front at rest; this moves a part
   * through the stack over time. It is what lets an arm swing in front of the
   * body and back behind it in one action, which is the other half of making a
   * flat cutout read as three-dimensional. Higher draws in front.
   */
  depth: AnimatableNumber;

  variants: Variant[];
  /** Index into `variants`. Keyed with hold easing, so it steps rather than blends. */
  variant: AnimatableNumber;
  /** Index of the variant shown while blinking, or null for a part that never blinks. */
  blinkVariant: number | null;
}

export type Layer = PartLayer;

// ------------------------------------------------------------------- artboard

/**
 * The white outline every part gets before any artwork is drawn.
 *
 * One pass over the whole rig rather than a per-part property, because a halo
 * some parts have and others do not is a sticker with a hole in it.
 */
export interface Halo {
  enabled: boolean;
  width: number;
  color: RGBA;
}

export interface Artboard {
  id: ArtboardId;
  name: string;
  width: number;
  height: number;
  /** null renders the transparency checkerboard, which is the rig default. */
  background: RGBA | null;
  /**
   * Draw order, back to front. Index 0 is the bottom of the stack.
   *
   * Independent of `parentLayerId` on purpose: in a cutout rig the back arm
   * hangs off the torso and draws behind it.
   */
  layerIds: LayerId[];
  /** Clip content to the artboard bounds. */
  clip: boolean;
  halo: Halo;
}

export function defaultHalo(): Halo {
  return { enabled: false, width: 10, color: { r: 255, g: 255, b: 255, a: 1 } };
}

// ------------------------------------------------------------------- document

/** Bumped when the saved shape changes in a way old files cannot be read as. */
export const DOCUMENT_VERSION = 1;

export interface RiffDocument {
  id: DocumentId;
  version: number;
  name: string;
  fps: number;
  /** Valid frames are [0, frameCount). */
  frameCount: Frame;
  /** Playback loop range, in frames. `loopOut` is exclusive. */
  loopIn: Frame;
  loopOut: Frame;

  artboards: Record<ArtboardId, Artboard>;
  layers: Record<LayerId, Layer>;
  paths: Record<PathId, PathGeometry>;
  tracks: Record<TrackId, Track>;

  artboardIds: ArtboardId[];
  activeArtboardId: ArtboardId;
}

/**
 * A blank rig.
 *
 * Portrait by default, because a character is taller than it is wide and the
 * page is what the exported player uses as its canvas.
 */
export function emptyDocument(
  width = 600,
  height = 800,
  fps = 24,
): RiffDocument {
  const artboardId = newId("Artboard");
  const artboard: Artboard = {
    id: artboardId,
    name: "Page",
    width,
    height,
    background: null,
    layerIds: [],
    clip: false,
    halo: defaultHalo(),
  };
  return {
    id: newId("Document"),
    version: DOCUMENT_VERSION,
    name: "Untitled character",
    fps,
    frameCount: 48,
    loopIn: 0,
    loopOut: 48,
    artboards: { [artboardId]: artboard },
    layers: {},
    paths: {},
    tracks: {},
    artboardIds: [artboardId],
    activeArtboardId: artboardId,
  };
}

// ------------------------------------------------------------------ factories

/** The starting ink for a new drawing. Warm near-black, never pure #000. */
export const INK: RGBA = { r: 22, g: 23, b: 25, a: 1 };

/**
 * The starting fill: a neutral that reads on the checkerboard and belongs to no
 * character in particular. Every rig recolours it on the first pass, and a
 * default with an opinion is a default someone has to undo.
 */
export const NEUTRAL_FILL: RGBA = { r: 199, g: 205, b: 214, a: 1 };

/**
 * The colour picker's starting swatches.
 *
 * Deliberately brand-neutral: four neutrals to build a figure out of, then one
 * step of each hue for skin, cloth and props. Nothing here encodes a particular
 * character.
 */
export interface Swatch {
  hex: string;
  /** What a person would call it out loud. Never the hex code. */
  name: string;
}

export const SWATCHES: readonly Swatch[] = [
  { hex: "#FFFFFF", name: "White" },
  { hex: "#C7CDD6", name: "Light grey" },
  { hex: "#6B7280", name: "Grey" },
  { hex: "#161719", name: "Near black" },
  { hex: "#F3C9A8", name: "Skin" },
  { hex: "#E8724C", name: "Orange" },
  { hex: "#E3B23C", name: "Yellow" },
  { hex: "#5FA85C", name: "Green" },
  { hex: "#3E8EDE", name: "Blue" },
  { hex: "#8A6FD1", name: "Purple" },
  { hex: "#D45D8B", name: "Pink" },
  { hex: "#8A5A3B", name: "Brown" },
];

export function newVariant(patch: Partial<Variant> = {}): Variant {
  return {
    id: newId("Variant"),
    name: "Default",
    pathIds: [],
    fill: NEUTRAL_FILL,
    fillRule: "nonzero",
    stroke: INK,
    strokeWidth: 7,
    image: null,
    ...patch,
  };
}

export function newPart(
  artboardId: ArtboardId,
  patch: Partial<PartLayer> = {},
): PartLayer {
  return {
    id: newId("Layer"),
    artboardId,
    kind: "part",
    name: "Part",
    parentLayerId: null,
    inFrame: 0,
    outFrame: Number.MAX_SAFE_INTEGER,
    timeOffset: 0,
    visible: true,
    locked: false,
    collapsed: false,
    transform: identityTransform(),
    pivot: { x: 0, y: 0 },
    opacity: constant(1),
    overlap: 0,
    depth: constant(0),
    variants: [newVariant()],
    variant: constant(0),
    blinkVariant: null,
    ...patch,
  };
}

/**
 * Import a file from the legacy single-file studio.
 *
 * riff grew out of a one-page prototype whose saved format ("v3") is close
 * enough to this one that the conversion is mostly renaming: `parts` become
 * parts, `pivot` becomes the joint, `overlap` carries straight over. Two things
 * genuinely change shape:
 *
 * - Angles are radians there and degrees here, because every inspector a user
 *   has met shows degrees.
 *
 * - Poses and a step sequence become keyframes. A pose is a set of angles held
 *   for `hold` milliseconds and then eased into the next over `duration`, which
 *   is exactly two keyframes per step per joint: one closing the hold, one
 *   opening the ease. Variant picks become a hold-eased variant track, which is
 *   what makes a mouth shape snap rather than blend.
 */

import {
  EASING,
  type Easing,
  emptyDocument,
  type LayerId,
  newId,
  newPart,
  newVariant,
  type PartLayer,
  type PathGeometry,
  type PathId,
  parseHex,
  type RGBA,
  type RiffDocument,
  type Track,
  type TrackId,
  type Variant,
} from "../model/document";
import { parsePathData } from "../model/path";
import { contoursToGeometry, smoothSamples } from "../model/polyline";
import { fitPageToContent } from "../model/rig";
import { cubicPathData } from "../model/shapes";

/** The legacy tracer frame, in the matrix order that format stored it. */
const TRACE: [number, number, number, number, number, number] = [
  0.1, 0, 0, -0.1, 0, 330,
];

const EASE_BY_NAME: Record<string, Easing> = {
  smooth: EASING.easeInOut,
  snappy: EASING.easeOut,
  bouncy: EASING.overshoot,
  linear: EASING.linear,
};

interface ProtoVariant {
  id?: string;
  name?: string;
  kind?: "path" | "draw" | "image";
  d?: string;
  pts?: number[][];
  closed?: boolean;
  open?: boolean;
  evenodd?: boolean;
  trace?: boolean;
  src?: string;
  w?: number;
  h?: number;
  fill?: string;
  ink?: number;
}

interface ProtoPart {
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  sx?: number;
  sy?: number;
  rot?: number;
  pivot?: [number, number];
  parent?: string | null;
  overlap?: number;
  hidden?: boolean;
  blink?: string | null;
  timeOffset?: number;
  variants?: ProtoVariant[];
}

interface ProtoProject {
  v?: number;
  parts?: ProtoPart[];
  poses?: Record<
    string,
    { angles?: Record<string, number>; variants?: Record<string, string> }
  >;
  anim?: (
    | string
    | { pose?: string; duration?: number; hold?: number; ease?: string }
  )[];
  play?: { speed?: number; ease?: string; loop?: boolean };
}

/** True when this parsed JSON looks like a legacy studio file, not a riff one. */
export function isLegacyStudioFile(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as ProtoProject;
  return Array.isArray(value.parts) && typeof value.v === "number";
}

function colour(hex: string | undefined, fallback: RGBA | null): RGBA | null {
  if (!hex) return fallback;
  return parseHex(hex) ?? fallback;
}

function tracePath(d: string, id: PathId): PathGeometry {
  const parsed = parsePathData(d);
  const [a, b, c, dd, e, f] = TRACE;
  const vertices = Float64Array.from(parsed.vertices);
  const tangentsIn = Float64Array.from(parsed.tangentsIn);
  const tangentsOut = Float64Array.from(parsed.tangentsOut);
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < vertices.length; i += 2) {
    const x = vertices[i];
    const y = vertices[i + 1];
    vertices[i] = a * x + c * y + e;
    vertices[i + 1] = b * x + dd * y + f;
    // Tangents are deltas, so only the linear part applies.
    for (const array of [tangentsIn, tangentsOut]) {
      const tx = array[i];
      const ty = array[i + 1];
      array[i] = a * tx + c * ty;
      array[i + 1] = b * tx + dd * ty;
    }
    x0 = Math.min(x0, vertices[i]);
    x1 = Math.max(x1, vertices[i]);
    y0 = Math.min(y0, vertices[i + 1]);
    y1 = Math.max(y1, vertices[i + 1]);
  }
  const geometry: PathGeometry = {
    ...parsed,
    id,
    d: "",
    vertices,
    tangentsIn,
    tangentsOut,
    bounds: Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0],
  };
  return { ...geometry, d: cubicPathData(geometry) };
}

function plainPath(d: string, id: PathId): PathGeometry {
  return { ...parsePathData(d), id, d };
}

function drawnPath(variant: ProtoVariant, id: PathId): PathGeometry | null {
  const samples = variant.pts ?? [];
  if (samples.length < 2) return null;
  const points: number[] = [];
  const pressure: number[] = [];
  for (const sample of samples) {
    points.push(sample[0], sample[1]);
    pressure.push(typeof sample[2] === "number" ? sample[2] : 0.5);
  }
  const smoothed = smoothSamples(points, pressure, !!variant.closed);
  return contoursToGeometry(
    [
      {
        points: smoothed.points,
        pressure: smoothed.pressure,
        closed: !!variant.closed,
      },
    ],
    id,
  );
}

export interface LegacyStudioImport {
  doc: RiffDocument;
  warnings: string[];
}

/**
 * Convert a legacy studio file into a riff character.
 *
 * `fps` is chosen by the caller because that format stores milliseconds and has
 * no frame rate of its own; 24 is the editor's default and rounds its 500 ms
 * steps onto whole frames.
 */
export function importLegacyStudio(
  raw: unknown,
  options: { fps?: number } = {},
): LegacyStudioImport {
  const project = raw as ProtoProject;
  const warnings: string[] = [];
  if (!isLegacyStudioFile(project)) {
    throw new Error("That file is not a legacy studio file.");
  }

  const fps = options.fps ?? 24;
  const base = emptyDocument(900, 900, fps);
  const artboardId = base.activeArtboardId;

  const paths: Record<PathId, PathGeometry> = {};
  const layers: Record<LayerId, PartLayer> = {};
  const order: LayerId[] = [];
  // The file's ids are its own; map them so one with a part called
  // "face" cannot collide with a riff layer id.
  const idMap = new Map<string, LayerId>();

  for (const part of project.parts ?? []) {
    const layer = newPart(artboardId, {
      name: part.name ?? "Part",
      pivot: { x: part.pivot?.[0] ?? 0, y: part.pivot?.[1] ?? 0 },
      overlap: Math.min(3, Math.max(0, Math.round(part.overlap ?? 0))),
      visible: part.hidden !== true,
      timeOffset: Math.round(((part.timeOffset ?? 0) / 1000) * fps),
      transform: {
        x: { kind: "const", value: part.x ?? 0 },
        y: { kind: "const", value: part.y ?? 0 },
        rotation: {
          kind: "const",
          value: ((part.rot ?? 0) * 180) / Math.PI,
        },
        scaleX: { kind: "const", value: part.sx ?? 1 },
        scaleY: { kind: "const", value: part.sy ?? 1 },
        skewX: { kind: "const", value: 0 },
        skewY: { kind: "const", value: 0 },
      },
      variants: [],
    });
    if (part.id) idMap.set(part.id, layer.id);

    const variants: Variant[] = [];
    for (const source of part.variants ?? []) {
      const pathIds: PathId[] = [];
      let geometry: PathGeometry | null = null;
      const pathId = newId("Path");
      if (source.kind === "image") {
        // Images carry no geometry; the attachment holds the source.
      } else if (source.kind === "draw") {
        geometry = drawnPath(source, pathId);
      } else if (source.d) {
        geometry = source.trace
          ? tracePath(source.d, pathId)
          : plainPath(source.d, pathId);
      }
      if (geometry) {
        paths[geometry.id] = geometry;
        pathIds.push(geometry.id);
      }

      const filled =
        source.kind === "draw" ? source.closed === true : source.open !== true;
      variants.push(
        newVariant({
          name: source.name ?? "Default",
          pathIds,
          fill: filled ? colour(source.fill, null) : null,
          fillRule: source.evenodd ? "evenodd" : "nonzero",
          stroke:
            (source.ink ?? 0) > 0 || source.kind === "draw"
              ? { r: 22, g: 23, b: 25, a: 1 }
              : null,
          strokeWidth: source.ink ?? 0,
          image:
            source.kind === "image" && source.src
              ? { src: source.src, width: source.w ?? 0, height: source.h ?? 0 }
              : null,
        }),
      );
    }
    layer.variants = variants;
    if (variants.length === 0) {
      warnings.push(`"${layer.name}" arrived with no drawing.`);
    }
    if (part.blink) {
      const index = variants.findIndex((v) => v.name === part.blink);
      layer.blinkVariant = index >= 0 ? index : null;
    }

    layers[layer.id] = layer;
    order.push(layer.id);
  }

  for (const part of project.parts ?? []) {
    if (!part.id || !part.parent) continue;
    const child = idMap.get(part.id);
    const parent = idMap.get(part.parent);
    if (child && parent && layers[child]) {
      layers[child].parentLayerId = parent;
    }
  }

  const { tracks, frameCount } = buildTracks(project, layers, idMap, fps);
  for (const track of Object.values(tracks)) {
    const [layerId, property] = track.property.split("|");
    const layer = layers[layerId as LayerId];
    if (!layer) continue;
    if (property === "variant") {
      layer.variant = { kind: "track", trackId: track.id };
    } else {
      layer.transform = {
        ...layer.transform,
        rotation: { kind: "track", trackId: track.id },
      };
    }
    track.property = property === "variant" ? "variant" : "transform.rotation";
  }

  const imported: RiffDocument = {
    ...base,
    name: "Imported character",
    frameCount,
    loopIn: 0,
    loopOut: frameCount,
    paths,
    layers,
    tracks,
    artboards: {
      ...base.artboards,
      [artboardId]: { ...base.artboards[artboardId], layerIds: order },
    },
  };

  // The file has no page of its own, so give it one that fits what arrived.
  return { doc: fitPageToContent(imported, 0), warnings };
}

interface Step {
  pose: string;
  startFrame: number;
  holdFrames: number;
  easing: Easing;
}

/**
 * Turn the legacy pose sequence into one rotation track per posed joint,
 * plus one variant track per part whose variant the sequence changes.
 *
 * The track's `property` is temporarily `layerId|property` so the caller can
 * attach it; it is rewritten to the real property path immediately after.
 */
function buildTracks(
  project: ProtoProject,
  layers: Record<LayerId, PartLayer>,
  idMap: Map<string, LayerId>,
  fps: number,
): { tracks: Record<TrackId, Track>; frameCount: number } {
  const poses = project.poses ?? {};
  const speed = project.play?.speed || 1;
  const defaultEase =
    EASE_BY_NAME[project.play?.ease ?? "smooth"] ?? EASING.easeInOut;

  const raw = (project.anim ?? [])
    .map((entry) => (typeof entry === "string" ? { pose: entry } : entry))
    .filter((entry) => entry?.pose && poses[entry.pose]);

  if (raw.length === 0) return { tracks: {}, frameCount: 48 };

  const steps: Step[] = [];
  let seconds = 0;
  for (const entry of raw) {
    const hold = (entry.hold ?? 0) / 1000 / speed;
    const duration = (entry.duration ?? 500) / 1000 / speed;
    steps.push({
      pose: entry.pose as string,
      startFrame: Math.round(seconds * fps),
      holdFrames: Math.round(hold * fps),
      easing: EASE_BY_NAME[entry.ease ?? ""] ?? defaultEase,
    });
    seconds += hold + duration;
  }
  const frameCount = Math.max(2, Math.round(seconds * fps) + 1);

  const angled = new Set<string>();
  const varied = new Set<string>();
  for (const pose of Object.values(poses)) {
    for (const id of Object.keys(pose.angles ?? {})) angled.add(id);
    for (const id of Object.keys(pose.variants ?? {})) varied.add(id);
  }

  const tracks: Record<TrackId, Track> = {};

  for (const protoId of angled) {
    const layerId = idMap.get(protoId);
    if (!layerId || !layers[layerId]) continue;
    const trackId = newId("Track");
    const keyframes = [];
    for (const step of steps) {
      const degrees =
        ((poses[step.pose]?.angles?.[protoId] ?? 0) * 180) / Math.PI;
      if (step.holdFrames > 0) {
        keyframes.push({
          frame: step.startFrame,
          value: degrees,
          easing: EASING.linear,
        });
      }
      keyframes.push({
        frame: step.startFrame + step.holdFrames,
        value: degrees,
        easing: step.easing,
      });
    }
    // Close the loop back onto the first pose.
    const first =
      ((poses[steps[0].pose]?.angles?.[protoId] ?? 0) * 180) / Math.PI;
    keyframes.push({
      frame: frameCount - 1,
      value: first,
      easing: steps[steps.length - 1].easing,
    });
    tracks[trackId] = {
      id: trackId,
      property: `${layerId}|transform.rotation`,
      keyframes: dedupe(keyframes),
    };
  }

  for (const protoId of varied) {
    const layerId = idMap.get(protoId);
    const layer = layerId ? layers[layerId] : undefined;
    if (!layerId || !layer) continue;
    const trackId = newId("Track");
    const keyframes = steps.map((step) => {
      const name = poses[step.pose]?.variants?.[protoId];
      const index = layer.variants.findIndex((v) => v.name === name);
      return {
        frame: step.startFrame,
        value: index >= 0 ? index : 0,
        easing: EASING.hold,
      };
    });
    tracks[trackId] = {
      id: trackId,
      property: `${layerId}|variant`,
      keyframes: dedupe(keyframes),
    };
  }

  return { tracks, frameCount };
}

/** Keep one keyframe per frame, the later one winning, and stay sorted. */
function dedupe(
  keyframes: { frame: number; value: number; easing: Easing }[],
): { frame: number; value: number; easing: Easing }[] {
  const byFrame = new Map<
    number,
    { frame: number; value: number; easing: Easing }
  >();
  for (const key of keyframes) byFrame.set(key.frame, key);
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

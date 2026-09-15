/**
 * Project files: the whole document, in and out.
 *
 * Typed arrays do not survive `JSON.stringify` as anything useful, so every
 * geometry array is written as a plain number array and rebuilt on read. That is
 * the only transformation in this file: the saved shape is otherwise the live
 * shape, because a file format that drifts from the model is a file format that
 * silently drops whatever was added last.
 *
 * Reading is defensive on purpose. A project file is a thing people hand to each
 * other, and half of them will have been hand-edited.
 */

import {
  type Artboard,
  type ArtboardId,
  DOCUMENT_VERSION,
  defaultHalo,
  emptyDocument,
  type Halo,
  identityTransform,
  type Layer,
  type LayerId,
  newId,
  type PathGeometry,
  type PathId,
  type RGBA,
  type RiffDocument,
  type Track,
  type TrackId,
  type Variant,
} from "../model/document";

interface StoredPath {
  id: string;
  d: string;
  vertices: number[];
  tangentsIn: number[];
  tangentsOut: number[];
  subpathStarts: number[];
  subpathClosed: number[];
  bounds: [number, number, number, number];
  pressure?: number[];
}

export interface StoredProject {
  format: "riff-rig";
  version: number;
  document: Omit<RiffDocument, "paths"> & { paths: Record<string, StoredPath> };
}

function storePath(path: PathGeometry): StoredPath {
  return {
    id: path.id,
    d: path.d,
    vertices: Array.from(path.vertices),
    tangentsIn: Array.from(path.tangentsIn),
    tangentsOut: Array.from(path.tangentsOut),
    subpathStarts: Array.from(path.subpathStarts),
    subpathClosed: Array.from(path.subpathClosed),
    bounds: path.bounds,
    ...(path.pressure ? { pressure: Array.from(path.pressure) } : {}),
  };
}

function readPath(raw: Partial<StoredPath>, id: PathId): PathGeometry | null {
  if (typeof raw?.d !== "string" && !Array.isArray(raw?.vertices)) return null;
  const vertices = Float64Array.from(raw.vertices ?? []);
  const zeros = new Float64Array(vertices.length);
  return {
    id,
    d: raw.d ?? "",
    vertices,
    tangentsIn: raw.tangentsIn ? Float64Array.from(raw.tangentsIn) : zeros,
    tangentsOut: raw.tangentsOut
      ? Float64Array.from(raw.tangentsOut)
      : zeros.slice(),
    subpathStarts: Uint32Array.from(raw.subpathStarts ?? [0]),
    subpathClosed: Uint8Array.from(raw.subpathClosed ?? [1]),
    bounds: raw.bounds ?? [0, 0, 0, 0],
    ...(raw.pressure ? { pressure: Float64Array.from(raw.pressure) } : {}),
  };
}

export function serializeProject(doc: RiffDocument): StoredProject {
  const paths: Record<string, StoredPath> = {};
  for (const [id, path] of Object.entries(doc.paths)) {
    paths[id] = storePath(path);
  }
  return {
    format: "riff-rig",
    version: DOCUMENT_VERSION,
    document: { ...doc, paths },
  };
}

export function projectToJson(doc: RiffDocument): string {
  return JSON.stringify(serializeProject(doc), null, 1);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

function readColor(raw: unknown, fallback: RGBA | null): RGBA | null {
  if (raw === null) return null;
  if (!isRecord(raw)) return fallback;
  const num = (key: string, or: number) =>
    typeof raw[key] === "number" ? (raw[key] as number) : or;
  return { r: num("r", 0), g: num("g", 0), b: num("b", 0), a: num("a", 1) };
}

function readHalo(raw: unknown): Halo {
  const base = defaultHalo();
  if (!isRecord(raw)) return base;
  return {
    enabled: raw.enabled === true,
    width: typeof raw.width === "number" ? raw.width : base.width,
    color: readColor(raw.color, base.color) ?? base.color,
  };
}

/**
 * Rebuild a document from a parsed project file.
 *
 * Throws only when the file is not a riff project at all. Anything else is
 * repaired: a missing field takes its default, a dangling id is dropped, and a
 * document that ends up with no artboard gets an empty one. A file that opens
 * missing one part beats a file that refuses to open.
 */
export function deserializeProject(raw: unknown): RiffDocument {
  if (!isRecord(raw)) throw new Error("That file is not a riff project.");
  const source = isRecord(raw.document) ? raw.document : raw;
  if (!isRecord(source.layers) || !isRecord(source.artboards)) {
    throw new Error("That file is not a riff character.");
  }

  const fallback = emptyDocument();

  const paths: Record<PathId, PathGeometry> = {};
  if (isRecord(source.paths)) {
    for (const [id, value] of Object.entries(source.paths)) {
      const path = readPath(value as Partial<StoredPath>, id as PathId);
      if (path) paths[id as PathId] = path;
    }
  }

  const tracks: Record<TrackId, Track> = {};
  if (isRecord(source.tracks)) {
    for (const [id, value] of Object.entries(source.tracks)) {
      if (!isRecord(value) || !Array.isArray(value.keyframes)) continue;
      tracks[id as TrackId] = {
        id: id as TrackId,
        property: typeof value.property === "string" ? value.property : "",
        keyframes: (value.keyframes as Record<string, unknown>[])
          .filter((k) => typeof k?.frame === "number")
          .map((k) => ({
            frame: Math.round(k.frame as number),
            value: typeof k.value === "number" ? k.value : 0,
            easing: isRecord(k.easing)
              ? {
                  x1: Number(k.easing.x1) || 0,
                  y1: Number(k.easing.y1) || 0,
                  x2: Number(k.easing.x2) || 1,
                  y2: Number(k.easing.y2) || 1,
                  hold: k.easing.hold === true,
                }
              : { x1: 0, y1: 0, x2: 1, y2: 1, hold: true },
          }))
          .sort((a, b) => a.frame - b.frame),
      };
    }
  }

  const layers: Record<LayerId, Layer> = {};
  for (const [id, value] of Object.entries(source.layers)) {
    if (!isRecord(value)) continue;
    const variants: Variant[] = Array.isArray(value.variants)
      ? (value.variants as Record<string, unknown>[]).map((variant) => ({
          id: (typeof variant.id === "string"
            ? variant.id
            : newId("Variant")) as Variant["id"],
          name: typeof variant.name === "string" ? variant.name : "Default",
          pathIds: (Array.isArray(variant.pathIds)
            ? (variant.pathIds as string[])
            : []
          ).filter((pathId) => paths[pathId as PathId]) as PathId[],
          fill: readColor(variant.fill, null),
          fillRule: variant.fillRule === "evenodd" ? "evenodd" : "nonzero",
          stroke: readColor(variant.stroke, null),
          strokeWidth:
            typeof variant.strokeWidth === "number" ? variant.strokeWidth : 0,
          image:
            isRecord(variant.image) && typeof variant.image.src === "string"
              ? {
                  src: variant.image.src,
                  width: Number(variant.image.width) || 0,
                  height: Number(variant.image.height) || 0,
                }
              : null,
        }))
      : [];

    const transform = isRecord(value.transform)
      ? { ...identityTransform(), ...(value.transform as object) }
      : identityTransform();

    layers[id as LayerId] = {
      id: id as LayerId,
      artboardId: String(value.artboardId ?? "") as ArtboardId,
      kind: "part",
      name: typeof value.name === "string" ? value.name : "Part",
      parentLayerId:
        typeof value.parentLayerId === "string"
          ? (value.parentLayerId as LayerId)
          : null,
      inFrame: Number(value.inFrame) || 0,
      outFrame:
        typeof value.outFrame === "number"
          ? value.outFrame
          : Number.MAX_SAFE_INTEGER,
      timeOffset: Number(value.timeOffset) || 0,
      visible: value.visible !== false,
      locked: value.locked === true,
      collapsed: value.collapsed === true,
      transform: transform as Layer["transform"],
      pivot: isRecord(value.pivot)
        ? { x: Number(value.pivot.x) || 0, y: Number(value.pivot.y) || 0 }
        : { x: 0, y: 0 },
      opacity: isRecord(value.opacity)
        ? (value.opacity as Layer["opacity"])
        : { kind: "const", value: 1 },
      overlap: Math.min(3, Math.max(0, Number(value.overlap) || 0)),
      depth: isRecord(value.depth)
        ? (value.depth as Layer["depth"])
        : { kind: "const", value: 0 },
      variants,
      variant: isRecord(value.variant)
        ? (value.variant as Layer["variant"])
        : { kind: "const", value: 0 },
      blinkVariant:
        typeof value.blinkVariant === "number" ? value.blinkVariant : null,
    };
  }

  // Drop parent links that point at nothing, or the renderer walks off a cliff.
  for (const layer of Object.values(layers)) {
    if (layer.parentLayerId && !layers[layer.parentLayerId]) {
      layer.parentLayerId = null;
    }
  }

  const artboards: Record<ArtboardId, Artboard> = {};
  for (const [id, value] of Object.entries(source.artboards)) {
    if (!isRecord(value)) continue;
    artboards[id as ArtboardId] = {
      id: id as ArtboardId,
      name: typeof value.name === "string" ? value.name : "Page",
      width: Number(value.width) || 900,
      height: Number(value.height) || 900,
      background: readColor(value.background, null),
      layerIds: (Array.isArray(value.layerIds)
        ? (value.layerIds as string[])
        : []
      ).filter((layerId) => layers[layerId as LayerId]) as LayerId[],
      clip: value.clip === true,
      halo: readHalo(value.halo),
    };
  }

  const artboardIds = Object.keys(artboards) as ArtboardId[];
  if (artboardIds.length === 0) return fallback;
  const activeArtboardId =
    typeof source.activeArtboardId === "string" &&
    artboards[source.activeArtboardId as ArtboardId]
      ? (source.activeArtboardId as ArtboardId)
      : artboardIds[0];

  // Every part must sit in the draw order, or it exists and never draws.
  const listed = new Set(artboards[activeArtboardId].layerIds);
  for (const layer of Object.values(layers)) {
    if (!listed.has(layer.id)) {
      artboards[activeArtboardId].layerIds.push(layer.id);
    }
  }

  const frameCount = Math.max(1, Math.round(Number(source.frameCount) || 48));
  const loopIn = Math.min(
    Math.max(0, Math.round(Number(source.loopIn) || 0)),
    frameCount - 1,
  );

  return {
    id: fallback.id,
    version: DOCUMENT_VERSION,
    name: typeof source.name === "string" ? source.name : "Untitled character",
    fps: Math.max(1, Math.round(Number(source.fps) || 24)),
    frameCount,
    loopIn,
    loopOut: Math.min(
      Math.max(loopIn + 1, Math.round(Number(source.loopOut) || frameCount)),
      frameCount,
    ),
    artboards,
    layers,
    paths,
    tracks,
    artboardIds,
    activeArtboardId,
  };
}

export function projectFromJson(text: string): RiffDocument {
  return deserializeProject(JSON.parse(text));
}

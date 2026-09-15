/**
 * Flattening the rig into timeline rows.
 *
 * The part column and the lane area are two renderings of one list, so the list
 * is computed once, here, and both consume it. That is what keeps the row
 * heights identical between them. The design lock calls two heights for one
 * tree a bug, and the cheapest way to make that bug unrepresentable is to give
 * the two views the same array.
 */

import type {
  AnimatableNumber,
  Layer,
  LayerId,
  RiffDocument,
  Track,
  TrackId,
} from "@/editor/model/document";
import { treeOrder } from "@/editor/model/rig";
import { LAYER_ROW_HEIGHT, PROPERTY_ROW_HEIGHT } from "./geometry";

/**
 * Animatable properties, in the order they appear under a part.
 *
 * Rotation first, because in a cutout rig rotation is the property: a pose is
 * one angle per joint. The rest follow the inspector's order, since two
 * different orders for one set of properties costs a scan every time.
 */
export const ANIMATABLE_PROPERTIES: {
  path: string;
  label: string;
  read: (layer: Layer) => AnimatableNumber;
}[] = [
  {
    path: "transform.rotation",
    label: "Rotation",
    read: (l) => l.transform.rotation,
  },
  { path: "transform.x", label: "X", read: (l) => l.transform.x },
  { path: "transform.y", label: "Y", read: (l) => l.transform.y },
  {
    path: "transform.scaleX",
    label: "Scale X",
    read: (l) => l.transform.scaleX,
  },
  {
    path: "transform.scaleY",
    label: "Scale Y",
    read: (l) => l.transform.scaleY,
  },
  { path: "transform.skewX", label: "Slant X", read: (l) => l.transform.skewX },
  { path: "transform.skewY", label: "Slant Y", read: (l) => l.transform.skewY },
  { path: "opacity", label: "Opacity", read: (l) => l.opacity },
  { path: "depth", label: "Depth", read: (l) => l.depth },
  { path: "variant", label: "Variant", read: (l) => l.variant },
];

export interface LayerRow {
  kind: "layer";
  id: string;
  layerId: LayerId;
  layer: Layer;
  depth: number;
  height: number;
  top: number;
  /** True when there is something under this row to open. */
  expandable: boolean;
  /** True when at least one of this part's properties is animated. */
  hasTracks: boolean;
  /**
   * Every frame at which any of this part's properties holds a key, sorted.
   *
   * This is what a closed part shows in its own lane, so somebody who has never
   * opened a part can still see where its keys are and click one to get there.
   */
  keyFrames: number[];
}

export interface PropertyRow {
  kind: "property";
  id: string;
  layerId: LayerId;
  layer: Layer;
  trackId: TrackId;
  /**
   * The driving values, or null when the property is still a single number.
   * A null one renders an empty lane with an "add a key" affordance, and
   * keying it creates the values (see `ensureTrack` in `./edits`).
   */
  track: Track | null;
  label: string;
  propertyPath: string;
  depth: number;
  height: number;
  top: number;
}

export type TimelineRow = LayerRow | PropertyRow;

/** Animated properties of a part, in `ANIMATABLE_PROPERTIES` order. */
export function layerTracks(
  layer: Layer,
  doc: RiffDocument,
): { label: string; path: string; track: Track }[] {
  const out: { label: string; path: string; track: Track }[] = [];
  for (const prop of ANIMATABLE_PROPERTIES) {
    const value = prop.read(layer);
    if (value.kind !== "track") continue;
    const track = doc.tracks[value.trackId];
    if (track) out.push({ label: prop.label, path: prop.path, track });
  }
  return out;
}

/**
 * Every animatable property of a part, with its driving track when one exists.
 *
 * The list is built from the property table rather than from the tracks a part
 * happens to have, so a freshly drawn part still offers every property to the
 * timeline instead of showing an empty row area.
 */
export function layerProperties(
  layer: Layer,
  doc: RiffDocument,
): { label: string; path: string; trackId: TrackId; track: Track | null }[] {
  return ANIMATABLE_PROPERTIES.map((prop) => {
    const value = prop.read(layer);
    const track =
      value.kind === "track" ? (doc.tracks[value.trackId] ?? null) : null;
    // Synthetic id for a property nothing drives yet. It carries a colon,
    // which `newId` never emits, so it cannot collide with a real one, and
    // every consumer guards on `track === null` before using it.
    const trackId =
      value.kind === "track"
        ? value.trackId
        : (`${layer.id}:${prop.path}` as TrackId);
    return { label: prop.label, path: prop.path, trackId, track };
  });
}

/**
 * Flatten the rig into timeline rows, front of the draw order first.
 *
 * The skeleton supplies the indent; `artboard.layerIds` supplies the order. A
 * part whose ancestor is closed is skipped, which is how closing an upper arm
 * folds the forearm and hand away with it.
 *
 * A part shows only the properties it actually animates, and a part that
 * animates nothing shows no property rows at all. That is the whole beginner
 * view: Play, the playhead, and one quiet row per part carrying its key dots.
 * Selecting a part opens every property it could animate.
 *
 * `top` is precomputed rather than derived from index because the two row
 * heights interleave; asking each consumer to accumulate is asking for the two
 * columns to drift apart by a pixel somewhere down the list.
 */
export function flattenRows(
  doc: RiffDocument,
  selectedIds: readonly LayerId[] = [],
): TimelineRow[] {
  const artboard = doc.artboards[doc.activeArtboardId];
  const rows: TimelineRow[] = [];
  if (!artboard) return rows;

  const selected = new Set<LayerId>(selectedIds);
  let top = 0;
  for (const node of treeOrder(doc)) {
    const layerId = node.id;
    const layer = doc.layers[layerId];
    if (!layer) continue;
    const chain = skeletonChain(doc, layerId);
    if (chain.some((id) => doc.layers[id]?.collapsed)) continue;

    const properties = layerProperties(layer, doc);
    const keyFrames = collectKeyFrames(properties);
    const showProperties = keyFrames.length > 0 || selected.has(layerId);

    rows.push({
      kind: "layer",
      id: layerId,
      layerId,
      layer,
      depth: node.depth,
      height: LAYER_ROW_HEIGHT,
      top,
      expandable: showProperties || node.hasChildren,
      hasTracks: keyFrames.length > 0,
      keyFrames,
    });
    top += LAYER_ROW_HEIGHT;

    if (layer.collapsed || !showProperties) continue;
    // An unselected part lists only the things it actually animates. Seven
    // empty rows under every part is what turns a timeline into a spreadsheet.
    const visible = selected.has(layerId)
      ? properties
      : properties.filter((property) => property.track);
    for (const { label, path, trackId, track } of visible) {
      rows.push({
        kind: "property",
        id: `${layerId}:${path}`,
        layerId,
        layer,
        trackId,
        track,
        label,
        propertyPath: path,
        depth: node.depth + 1,
        height: PROPERTY_ROW_HEIGHT,
        top,
      });
      top += PROPERTY_ROW_HEIGHT;
    }
  }
  return rows;
}

/** The union of every frame any of a part's properties holds a key on. */
function collectKeyFrames(
  properties: readonly { track: Track | null }[],
): number[] {
  const frames = new Set<number>();
  for (const { track } of properties) {
    if (!track) continue;
    for (const key of track.keyframes) frames.add(key.frame);
  }
  return [...frames].sort((a, b) => a - b);
}

/** Ancestors of a part, nearest first. Cycle-safe, so a bad file cannot hang. */
function skeletonChain(doc: RiffDocument, id: LayerId): LayerId[] {
  const out: LayerId[] = [];
  const seen = new Set<LayerId>([id]);
  let current = doc.layers[id]?.parentLayerId ?? null;
  while (current && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    current = doc.layers[current]?.parentLayerId ?? null;
  }
  return out;
}

export function rowsHeight(rows: readonly TimelineRow[]): number {
  const last = rows[rows.length - 1];
  return last ? last.top + last.height : 0;
}

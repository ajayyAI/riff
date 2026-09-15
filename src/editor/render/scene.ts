/**
 * Scene resolution: document + frame -> a flat draw list.
 *
 * Resolving to a flat list rather than walking the skeleton at paint time is
 * what keeps the renderer simple and the hit-tester honest: both consume the
 * same list, in the same order, so what you click is always what you see. It
 * also means the expensive part (evaluating tracks, composing the parent chain)
 * happens once per frame instead of once per surface.
 *
 * One item per part, not per path, because everything the rig renderer does
 * beyond a plain fill -- the halo pass, the overlap copies -- is a per-part
 * decision.
 */

import { evalAnimatable } from "../model/animation";
import type {
  Artboard,
  FillRule,
  Frame,
  Halo,
  Layer,
  LayerId,
  Matrix,
  PathGeometry,
  RGBA,
  RiffDocument,
  Variant,
} from "../model/document";
import { applyMatrix, invert } from "../model/document";
import {
  drawOrder,
  variantAt,
  variantBounds,
  variantPaths,
  worldMatrix,
} from "../model/rig";

export interface DrawItem {
  layerId: LayerId;
  /** The variant actually shown at this frame. */
  variant: Variant | null;
  paths: PathGeometry[];
  fill: RGBA | null;
  fillRule: FillRule;
  stroke: RGBA | null;
  strokeWidth: number;
  /** Part-to-document transform, with the parent chain already folded in. */
  matrix: Matrix;
  opacity: number;
  /** Document-space AABB, for culling and hit rejection. */
  bounds: [number, number, number, number];
  /** Resolved draw-order offset at this frame. Higher draws in front. */
  depth: number;
  /**
   * Local-space offset toward the parent for the fill-only overlap copies,
   * or null when this part has no parent or no overlap.
   */
  overlapShift: [number, number] | null;
  image: { src: string; width: number; height: number } | null;
}

export interface ResolvedScene {
  artboard: Artboard;
  frame: Frame;
  items: DrawItem[];
  halo: Halo;
}

/** Transform an AABB by a matrix, returning a new AABB that contains it. */
export function transformBounds(
  m: Matrix,
  [x0, y0, x1, y1]: [number, number, number, number],
): [number, number, number, number] {
  // All four corners, because rotation turns an axis-aligned box into a diamond.
  const xs = [
    m.a * x0 + m.c * y0 + m.e,
    m.a * x1 + m.c * y0 + m.e,
    m.a * x0 + m.c * y1 + m.e,
    m.a * x1 + m.c * y1 + m.e,
  ];
  const ys = [
    m.b * x0 + m.d * y0 + m.f,
    m.b * x1 + m.d * y0 + m.f,
    m.b * x0 + m.d * y1 + m.f,
    m.b * x1 + m.d * y1 + m.f,
  ];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Where to push this part's fill-only copies so the parent hides the joint gap.
 *
 * Ported from the `overlapShift` of the single-file prototype riff grew out of:
 * aim from the part's own joint at the centre of the parent's artwork,
 * expressed in this part's local space so the copies survive rotation for free.
 * The distance is divided by the part's scale so a scaled-down hand does not
 * get a scaled-up tuck.
 */
function overlapShift(
  layer: Layer,
  doc: RiffDocument,
  frame: Frame,
  matrix: Matrix,
  memo: Map<LayerId, Matrix>,
): [number, number] | null {
  if (!layer.overlap || !layer.parentLayerId) return null;
  const parent = doc.layers[layer.parentLayerId];
  if (!parent) return null;
  const box = variantBounds(variantAt(parent, doc, frame), doc);
  if (!box) return null;

  const parentMatrix = worldMatrix(parent, doc, frame, memo);
  const [px, py] = applyMatrix(
    parentMatrix,
    (box[0] + box[2]) / 2,
    (box[1] + box[3]) / 2,
  );
  const inverse = invert(matrix);
  if (!inverse) return null;
  const [lx, ly] = applyMatrix(inverse, px, py);

  const dx = lx - layer.pivot.x;
  const dy = ly - layer.pivot.y;
  const distance = Math.hypot(dx, dy) || 1;
  const scaleX = evalAnimatable(layer.transform.scaleX, doc.tracks, frame);
  const scaleY = evalAnimatable(layer.transform.scaleY, doc.tracks, frame);
  const average = (Math.abs(scaleX) + Math.abs(scaleY)) / 2 || 1;
  const reach = (layer.overlap * 6) / average;
  return [(dx / distance) * reach, (dy / distance) * reach];
}

/**
 * Flatten the rig at a frame into a draw list, back to front.
 *
 * `artboard.layerIds` is the draw order; the parent chain only supplies the
 * matrix. A part hidden by an ancestor is dropped, because in a cutout rig
 * hiding an upper arm and keeping its hand on screen is never what was meant.
 */
export function resolveScene(
  doc: RiffDocument,
  frame: Frame,
  options: { blinking?: boolean } = {},
): ResolvedScene {
  const artboard = doc.artboards[doc.activeArtboardId];
  const items: DrawItem[] = [];
  if (!artboard) {
    return {
      artboard: artboard as Artboard,
      frame,
      items,
      halo: {
        enabled: false,
        width: 0,
        color: { r: 255, g: 255, b: 255, a: 1 },
      },
    };
  }

  const memo = new Map<LayerId, Matrix>();
  const hiddenCache = new Map<LayerId, boolean>();

  const hidden = (layer: Layer): boolean => {
    const cached = hiddenCache.get(layer.id);
    if (cached !== undefined) return cached;
    hiddenCache.set(layer.id, true); // Break cycles pessimistically.
    const parent = layer.parentLayerId
      ? doc.layers[layer.parentLayerId]
      : undefined;
    const result = !layer.visible || (parent ? hidden(parent) : false);
    hiddenCache.set(layer.id, result);
    return result;
  };

  const inheritedOpacity = (layer: Layer): number => {
    let value = 1;
    let current: Layer | undefined = layer;
    const seen = new Set<LayerId>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      value *= evalAnimatable(current.opacity, doc.tracks, frame);
      current = current.parentLayerId
        ? doc.layers[current.parentLayerId]
        : undefined;
    }
    return value;
  };

  for (const layer of drawOrder(doc)) {
    if (hidden(layer)) continue;
    if (frame < layer.inFrame || frame >= layer.outFrame) continue;

    const variant = variantAt(layer, doc, frame, options.blinking);
    const paths = variantPaths(variant, doc);
    if (paths.length === 0 && !variant?.image) continue;

    const opacity = inheritedOpacity(layer);
    if (opacity <= 0) continue;

    const matrix = worldMatrix(layer, doc, frame, memo);
    const box = variantBounds(variant, doc) ?? [0, 0, 0, 0];

    items.push({
      layerId: layer.id,
      variant,
      paths,
      fill: variant?.fill ?? null,
      fillRule: variant?.fillRule ?? "nonzero",
      stroke: variant?.stroke ?? null,
      strokeWidth: variant?.strokeWidth ?? 0,
      matrix,
      opacity,
      depth: evalAnimatable(layer.depth, doc.tracks, frame),
      bounds: transformBounds(matrix, box),
      overlapShift: overlapShift(layer, doc, frame, matrix, memo),
      image: variant?.image ?? null,
    });
  }

  // Depth re-sorts the draw list at this frame, so an arm can swing in front
  // of the body and back behind it without the artboard's list changing. A
  // stable sort keeps the artboard's order as the tie-break, which is what
  // makes a rig with no depth on anything behave exactly as it reads.
  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      a.item.depth === b.item.depth
        ? a.index - b.index
        : a.item.depth - b.item.depth,
    )
    .map((entry) => entry.item);

  return { artboard, frame, items: sorted, halo: artboard.halo };
}

/**
 * Union of a set of parts' bounds at a frame, in document space.
 * Returns null when nothing in the selection is on screen this frame.
 */
export function selectionBounds(
  scene: ResolvedScene,
  layerIds: Iterable<LayerId>,
): [number, number, number, number] | null {
  const wanted = new Set<string>(layerIds as Iterable<string>);
  if (wanted.size === 0) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const item of scene.items) {
    if (!wanted.has(item.layerId)) continue;
    found = true;
    x0 = Math.min(x0, item.bounds[0]);
    y0 = Math.min(y0, item.bounds[1]);
    x1 = Math.max(x1, item.bounds[2]);
    y1 = Math.max(y1, item.bounds[3]);
  }
  return found ? [x0, y0, x1, y1] : null;
}

/** Union of every visible part's bounds. What "zoom to fit the rig" fits to. */
export function sceneBounds(
  scene: ResolvedScene,
): [number, number, number, number] | null {
  return selectionBounds(
    scene,
    scene.items.map((item) => item.layerId),
  );
}

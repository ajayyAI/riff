/**
 * What Join, Add, Subtract, Overlap only, Simplify and Smooth actually do.
 *
 * One definition, because these are offered from three places: the inspector,
 * the right-click menu in the parts list, and the agent tool surface. Three
 * copies of "which part survives a boolean" is three answers to one question.
 *
 * Every function is pure `doc -> doc`. The caller wraps it in a transaction.
 */

import { evalAnimatable } from "./animation";
import { clipPolygons } from "./boolean";
import {
  applyMatrix,
  type Frame,
  invert,
  type LayerId,
  type Matrix,
  multiply,
  type PartLayer,
  type RGBA,
  type RiffDocument,
  type Variant,
} from "./document";
import {
  type Contour,
  contoursToGeometry,
  flattenPaths,
  joinContours,
  simplifyContour,
  smoothContour,
} from "./polyline";
import {
  activeArtboard,
  deleteParts,
  patchLayer,
  variantAt,
  worldMatrix,
} from "./rig";

/** How finely a curve is sampled before a shape operation. Sub-pixel at any zoom. */
const FLATTEN_TOLERANCE = 1.5;

export function activeVariantIndex(
  part: PartLayer,
  doc: RiffDocument,
  frame: Frame,
): number {
  if (part.variants.length === 0) return -1;
  const raw = Math.round(evalAnimatable(part.variant, doc.tracks, frame));
  return Math.min(Math.max(raw, 0), part.variants.length - 1);
}

export function patchVariantAt(
  doc: RiffDocument,
  id: LayerId,
  index: number,
  patch: Partial<Variant>,
): RiffDocument {
  const part = doc.layers[id];
  if (!part?.variants[index]) return doc;
  const variants = part.variants.slice();
  variants[index] = { ...variants[index], ...patch };
  return patchLayer(doc, id, { variants });
}

/** The contours a part draws right now, in its own coordinates. */
export function partContours(
  doc: RiffDocument,
  part: PartLayer,
  frame: Frame,
): Contour[] {
  const variant = variantAt(part, doc, frame);
  if (!variant) return [];
  return flattenPaths(doc, variant.pathIds, FLATTEN_TOLERANCE);
}

export function mapContours(
  contours: readonly Contour[],
  m: Matrix,
): Contour[] {
  return contours.map((contour) => {
    const points: number[] = [];
    for (let i = 0; i < contour.points.length; i += 2) {
      const [x, y] = applyMatrix(m, contour.points[i], contour.points[i + 1]);
      points.push(x, y);
    }
    return { points, closed: contour.closed };
  });
}

/**
 * Replace what a part draws.
 *
 * Paths are immutable, so this mints a new one rather than editing in place,
 * which is also why the renderer's cache can never go stale.
 */
export function setShownContours(
  doc: RiffDocument,
  id: LayerId,
  frame: Frame,
  contours: readonly Contour[],
): RiffDocument {
  const part = doc.layers[id];
  if (!part) return doc;
  const usable = contours.filter((contour) => contour.points.length >= 4);
  if (usable.length === 0) return doc;
  const geometry = contoursToGeometry(usable);
  return patchVariantAt(
    { ...doc, paths: { ...doc.paths, [geometry.id]: geometry } },
    id,
    activeVariantIndex(part, doc, frame),
    { pathIds: [geometry.id] },
  );
}

/**
 * The part a shape operation lands in: the backmost of the selection.
 *
 * Backmost rather than first-clicked, because the result inherits that part's
 * place in the stack and a result that jumps forward is a result that hides
 * something.
 */
export function keeperOf(doc: RiffDocument, ids: readonly LayerId[]): LayerId {
  const order = activeArtboard(doc)?.layerIds ?? [];
  return [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
}

/** Every selected part's contours, mapped into the keeper's own coordinates. */
function gather(
  doc: RiffDocument,
  ids: readonly LayerId[],
  keeperId: LayerId,
  frame: Frame,
): Contour[][] {
  const keeper = doc.layers[keeperId];
  const toKeeper = keeper ? invert(worldMatrix(keeper, doc, frame)) : null;
  return ids.map((id) => {
    const part = doc.layers[id];
    if (!part) return [];
    const local = partContours(doc, part, frame);
    if (id === keeperId || !toKeeper) return local;
    return mapContours(
      local,
      multiply(toKeeper, worldMatrix(part, doc, frame)),
    );
  });
}

export function contourCount(
  doc: RiffDocument,
  id: LayerId,
  frame: Frame,
): number {
  const part = doc.layers[id];
  return part ? partContours(doc, part, frame).length : 0;
}

export function canJoin(
  doc: RiffDocument,
  ids: readonly LayerId[],
  frame: Frame,
): boolean {
  if (ids.length > 1) return ids.some((id) => contourCount(doc, id, frame) > 0);
  return ids.length === 1 && contourCount(doc, ids[0], frame) > 1;
}

export function canCombine(
  doc: RiffDocument,
  ids: readonly LayerId[],
  frame: Frame,
): boolean {
  return (
    ids.length === 2 && ids.every((id) => contourCount(doc, id, frame) > 0)
  );
}

export function hasGeometry(
  doc: RiffDocument,
  ids: readonly LayerId[],
  frame: Frame,
): boolean {
  return ids.some((id) => contourCount(doc, id, frame) > 0);
}

export interface ShapeResult {
  doc: RiffDocument;
  keeperId: LayerId | null;
}

/**
 * Chain separate lines into one closed, filled shape.
 *
 * The result is filled because that is the point: someone drew a silhouette in
 * four passes and wants a body part, not a fourth outline. `fill` is the colour
 * to use when the keeper has none yet.
 */
export function joinParts(
  doc: RiffDocument,
  ids: readonly LayerId[],
  frame: Frame,
  fill: RGBA,
): ShapeResult {
  if (!canJoin(doc, ids, frame)) return { doc, keeperId: null };
  const keeperId = keeperOf(doc, ids);
  const merged = joinContours(gather(doc, ids, keeperId, frame).flat(), {
    close: true,
  });
  if (!merged) return { doc, keeperId: null };

  let out = setShownContours(doc, keeperId, frame, [merged]);
  const keeper = out.layers[keeperId];
  const shown = keeper ? variantAt(keeper, out, frame) : null;
  if (keeper && shown && !shown.fill) {
    out = patchVariantAt(
      out,
      keeperId,
      activeVariantIndex(keeper, out, frame),
      {
        fill,
      },
    );
  }
  const others = ids.filter((id) => id !== keeperId);
  if (others.length > 0) out = deleteParts(out, others, frame);
  return { doc: out, keeperId };
}

export function combineParts(
  doc: RiffDocument,
  ids: readonly LayerId[],
  op: "union" | "subtract" | "intersect",
  frame: Frame,
): ShapeResult {
  if (!canCombine(doc, ids, frame)) return { doc, keeperId: null };
  const keeperId = keeperOf(doc, ids);
  const otherId = ids.find((id) => id !== keeperId);
  if (!otherId) return { doc, keeperId: null };

  const groups = gather(doc, ids, keeperId, frame);
  const keeperIndex = ids.indexOf(keeperId);
  const subject = groups[keeperIndex] ?? [];
  const clip = groups.filter((_, index) => index !== keeperIndex).flat();
  const result = clipPolygons(subject, clip, op);
  if (result.length === 0) return { doc, keeperId: null };

  let out = setShownContours(doc, keeperId, frame, result);
  out = deleteParts(out, [otherId], frame);
  return { doc: out, keeperId };
}

/** Apply a per-contour transform to every selected part's drawing. */
export function reshapeParts(
  doc: RiffDocument,
  ids: readonly LayerId[],
  frame: Frame,
  transform: (contour: Contour) => Contour,
): RiffDocument {
  let out = doc;
  for (const id of ids) {
    // Read the live part each time: an earlier iteration may already have
    // replaced geometry, and paths are immutable so a stale copy points at ids
    // that are no longer drawn.
    const live = out.layers[id];
    if (!live || live.locked) continue;
    const contours = partContours(out, live, frame);
    if (contours.length === 0) continue;
    out = setShownContours(out, id, frame, contours.map(transform));
  }
  return out;
}

export function simplifyParts(
  doc: RiffDocument,
  ids: readonly LayerId[],
  frame: Frame,
  tolerance = 1.5,
): RiffDocument {
  return reshapeParts(doc, ids, frame, (contour) =>
    simplifyContour(contour, tolerance),
  );
}

export function smoothParts(
  doc: RiffDocument,
  ids: readonly LayerId[],
  frame: Frame,
  iterations = 1,
): RiffDocument {
  return reshapeParts(doc, ids, frame, (contour) =>
    smoothContour(contour, iterations),
  );
}

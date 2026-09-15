/**
 * Rig operations: the skeleton, the draw order, and the edits that touch both.
 *
 * Every function here is pure `doc -> doc` (or a plain read), so the store can
 * wrap any of them in one transaction and a drag can recompute from its
 * pointer-down snapshot instead of accumulating deltas.
 *
 * The one invariant worth stating out loud: `artboard.layerIds` is the draw
 * order and nothing else, `parentLayerId` is the skeleton and nothing else. A
 * part may be attached to a parent it draws behind. Code that conflates the two
 * is the bug this file exists to prevent.
 */

import { evalAnimatable } from "./animation";
import {
  type Artboard,
  type ArtboardId,
  applyMatrix,
  constant,
  type Frame,
  IDENTITY,
  type Layer,
  type LayerId,
  type Matrix,
  multiply,
  newId,
  newPart,
  type PartLayer,
  type PathGeometry,
  type PathId,
  type RiffDocument,
  type Variant,
} from "./document";

// --------------------------------------------------------------------- reads

export function activeArtboard(doc: RiffDocument): Artboard | undefined {
  return doc.artboards[doc.activeArtboardId];
}

/** Draw order, back to front, skipping ids the layer table no longer has. */
export function drawOrder(doc: RiffDocument): Layer[] {
  const artboard = activeArtboard(doc);
  if (!artboard) return [];
  const out: Layer[] = [];
  for (const id of artboard.layerIds) {
    const layer = doc.layers[id];
    if (layer) out.push(layer);
  }
  return out;
}

/** The chain from a part up to its root, nearest parent first. Cycle-safe. */
export function ancestors(doc: RiffDocument, id: LayerId): LayerId[] {
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

export function childrenOf(doc: RiffDocument, id: LayerId | null): LayerId[] {
  const artboard = activeArtboard(doc);
  if (!artboard) return [];
  return artboard.layerIds.filter(
    (candidate) => doc.layers[candidate]?.parentLayerId === id,
  );
}

/** True when `id` is `ofId` or hangs off it. Guards against parent cycles. */
export function isDescendant(
  doc: RiffDocument,
  id: LayerId,
  ofId: LayerId,
): boolean {
  if (id === ofId) return true;
  return ancestors(doc, id).includes(ofId);
}

export interface TreeNode {
  id: LayerId;
  depth: number;
  /** True when something hangs off this part. */
  hasChildren: boolean;
}

/**
 * The rig as a tree, in the order the parts list shows it.
 *
 * Nested by `parentLayerId`, so a hand reads as sitting under its forearm, and
 * siblings ordered front of the draw order first, so the list agrees with the
 * canvas about what is on top. Those are two different facts about a cutout rig
 * and the list has to carry both: the indent is the skeleton, the order within
 * an indent is the stack.
 *
 * A part whose parent has gone missing, or whose parent chain loops, is shown
 * as a root rather than dropped. A malformed file must still be openable and
 * fixable.
 */
export function treeOrder(doc: RiffDocument): TreeNode[] {
  const artboard = activeArtboard(doc);
  if (!artboard) return [];

  const buckets = new Map<LayerId | "", LayerId[]>();
  // Front of the stack first, so the top row of the list is the top of the
  // canvas. `layerIds` is back to front, so this walks it backwards.
  for (let i = artboard.layerIds.length - 1; i >= 0; i--) {
    const id = artboard.layerIds[i];
    const layer = doc.layers[id];
    if (!layer) continue;
    const parent = layer.parentLayerId;
    const attached =
      parent && doc.layers[parent] && !isDescendant(doc, parent, id)
        ? parent
        : "";
    const bucket = buckets.get(attached);
    if (bucket) bucket.push(id);
    else buckets.set(attached, [id]);
  }

  const out: TreeNode[] = [];
  const seen = new Set<LayerId>();
  const walk = (parent: LayerId | "", depth: number) => {
    for (const id of buckets.get(parent) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const children = buckets.get(id);
      out.push({ id, depth, hasChildren: (children?.length ?? 0) > 0 });
      walk(id, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

/** Every part hanging off `id`, `id` included, in draw order. */
export function subtree(doc: RiffDocument, id: LayerId): LayerId[] {
  const artboard = activeArtboard(doc);
  if (!artboard) return [id];
  return artboard.layerIds.filter((candidate) =>
    isDescendant(doc, candidate, id),
  );
}

/**
 * The variant a part shows at a frame.
 *
 * Out-of-range indices clamp rather than vanish: a variant deleted while it was
 * keyed must not blank the part, it must fall back to something drawable.
 */
export function variantAt(
  layer: PartLayer,
  doc: RiffDocument,
  frame: Frame,
  blinking = false,
): Variant | null {
  if (layer.variants.length === 0) return null;
  if (blinking && layer.blinkVariant !== null) {
    const blink = layer.variants[layer.blinkVariant];
    if (blink) return blink;
  }
  const raw = Math.round(evalAnimatable(layer.variant, doc.tracks, frame));
  const index = Math.min(Math.max(raw, 0), layer.variants.length - 1);
  return layer.variants[index] ?? layer.variants[0];
}

/** Every path a variant draws, skipping ids the path table no longer has. */
export function variantPaths(
  variant: Variant | null,
  doc: RiffDocument,
): PathGeometry[] {
  if (!variant) return [];
  const out: PathGeometry[] = [];
  for (const id of variant.pathIds) {
    const geometry = doc.paths[id];
    if (geometry) out.push(geometry);
  }
  return out;
}

/** Union of a variant's path bounds, in the part's own space. */
export function variantBounds(
  variant: Variant | null,
  doc: RiffDocument,
): [number, number, number, number] | null {
  if (variant?.image) {
    return [0, 0, variant.image.width, variant.image.height];
  }
  const paths = variantPaths(variant, doc);
  if (paths.length === 0) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const path of paths) {
    x0 = Math.min(x0, path.bounds[0]);
    y0 = Math.min(y0, path.bounds[1]);
    x1 = Math.max(x1, path.bounds[2]);
    y1 = Math.max(y1, path.bounds[3]);
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

// ------------------------------------------------------------ forward kinematics

/**
 * Compose one part's local transform.
 *
 * Order is translate(position) then translate(joint) then rotate then scale then
 * translate(-joint), so a point at the joint lands at `position + joint` and
 * moving the joint alone never moves the artwork. That last property is the
 * difference between a rig joint and a design tool's anchor point, and getting
 * it wrong makes "Set joint at click" shove the part across the canvas.
 */
export function composeLayerMatrix(
  x: number,
  y: number,
  rotationDeg: number,
  scaleX: number,
  scaleY: number,
  pivotX: number,
  pivotY: number,
  skewXDeg = 0,
  skewYDeg = 0,
): Matrix {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Shear sits between the rotation and the scale, so slanting a part shears it
  // in its own frame and the joint stays the fixed point. Clamped short of a
  // right angle because tan blows up there and the part would vanish.
  const tx = Math.tan((clampSkew(skewXDeg) * Math.PI) / 180);
  const ty = Math.tan((clampSkew(skewYDeg) * Math.PI) / 180);
  const a = (cos - sin * ty) * scaleX;
  const b = (sin + cos * ty) * scaleX;
  const c = (cos * tx - sin) * scaleY;
  const d = (sin * tx + cos) * scaleY;
  return {
    a,
    b,
    c,
    d,
    e: x + pivotX - (a * pivotX + c * pivotY),
    f: y + pivotY - (b * pivotX + d * pivotY),
  };
}

/** Shear beyond this is indistinguishable from a collapsed part. */
export const MAX_SKEW = 80;

function clampSkew(degrees: number): number {
  return Math.min(MAX_SKEW, Math.max(-MAX_SKEW, degrees));
}

export function localMatrix(
  layer: PartLayer,
  doc: RiffDocument,
  frame: Frame,
): Matrix {
  const t = layer.transform;
  const tracks = doc.tracks;
  return composeLayerMatrix(
    evalAnimatable(t.x, tracks, frame),
    evalAnimatable(t.y, tracks, frame),
    evalAnimatable(t.rotation, tracks, frame),
    evalAnimatable(t.scaleX, tracks, frame),
    evalAnimatable(t.scaleY, tracks, frame),
    layer.pivot.x,
    layer.pivot.y,
    evalAnimatable(t.skewX, tracks, frame),
    evalAnimatable(t.skewY, tracks, frame),
  );
}

/**
 * Part-to-document matrix, walking the parent chain.
 *
 * `memo` is not an optimisation detail you can skip: a deep chain resolved once
 * per part per frame is quadratic, and the renderer calls this for every part on
 * every repaint.
 */
export function worldMatrix(
  layer: PartLayer,
  doc: RiffDocument,
  frame: Frame,
  memo?: Map<LayerId, Matrix>,
  guard: Set<LayerId> = new Set(),
): Matrix {
  const hit = memo?.get(layer.id);
  if (hit) return hit;
  // A malformed document with a parent cycle must not hang the renderer.
  if (guard.has(layer.id)) return IDENTITY;
  guard.add(layer.id);

  const parent = layer.parentLayerId
    ? doc.layers[layer.parentLayerId]
    : undefined;
  const base = parent ? worldMatrix(parent, doc, frame, memo, guard) : IDENTITY;
  const matrix = multiply(base, localMatrix(layer, doc, frame));
  memo?.set(layer.id, matrix);
  return matrix;
}

/** The joint, in document space. What the canvas draws a crosshair on. */
export function jointPosition(
  layer: PartLayer,
  doc: RiffDocument,
  frame: Frame,
  memo?: Map<LayerId, Matrix>,
): [number, number] {
  return applyMatrix(
    worldMatrix(layer, doc, frame, memo),
    layer.pivot.x,
    layer.pivot.y,
  );
}

// ------------------------------------------------------------------ mutations

function withLayers(
  doc: RiffDocument,
  next: Record<LayerId, Layer>,
): RiffDocument {
  return { ...doc, layers: next };
}

export function patchLayer(
  doc: RiffDocument,
  id: LayerId,
  patch: Partial<PartLayer>,
): RiffDocument {
  const layer = doc.layers[id];
  if (!layer) return doc;
  return withLayers(doc, { ...doc.layers, [id]: { ...layer, ...patch } });
}

export function patchLayers(
  doc: RiffDocument,
  ids: readonly LayerId[],
  patch: (layer: PartLayer) => PartLayer,
): RiffDocument {
  const layers = { ...doc.layers };
  let changed = false;
  for (const id of ids) {
    const layer = layers[id];
    if (!layer) continue;
    const next = patch(layer);
    if (next !== layer) {
      layers[id] = next;
      changed = true;
    }
  }
  return changed ? withLayers(doc, layers) : doc;
}

function setLayerIds(doc: RiffDocument, layerIds: LayerId[]): RiffDocument {
  const artboard = activeArtboard(doc);
  if (!artboard) return doc;
  return {
    ...doc,
    artboards: { ...doc.artboards, [artboard.id]: { ...artboard, layerIds } },
  };
}

/**
 * Attach parts to a new parent.
 *
 * Refuses a cycle rather than silently dropping the change, and keeps each
 * part's place on screen by rewriting its position against the new parent's
 * matrix. Re-parenting that teleports the artwork is the single most common way
 * a rig editor loses someone's work.
 */
export function attachTo(
  doc: RiffDocument,
  ids: readonly LayerId[],
  parentId: LayerId | null,
  frame: Frame,
): RiffDocument {
  let out = doc;
  for (const id of ids) {
    const layer = out.layers[id];
    if (!layer || layer.locked) continue;
    if (parentId && isDescendant(out, parentId, id)) continue;
    if (layer.parentLayerId === parentId) continue;

    const before = worldMatrix(layer, out, frame);
    const nextParent = parentId ? out.layers[parentId] : undefined;
    const parentMatrix = nextParent
      ? worldMatrix(nextParent, out, frame)
      : IDENTITY;

    out = patchLayer(out, id, { parentLayerId: parentId });
    let moved = out.layers[id];
    if (!moved) continue;

    // A part that has never been posed gets its joint put where a joint
    // belongs: the point of its own artwork nearest the thing it now hangs
    // off. Otherwise everyone's first arm rotates around its own middle.
    const auto = parentId ? autoJoint(out, moved, frame) : null;
    if (auto) {
      out = patchLayer(out, id, { pivot: auto });
      moved = out.layers[id] ?? moved;
    }

    // Solve for the position that reproduces the old world placement under the
    // new parent. The joint is the one point whose image is position + joint,
    // so one point is enough and no decomposition is needed.
    const inverseParent = invertOrIdentity(parentMatrix);
    const [wx, wy] = applyMatrix(before, moved.pivot.x, moved.pivot.y);
    const [lx, ly] = applyMatrix(inverseParent, wx, wy);
    out = patchLayer(out, id, {
      transform: {
        ...moved.transform,
        x: constant(lx - moved.pivot.x),
        y: constant(ly - moved.pivot.y),
      },
    });
  }
  return out;
}

/**
 * Where this part's joint should sit once it hangs off a parent.
 *
 * Returns null when the part has already been placed by hand, which is anything
 * rotated, scaled, or whose joint has been moved off the centre of its artwork.
 * Guessing over a decision someone already made is worse than not guessing.
 */
function autoJoint(
  doc: RiffDocument,
  layer: PartLayer,
  frame: Frame,
): { x: number; y: number } | null {
  const rotation = evalAnimatable(layer.transform.rotation, doc.tracks, frame);
  const scaleX = evalAnimatable(layer.transform.scaleX, doc.tracks, frame);
  const scaleY = evalAnimatable(layer.transform.scaleY, doc.tracks, frame);
  if (rotation !== 0 || scaleX !== 1 || scaleY !== 1) return null;

  const box = variantBounds(variantAt(layer, doc, frame), doc);
  if (!box) return null;
  const centreX = (box[0] + box[2]) / 2;
  const centreY = (box[1] + box[3]) / 2;
  const untouched =
    (Math.abs(layer.pivot.x - centreX) < 0.75 &&
      Math.abs(layer.pivot.y - centreY) < 0.75) ||
    (layer.pivot.x === 0 && layer.pivot.y === 0);
  if (!untouched) return null;

  const parent = layer.parentLayerId ? doc.layers[layer.parentLayerId] : null;
  if (!parent) return null;
  const [px, py] = jointPosition(parent, doc, frame);
  const inverse = invertOrIdentity(worldMatrix(layer, doc, frame));
  const [lx, ly] = applyMatrix(inverse, px, py);
  return {
    x: Math.min(Math.max(lx, box[0]), box[2]),
    y: Math.min(Math.max(ly, box[1]), box[3]),
  };
}

function invertOrIdentity(m: Matrix): Matrix {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) return IDENTITY;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

/** Insert `ids` into the draw order at `index`, removing them from wherever they were. */
export function reorderTo(
  doc: RiffDocument,
  ids: readonly LayerId[],
  index: number,
): RiffDocument {
  const artboard = activeArtboard(doc);
  if (!artboard || ids.length === 0) return doc;
  const moving = new Set(ids);
  const before = artboard.layerIds
    .slice(0, index)
    .filter((id) => !moving.has(id));
  const after = artboard.layerIds.slice(index).filter((id) => !moving.has(id));
  const ordered = artboard.layerIds.filter((id) => moving.has(id));
  return setLayerIds(doc, [...before, ...ordered, ...after]);
}

export type DrawOrderMove = "forward" | "backward" | "front" | "back";

/** Bring forward, send backward, to front, to back. One step per call. */
export function moveInDrawOrder(
  doc: RiffDocument,
  ids: readonly LayerId[],
  move: DrawOrderMove,
): RiffDocument {
  const artboard = activeArtboard(doc);
  if (!artboard || ids.length === 0) return doc;
  const moving = new Set(ids);
  const rest = artboard.layerIds.filter((id) => !moving.has(id));
  const ordered = artboard.layerIds.filter((id) => moving.has(id));
  if (ordered.length === 0) return doc;

  if (move === "front") return setLayerIds(doc, [...rest, ...ordered]);
  if (move === "back") return setLayerIds(doc, [...ordered, ...rest]);

  const indices = ordered.map((id) => artboard.layerIds.indexOf(id));
  const anchor =
    move === "forward" ? Math.max(...indices) + 2 : Math.min(...indices) - 1;
  const target = Math.min(
    Math.max(anchor - ordered.filter((_, i) => indices[i] < anchor).length, 0),
    rest.length,
  );
  return setLayerIds(doc, [
    ...rest.slice(0, target),
    ...ordered,
    ...rest.slice(target),
  ]);
}

/** Add a part to the document, on top of the draw order unless told otherwise. */
export function addPart(
  doc: RiffDocument,
  layer: PartLayer,
  index?: number,
): RiffDocument {
  const artboard = activeArtboard(doc);
  if (!artboard) return doc;
  const layerIds = artboard.layerIds.slice();
  layerIds.splice(index ?? layerIds.length, 0, layer.id);
  return {
    ...doc,
    layers: { ...doc.layers, [layer.id]: layer },
    artboards: { ...doc.artboards, [artboard.id]: { ...artboard, layerIds } },
  };
}

/**
 * Delete parts, re-attaching their children to the deleted part's own parent.
 *
 * Orphaning a subtree on delete looks tidy in the data and is a disaster on
 * screen: a hand whose forearm is gone should hang off the upper arm, not fly
 * back to the artboard origin.
 */
export function deleteParts(
  doc: RiffDocument,
  ids: readonly LayerId[],
  frame: Frame,
): RiffDocument {
  const artboard = activeArtboard(doc);
  if (!artboard || ids.length === 0) return doc;
  const doomed = new Set(ids.filter((id) => !doc.layers[id]?.locked));
  if (doomed.size === 0) return doc;

  let out = doc;
  for (const id of doomed) {
    const layer = out.layers[id];
    if (!layer) continue;
    let heir = layer.parentLayerId;
    while (heir && doomed.has(heir))
      heir = out.layers[heir]?.parentLayerId ?? null;
    out = attachTo(out, childrenOf(out, id), heir, frame);
  }

  const layers = { ...out.layers };
  for (const id of doomed) delete layers[id];
  const next = withLayers(out, layers);
  return setLayerIds(
    next,
    (activeArtboard(next)?.layerIds ?? []).filter((id) => !doomed.has(id)),
  );
}

/**
 * Wrap a selection in a new empty part.
 *
 * "Group" in a rig is a null joint: the parts hang off it, it draws nothing, and
 * rotating it swings the whole cluster. It is the same type as every other part,
 * which is why there is no "this action is unavailable for groups" anywhere.
 */
export function groupParts(
  doc: RiffDocument,
  ids: readonly LayerId[],
  frame: Frame,
): { doc: RiffDocument; groupId: LayerId | null } {
  const artboard = activeArtboard(doc);
  const members = ids.filter((id) => doc.layers[id]);
  if (!artboard || members.length === 0) return { doc, groupId: null };

  const memo = new Map<LayerId, Matrix>();
  let sumX = 0;
  let sumY = 0;
  for (const id of members) {
    const layer = doc.layers[id];
    if (!layer) continue;
    const [jx, jy] = jointPosition(layer, doc, frame, memo);
    sumX += jx;
    sumY += jy;
  }
  const centreX = sumX / members.length;
  const centreY = sumY / members.length;

  // The new node inherits the shared parent when every member has one, so
  // grouping a hand and a forearm under a wrist keeps the wrist on the arm.
  const parents = new Set(members.map((id) => doc.layers[id]?.parentLayerId));
  const inherited = parents.size === 1 ? ([...parents][0] ?? null) : null;

  const group = newPart(artboard.id, {
    name: "Group",
    variants: [],
    parentLayerId: inherited && !members.includes(inherited) ? inherited : null,
    transform: {
      ...newPart(artboard.id).transform,
      x: constant(centreX),
      y: constant(centreY),
    },
  });

  const backmost = Math.min(
    ...members.map((id) => artboard.layerIds.indexOf(id)),
  );
  let out = addPart(doc, group, Math.max(0, backmost));
  out = attachTo(out, members, group.id, frame);
  return { doc: out, groupId: group.id };
}

/** Dissolve a group node, re-attaching its children to its own parent. */
export function ungroupParts(
  doc: RiffDocument,
  ids: readonly LayerId[],
  frame: Frame,
): RiffDocument {
  let out = doc;
  for (const id of ids) {
    const layer = out.layers[id];
    if (!layer) continue;
    const kids = childrenOf(out, id);
    if (kids.length === 0) continue;
    out = attachTo(out, kids, layer.parentLayerId, frame);
    if (layer.variants.length === 0) out = deleteParts(out, [id], frame);
  }
  return out;
}

// ----------------------------------------------------------------- duplication

/**
 * Copy a path, optionally mirrored about a vertical line in its own space.
 *
 * `d` is cleared on a mirrored copy: the string and the arrays would otherwise
 * disagree, and `d` is the one the renderer trusts. The caller regenerates it.
 */
function clonePath(
  source: PathGeometry,
  paths: Record<PathId, PathGeometry>,
  flipAboutX: number | null,
): PathId {
  const nextId = newId("Path");
  if (flipAboutX === null) {
    paths[nextId] = { ...source, id: nextId };
    return nextId;
  }
  const vertices = Float64Array.from(source.vertices);
  const tangentsIn = Float64Array.from(source.tangentsIn);
  const tangentsOut = Float64Array.from(source.tangentsOut);
  for (let i = 0; i < vertices.length; i += 2) {
    vertices[i] = 2 * flipAboutX - vertices[i];
    tangentsIn[i] = -tangentsIn[i];
    tangentsOut[i] = -tangentsOut[i];
  }
  paths[nextId] = {
    ...source,
    id: nextId,
    vertices,
    tangentsIn,
    tangentsOut,
    d: "",
    bounds: [
      2 * flipAboutX - source.bounds[2],
      source.bounds[1],
      2 * flipAboutX - source.bounds[0],
      source.bounds[3],
    ],
  };
  return nextId;
}

export interface DuplicateResult {
  doc: RiffDocument;
  /** New ids, in the same order as the ids that were passed in. */
  created: LayerId[];
}

/**
 * Duplicate parts, optionally mirrored about a vertical line in parent space.
 *
 * Mirroring flips the geometry and negates the rotation rather than setting a
 * negative scale, because a negative scale silently reverses every child's
 * rotation direction and turns "swing the forearm up" into "swing it down".
 *
 * The flip happens about each part's own joint, so the joint stays put in the
 * artwork; the position then solves so the copy's joint lands at the mirror of
 * the original's. Both are one line of algebra because `composeLayerMatrix`
 * puts the joint at `position + joint` by construction.
 *
 * A mirror takes the whole chain. An upper arm mirrored on its own leaves its
 * forearm and hand behind on the original, which is never what "make the other
 * side" meant. Each member below the top of the chain mirrors about its own
 * parent's joint, because a child lives in its parent's coordinates and that is
 * the line its parent was flipped about.
 */
export function duplicateParts(
  doc: RiffDocument,
  ids: readonly LayerId[],
  options: { mirrorAxis?: number | null; frame: Frame; offset?: number },
): DuplicateResult {
  const artboard = activeArtboard(doc);
  const asked = ids.filter((id) => doc.layers[id]);
  if (!artboard || asked.length === 0) return { doc, created: [] };

  // A mirror carries everything hanging off what was asked for, in draw order.
  const members =
    options.mirrorAxis === null || options.mirrorAxis === undefined
      ? asked
      : artboard.layerIds.filter((id) =>
          asked.some((root) => isDescendant(doc, id, root)),
        );
  const inSelection = new Set(members);

  const axis = options.mirrorAxis ?? null;
  const frame = options.frame;
  // A plain duplicate steps aside so it is visible; one that is about to be
  // dragged must not jump out from under the pointer first.
  const nudge = options.offset ?? 16;
  const paths = { ...doc.paths };
  const layers = { ...doc.layers };
  const idMap = new Map<LayerId, LayerId>();
  const created: LayerId[] = [];

  for (const id of members) {
    const source = doc.layers[id];
    if (!source) continue;
    const nextId = newId("Layer");
    idMap.set(id, nextId);
    created.push(nextId);

    const read = (prop: (typeof source)["opacity"]) =>
      evalAnimatable(prop, doc.tracks, frame);
    const x = read(source.transform.x);
    const y = read(source.transform.y);
    const rotation = read(source.transform.rotation);

    // The line this part mirrors about: the caller's line for the top of the
    // chain, and the parent's joint for anything hanging off it.
    const parentInSelection =
      source.parentLayerId && inSelection.has(source.parentLayerId)
        ? doc.layers[source.parentLayerId]
        : null;
    const localAxis =
      axis === null ? null : (parentInSelection?.pivot.x ?? axis);

    const variants: Variant[] = source.variants.map((variant) => ({
      ...variant,
      id: newId("Variant"),
      pathIds: variant.pathIds.flatMap((pathId) => {
        const geometry = doc.paths[pathId];
        if (!geometry) return [];
        return [
          clonePath(
            geometry,
            paths,
            localAxis === null ? null : source.pivot.x,
          ),
        ];
      }),
    }));

    layers[nextId] = {
      ...source,
      id: nextId,
      name: axis === null ? `${source.name} copy` : mirrorName(source.name),
      variants,
      // A duplicate starts as constants sampled at the current frame: sharing
      // tracks would make the copy move whenever the original does.
      transform: {
        x: constant(
          localAxis === null
            ? x + nudge
            : 2 * localAxis - x - 2 * source.pivot.x,
        ),
        y: constant(localAxis === null ? y + nudge : y),
        rotation: constant(localAxis === null ? rotation : -rotation),
        scaleX: constant(read(source.transform.scaleX)),
        scaleY: constant(read(source.transform.scaleY)),
        // A mirrored copy slants the other way, or the two sides lean together.
        skewX: constant(
          localAxis === null
            ? read(source.transform.skewX)
            : -read(source.transform.skewX),
        ),
        skewY: constant(
          localAxis === null
            ? read(source.transform.skewY)
            : -read(source.transform.skewY),
        ),
      },
      depth: constant(read(source.depth)),
      opacity: constant(read(source.opacity)),
      variant: constant(read(source.variant)),
    };
  }

  // Re-point parents that were duplicated too, so a copied forearm hangs off
  // the copied upper arm rather than the original one.
  for (const nextId of created) {
    const layer = layers[nextId];
    if (!layer?.parentLayerId) continue;
    const mapped = idMap.get(layer.parentLayerId);
    if (mapped) layers[nextId] = { ...layer, parentLayerId: mapped };
  }

  // A plain duplicate sits right on top of what it copied. A mirror goes to
  // the front of the stack: the part being mirrored is usually the far side of
  // the character, so its other side belongs in front, and a copy you cannot
  // see is a copy that looks like it was not made.
  const layerIds = artboard.layerIds.slice();
  if (axis === null) {
    for (const id of members) {
      const mapped = idMap.get(id);
      if (mapped) layerIds.splice(layerIds.indexOf(id) + 1, 0, mapped);
    }
  } else {
    layerIds.push(...created);
  }

  return {
    doc: {
      ...doc,
      paths,
      layers,
      artboards: { ...doc.artboards, [artboard.id]: { ...artboard, layerIds } },
    },
    created,
  };
}

/** "Left arm" mirrors to "Right arm", and back. Anything else gets " mirrored". */
function mirrorName(name: string): string {
  if (/\bleft\b/i.test(name)) return name.replace(/\bleft\b/i, "Right");
  if (/\bright\b/i.test(name)) return name.replace(/\bright\b/i, "Left");
  if (/\bL\b/.test(name)) return name.replace(/\bL\b/, "R");
  if (/\bR\b/.test(name)) return name.replace(/\bR\b/, "L");
  return `${name} mirrored`;
}

/**
 * The default mirror line for a part, in its parent's coordinates.
 *
 * A part's coordinates live in its parent's local space, so the parent's joint
 * is simply `parent.pivot`. A root part mirrors about the artboard centre.
 */
export function mirrorAxisFor(doc: RiffDocument, id: LayerId): number {
  const layer = doc.layers[id];
  const parent = layer?.parentLayerId ? doc.layers[layer.parentLayerId] : null;
  if (parent) return parent.pivot.x;
  return (activeArtboard(doc)?.width ?? 0) / 2;
}

// ----------------------------------------------------------------- the page

/** Union of every visible part's bounds at a frame, in document space. */
export function contentBounds(
  doc: RiffDocument,
  frame: Frame,
): [number, number, number, number] | null {
  const memo = new Map<LayerId, Matrix>();
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  let found = false;

  for (const layer of drawOrder(doc)) {
    if (!layer.visible) continue;
    const box = variantBounds(variantAt(layer, doc, frame), doc);
    if (!box) continue;
    const m = worldMatrix(layer, doc, frame, memo);
    for (const [bx, by] of [
      [box[0], box[1]],
      [box[2], box[1]],
      [box[0], box[3]],
      [box[2], box[3]],
    ]) {
      const [wx, wy] = applyMatrix(m, bx, by);
      x0 = Math.min(x0, wx);
      y0 = Math.min(y0, wy);
      x1 = Math.max(x1, wx);
      y1 = Math.max(y1, wy);
      found = true;
    }
  }
  return found ? [x0, y0, x1, y1] : null;
}

/** A part's box in document space at a frame, or null when it draws nothing. */
export function partWorldBounds(
  doc: RiffDocument,
  id: LayerId,
  frame: Frame,
  memo?: Map<LayerId, Matrix>,
): [number, number, number, number] | null {
  const layer = doc.layers[id];
  if (!layer) return null;
  const box = variantBounds(variantAt(layer, doc, frame), doc);
  if (!box) return null;
  const m = worldMatrix(layer, doc, frame, memo);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [bx, by] of [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[0], box[3]],
    [box[2], box[3]],
  ]) {
    const [wx, wy] = applyMatrix(m, bx, by);
    xs.push(wx);
    ys.push(wy);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * True when any of a part's artwork falls outside the page.
 *
 * Worth knowing because the page is what the exported player uses as its
 * canvas: anything over the edge is simply gone in the export, and nothing else
 * on screen says so.
 */
export function isOffPage(
  doc: RiffDocument,
  id: LayerId,
  frame: Frame,
  memo?: Map<LayerId, Matrix>,
): boolean {
  const artboard = activeArtboard(doc);
  const box = partWorldBounds(doc, id, frame, memo);
  if (!artboard || !box) return false;
  // A pixel of slack, so a part drawn exactly to the edge is not flagged.
  return (
    box[0] < -1 ||
    box[1] < -1 ||
    box[2] > artboard.width + 1 ||
    box[3] > artboard.height + 1
  );
}

/**
 * Resize the page around the artwork and move the artwork onto it.
 *
 * An imported rig arrives in whatever coordinates its author used, and the page
 * is what the exported player uses as its canvas. Without this, opening someone
 * else's file and exporting it produces a mostly empty frame with the character
 * hanging off one edge.
 *
 * Only roots move, because a child's position is read in its parent's space and
 * shifting both would move it twice.
 */
export function fitPageToContent(
  doc: RiffDocument,
  frame: Frame,
  margin = 48,
): RiffDocument {
  const artboard = activeArtboard(doc);
  const box = contentBounds(doc, frame);
  if (!artboard || !box) return doc;

  const dx = margin - box[0];
  const dy = margin - box[1];
  let out = doc;
  for (const layer of Object.values(doc.layers)) {
    if (layer.parentLayerId) continue;
    const x = evalAnimatable(layer.transform.x, doc.tracks, frame);
    const y = evalAnimatable(layer.transform.y, doc.tracks, frame);
    out = patchLayer(out, layer.id, {
      transform: {
        ...layer.transform,
        x: constant(x + dx),
        y: constant(y + dy),
      },
    });
  }
  return patchArtboard(out, artboard.id, {
    width: Math.max(1, Math.round(box[2] - box[0] + margin * 2)),
    height: Math.max(1, Math.round(box[3] - box[1] + margin * 2)),
  });
}

// ------------------------------------------------------------------ artboards

export function patchArtboard(
  doc: RiffDocument,
  id: ArtboardId,
  patch: Partial<Artboard>,
): RiffDocument {
  const artboard = doc.artboards[id];
  if (!artboard) return doc;
  return {
    ...doc,
    artboards: { ...doc.artboards, [id]: { ...artboard, ...patch } },
  };
}

/**
 * What the drawing tools do to the document.
 *
 * Pure `doc -> doc` so the canvas stays about pointers and this stays about
 * meaning. Every one of these is called inside a single store transaction, so
 * one stroke is one undo.
 */

import { evalAnimatable } from "@/editor/model/animation";
import {
  constant,
  type Frame,
  type LayerId,
  newPart,
  newVariant,
  type PathGeometry,
  type RGBA,
  type RiffDocument,
} from "@/editor/model/document";
import {
  addPart,
  variantAt,
  variantBounds,
  worldMatrix,
} from "@/editor/model/rig";

export interface DrawnPartOptions {
  name: string;
  fill: RGBA | null;
  stroke: RGBA | null;
  strokeWidth: number;
}

/**
 * Turn one finished drawing into a part.
 *
 * The joint starts at the centre of what was drawn, which is the only honest
 * guess before the part is attached to anything. Attaching moves it to the
 * right place automatically.
 */
export function addDrawnPart(
  doc: RiffDocument,
  geometry: PathGeometry,
  options: DrawnPartOptions,
): { doc: RiffDocument; layerId: LayerId } {
  const artboard = doc.artboards[doc.activeArtboardId];
  if (!artboard) return { doc, layerId: "" as LayerId };

  const [x0, y0, x1, y1] = geometry.bounds;
  const part = newPart(artboard.id, {
    name: options.name,
    pivot: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
    variants: [
      newVariant({
        name: "Default",
        pathIds: [geometry.id],
        fill: options.fill,
        stroke: options.stroke,
        strokeWidth: options.strokeWidth,
      }),
    ],
  });

  const withPath: RiffDocument = {
    ...doc,
    paths: { ...doc.paths, [geometry.id]: geometry },
  };
  return { doc: addPart(withPath, part), layerId: part.id };
}

/** A name that does not collide: "Part", "Part 2", "Part 3". */
export function nextPartName(doc: RiffDocument, base = "Part"): string {
  const taken = new Set(Object.values(doc.layers).map((layer) => layer.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/**
 * Move a part's joint to a document-space point, leaving the artwork where it is.
 *
 * At rest the joint has no effect on placement, so the compensation below only
 * ever matters on a part that is already rotated or scaled. Skipping it is the
 * bug where clicking to set a joint shoves a posed arm across the canvas.
 */
export function setJointAt(
  doc: RiffDocument,
  layerId: LayerId,
  documentX: number,
  documentY: number,
  frame: Frame,
): RiffDocument {
  const layer = doc.layers[layerId];
  if (!layer || layer.locked) return doc;

  const matrix = worldMatrix(layer, doc, frame);
  const det = matrix.a * matrix.d - matrix.b * matrix.c;
  if (det === 0) return doc;
  const lx =
    (matrix.d * (documentX - matrix.e) - matrix.c * (documentY - matrix.f)) /
    det;
  const ly =
    (matrix.a * (documentY - matrix.f) - matrix.b * (documentX - matrix.e)) /
    det;

  const rotation = evalAnimatable(layer.transform.rotation, doc.tracks, frame);
  const scaleX = evalAnimatable(layer.transform.scaleX, doc.tracks, frame);
  const scaleY = evalAnimatable(layer.transform.scaleY, doc.tracks, frame);
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const a = cos * scaleX;
  const b = sin * scaleX;
  const c = -sin * scaleY;
  const d = cos * scaleY;

  const dx = layer.pivot.x - lx;
  const dy = layer.pivot.y - ly;
  const x = evalAnimatable(layer.transform.x, doc.tracks, frame);
  const y = evalAnimatable(layer.transform.y, doc.tracks, frame);

  return {
    ...doc,
    layers: {
      ...doc.layers,
      [layerId]: {
        ...layer,
        pivot: { x: lx, y: ly },
        transform: {
          ...layer.transform,
          x: constant(x + dx - (a * dx + c * dy)),
          y: constant(y + dy - (b * dx + d * dy)),
        },
      },
    },
  };
}

/** Add a finished drawing to an existing part's active variant. */
export function addPathToVariant(
  doc: RiffDocument,
  layerId: LayerId,
  geometry: PathGeometry,
  frame: Frame,
): RiffDocument {
  const layer = doc.layers[layerId];
  if (!layer) return doc;
  const variant = variantAt(layer, doc, frame);
  if (!variant) return doc;
  return {
    ...doc,
    paths: { ...doc.paths, [geometry.id]: geometry },
    layers: {
      ...doc.layers,
      [layerId]: {
        ...layer,
        variants: layer.variants.map((candidate) =>
          candidate.id === variant.id
            ? { ...candidate, pathIds: [...candidate.pathIds, geometry.id] }
            : candidate,
        ),
      },
    },
  };
}

/** The centre of a part's artwork, in document space. Used to aim new joints. */
export function partCentre(
  doc: RiffDocument,
  layerId: LayerId,
  frame: Frame,
): [number, number] | null {
  const layer = doc.layers[layerId];
  if (!layer) return null;
  const box = variantBounds(variantAt(layer, doc, frame), doc);
  if (!box) return null;
  const matrix = worldMatrix(layer, doc, frame);
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  return [
    matrix.a * cx + matrix.c * cy + matrix.e,
    matrix.b * cx + matrix.d * cy + matrix.f,
  ];
}

/**
 * The editor, as a set of tools an agent can call.
 *
 * Every tool goes through the same store transactions the panels use, so
 * anything an agent does is undoable, autosaved and visible on screen exactly
 * as if a person had done it. Nothing here reaches into the document directly:
 * a second write path is a second set of bugs, and the first thing that rots is
 * undo.
 *
 * The vocabulary matches the interface. A part is a part, a joint is a joint,
 * and there is no tool whose name only makes sense if you have read the code.
 */

import {
  addDrawnPart,
  nextPartName,
  setJointAt,
} from "@/components/editor/draw";
import {
  ensureTrack,
  readAnimatable,
  upsertKeyframe,
} from "@/components/editor/timeline/edits";
import { importLegacyStudio, isLegacyStudioFile } from "./io/legacy-studio";
import { exportPlayerHtml } from "./io/player";
import { deserializeProject, projectToJson } from "./io/project";
import { evalAnimatable } from "./model/animation";
import type { BooleanOp } from "./model/boolean";
import {
  applyMatrix,
  constant,
  emptyDocument,
  INK,
  invert,
  type LayerId,
  type Matrix,
  multiply,
  newVariant,
  type PartLayer,
  type PathGeometry,
  parseHex,
  type RGBA,
  type RiffDocument,
  type Variant,
} from "./model/document";
import {
  type Contour,
  contoursToGeometry,
  flattenGeometry,
  flattenPaths,
} from "./model/polyline";
import {
  activeArtboard,
  attachTo,
  duplicateParts,
  groupParts,
  mirrorAxisFor,
  patchLayer,
  reorderTo,
  treeOrder,
  variantAt,
  worldMatrix,
} from "./model/rig";
import { sampleDocument } from "./model/sample";
import {
  combineParts,
  joinParts,
  partContours,
  simplifyParts,
} from "./model/shape-ops";
import {
  type BrushSample,
  brushStroke,
  ellipsePath,
  rectPath,
} from "./model/shapes";
import { resolveScene } from "./render/scene";
import type { EditorStore } from "./store";

export interface AgentTool {
  name: string;
  /** One line, active voice, no jargon. */
  description: string;
  /** JSON-schema-shaped, enough for a model to call it correctly. */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (input: Record<string, unknown>) => unknown;
}

/** Every property a part can animate, in the order the timeline lists them. */
const ANIMATABLE = [
  "transform.rotation",
  "transform.x",
  "transform.y",
  "transform.scaleX",
  "transform.scaleY",
  "transform.skewX",
  "transform.skewY",
  "opacity",
  "depth",
  "variant",
] as const;

/** What a part gets keyed on when it has never moved: a pose is angles first. */
const POSE_DEFAULTS = ["transform.rotation", "transform.x", "transform.y"];

// ----------------------------------------------------------------- schemas

const schema = (
  properties: Record<string, unknown>,
  required?: string[],
): AgentTool["inputSchema"] => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
});

const NUMBER = { type: "number" };
const STRING = { type: "string" };
const BOOLEAN = { type: "boolean" };
const ID = { type: "string", description: "A part id from listLayers." };
const IDS = {
  type: "array",
  items: ID,
  description: "Part ids from listLayers.",
};

// ------------------------------------------------------------ reading input

function num(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function needNum(input: Record<string, unknown>, key: string): number {
  const value = num(input, key);
  if (value === undefined) throw new Error(`"${key}" must be a number.`);
  return value;
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function needStr(input: Record<string, unknown>, key: string): string {
  const value = str(input, key);
  if (value === undefined) throw new Error(`"${key}" must be text.`);
  return value;
}

function needId(input: Record<string, unknown>, key = "id"): LayerId {
  return needStr(input, key) as LayerId;
}

function idList(input: Record<string, unknown>, key: string): LayerId[] | null {
  const value = input[key];
  if (!Array.isArray(value)) return null;
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`"${key}[${index}]" must be a part id.`);
    }
    return entry as LayerId;
  });
}

function needIds(input: Record<string, unknown>, key = "ids"): LayerId[] {
  const ids = idList(input, key);
  if (!ids || ids.length === 0) {
    throw new Error(`"${key}" must be a list of part ids.`);
  }
  return ids;
}

/**
 * A colour the caller gave us.
 *
 * Saying nothing means the editor's current colour applies; an explicit null
 * means no fill at all, which is how an open ink line is asked for. The two
 * have to stay distinguishable.
 */
function colour(
  input: Record<string, unknown>,
  key: string,
  fallback: RGBA | null,
): RGBA | null {
  if (!(key in input)) return fallback;
  const value = input[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`"${key}" must be a hex colour.`);
  }
  const parsed = parseHex(value);
  if (!parsed) throw new Error(`"${value}" is not a hex colour.`);
  return parsed;
}

// ------------------------------------------------------------- reading state

function requirePart(doc: RiffDocument, id: LayerId): PartLayer {
  const layer = doc.layers[id];
  if (!layer) throw new Error(`There is no part with the id "${id}".`);
  return layer;
}

function requireVariant(
  doc: RiffDocument,
  layer: PartLayer,
  frame: number,
): Variant {
  const variant = variantAt(layer, doc, frame);
  if (!variant) throw new Error(`"${layer.name}" has no drawing to work with.`);
  return variant;
}

/** The outlines a part is showing, flattened, in that part's own coordinates. */
/** Total vertices across a set of contours, for the simplify report. */
function countPoints(contours: readonly Contour[]): number {
  return contours.reduce((sum, c) => sum + c.points.length / 2, 0);
}

function contoursOf(doc: RiffDocument, id: LayerId, frame: number): Contour[] {
  const layer = requirePart(doc, id);
  return flattenPaths(doc, requireVariant(doc, layer, frame).pathIds);
}

/** Maps one part's own coordinates into another's. */
function betweenParts(
  doc: RiffDocument,
  keeperId: LayerId,
  sourceId: LayerId,
  frame: number,
): Matrix {
  const keeper = invert(worldMatrix(requirePart(doc, keeperId), doc, frame));
  if (!keeper) {
    throw new Error(
      "That part is squashed to nothing and cannot take a shape.",
    );
  }
  return multiply(keeper, worldMatrix(requirePart(doc, sourceId), doc, frame));
}

function mapContours(contours: readonly Contour[], m: Matrix): Contour[] {
  return contours.map((contour) => {
    const points: number[] = [];
    for (let i = 0; i < contour.points.length; i += 2) {
      const [x, y] = applyMatrix(m, contour.points[i], contour.points[i + 1]);
      points.push(x, y);
    }
    // Pen pressure belongs to the stroke that was drawn, not to a shape
    // computed from it, so it is dropped rather than carried along wrongly.
    return { points, closed: contour.closed };
  });
}

/** Replace what a part is showing with one new outline. */
function _writeContours(
  doc: RiffDocument,
  id: LayerId,
  frame: number,
  contours: readonly Contour[],
): RiffDocument {
  const layer = requirePart(doc, id);
  const variant = requireVariant(doc, layer, frame);
  const geometry = contoursToGeometry(contours);
  return {
    ...doc,
    paths: { ...doc.paths, [geometry.id]: geometry },
    layers: {
      ...doc.layers,
      [id]: {
        ...layer,
        variants: layer.variants.map((candidate) =>
          candidate.id === variant.id
            ? { ...candidate, pathIds: [geometry.id] }
            : candidate,
        ),
      },
    },
  };
}

// ------------------------------------------------------------------- factory

export function createAgentTools(store: EditorStore): AgentTool[] {
  const doc = () => store.getState().doc;
  const ui = () => store.getState().ui;
  const frame = () => store.getState().ui.frame;

  /**
   * One call, one undo step.
   *
   * A patch that throws must not leave the transaction open, or the next tool
   * silently joins a transaction nobody will ever commit.
   */
  const edit = (patch: (current: RiffDocument) => RiffDocument) => {
    store.begin(null);
    try {
      store.setDoc(patch);
    } catch (error) {
      store.abort();
      throw error;
    }
    store.commit();
  };

  const describe = (id: LayerId) => {
    const current = doc();
    const layer = requirePart(current, id);
    const at = frame();
    const read = (prop: PartLayer["opacity"]) =>
      evalAnimatable(prop, current.tracks, at);
    const shown = variantAt(layer, current, at);
    return {
      id: layer.id,
      name: layer.name,
      parentId: layer.parentLayerId,
      joint: { x: layer.pivot.x, y: layer.pivot.y },
      transform: {
        x: read(layer.transform.x),
        y: read(layer.transform.y),
        rotation: read(layer.transform.rotation),
        scaleX: read(layer.transform.scaleX),
        scaleY: read(layer.transform.scaleY),
        skewX: read(layer.transform.skewX),
        skewY: read(layer.transform.skewY),
      },
      opacity: read(layer.opacity),
      depthValue: read(layer.depth),
      overlap: layer.overlap,
      variants: layer.variants.map((variant) => ({
        name: variant.name,
        active: variant.id === shown?.id,
      })),
      visible: layer.visible,
      locked: layer.locked,
    };
  };

  const listLayers = () =>
    treeOrder(doc()).map((node) => ({
      depth: node.depth,
      ...describe(node.id),
    }));

  /** Add one finished drawing as a new part, and select it. */
  const createPart = (
    geometry: PathGeometry,
    input: Record<string, unknown>,
    filled: boolean,
  ) => {
    const fill = colour(input, "fill", filled ? ui().drawFill : null);
    const name = str(input, "name") ?? nextPartName(doc());
    const width = ui().brushWidth;
    let created = "" as LayerId;
    edit((current) => {
      const result = addDrawnPart(current, geometry, {
        name,
        fill,
        stroke: INK,
        strokeWidth: width,
      });
      created = result.layerId;
      return result.doc;
    });
    store.select([created]);
    return { id: created };
  };

  /** Two shapes into one, with the result landing in the first part. */
  /**
   * Add, subtract or intersect two parts.
   *
   * The shape work itself lives in `model/shape-ops`, so the tool surface and
   * the inspector cannot disagree about which part survives. Both keep the
   * backmost one, because the result inherits its place in the stack and a
   * result that jumps forward is a result that hides something.
   */
  const combine = (input: Record<string, unknown>, op: BooleanOp) => {
    const ids = needIds(input);
    if (ids.length !== 2) throw new Error("Pick exactly two parts to combine.");
    for (const id of ids) requirePart(doc(), id);
    const at = frame();
    let landed: LayerId | null = null;
    edit((current) => {
      const result = combineParts(current, ids, op, at);
      if (!result.keeperId) {
        throw new Error("Those two shapes do not overlap.");
      }
      landed = result.keeperId;
      return result.doc;
    });
    const keeperId = landed ?? ids[0];
    store.select([keeperId]);
    return { id: keeperId };
  };

  /** Write a number onto a part, keying it when that property is animated. */
  const writeNumber = (
    current: RiffDocument,
    id: LayerId,
    path: string,
    value: number,
    at: number,
  ): RiffDocument => {
    const layer = requirePart(current, id);
    if (readAnimatable(layer, path).kind === "track") {
      const ensured = ensureTrack(current, id, path, at);
      return upsertKeyframe(ensured.doc, ensured.trackId, at, value);
    }
    if (path === "opacity") {
      return patchLayer(current, id, { opacity: constant(value) });
    }
    if (path === "depth") {
      return patchLayer(current, id, { depth: constant(value) });
    }
    if (path === "variant") {
      return patchLayer(current, id, { variant: constant(value) });
    }
    const key = path.split(".")[1] as keyof PartLayer["transform"];
    return patchLayer(current, id, {
      transform: { ...layer.transform, [key]: constant(value) },
    });
  };

  /** Key one part on the properties it already animates, or on a plain pose. */
  const keyPart = (
    current: RiffDocument,
    id: LayerId,
    props: readonly string[] | null,
    at: number,
  ): RiffDocument => {
    const layer = requirePart(current, id);
    const animated = ANIMATABLE.filter(
      (path) => readAnimatable(layer, path).kind === "track",
    );
    const targets =
      props && props.length > 0
        ? props
        : animated.length > 0
          ? animated
          : POSE_DEFAULTS;

    let out = current;
    for (const path of targets) {
      const before = requirePart(out, id);
      const value = evalAnimatable(
        readAnimatable(before, path),
        out.tracks,
        at,
      );
      const ensured = ensureTrack(out, id, path, at);
      out = upsertKeyframe(ensured.doc, ensured.trackId, at, value);
    }
    return out;
  };

  return [
    {
      name: "newDocument",
      description: "Throw everything away and start an empty rig.",
      inputSchema: schema({}),
      execute: () => {
        edit(() => emptyDocument());
        store.select([]);
        store.requestFit();
        return { layers: 0 };
      },
    },
    {
      name: "loadSample",
      description: "Load the sample character, a seven part rig that waves.",
      inputSchema: schema({}),
      execute: () => {
        edit(() => sampleDocument());
        store.select([]);
        store.requestFit();
        return { layers: listLayers().length };
      },
    },
    {
      name: "listLayers",
      description:
        "List every part, nested by what it is attached to, with its joint, transform and drawings at the playhead.",
      inputSchema: schema({}),
      execute: () => listLayers(),
    },
    {
      name: "select",
      description: "Select parts by id. Pass an empty list to select nothing.",
      inputSchema: schema({ ids: IDS }, ["ids"]),
      execute: (input) => {
        const ids = idList(input, "ids");
        if (!ids) throw new Error('"ids" must be a list of part ids.');
        for (const id of ids) requirePart(doc(), id);
        store.select(ids);
        return { selection: ids };
      },
    },
    {
      name: "drawStroke",
      description:
        "Draw a freehand stroke and turn it into a new part. Finishing near the start fills it.",
      inputSchema: schema(
        {
          points: {
            type: "array",
            items: { type: "array", items: NUMBER },
            description:
              "Points as [x, y] or [x, y, pressure], in page coordinates.",
          },
          closed: BOOLEAN,
          name: STRING,
          fill: {
            ...STRING,
            description: "Hex colour, or null for an open line.",
          },
        },
        ["points"],
      ),
      execute: (input) => {
        const raw = input.points;
        if (!Array.isArray(raw) || raw.length < 2) {
          throw new Error("A stroke needs at least two points.");
        }
        const samples: BrushSample[] = raw.map((point, index) => {
          if (
            !Array.isArray(point) ||
            typeof point[0] !== "number" ||
            typeof point[1] !== "number"
          ) {
            throw new Error(
              `Point ${index} must be [x, y] or [x, y, pressure].`,
            );
          }
          return {
            x: point[0],
            y: point[1],
            pressure: typeof point[2] === "number" ? point[2] : 0.5,
          };
        });

        const stroke = brushStroke(samples);
        if (!stroke) throw new Error("That stroke was too short to draw.");
        // The brush decides closed-ness from where the stroke ended. A caller
        // that states it outright overrides that, which is the only way to draw
        // a shape from four points.
        const asked =
          typeof input.closed === "boolean" ? input.closed : stroke.closed;
        const geometry =
          asked === stroke.closed
            ? stroke.geometry
            : contoursToGeometry(
                flattenGeometry(stroke.geometry).map((contour) => ({
                  ...contour,
                  closed: asked,
                })),
              );
        return createPart(geometry, input, asked);
      },
    },
    {
      name: "rect",
      description: "Draw a rectangle as a new part.",
      inputSchema: schema(
        {
          x: NUMBER,
          y: NUMBER,
          width: NUMBER,
          height: NUMBER,
          name: STRING,
          fill: STRING,
        },
        ["x", "y", "width", "height"],
      ),
      execute: (input) =>
        createPart(
          rectPath(
            needNum(input, "x"),
            needNum(input, "y"),
            needNum(input, "width"),
            needNum(input, "height"),
          ),
          input,
          true,
        ),
    },
    {
      name: "ellipse",
      description: "Draw an oval as a new part.",
      inputSchema: schema(
        {
          cx: NUMBER,
          cy: NUMBER,
          rx: NUMBER,
          ry: NUMBER,
          name: STRING,
          fill: STRING,
        },
        ["cx", "cy", "rx", "ry"],
      ),
      execute: (input) =>
        createPart(
          ellipsePath(
            needNum(input, "cx"),
            needNum(input, "cy"),
            needNum(input, "rx"),
            needNum(input, "ry"),
          ),
          input,
          true,
        ),
    },
    {
      name: "join",
      description:
        "Join separate lines into one filled shape. Several parts become the backmost one.",
      inputSchema: schema({ ids: IDS }, ["ids"]),
      execute: (input) => {
        const ids = needIds(input);
        for (const id of ids) requirePart(doc(), id);
        const at = frame();
        let landed: LayerId | null = null;
        edit((current) => {
          const result = joinParts(current, ids, at, ui().drawFill);
          if (!result.keeperId) throw new Error("There was nothing to join.");
          landed = result.keeperId;
          return result.doc;
        });
        const keeperId = landed ?? ids[0];
        store.select([keeperId]);
        return { id: keeperId };
      },
    },
    {
      name: "union",
      description:
        "Add two shapes together. The result lands in the backmost part.",
      inputSchema: schema({ ids: IDS }, ["ids"]),
      execute: (input) => combine(input, "union"),
    },
    {
      name: "subtract",
      description: "Cut the second shape out of the first.",
      inputSchema: schema({ ids: IDS }, ["ids"]),
      execute: (input) => combine(input, "subtract"),
    },
    {
      name: "intersect",
      description: "Keep only the part where two shapes overlap.",
      inputSchema: schema({ ids: IDS }, ["ids"]),
      execute: (input) => combine(input, "intersect"),
    },
    {
      name: "simplify",
      description:
        "Drop points a shape does not need, without changing how it looks.",
      inputSchema: schema({ id: ID, tolerance: NUMBER }, ["id"]),
      execute: (input) => {
        const id = needId(input);
        const tolerance = num(input, "tolerance") ?? 1.5;
        const at = frame();
        let before = 0;
        let after = 0;
        edit((current) => {
          before = countPoints(
            partContours(current, requirePart(current, id), at),
          );
          const next = simplifyParts(current, [id], at, tolerance);
          after = countPoints(partContours(next, requirePart(next, id), at));
          return next;
        });
        return { id, pointsBefore: before, pointsAfter: after };
      },
    },
    {
      name: "attach",
      description:
        "Attach a part to another so it follows it. Pass null to detach it.",
      inputSchema: schema(
        { childId: ID, parentId: { type: ["string", "null"] } },
        ["childId"],
      ),
      execute: (input) => {
        const childId = needId(input, "childId");
        const raw = input.parentId;
        const parentId =
          raw === null || raw === undefined ? null : (String(raw) as LayerId);
        requirePart(doc(), childId);
        if (parentId) requirePart(doc(), parentId);
        const at = frame();
        edit((current) => attachTo(current, [childId], parentId, at));
        return describe(childId);
      },
    },
    {
      name: "setJoint",
      description: "Put a part's joint at a point on the page.",
      inputSchema: schema({ id: ID, x: NUMBER, y: NUMBER }, ["id", "x", "y"]),
      execute: (input) => {
        const id = needId(input);
        requirePart(doc(), id);
        const x = needNum(input, "x");
        const y = needNum(input, "y");
        const at = frame();
        edit((current) => setJointAt(current, id, x, y, at));
        return describe(id);
      },
    },
    {
      name: "setTransform",
      description:
        "Move, turn, scale, slant or restack a part. Animated properties get a key at the playhead.",
      inputSchema: schema(
        {
          id: ID,
          x: NUMBER,
          y: NUMBER,
          rotation: NUMBER,
          scaleX: NUMBER,
          scaleY: NUMBER,
          skewX: NUMBER,
          skewY: NUMBER,
          depth: NUMBER,
        },
        ["id"],
      ),
      execute: (input) => {
        const id = needId(input);
        requirePart(doc(), id);
        const at = frame();
        const writes: [string, number][] = [];
        for (const key of [
          "x",
          "y",
          "rotation",
          "scaleX",
          "scaleY",
          "skewX",
          "skewY",
        ]) {
          const value = num(input, key);
          if (value !== undefined) writes.push([`transform.${key}`, value]);
        }
        // Depth is not part of the transform, but it is set the same way and
        // splitting it into its own tool would only make a caller look twice.
        const depth = num(input, "depth");
        if (depth !== undefined) writes.push(["depth", depth]);
        if (writes.length === 0) {
          throw new Error("Give at least one number to set.");
        }
        edit((current) => {
          let out = current;
          for (const [path, value] of writes) {
            out = writeNumber(out, id, path, value, at);
          }
          return out;
        });
        return describe(id);
      },
    },
    {
      name: "setOverlap",
      description:
        "Tuck a part under the one it is attached to, from 0 to 3, so the join does not show.",
      inputSchema: schema({ id: ID, overlap: NUMBER }, ["id", "overlap"]),
      execute: (input) => {
        const id = needId(input);
        requirePart(doc(), id);
        const overlap = Math.min(
          3,
          Math.max(0, Math.round(needNum(input, "overlap"))),
        );
        edit((current) => patchLayer(current, id, { overlap }));
        return describe(id);
      },
    },
    {
      name: "addVariant",
      description:
        "Give a part another drawing, copied from what it is showing or from other parts.",
      inputSchema: schema({ id: ID, name: STRING, fromIds: IDS }, [
        "id",
        "name",
      ]),
      execute: (input) => {
        const id = needId(input);
        const name = needStr(input, "name");
        const from = idList(input, "fromIds");
        const at = frame();
        edit((current) => {
          const layer = requirePart(current, id);
          const shown = requireVariant(current, layer, at);
          const contours =
            from && from.length > 0
              ? from.flatMap((other) =>
                  mapContours(
                    contoursOf(current, other, at),
                    betweenParts(current, id, other, at),
                  ),
                )
              : contoursOf(current, id, at);
          const geometry = contoursToGeometry(contours);
          return {
            ...current,
            paths: { ...current.paths, [geometry.id]: geometry },
            layers: {
              ...current.layers,
              [id]: {
                ...layer,
                variants: [
                  ...layer.variants,
                  newVariant({
                    name,
                    pathIds: [geometry.id],
                    fill: shown.fill,
                    fillRule: shown.fillRule,
                    stroke: shown.stroke,
                    strokeWidth: shown.strokeWidth,
                  }),
                ],
              },
            },
          };
        });
        return describe(id);
      },
    },
    {
      name: "setVariant",
      description:
        "Show one of a part's drawings by name. Keys it at the playhead when it is animated.",
      inputSchema: schema({ id: ID, name: STRING }, ["id", "name"]),
      execute: (input) => {
        const id = needId(input);
        const name = needStr(input, "name");
        const layer = requirePart(doc(), id);
        const index = layer.variants.findIndex(
          (variant) => variant.name === name,
        );
        if (index < 0) {
          throw new Error(`"${layer.name}" has no drawing called "${name}".`);
        }
        const at = frame();
        edit((current) => writeNumber(current, id, "variant", index, at));
        return describe(id);
      },
    },
    {
      name: "mirror",
      description:
        "Make the other side of a part, flipped, and select the copy.",
      inputSchema: schema({ id: ID }, ["id"]),
      execute: (input) => {
        const id = needId(input);
        requirePart(doc(), id);
        const at = frame();
        let created: LayerId[] = [];
        edit((current) => {
          const result = duplicateParts(current, [id], {
            frame: at,
            mirrorAxis: mirrorAxisFor(current, id),
          });
          created = result.created;
          return result.doc;
        });
        store.select(created);
        return { ids: created };
      },
    },
    {
      name: "group",
      description:
        "Attach several parts to one new joint, so turning it swings the whole cluster.",
      inputSchema: schema({ ids: IDS }, ["ids"]),
      execute: (input) => {
        const ids = needIds(input);
        for (const id of ids) requirePart(doc(), id);
        const at = frame();
        let groupId: LayerId | null = null;
        edit((current) => {
          const result = groupParts(current, ids, at);
          groupId = result.groupId;
          return result.doc;
        });
        if (groupId) store.select([groupId]);
        return { id: groupId };
      },
    },
    {
      name: "reorder",
      description:
        "Move a part in the draw order. Index 0 is the very back of the stack.",
      inputSchema: schema({ id: ID, index: NUMBER }, ["id", "index"]),
      execute: (input) => {
        const id = needId(input);
        requirePart(doc(), id);
        const index = Math.round(needNum(input, "index"));
        edit((current) => reorderTo(current, [id], index));
        return { order: activeArtboard(doc())?.layerIds ?? [] };
      },
    },
    {
      name: "setPlayhead",
      description: "Move the playhead to a frame.",
      inputSchema: schema({ frame: NUMBER }, ["frame"]),
      execute: (input) => {
        store.setFrame(needNum(input, "frame"));
        return { frame: frame() };
      },
    },
    {
      name: "key",
      description:
        "Remember how parts look at the playhead. Defaults to the selected parts.",
      inputSchema: schema({
        ids: IDS,
        props: {
          type: "array",
          items: STRING,
          description: `One or more of ${ANIMATABLE.join(", ")}.`,
        },
      }),
      execute: (input) => {
        const asked = idList(input, "ids");
        const ids =
          asked && asked.length > 0 ? asked : [...ui().selection.layerIds];
        if (ids.length === 0) {
          throw new Error("Select a part first, or pass ids.");
        }
        const props = idList(input, "props") as string[] | null;
        if (props) {
          for (const path of props) {
            if (!(ANIMATABLE as readonly string[]).includes(path)) {
              throw new Error(`"${path}" is not something a part can animate.`);
            }
          }
        }
        const at = frame();
        edit((current) => {
          let out = current;
          for (const id of ids) out = keyPart(out, id, props, at);
          return out;
        });
        return { keyed: ids, frame: at };
      },
    },
    {
      name: "keyAll",
      description: "Remember how every part looks at the playhead.",
      inputSchema: schema({}),
      execute: () => {
        const ids = (activeArtboard(doc())?.layerIds ?? []).slice();
        const at = frame();
        edit((current) => {
          let out = current;
          for (const id of ids) out = keyPart(out, id, null, at);
          return out;
        });
        return { keyed: ids.length, frame: at };
      },
    },
    {
      name: "play",
      description: "Start playing.",
      inputSchema: schema({}),
      execute: () => {
        store.setUi({ playing: true });
        return { playing: true };
      },
    },
    {
      name: "pause",
      description: "Stop playing.",
      inputSchema: schema({}),
      execute: () => {
        store.setUi({ playing: false });
        return { playing: false };
      },
    },
    {
      name: "exportJson",
      description: "Return the whole rig as a project file.",
      inputSchema: schema({}),
      execute: () => projectToJson(doc()),
    },
    {
      name: "importJson",
      description:
        "Open a rig from a project file. Also reads a file from the rig prototype.",
      inputSchema: schema({ json: STRING }, ["json"]),
      execute: (input) => {
        const text = needStr(input, "json");
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error("That is not a rig file. It is not even valid JSON.");
        }
        const next = isLegacyStudioFile(parsed)
          ? importLegacyStudio(parsed).doc
          : deserializeProject(parsed);
        edit(() => next);
        store.select([]);
        store.requestFit();
        return { layers: listLayers().length };
      },
    },
    {
      name: "exportPlayerHtml",
      description:
        "Return a single HTML file that plays the rig with no editor and no libraries.",
      inputSchema: schema({}),
      execute: () => exportPlayerHtml(doc()),
    },
    {
      name: "undo",
      description: "Undo the last change.",
      inputSchema: schema({}),
      execute: () => {
        store.undo();
        return { canUndo: store.canUndo };
      },
    },
    {
      name: "redo",
      description: "Redo the change that was just undone.",
      inputSchema: schema({}),
      execute: () => {
        store.redo();
        return { canRedo: store.canRedo };
      },
    },
    {
      name: "state",
      description: "Report what the editor is showing right now.",
      inputSchema: schema({}),
      execute: () => {
        const current = doc();
        const artboard = activeArtboard(current);
        const view = ui();
        return {
          name: current.name,
          fps: current.fps,
          frameCount: current.frameCount,
          loopIn: current.loopIn,
          loopOut: current.loopOut,
          artboard: {
            width: artboard?.width ?? 0,
            height: artboard?.height ?? 0,
          },
          layerCount: artboard?.layerIds.length ?? 0,
          ui: {
            tool: view.tool,
            selection: [...view.selection.layerIds],
            frame: view.frame,
            playing: view.playing,
            viewport: { ...view.viewport },
          },
        };
      },
    },
    {
      name: "screenshotHints",
      description:
        "Where every part is on screen, in page pixels, so a click can be aimed at one.",
      inputSchema: schema({}),
      execute: () => {
        const current = doc();
        const view = ui();
        const scene = resolveScene(current, view.frame);
        const artboard = activeArtboard(current);
        const rect = (box: readonly [number, number, number, number]) => ({
          x: box[0] * view.viewport.scale + view.viewport.x,
          y: box[1] * view.viewport.scale + view.viewport.y,
          width: (box[2] - box[0]) * view.viewport.scale,
          height: (box[3] - box[1]) * view.viewport.scale,
        });
        return {
          layers: scene.items.map((item) => ({
            id: item.layerId,
            name: current.layers[item.layerId]?.name ?? "",
            rect: rect(item.bounds),
          })),
          artboard: rect([0, 0, artboard?.width ?? 0, artboard?.height ?? 0]),
        };
      },
    },
  ];
}

/** The tools as a name-to-function map, which is what a console wants. */
export function toolMap(
  tools: readonly AgentTool[],
): Record<string, (input?: Record<string, unknown>) => unknown> {
  const map: Record<string, (input?: Record<string, unknown>) => unknown> = {};
  for (const tool of tools) {
    map[tool.name] = (input?: Record<string, unknown>) =>
      tool.execute(input ?? {});
  }
  return map;
}

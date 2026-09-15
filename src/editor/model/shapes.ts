/**
 * Geometry the drawing tools produce.
 *
 * Rectangles and ellipses are emitted as real bezier paths rather than as
 * parametric primitives, because in a rig every shape is eventually dragged out
 * of square by hand, and a primitive that has to be "converted to a path" before
 * it can be edited is a dead end the user has to learn about.
 */

import { newId, type PathGeometry, type PathId } from "./document";
import { type Contour, contoursToGeometry, smoothSamples } from "./polyline";

/** Kappa: the control-point ratio that makes four cubics into a circle. */
const KAPPA = 0.5522847498307936;

export function rectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  id: PathId = newId("Path"),
): PathGeometry {
  const x0 = Math.min(x, x + width);
  const y0 = Math.min(y, y + height);
  const x1 = Math.max(x, x + width);
  const y1 = Math.max(y, y + height);
  const contour: Contour = {
    points: [x0, y0, x1, y0, x1, y1, x0, y1],
    closed: true,
  };
  return contoursToGeometry([contour], id);
}

export function ellipsePath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  id: PathId = newId("Path"),
): PathGeometry {
  const ox = Math.abs(rx) * KAPPA;
  const oy = Math.abs(ry) * KAPPA;
  const ax = Math.abs(rx);
  const ay = Math.abs(ry);

  const vertices = new Float64Array([
    cx,
    cy - ay,
    cx + ax,
    cy,
    cx,
    cy + ay,
    cx - ax,
    cy,
  ]);
  const tangentsOut = new Float64Array([ox, 0, 0, oy, -ox, 0, 0, -oy]);
  const tangentsIn = new Float64Array([-ox, 0, 0, -oy, ox, 0, 0, oy]);

  const geo: PathGeometry = {
    id,
    d: "",
    vertices,
    tangentsIn,
    tangentsOut,
    subpathStarts: new Uint32Array([0]),
    subpathClosed: new Uint8Array([1]),
    bounds: [cx - ax, cy - ay, cx + ax, cy + ay],
  };
  return { ...geo, d: cubicPathData(geo) };
}

/**
 * Serialise geometry back to path data.
 *
 * Kept here rather than in `polyline` because it is the only writer that has to
 * emit curves; everything the polyline module produces is straight segments and
 * has its own cheaper writer.
 */
export function cubicPathData(geo: PathGeometry, precision = 2): string {
  const f = (v: number) => {
    const r = Number(v.toFixed(precision));
    return Object.is(r, -0) ? "0" : String(r);
  };
  const { vertices, tangentsIn, tangentsOut, subpathStarts, subpathClosed } =
    geo;
  const total = vertices.length / 2;
  const out: string[] = [];

  for (let s = 0; s < subpathStarts.length; s++) {
    const start = subpathStarts[s];
    const end = s + 1 < subpathStarts.length ? subpathStarts[s + 1] : total;
    const count = end - start;
    if (count <= 0) continue;
    const closed = subpathClosed[s] === 1;
    out.push(`M${f(vertices[start * 2])} ${f(vertices[start * 2 + 1])}`);

    const segments = closed ? count : count - 1;
    for (let k = 0; k < segments; k++) {
      const a = start + k;
      const b = start + ((k + 1) % count);
      const o1x = tangentsOut[a * 2];
      const o1y = tangentsOut[a * 2 + 1];
      const i2x = tangentsIn[b * 2];
      const i2y = tangentsIn[b * 2 + 1];
      const bx = vertices[b * 2];
      const by = vertices[b * 2 + 1];
      if (o1x === 0 && o1y === 0 && i2x === 0 && i2y === 0) {
        out.push(`L${f(bx)} ${f(by)}`);
      } else {
        out.push(
          `C${f(vertices[a * 2] + o1x)} ${f(vertices[a * 2 + 1] + o1y)} ` +
            `${f(bx + i2x)} ${f(by + i2y)} ${f(bx)} ${f(by)}`,
        );
      }
    }
    if (closed) out.push("Z");
  }
  return out.join("");
}

function totalTravel(samples: readonly BrushSample[]): number {
  let sum = 0;
  for (let i = 1; i < samples.length; i++) {
    sum += Math.hypot(
      samples[i].x - samples[i - 1].x,
      samples[i].y - samples[i - 1].y,
    );
  }
  return sum;
}

/** One raw pointer sample from the brush. */
export interface BrushSample {
  x: number;
  y: number;
  /** Pen pressure in [0,1]. Mice report 0.5. */
  pressure: number;
}

/**
 * How near the last sample must land to the first for the stroke to close.
 *
 * In screen pixels, converted by the caller. Generous, because freehand is
 * freehand: a tolerance tight enough to feel precise is a tolerance that
 * silently hands back an outline when someone meant to draw a body part.
 */
export const BRUSH_CLOSE_DISTANCE = 30;

export interface BrushResult {
  geometry: PathGeometry;
  closed: boolean;
}

/** Below this much travel a stroke is a click, not a drag. Document units. */
const DOT_TRAVEL = 3;

/**
 * Turn a pointer trail into one marker stroke.
 *
 * A stroke whose end lands near its start closes and becomes a fillable shape;
 * anything else stays an open ink line. That single rule is the whole interaction
 * model for the brush: there is no mode to pick and no checkbox to find.
 */
export function brushStroke(
  samples: readonly BrushSample[],
  options: { closeDistance?: number; dotRadius?: number } = {},
): BrushResult | null {
  if (samples.length === 0) return null;

  // A click is a dot. Doing nothing at all is how a drawing tool convinces
  // someone it is broken, and a dot is both what they asked for and something
  // they can immediately undo.
  const travelled = totalTravel(samples);
  if (samples.length < 2 || travelled < DOT_TRAVEL) {
    const radius = Math.max(1, options.dotRadius ?? 6);
    return {
      geometry: ellipsePath(samples[0].x, samples[0].y, radius, radius),
      closed: true,
    };
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = Math.hypot(last.x - first.x, last.y - first.y);
  const closed =
    samples.length > 8 &&
    span <= (options.closeDistance ?? BRUSH_CLOSE_DISTANCE);

  const rawPoints: number[] = [];
  const rawPressure: number[] = [];
  for (const sample of samples) {
    rawPoints.push(sample.x, sample.y);
    rawPressure.push(Math.min(1, Math.max(0, sample.pressure)));
  }

  const smoothed = smoothSamples(rawPoints, rawPressure, closed);
  return {
    geometry: contoursToGeometry([
      { points: smoothed.points, pressure: smoothed.pressure, closed },
    ]),
    closed,
  };
}

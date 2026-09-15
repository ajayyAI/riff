/**
 * SVG path data parsing.
 *
 * This exists because every off-the-shelf converter surveyed gets the same three
 * things wrong, and traced artwork trips all three on the first file:
 *
 * 1. **Polycommands.** `L 10 10 20 20` is two line segments, and `c` with twelve
 *    numbers is two curves. Parsers that read one argument tuple per command
 *    silently drop the rest. Optimised path data is full of these.
 *
 * 2. **Subpaths.** A traced shape has holes, a fist against an arm, the inside
 *    of an `o`, expressed as extra `M...Z` runs in one `d`. Flattening them into
 *    a single contour connects the hole to the outline and the fill goes wrong.
 *
 * 3. **Arcs and shorthand.** `A`, `S`, `T` dropped without updating the current
 *    point, so every following relative command is displaced. This is the worst
 *    failure mode of the three because the output still looks like a shape.
 *
 * Tangents are stored *relative to their vertex*, matching Lottie's convention,
 * so export is a transcription rather than a conversion.
 */

import { newId, type PathGeometry, type PathId } from "./document";

// Argument count per command, used to drive implicit repetition.
const ARITY: Record<string, number> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
  z: 0,
};

interface RawSegment {
  cmd: string;
  args: number[];
}

/**
 * Tokenise path data into absolute-arity segments, expanding polycommands.
 *
 * Handles the full grammar's punctuation: numbers may be separated by commas,
 * whitespace, or nothing at all when the sign or decimal point disambiguates
 * (`10-5` is two numbers, and so is `.5.5`).
 */
export function tokenizePath(d: string): RawSegment[] {
  const out: RawSegment[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/g;
  let match: RegExpExecArray | null;
  let cmd = "";
  let args: number[] = [];

  const flush = () => {
    if (!cmd) return;
    const key = cmd.toLowerCase();
    const arity = ARITY[key];
    if (arity === 0) {
      out.push({ cmd, args: [] });
      args = [];
      return;
    }
    if (args.length < arity) {
      args = [];
      return; // Malformed tail; drop rather than emit a partial segment.
    }
    for (let i = 0; i + arity <= args.length; i += arity) {
      // An implicit repeat of `M` is an `L` (and `m` implies `l`) -- this is in
      // the spec and is the single most commonly missed rule in the grammar.
      let c = cmd;
      if (i > 0 && key === "m") c = cmd === "M" ? "L" : "l";
      out.push({ cmd: c, args: args.slice(i, i + arity) });
    }
    args = [];
  };

  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex scan
  while ((match = re.exec(d)) !== null) {
    if (match[1]) {
      flush();
      cmd = match[1];
      if (ARITY[cmd.toLowerCase()] === 0) flush();
    } else {
      args.push(Number.parseFloat(match[2]));
    }
  }
  flush();
  return out;
}

/**
 * Convert an elliptical arc to cubic segments.
 *
 * Follows the SVG implementation notes (F.6.5). Returns a flat list of
 * [x1,y1,x2,y2,x,y] control/end triples in absolute coordinates.
 */
function arcToCubics(
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  angleDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x: number,
  y: number,
): number[] {
  // Degenerate radii mean a straight line, per the spec.
  if (rxIn === 0 || ryIn === 0) return [x, y, x, y, x, y];
  if (x0 === x && y0 === y) return [];

  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  const phi = (angleDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // Scale up radii that are too small to span the endpoints (F.6.6).
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));

  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };

  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  // A cubic approximates at most a quarter turn well.
  const count = Math.max(1, Math.ceil(Math.abs(dTheta / (Math.PI / 2))));
  const delta = dTheta / count;
  const t = (4 / 3) * Math.tan(delta / 4);

  const out: number[] = [];
  let th = theta1;
  let px = x0;
  let py = y0;
  for (let i = 0; i < count; i++) {
    const th2 = th + delta;
    const cosT1 = Math.cos(th);
    const sinT1 = Math.sin(th);
    const cosT2 = Math.cos(th2);
    const sinT2 = Math.sin(th2);

    const e2x = cosPhi * rx * cosT2 - sinPhi * ry * sinT2 + cx;
    const e2y = sinPhi * rx * cosT2 + cosPhi * ry * sinT2 + cy;
    const d1x = -rx * cosPhi * sinT1 - ry * sinPhi * cosT1;
    const d1y = -rx * sinPhi * sinT1 + ry * cosPhi * cosT1;
    const d2x = -rx * cosPhi * sinT2 - ry * sinPhi * cosT2;
    const d2y = -rx * sinPhi * sinT2 + ry * cosPhi * cosT2;

    out.push(
      px + t * d1x,
      py + t * d1y,
      e2x - t * d2x,
      e2y - t * d2y,
      e2x,
      e2y,
    );
    px = e2x;
    py = e2y;
    th = th2;
  }
  return out;
}

interface Builder {
  vx: number[];
  vy: number[];
  ix: number[];
  iy: number[];
  ox: number[];
  oy: number[];
  starts: number[];
  closed: number[];
}

/**
 * Parse path data into riff's geometry form.
 *
 * The tangent convention is the one detail worth stating twice: a curve's first
 * control point becomes the *out* tangent of the vertex already emitted, and its
 * second becomes the *in* tangent of the vertex being emitted. Both are stored
 * as deltas from their own vertex.
 */
export function parsePathData(d: string): Omit<PathGeometry, "id" | "d"> {
  const b: Builder = {
    vx: [],
    vy: [],
    ix: [],
    iy: [],
    ox: [],
    oy: [],
    starts: [],
    closed: [],
  };

  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // Reflection state for S/T shorthand.
  let lastCubicCtrlX = 0;
  let lastCubicCtrlY = 0;
  let lastQuadCtrlX = 0;
  let lastQuadCtrlY = 0;
  let prevWasCubic = false;
  let prevWasQuad = false;
  let open = false;

  const vertex = (px: number, py: number) => {
    b.vx.push(px);
    b.vy.push(py);
    b.ix.push(0);
    b.iy.push(0);
    b.ox.push(0);
    b.oy.push(0);
  };

  const beginSubpath = (px: number, py: number) => {
    b.starts.push(b.vx.length);
    b.closed.push(0);
    vertex(px, py);
    open = true;
  };

  /** Emit a cubic ending at (ex,ey) with absolute control points. */
  const cubic = (
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    ex: number,
    ey: number,
  ) => {
    if (!open) beginSubpath(x, y);
    const prev = b.vx.length - 1;
    b.ox[prev] = c1x - b.vx[prev];
    b.oy[prev] = c1y - b.vy[prev];
    vertex(ex, ey);
    const cur = b.vx.length - 1;
    b.ix[cur] = c2x - ex;
    b.iy[cur] = c2y - ey;
  };

  const line = (ex: number, ey: number) => {
    if (!open) beginSubpath(x, y);
    vertex(ex, ey);
  };

  for (const { cmd, args } of tokenizePath(d)) {
    const rel = cmd === cmd.toLowerCase();
    const key = cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    const wasCubic = prevWasCubic;
    const wasQuad = prevWasQuad;
    prevWasCubic = false;
    prevWasQuad = false;

    switch (key) {
      case "m": {
        x = args[0] + ox;
        y = args[1] + oy;
        startX = x;
        startY = y;
        beginSubpath(x, y);
        break;
      }
      case "l": {
        x = args[0] + ox;
        y = args[1] + oy;
        line(x, y);
        break;
      }
      case "h": {
        x = args[0] + ox;
        line(x, y);
        break;
      }
      case "v": {
        y = args[0] + oy;
        line(x, y);
        break;
      }
      case "c": {
        const c1x = args[0] + ox;
        const c1y = args[1] + oy;
        const c2x = args[2] + ox;
        const c2y = args[3] + oy;
        const ex = args[4] + ox;
        const ey = args[5] + oy;
        cubic(c1x, c1y, c2x, c2y, ex, ey);
        lastCubicCtrlX = c2x;
        lastCubicCtrlY = c2y;
        x = ex;
        y = ey;
        prevWasCubic = true;
        break;
      }
      case "s": {
        // First control point mirrors the previous curve's second, about the
        // current point -- but only if the previous command was a cubic.
        const c1x = wasCubic ? 2 * x - lastCubicCtrlX : x;
        const c1y = wasCubic ? 2 * y - lastCubicCtrlY : y;
        const c2x = args[0] + ox;
        const c2y = args[1] + oy;
        const ex = args[2] + ox;
        const ey = args[3] + oy;
        cubic(c1x, c1y, c2x, c2y, ex, ey);
        lastCubicCtrlX = c2x;
        lastCubicCtrlY = c2y;
        x = ex;
        y = ey;
        prevWasCubic = true;
        break;
      }
      case "q": {
        const qx = args[0] + ox;
        const qy = args[1] + oy;
        const ex = args[2] + ox;
        const ey = args[3] + oy;
        // Degree-elevate quadratic to cubic: controls at 1/3 and 2/3.
        cubic(
          x + (2 / 3) * (qx - x),
          y + (2 / 3) * (qy - y),
          ex + (2 / 3) * (qx - ex),
          ey + (2 / 3) * (qy - ey),
          ex,
          ey,
        );
        lastQuadCtrlX = qx;
        lastQuadCtrlY = qy;
        x = ex;
        y = ey;
        prevWasQuad = true;
        break;
      }
      case "t": {
        const qx = wasQuad ? 2 * x - lastQuadCtrlX : x;
        const qy = wasQuad ? 2 * y - lastQuadCtrlY : y;
        const ex = args[0] + ox;
        const ey = args[1] + oy;
        cubic(
          x + (2 / 3) * (qx - x),
          y + (2 / 3) * (qy - y),
          ex + (2 / 3) * (qx - ex),
          ey + (2 / 3) * (qy - ey),
          ex,
          ey,
        );
        lastQuadCtrlX = qx;
        lastQuadCtrlY = qy;
        x = ex;
        y = ey;
        prevWasQuad = true;
        break;
      }
      case "a": {
        const ex = args[5] + ox;
        const ey = args[6] + oy;
        const cubics = arcToCubics(
          x,
          y,
          args[0],
          args[1],
          args[2],
          args[3] !== 0,
          args[4] !== 0,
          ex,
          ey,
        );
        for (let i = 0; i + 5 < cubics.length; i += 6) {
          cubic(
            cubics[i],
            cubics[i + 1],
            cubics[i + 2],
            cubics[i + 3],
            cubics[i + 4],
            cubics[i + 5],
          );
        }
        x = ex;
        y = ey;
        break;
      }
      case "z": {
        if (open) {
          const s = b.starts[b.starts.length - 1];
          b.closed[b.closed.length - 1] = 1;
          // Drop a duplicated closing vertex; the closed flag already implies
          // the segment back to the start.
          const last = b.vx.length - 1;
          if (last > s && b.vx[last] === b.vx[s] && b.vy[last] === b.vy[s]) {
            b.ix[s] = b.ix[last];
            b.iy[s] = b.iy[last];
            b.vx.pop();
            b.vy.pop();
            b.ix.pop();
            b.iy.pop();
            b.ox.pop();
            b.oy.pop();
          }
          open = false;
        }
        x = startX;
        y = startY;
        break;
      }
    }
  }

  const n = b.vx.length;
  const vertices = new Float64Array(n * 2);
  const tangentsIn = new Float64Array(n * 2);
  const tangentsOut = new Float64Array(n * 2);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < n; i++) {
    vertices[i * 2] = b.vx[i];
    vertices[i * 2 + 1] = b.vy[i];
    tangentsIn[i * 2] = b.ix[i];
    tangentsIn[i * 2 + 1] = b.iy[i];
    tangentsOut[i * 2] = b.ox[i];
    tangentsOut[i * 2 + 1] = b.oy[i];
    if (b.vx[i] < minX) minX = b.vx[i];
    if (b.vx[i] > maxX) maxX = b.vx[i];
    if (b.vy[i] < minY) minY = b.vy[i];
    if (b.vy[i] > maxY) maxY = b.vy[i];
  }

  // Control points can push the drawn shape outside the vertex hull. Including
  // them keeps the bounds conservative, which is what a hit-test reject needs.
  for (let i = 0; i < n; i++) {
    const cx1 = vertices[i * 2] + tangentsOut[i * 2];
    const cy1 = vertices[i * 2 + 1] + tangentsOut[i * 2 + 1];
    const cx2 = vertices[i * 2] + tangentsIn[i * 2];
    const cy2 = vertices[i * 2 + 1] + tangentsIn[i * 2 + 1];
    minX = Math.min(minX, cx1, cx2);
    maxX = Math.max(maxX, cx1, cx2);
    minY = Math.min(minY, cy1, cy2);
    maxY = Math.max(maxY, cy1, cy2);
  }

  return {
    vertices,
    tangentsIn,
    tangentsOut,
    subpathStarts: new Uint32Array(b.starts),
    subpathClosed: new Uint8Array(b.closed),
    bounds: n ? [minX, minY, maxX, maxY] : [0, 0, 0, 0],
  };
}

export function makePath(d: string, id: PathId = newId("Path")): PathGeometry {
  return { id, d, ...parsePathData(d) };
}

/** Serialise geometry back to path data, at a given decimal precision. */
export function toPathData(geo: PathGeometry, precision = 1): string {
  const f = (v: number) => {
    const r = Number(v.toFixed(precision));
    return Object.is(r, -0) ? "0" : String(r);
  };
  const { vertices, tangentsIn, tangentsOut, subpathStarts, subpathClosed } =
    geo;
  const count = vertices.length / 2;
  const out: string[] = [];

  for (let s = 0; s < subpathStarts.length; s++) {
    const start = subpathStarts[s];
    const end = s + 1 < subpathStarts.length ? subpathStarts[s + 1] : count;
    if (end <= start) continue;
    const closed = subpathClosed[s] === 1;

    out.push(`M${f(vertices[start * 2])} ${f(vertices[start * 2 + 1])}`);

    const segCount = closed ? end - start : end - start - 1;
    for (let k = 0; k < segCount; k++) {
      const a = start + k;
      const bIdx = start + ((k + 1) % (end - start));
      const o1x = tangentsOut[a * 2];
      const o1y = tangentsOut[a * 2 + 1];
      const i2x = tangentsIn[bIdx * 2];
      const i2y = tangentsIn[bIdx * 2 + 1];
      const bx = vertices[bIdx * 2];
      const by = vertices[bIdx * 2 + 1];

      // A segment with no tangents is a straight line; emitting it as a cubic
      // costs four numbers and buys nothing.
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

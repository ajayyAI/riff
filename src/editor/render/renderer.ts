/**
 * Canvas2D rig renderer.
 *
 * Three things make this fast enough to scrub a rig in real time:
 *
 * - `Path2D` is built from each path's own `d` string and cached by path id.
 *   The browser parses that in native code once; after that, drawing a part is
 *   a `fill()` against pre-parsed geometry. Paths are immutable in the document
 *   model (editing mints a new id) so a cache entry can never go stale.
 *
 * - Marker strokes are bucketed by pressure at cache time, so a 900-sample
 *   variable-width stroke costs eight `stroke()` calls rather than 900.
 *
 * - Overlays live on a *separate* canvas. Selection handles change on every
 *   pointer move; artwork does not.
 *
 * The pressure bucketing and the overlap pass are ported from the single-file
 * prototype riff grew out of.
 */

import {
  type PathGeometry,
  type PathId,
  type RGBA,
  rgbaToCss,
} from "../model/document";
import type { Viewport } from "../store";
import type { DrawItem, ResolvedScene } from "./scene";
import { rectsIntersect, visibleRect } from "./viewport";

/** Pressure is quantised so a stroke draws in at most this many calls. */
const PRESSURE_BUCKETS = 8;

interface CachedPath {
  path: Path2D;
  /** One Path2D per pressure bucket, or null for a path drawn at one weight. */
  buckets: (Path2D | null)[] | null;
}

export class PathCache {
  private map = new Map<PathId, CachedPath>();

  constructor(private limit = 20000) {}

  get(geometry: PathGeometry): CachedPath {
    const hit = this.map.get(geometry.id);
    if (hit) return hit;
    const entry: CachedPath = {
      path: new Path2D(geometry.d),
      buckets: buildPressureBuckets(geometry),
    };
    if (this.map.size >= this.limit) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(geometry.id, entry);
    return entry;
  }

  clear() {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Group a marker stroke's segments by pen pressure.
 *
 * Returns null for anything with no pressure data, which is every path the pen,
 * rectangle and ellipse tools produce.
 */
function buildPressureBuckets(
  geometry: PathGeometry,
): (Path2D | null)[] | null {
  const { pressure, vertices, subpathStarts, subpathClosed } = geometry;
  if (!pressure || pressure.length < 2) return null;

  const buckets: (Path2D | null)[] = new Array(PRESSURE_BUCKETS).fill(null);
  const total = vertices.length / 2;

  for (let s = 0; s < subpathStarts.length; s++) {
    const start = subpathStarts[s];
    const end = s + 1 < subpathStarts.length ? subpathStarts[s + 1] : total;
    const count = end - start;
    if (count < 2) continue;
    const segments = subpathClosed[s] === 1 ? count : count - 1;
    for (let k = 0; k < segments; k++) {
      const a = start + k;
      const b = start + ((k + 1) % count);
      const mean = (pressure[a] + pressure[b]) / 2;
      const index = Math.min(
        PRESSURE_BUCKETS - 1,
        Math.max(0, Math.floor(mean * PRESSURE_BUCKETS)),
      );
      let bucket = buckets[index];
      if (!bucket) {
        bucket = new Path2D();
        buckets[index] = bucket;
      }
      bucket.moveTo(vertices[a * 2], vertices[a * 2 + 1]);
      bucket.lineTo(vertices[b * 2], vertices[b * 2 + 1]);
    }
  }
  return buckets;
}

/** Stroke weight for a pressure bucket: 70% to 130% of the nominal width. */
export function bucketWidth(nominal: number, index: number): number {
  return nominal * (0.7 + (0.6 * (index + 0.5)) / PRESSURE_BUCKETS);
}

export interface RenderOptions {
  viewport: Viewport;
  width: number;
  height: number;
  dpr: number;
  /** Draw the transparency checkerboard behind the artboard. */
  checkerboard?: boolean;
  /** Clear the canvas first. False when this pass draws on top of another. */
  clear?: boolean;
  /** Paint the page. False for the passes that follow the first. */
  background?: boolean;
  /** Multiplies every part's opacity. What makes a ghost pose a ghost. */
  alpha?: number;
  /** Parts to fade, keyed by id. Used for the onion skin while drawing. */
  dim?: ReadonlySet<string>;
}

const CHECKER_SIZE = 8;
let checkerPattern: CanvasPattern | null = null;

function getChecker(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (checkerPattern) return checkerPattern;
  const tile = document.createElement("canvas");
  tile.width = CHECKER_SIZE * 2;
  tile.height = CHECKER_SIZE * 2;
  const tctx = tile.getContext("2d");
  if (!tctx) return null;
  tctx.fillStyle = "#ffffff";
  tctx.fillRect(0, 0, tile.width, tile.height);
  tctx.fillStyle = "#eceef2";
  tctx.fillRect(0, 0, CHECKER_SIZE, CHECKER_SIZE);
  tctx.fillRect(CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE);
  checkerPattern = ctx.createPattern(tile, "repeat");
  return checkerPattern;
}

function setItemTransform(
  ctx: CanvasRenderingContext2D,
  item: DrawItem,
  viewport: Viewport,
  dpr: number,
) {
  const m = item.matrix;
  ctx.setTransform(
    m.a * viewport.scale * dpr,
    m.b * viewport.scale * dpr,
    m.c * viewport.scale * dpr,
    m.d * viewport.scale * dpr,
    (m.e * viewport.scale + viewport.x) * dpr,
    (m.f * viewport.scale + viewport.y) * dpr,
  );
}

/** Fill, then the part's own outline, then the marker strokes if it has them. */
function paintItem(
  ctx: CanvasRenderingContext2D,
  item: DrawItem,
  cache: PathCache,
  fillOnly: boolean,
) {
  for (const geometry of item.paths) {
    const cached = cache.get(geometry);
    if (item.fill) {
      ctx.fillStyle = rgbaToCss(item.fill);
      ctx.fill(cached.path, item.fillRule);
    }
    if (fillOnly) continue;
    if (!item.stroke || item.strokeWidth <= 0) continue;
    ctx.strokeStyle = rgbaToCss(item.stroke);
    if (cached.buckets) {
      for (let i = 0; i < cached.buckets.length; i++) {
        const bucket = cached.buckets[i];
        if (!bucket) continue;
        ctx.lineWidth = bucketWidth(item.strokeWidth, i);
        ctx.stroke(bucket);
      }
    } else {
      ctx.lineWidth = item.strokeWidth;
      ctx.stroke(cached.path);
    }
  }
}

/** Paint one frame of the rig. */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  scene: ResolvedScene,
  cache: PathCache,
  opts: RenderOptions,
): { drawn: number; culled: number } {
  const { viewport, width, height, dpr } = opts;

  const alpha = opts.alpha ?? 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (opts.clear !== false) ctx.clearRect(0, 0, width, height);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const { artboard } = scene;
  if (!artboard) return { drawn: 0, culled: 0 };

  const bgX = viewport.x * dpr;
  const bgY = viewport.y * dpr;
  const bgW = artboard.width * viewport.scale * dpr;
  const bgH = artboard.height * viewport.scale * dpr;

  ctx.setTransform(1, 0, 0, 1, 0, 0);

  if (opts.background !== false) {
    // The page as a card. The panels are glass and the artwork runs under them,
    // so without a lifted edge there is no way to tell where the page stops and
    // a part drawn off it looks the same as one drawn on it.
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.18)";
    ctx.shadowBlur = 24 * dpr;
    ctx.shadowOffsetY = 6 * dpr;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(bgX, bgY, bgW, bgH);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(bgX, bgY, bgW, bgH);
    ctx.clip();
    if (artboard.background) {
      ctx.fillStyle = rgbaToCss(artboard.background);
      ctx.fillRect(bgX, bgY, bgW, bgH);
    } else if (opts.checkerboard !== false) {
      const pattern = getChecker(ctx);
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(bgX, bgY, bgW, bgH);
      }
    }
    ctx.restore();
  }

  ctx.save();
  if (artboard.clip) {
    ctx.beginPath();
    ctx.rect(bgX, bgY, bgW, bgH);
    ctx.clip();
  }

  const view = visibleRect(viewport, { width, height });
  const visible = scene.items.filter((item) =>
    rectsIntersect(item.bounds, view),
  );
  const culled = scene.items.length - visible.length;

  // Halo first, over the whole rig: a thick outline under every part, so the
  // character reads as one sticker rather than as a pile of shapes. Drawing it
  // per part inside the main loop would put each part's halo on top of the
  // parts already drawn, which is the bug this separate pass avoids.
  if (scene.halo.enabled && scene.halo.width > 0 && alpha >= 1) {
    ctx.strokeStyle = rgbaToCss(scene.halo.color);
    ctx.fillStyle = rgbaToCss(scene.halo.color);
    for (const item of visible) {
      ctx.globalAlpha = 1;
      setItemTransform(ctx, item, viewport, dpr);
      for (const geometry of item.paths) {
        const cached = cache.get(geometry);
        ctx.lineWidth = scene.halo.width + item.strokeWidth;
        ctx.stroke(cached.path);
        if (item.fill) ctx.fill(cached.path, item.fillRule);
      }
    }
  }

  for (const item of visible) {
    setItemTransform(ctx, item, viewport, dpr);
    ctx.globalAlpha =
      (opts.dim?.has(item.layerId) ? item.opacity * 0.25 : item.opacity) *
      alpha;

    // Overlap: fill-only copies stepped toward the parent, under the part
    // itself, so the parent's outline covers the gap at the joint.
    if (item.overlapShift && item.fill) {
      const [sx, sy] = item.overlapShift;
      for (const step of [0.35, 0.7, 1]) {
        ctx.save();
        ctx.translate(sx * step, sy * step);
        paintItem(ctx, item, cache, true);
        ctx.restore();
      }
    }

    paintItem(ctx, item, cache, false);
  }

  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { drawn: visible.length, culled };
}

/**
 * Hit-test a document-space point against the scene, topmost first.
 *
 * The probe is transformed into each part's own space rather than transforming
 * the path, because `isPointInPath` with a matrix argument is not portable and
 * inverting one matrix per item is cheaper than rebuilding geometry.
 *
 * `tolerance` is in document units and widens the target for thin strokes,
 * which is what makes a hairline clickable without pixel-perfect aim.
 */
export function hitTest(
  ctx: CanvasRenderingContext2D,
  scene: ResolvedScene,
  cache: PathCache,
  x: number,
  y: number,
  tolerance = 0,
): DrawItem | null {
  for (let i = scene.items.length - 1; i >= 0; i--) {
    const item = scene.items[i];
    const [bx0, by0, bx1, by1] = item.bounds;
    if (
      x < bx0 - tolerance ||
      x > bx1 + tolerance ||
      y < by0 - tolerance ||
      y > by1 + tolerance
    ) {
      continue;
    }

    const m = item.matrix;
    const det = m.a * m.d - m.b * m.c;
    if (det === 0) continue;
    const px = (m.d * (x - m.e) - m.c * (y - m.f)) / det;
    const py = (m.a * (y - m.f) - m.b * (x - m.e)) / det;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const geometry of item.paths) {
      const cached = cache.get(geometry);
      if (item.fill && ctx.isPointInPath(cached.path, px, py, item.fillRule)) {
        return item;
      }
      if (item.stroke) {
        const previous = ctx.lineWidth;
        ctx.lineWidth = Math.max(item.strokeWidth, tolerance * 2);
        const hit = ctx.isPointInStroke(cached.path, px, py);
        ctx.lineWidth = previous;
        if (hit) return item;
      }
    }
  }
  return null;
}

/** Every item whose bounds fall inside a document-space rect, for marquee select. */
export function hitTestRect(
  scene: ResolvedScene,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): DrawItem[] {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  return scene.items.filter(
    (item) =>
      !(
        item.bounds[2] < minX ||
        item.bounds[0] > maxX ||
        item.bounds[3] < minY ||
        item.bounds[1] > maxY
      ),
  );
}

/** Resolve an RGBA from a CSS colour string, for tokens read off the DOM. */
export function cssToRgba(value: string, fallback: RGBA): RGBA {
  const match = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return fallback;
  const hex = match[1];
  const expand = (s: string) => Number.parseInt(s, 16);
  if (hex.length === 3) {
    return {
      r: expand(hex[0] + hex[0]),
      g: expand(hex[1] + hex[1]),
      b: expand(hex[2] + hex[2]),
      a: 1,
    };
  }
  return {
    r: expand(hex.slice(0, 2)),
    g: expand(hex.slice(2, 4)),
    b: expand(hex.slice(4, 6)),
    a: 1,
  };
}

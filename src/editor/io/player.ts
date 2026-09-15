/**
 * The standalone player export.
 *
 * One HTML file, one canvas, no libraries, no network. Drop it on a desktop and
 * double-click it and the rig plays, which is the only export format that can be
 * checked by the person who made the animation rather than by a developer.
 *
 * The runtime below is deliberately a transcription of `render/scene.ts` and
 * `render/renderer.ts` rather than a clever reuse of them: shipping the editor's
 * TypeScript would need a bundler inside the editor, and the player has to stay
 * a file you can read. Anything that changes the look of a rig has to change in
 * both places, so the two are kept in the same order and use the same names.
 */

import type { PathId, RiffDocument } from "../model/document";
import { drawOrder } from "../model/rig";

interface PlayerPath {
  d: string;
  /** Only present for marker strokes: the renderer needs them for pressure. */
  v?: number[];
  ss?: number[];
  sc?: number[];
  p?: number[];
}

function playerPayload(doc: RiffDocument) {
  const artboard = doc.artboards[doc.activeArtboardId];
  const order = drawOrder(doc).map((layer) => layer.id);
  const used = new Set<PathId>();
  for (const layer of Object.values(doc.layers)) {
    for (const variant of layer.variants) {
      for (const id of variant.pathIds) used.add(id);
    }
  }

  const paths: Record<string, PlayerPath> = {};
  for (const id of used) {
    const path = doc.paths[id];
    if (!path) continue;
    paths[id] = path.pressure
      ? {
          d: path.d,
          v: Array.from(path.vertices),
          ss: Array.from(path.subpathStarts),
          sc: Array.from(path.subpathClosed),
          p: Array.from(path.pressure),
        }
      : { d: path.d };
  }

  const layers: Record<string, unknown> = {};
  for (const layer of Object.values(doc.layers)) {
    layers[layer.id] = {
      parent: layer.parentLayerId,
      pivot: [layer.pivot.x, layer.pivot.y],
      overlap: layer.overlap,
      visible: layer.visible,
      inFrame: layer.inFrame,
      outFrame: Math.min(layer.outFrame, Number.MAX_SAFE_INTEGER),
      t: layer.transform,
      opacity: layer.opacity,
      depth: layer.depth,
      variant: layer.variant,
      variants: layer.variants.map((variant) => ({
        paths: variant.pathIds.filter((id) => paths[id]),
        fill: variant.fill,
        rule: variant.fillRule,
        stroke: variant.stroke,
        sw: variant.strokeWidth,
      })),
    };
  }

  return {
    name: doc.name,
    fps: doc.fps,
    frames: doc.frameCount,
    loopIn: doc.loopIn,
    loopOut: doc.loopOut,
    width: artboard?.width ?? 900,
    height: artboard?.height ?? 900,
    background: artboard?.background ?? null,
    halo: artboard?.halo ?? null,
    order,
    layers,
    paths,
  };
}

/**
 * The player runtime, as source.
 *
 * Kept as one string rather than assembled from pieces so that what ships is
 * exactly what is written here and a reader of the exported file sees the same
 * code a reader of this file does.
 */
const RUNTIME = `
const rgba = (c) => (c ? (c.a >= 1 ? 'rgb(' + c.r + ' ' + c.g + ' ' + c.b + ')' : 'rgb(' + c.r + ' ' + c.g + ' ' + c.b + ' / ' + c.a + ')') : null);

function easeFactor(e, x) {
  if (e.hold) return 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Newton on the x component, bisection fallback. Plenty for playback.
  let t = x;
  for (let i = 0; i < 8; i++) {
    const mt = 1 - t;
    const fx = 3 * mt * mt * t * e.x1 + 3 * mt * t * t * e.x2 + t * t * t - x;
    const d = 3 * mt * mt * (e.x1) + 6 * mt * t * (e.x2 - e.x1) + 3 * t * t * (1 - e.x2);
    if (Math.abs(d) < 1e-6) break;
    t -= fx / d;
    if (t < 0) t = 0; else if (t > 1) t = 1;
  }
  const mt = 1 - t;
  return 3 * mt * mt * t * e.y1 + 3 * mt * t * t * e.y2 + t * t * t;
}

function evalTrack(track, frame) {
  const keys = track.keyframes;
  if (!keys.length) return 0;
  let i = -1;
  let lo = 0;
  let hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].frame <= frame) { i = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (i < 0) return keys[0].value;
  if (i >= keys.length - 1) return keys[keys.length - 1].value;
  const a = keys[i];
  const b = keys[i + 1];
  if (a.easing.hold) return a.value;
  const span = b.frame - a.frame;
  if (span <= 0) return b.value;
  return a.value + (b.value - a.value) * easeFactor(a.easing, (frame - a.frame) / span);
}

function evalProp(prop, tracks, frame) {
  if (!prop) return 0;
  if (prop.kind === 'const') return prop.value;
  const track = tracks[prop.trackId];
  return track ? evalTrack(track, frame) : 0;
}

function compose(x, y, deg, sx, sy, px, py, kx, ky) {
  const rad = deg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const clamp = (v) => Math.min(80, Math.max(-80, v || 0));
  const tx = Math.tan(clamp(kx) * Math.PI / 180);
  const ty = Math.tan(clamp(ky) * Math.PI / 180);
  const a = (cos - sin * ty) * sx;
  const b = (sin + cos * ty) * sx;
  const c = (cos * tx - sin) * sy;
  const d = (sin * tx + cos) * sy;
  return { a, b, c, d, e: x + px - (a * px + c * py), f: y + py - (b * px + d * py) };
}

function mul(m, n) {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

function boot(rig, canvas) {
  const ctx = canvas.getContext('2d');
  const cache = {};
  const BUCKETS = 8;

  function cached(id) {
    let entry = cache[id];
    if (entry) return entry;
    const raw = rig.paths[id];
    entry = { path: new Path2D(raw.d), buckets: null };
    if (raw.p && raw.v) {
      const buckets = new Array(BUCKETS).fill(null);
      const total = raw.v.length / 2;
      for (let s = 0; s < raw.ss.length; s++) {
        const start = raw.ss[s];
        const end = s + 1 < raw.ss.length ? raw.ss[s + 1] : total;
        const count = end - start;
        if (count < 2) continue;
        const segments = raw.sc[s] === 1 ? count : count - 1;
        for (let k = 0; k < segments; k++) {
          const a = start + k;
          const b = start + ((k + 1) % count);
          const mean = (raw.p[a] + raw.p[b]) / 2;
          const index = Math.min(BUCKETS - 1, Math.max(0, Math.floor(mean * BUCKETS)));
          if (!buckets[index]) buckets[index] = new Path2D();
          buckets[index].moveTo(raw.v[a * 2], raw.v[a * 2 + 1]);
          buckets[index].lineTo(raw.v[b * 2], raw.v[b * 2 + 1]);
        }
      }
      entry.buckets = buckets;
    }
    cache[id] = entry;
    return entry;
  }

  function world(id, frame, memo) {
    if (memo[id]) return memo[id];
    const layer = rig.layers[id];
    memo[id] = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const parent = layer.parent && rig.layers[layer.parent] ? world(layer.parent, frame, memo) : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const local = compose(
      evalProp(layer.t.x, rig.tracks, frame),
      evalProp(layer.t.y, rig.tracks, frame),
      evalProp(layer.t.rotation, rig.tracks, frame),
      evalProp(layer.t.scaleX, rig.tracks, frame),
      evalProp(layer.t.scaleY, rig.tracks, frame),
      layer.pivot[0], layer.pivot[1],
      evalProp(layer.t.skewX, rig.tracks, frame),
      evalProp(layer.t.skewY, rig.tracks, frame)
    );
    memo[id] = mul(parent, local);
    return memo[id];
  }

  function variantOf(layer, frame) {
    if (!layer.variants.length) return null;
    const raw = Math.round(evalProp(layer.variant, rig.tracks, frame));
    return layer.variants[Math.min(Math.max(raw, 0), layer.variants.length - 1)] || layer.variants[0];
  }

  function boxOf(variant) {
    if (!variant || !variant.paths.length) return null;
    let b = null;
    for (const id of variant.paths) {
      const raw = rig.paths[id];
      if (!raw || !raw.box) continue;
      b = b ? [Math.min(b[0], raw.box[0]), Math.min(b[1], raw.box[1]), Math.max(b[2], raw.box[2]), Math.max(b[3], raw.box[3])] : raw.box.slice();
    }
    return b;
  }

  function visible(id) {
    let current = rig.layers[id];
    let guard = 0;
    while (current && guard++ < 64) {
      if (!current.visible) return false;
      current = current.parent ? rig.layers[current.parent] : null;
    }
    return true;
  }

  function opacityOf(id, frame) {
    let value = 1;
    let current = rig.layers[id];
    let guard = 0;
    while (current && guard++ < 64) {
      value *= evalProp(current.opacity, rig.tracks, frame);
      current = current.parent ? rig.layers[current.parent] : null;
    }
    return value;
  }

  function paint(item, fillOnly) {
    for (const id of item.variant.paths) {
      const entry = cached(id);
      if (item.variant.fill) {
        ctx.fillStyle = rgba(item.variant.fill);
        ctx.fill(entry.path, item.variant.rule);
      }
      if (fillOnly) continue;
      if (!item.variant.stroke || item.variant.sw <= 0) continue;
      ctx.strokeStyle = rgba(item.variant.stroke);
      if (entry.buckets) {
        for (let i = 0; i < BUCKETS; i++) {
          if (!entry.buckets[i]) continue;
          ctx.lineWidth = item.variant.sw * (0.7 + 0.6 * (i + 0.5) / BUCKETS);
          ctx.stroke(entry.buckets[i]);
        }
      } else {
        ctx.lineWidth = item.variant.sw;
        ctx.stroke(entry.path);
      }
    }
  }

  // The display size is computed rather than left to CSS. Every pure-CSS way
  // of fitting a canvas into a window either stretches it or needs a wrapper,
  // and one line of arithmetic is both shorter and exactly right.
  function layout() {
    const scale = Math.min(window.innerWidth / rig.width, window.innerHeight / rig.height);
    canvas.style.width = (rig.width * scale) + 'px';
    canvas.style.height = (rig.height * scale) + 'px';
  }
  layout();
  window.addEventListener('resize', layout);

  function drawFrame(frame) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(rig.width * dpr)) {
      canvas.width = Math.round(rig.width * dpr);
      canvas.height = Math.round(rig.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rig.width, rig.height);
    if (rig.background) {
      ctx.fillStyle = rgba(rig.background);
      ctx.fillRect(0, 0, rig.width, rig.height);
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const memo = {};
    const items = [];
    for (const id of rig.order) {
      const layer = rig.layers[id];
      if (!layer || !visible(id)) continue;
      if (frame < layer.inFrame || frame >= layer.outFrame) continue;
      const variant = variantOf(layer, frame);
      if (!variant || !variant.paths.length) continue;
      const opacity = opacityOf(id, frame);
      if (opacity <= 0) continue;
      items.push({
        id, layer, variant, matrix: world(id, frame, memo), opacity,
        depth: evalProp(layer.depth, rig.tracks, frame), order: items.length,
      });
    }
    // Depth re-sorts the stack at this frame; the file's order is the tie-break.
    items.sort((a, b) => a.depth === b.depth ? a.order - b.order : a.depth - b.depth);

    const setT = (m) => ctx.setTransform(m.a * dpr, m.b * dpr, m.c * dpr, m.d * dpr, m.e * dpr, m.f * dpr);

    if (rig.halo && rig.halo.enabled && rig.halo.width > 0) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = rgba(rig.halo.color);
      ctx.fillStyle = rgba(rig.halo.color);
      for (const item of items) {
        setT(item.matrix);
        for (const id of item.variant.paths) {
          const entry = cached(id);
          ctx.lineWidth = rig.halo.width + item.variant.sw;
          ctx.stroke(entry.path);
          if (item.variant.fill) ctx.fill(entry.path, item.variant.rule);
        }
      }
    }

    for (const item of items) {
      setT(item.matrix);
      ctx.globalAlpha = item.opacity;
      const shift = overlapOf(item, frame, memo);
      if (shift && item.variant.fill) {
        for (const step of [0.35, 0.7, 1]) {
          ctx.save();
          ctx.translate(shift[0] * step, shift[1] * step);
          paint(item, true);
          ctx.restore();
        }
      }
      paint(item, false);
    }
    ctx.globalAlpha = 1;
  }

  function overlapOf(item, frame, memo) {
    const layer = item.layer;
    if (!layer.overlap || !layer.parent) return null;
    const parent = rig.layers[layer.parent];
    if (!parent) return null;
    const box = boxOf(variantOf(parent, frame));
    if (!box) return null;
    const pm = world(layer.parent, frame, memo);
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;
    const wx = pm.a * cx + pm.c * cy + pm.e;
    const wy = pm.b * cx + pm.d * cy + pm.f;
    const m = item.matrix;
    const det = m.a * m.d - m.b * m.c;
    if (!det) return null;
    const lx = (m.d * (wx - m.e) - m.c * (wy - m.f)) / det;
    const ly = (m.a * (wy - m.f) - m.b * (wx - m.e)) / det;
    const dx = lx - layer.pivot[0];
    const dy = ly - layer.pivot[1];
    const dist = Math.hypot(dx, dy) || 1;
    const sx = Math.abs(evalProp(layer.t.scaleX, rig.tracks, frame));
    const sy = Math.abs(evalProp(layer.t.scaleY, rig.tracks, frame));
    const reach = layer.overlap * 6 / (((sx + sy) / 2) || 1);
    return [dx / dist * reach, dy / dist * reach];
  }

  const span = Math.max(1, rig.loopOut - rig.loopIn);
  let playing = false;
  let raf = 0;
  let startedAt = 0;
  let pausedFrame = rig.loopIn;

  function tick(now) {
    const elapsed = (now - startedAt) / 1000;
    const frame = rig.loopIn + (elapsed * rig.fps) % span;
    drawFrame(frame);
    if (playing) raf = requestAnimationFrame(tick);
  }

  const api = {
    play() {
      if (playing) return;
      playing = true;
      startedAt = performance.now() - ((pausedFrame - rig.loopIn) / rig.fps) * 1000;
      raf = requestAnimationFrame(tick);
    },
    pause() {
      if (!playing) return;
      playing = false;
      cancelAnimationFrame(raf);
      pausedFrame = rig.loopIn + ((performance.now() - startedAt) / 1000 * rig.fps) % span;
    },
    restart() { pausedFrame = rig.loopIn; startedAt = performance.now(); if (!playing) api.play(); },
    goto(frame) { api.pause(); pausedFrame = Math.min(Math.max(frame, rig.loopIn), rig.loopOut - 1); drawFrame(pausedFrame); },
    get frame() { return pausedFrame; },
  };
  drawFrame(rig.loopIn);
  return api;
}
`;

/** Escape the one sequence that can close a script tag from inside a string. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}

export function exportPlayerHtml(doc: RiffDocument): string {
  const payload = playerPayload(doc);
  // Bounds travel with the paths so the player can compute the overlap shift
  // without re-parsing any geometry.
  const boxed: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(payload.paths)) {
    boxed[id] = {
      ...entry,
      box: doc.paths[id as PathId]?.bounds ?? [0, 0, 0, 0],
    };
  }

  const rig = {
    ...payload,
    paths: boxed,
    tracks: doc.tracks,
  };

  const tag = "script";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.name)}</title>
<style>
  /*
   * The rig is letterboxed rather than stretched. A canvas is a replaced
   * element, so object-fit does the work and the page can be any shape
   * without the character going oval.
   */
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  body { display: grid; place-items: center; }
  canvas { display: block; }
</style>
</head>
<body>
<canvas id="rig" role="img" aria-label="${escapeHtml(doc.name)}"></canvas>
<${tag}>
// Standalone rig player. window.rig.play() / .pause() / .restart() / .goto(frame).
const RIG = ${safeJson(rig)};
${RUNTIME}
window.rig = boot(RIG, document.getElementById('rig'));
window.rig.play();
</${tag}>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

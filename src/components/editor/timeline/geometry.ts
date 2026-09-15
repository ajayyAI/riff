/**
 * Timeline geometry: the only place frame <-> pixel conversion happens.
 *
 * Everything here is pure and synchronously testable. That is deliberate: a
 * timeline's silent bugs all live in the coordinate transform (an off-by-one in
 * the lane inset, a zoom that drifts the frame under the cursor, a tick step
 * that collides labels at one specific zoom), and none of them are catchable by
 * looking at the screen. They are catchable by `bun test`.
 *
 * `findGoodStep` / `getPowArgument` / `getSharp` are ported from
 * animation-timeline-control (MIT, https://github.com/ievgennaida/animation-timeline-control)
 * -- see `ref/RESEARCH-editor-architecture.md` section 4. Ported, not imported:
 * that project's data model is a flat array of unidentified rows and cannot
 * express a riff document, so only the geometry is worth taking.
 */

// ------------------------------------------------------------------ constants

/** Pixels per second of timeline at 100% zoom. Design lock. */
export const BASE_PX_PER_SECOND = 140;

/**
 * Blank strip before frame 0 inside the lane.
 *
 * Without it a keyframe diamond on frame 0 is half-clipped by the layer column,
 * which reads as a rendering bug rather than as a keyframe.
 */
export const LANE_INSET = 28;

/**
 * The playhead's head: a pill carrying the current timecode.
 *
 * A bare handle answers "where is the playhead" but not "what frame am I on",
 * which is the question a user asks while scrubbing -- and the transport's
 * readout is at the other end of the panel. See docs/lottielab-teardown.md,
 * "Timeline". 52px holds `0.00s` in 11px mono with room to spare.
 */
export const PLAYHEAD_PILL_WIDTH = 52;
export const PLAYHEAD_PILL_HEIGHT = 20;

export const LAYER_COLUMN_WIDTH = 220;
export const RULER_HEIGHT = 30;
export const LAYER_ROW_HEIGHT = 32;
export const PROPERTY_ROW_HEIGHT = 26;
export const TRANSPORT_HEIGHT = 44;
export const SCROLLBAR_HEIGHT = 10;

export const PANEL_HEIGHT_DEFAULT = 208;
export const PANEL_HEIGHT_COLLAPSED = 80;
export const PANEL_HEIGHT_MIN = 80;

/** Keyframe diamond: 9px glyph, >=20px hit target (padding, not a bigger glyph). */
export const KEYFRAME_SIZE = 9;
export const KEYFRAME_HIT_RADIUS = 10;

/** Zoom range, expressed as a multiplier on BASE_PX_PER_SECOND. */
export const MIN_ZOOM = 8 / BASE_PX_PER_SECOND;
export const MAX_ZOOM = 1200 / BASE_PX_PER_SECOND;

/** Below this many pixels per frame the filmstrip falls back to plain ticks. */
export const MIN_THUMBNAIL_PX = 14;

/** Minimum gap a major tick label needs before the step is bumped up. */
export const MIN_TICK_LABEL_PX = 64;

// ----------------------------------------------------------------- time scale

/**
 * Everything needed to map a frame to a screen x, in one value.
 *
 * Passed by value rather than read from a store so the math stays pure and the
 * tests do not need a store.
 */
export interface TimeScale {
  fps: number;
  /** Multiplier on BASE_PX_PER_SECOND. 1 = 100%. */
  zoom: number;
  /** Horizontal scroll of the lane viewport, in content pixels. */
  scrollLeft: number;
  laneInset: number;
}

export function makeScale(
  fps: number,
  zoom: number,
  scrollLeft = 0,
  laneInset = LANE_INSET,
): TimeScale {
  return { fps: fps > 0 ? fps : 1, zoom, scrollLeft, laneInset };
}

export function pixelsPerFrame(scale: TimeScale): number {
  return (BASE_PX_PER_SECOND * scale.zoom) / scale.fps;
}

/** Frame -> x in content space (independent of scroll). */
export function frameToContentX(frame: number, scale: TimeScale): number {
  return scale.laneInset + frame * pixelsPerFrame(scale);
}

/** Content x -> fractional frame. */
export function contentXToFrame(x: number, scale: TimeScale): number {
  const ppf = pixelsPerFrame(scale);
  return ppf === 0 ? 0 : (x - scale.laneInset) / ppf;
}

/** Frame -> x relative to the left edge of the lane viewport. */
export function frameToScreenX(frame: number, scale: TimeScale): number {
  return frameToContentX(frame, scale) - scale.scrollLeft;
}

/** Viewport x -> fractional frame. */
export function screenXToFrame(x: number, scale: TimeScale): number {
  return contentXToFrame(x + scale.scrollLeft, scale);
}

/** Total scrollable width of the lane content, with a screen of trailing slack. */
export function contentWidth(
  frameCount: number,
  scale: TimeScale,
  viewportWidth = 0,
): number {
  const end = frameToContentX(Math.max(0, frameCount - 1), scale);
  return Math.max(end + scale.laneInset, viewportWidth);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clampZoom(zoom: number): number {
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

export function clampScrollLeft(
  scrollLeft: number,
  frameCount: number,
  scale: TimeScale,
  viewportWidth: number,
): number {
  const max = Math.max(
    0,
    contentWidth(frameCount, scale, viewportWidth) - viewportWidth,
  );
  return clamp(scrollLeft, 0, max);
}

// --------------------------------------------------------------- zoom anchor

export interface ZoomResult {
  zoom: number;
  scrollLeft: number;
}

/**
 * Change zoom while pinning the frame under the cursor to the cursor.
 *
 * The reference implementation writes this as
 * `scrollLeft = valToPx(val) - clientWidth / (clientWidth / x)`, which reduces
 * exactly to `valToPx(val) - x`. Written that way it is obviously correct and
 * obviously testable: the frame sampled before the zoom must land back under the
 * same viewport x after it.
 *
 * `cursorX` is relative to the left edge of the lane viewport, so a cursor over
 * the layer column (negative x) still anchors sensibly.
 */
export function zoomAtCursor(
  scale: TimeScale,
  cursorX: number,
  nextZoom: number,
): ZoomResult {
  const anchorFrame = screenXToFrame(cursorX, scale);
  const zoom = clampZoom(nextZoom);
  const next: TimeScale = { ...scale, zoom };
  const scrollLeft = Math.max(0, frameToContentX(anchorFrame, next) - cursorX);
  return { zoom, scrollLeft };
}

/** Multiplicative zoom step. Exponential so every notch feels the same size. */
export function zoomByFactor(
  scale: TimeScale,
  cursorX: number,
  factor: number,
): ZoomResult {
  return zoomAtCursor(scale, cursorX, scale.zoom * factor);
}

/** Wheel deltaY -> zoom factor. Trackpads emit small deltas; mice emit ~100. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-clamp(deltaY, -120, 120) * 0.005);
}

/**
 * Horizontal distance a wheel event should pan the timeline.
 *
 * Trackpads emit real horizontal deltas; classic mouse wheels only emit
 * vertical, so Shift+wheel is honoured as horizontal (the Figma/AE
 * convention) when the vertical axis dominates. Returns 0 when the gesture
 * is vertical scrolling, which the lane body handles natively.
 */
export function horizontalPanDelta(
  deltaX: number,
  deltaY: number,
  shiftKey: boolean,
): number {
  if (Math.abs(deltaX) > Math.abs(deltaY)) return deltaX;
  if (shiftKey && deltaY !== 0) return deltaY;
  return 0;
}

/** Zoom that fits the whole document in `viewportWidth`, plus the inset. */
export function fitZoom(
  frameCount: number,
  fps: number,
  viewportWidth: number,
  laneInset = LANE_INSET,
): number {
  const frames = Math.max(1, frameCount - 1);
  const usable = Math.max(1, viewportWidth - laneInset * 2);
  return clampZoom((usable / frames) * (fps / BASE_PX_PER_SECOND));
}

// -------------------------------------------------------------- ruler ticks

/**
 * Ported verbatim from animation-timeline-control (MIT):
 * `TimelineUtils.getPowArgument`, src/utils/timelineUtils.ts:204.
 */
export function getPowArgument(toCheck: number): number {
  if (!toCheck || toCheck === 0 || !Number.isFinite(toCheck)) return 1;
  if (toCheck >= 10 && toCheck < 100) return 1;
  if (toCheck >= 100 && toCheck < 1000) return 2;
  if (toCheck >= 1000 && toCheck < 10000) return 3;
  return Math.floor(Math.log10(Math.abs(toCheck)));
}

const DEFAULT_DENOMINATORS = [1, 2, 5, 10];

/**
 * Ported from animation-timeline-control (MIT):
 * `TimelineUtils.findGoodStep`, src/utils/timelineUtils.ts:45.
 *
 * Returns the *nearest* round step to `originalStep`, which may be smaller than
 * it. `findFrameStep` below wraps it with an at-least guarantee, because
 * "nearest" is what makes labels collide at one awkward zoom.
 */
export function findGoodStep(
  originalStep: number,
  divisionCheck = 0,
  denominators: number[] = DEFAULT_DENOMINATORS,
): number {
  if (originalStep <= 0 || !Number.isFinite(originalStep)) return originalStep;

  let step = originalStep;
  let lastDistance: number | null = null;
  const pow = getPowArgument(originalStep);

  for (const denominator of denominators) {
    const calculated = denominator * 10 ** pow;
    if (divisionCheck && divisionCheck % calculated !== 0) continue;

    const distance = Math.abs(originalStep - calculated);
    if (distance === 0 || (distance <= 0.1 && pow > 0)) {
      step = calculated;
      break;
    }
    if (lastDistance === null || lastDistance > distance) {
      lastDistance = distance;
      step = calculated;
    }
  }
  return step;
}

/**
 * Divisors of the frame rate that land on a readable fraction of a second.
 *
 * At 24fps the divisors are 1, 2, 3, 4, 6, 8, 12 and 24, but three of them are
 * 0.125s and 0.1667s, and a ruler labelled 0.1, 0.3, 0.4, 0.6 is a ruler
 * nobody can read. Keeping only the divisors whose second value is a whole
 * number of hundredths leaves 0.25s, 0.5s and 1s, which is what a person
 * counts in. Ascending, and the frame rate itself always qualifies.
 */
function readableDivisors(n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= n; i++) {
    if (n % i !== 0) continue;
    const hundredths = (i / n) * 100;
    if (Math.abs(hundredths - Math.round(hundredths)) < 1e-9) out.push(i);
  }
  return out.length > 0 ? out : [n];
}

/**
 * Smallest "musical" tick step, in frames, that is at least `minFrames`.
 *
 * Frames, not milliseconds: at 24fps a user thinks in halves and quarters of a
 * second, so ticks land on 1, 2, 3, 4, 6, 8, 12, 24 -- the divisors of the frame
 * rate -- and only above one second does it fall back to the decimal 1/2/5/10
 * ladder that `findGoodStep` implements. A tick at "every 10 frames" of a 24fps
 * document is a tick at 0.4166s, which is a number nobody wants to read.
 *
 * The at-least guarantee is what makes label collision impossible: the caller
 * passes the pixel width a label needs, converted to frames.
 */
export function findFrameStep(minFrames: number, fps: number): number {
  const rate = fps > 0 ? Math.round(fps) : 1;
  if (!(minFrames > 0) || !Number.isFinite(minFrames)) return 1;

  if (minFrames <= rate) {
    for (const d of readableDivisors(rate)) if (d >= minFrames) return d;
    return rate;
  }

  const seconds = minFrames / rate;
  let step = findGoodStep(seconds);
  if (step < seconds) {
    const pow = getPowArgument(seconds);
    for (const d of [1, 2, 5, 10, 20, 50, 100]) {
      const candidate = d * 10 ** pow;
      if (candidate >= seconds) {
        step = candidate;
        break;
      }
    }
  }
  return Math.max(rate, Math.round(step * rate));
}

export interface RulerTicks {
  /** Step between labelled ticks, in frames. */
  major: number;
  /** Step between unlabelled ticks, in frames. 0 when there is no room. */
  minor: number;
  /** First major tick at or before the left edge of the viewport. */
  from: number;
  /** Last major tick at or after the right edge. */
  to: number;
}

/**
 * Choose the tick steps and the visible range for the current viewport.
 *
 * Clamped to the document so we never draw ticks into the trailing slack, and
 * `from` is snapped down to a multiple of the step so ticks do not crawl while
 * scrolling.
 */
export function rulerTicks(
  scale: TimeScale,
  viewportWidth: number,
  frameCount: number,
  minLabelPx = MIN_TICK_LABEL_PX,
): RulerTicks {
  const ppf = pixelsPerFrame(scale);
  const major = findFrameStep(ppf > 0 ? minLabelPx / ppf : 1, scale.fps);

  // A minor tick needs elbow room too, or the strip turns into a grey block.
  let minor = 0;
  for (const divisor of [4, 2]) {
    if (major % divisor === 0 && (major / divisor) * ppf >= 6) {
      minor = major / divisor;
      break;
    }
  }

  const left = Math.max(0, screenXToFrame(0, scale));
  const right = Math.min(
    Math.max(0, frameCount - 1),
    screenXToFrame(viewportWidth, scale),
  );
  const from = Math.max(0, Math.floor(left / major) * major);
  const to = Math.ceil(right / major) * major;
  return { major, minor, from, to };
}

/**
 * Label for a tick, in seconds, with only as many decimals as the step needs.
 *
 * Showing `0.500s` next to `1.000s` when the step is half a second is noise;
 * showing `0.5s` next to `1s` is not.
 */
export function formatTickLabel(
  frame: number,
  fps: number,
  stepFrames: number,
): string {
  const seconds = frame / (fps > 0 ? fps : 1);
  const stepSeconds = stepFrames / (fps > 0 ? fps : 1);
  // Enough decimals that two neighbouring ticks cannot print the same number.
  // One decimal on a quarter-second step gives 0.0, 0.3, 0.5, 0.8, which reads
  // as a broken ruler even though the ticks are evenly spaced.
  const tenths = stepSeconds * 10;
  const decimals =
    stepSeconds >= 1 ? 0 : Math.abs(tenths - Math.round(tenths)) < 1e-9 ? 1 : 2;
  return `${seconds.toFixed(decimals)}s`;
}

/** `1.32 / 3.00 s` -- the transport readout. Fixed decimals so it cannot reflow. */
export function formatTimecode(frame: number, fps: number): string {
  return (frame / (fps > 0 ? fps : 1)).toFixed(2);
}

// ------------------------------------------------------------------- HiDPI

/**
 * Snap a coordinate so a hairline lands on whole device pixels.
 *
 * Adapted from animation-timeline-control's `_getSharp` (MIT, src/timeline.ts:2255).
 * The original works in device pixels and adds `pixelRatio / 2`; we let the
 * context carry the ratio (`setTransform(dpr, 0, 0, dpr, 0, 0)`) so text and
 * layout stay in CSS pixels, which means the offset is `0.5 / dpr` instead. Same
 * idea, one coordinate space fewer to get wrong.
 */
export function getSharp(pos: number, dpr: number, thickness = 1): number {
  const ratio = dpr > 0 ? dpr : 1;
  const snapped = Math.round(pos * ratio) / ratio;
  return thickness % 2 === 0 ? snapped : snapped + 0.5 / ratio;
}

// -------------------------------------------------------------- hit testing

/**
 * Index of the keyframe nearest `viewportX`, or -1.
 *
 * Nearest rather than first-within-radius: at low zoom several diamonds overlap,
 * and picking the first one in array order means clicking the right half of a
 * cluster selects the left-most keyframe, which feels broken.
 */
export function hitTestKeyframes(
  frames: readonly number[],
  viewportX: number,
  scale: TimeScale,
  radius = KEYFRAME_HIT_RADIUS,
): number {
  let best = -1;
  let bestDistance = radius;
  for (let i = 0; i < frames.length; i++) {
    const distance = Math.abs(frameToScreenX(frames[i], scale) - viewportX);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** Indices of keyframes whose diamond centre falls inside a marquee band. */
export function keyframesInBand(
  frames: readonly number[],
  x0: number,
  x1: number,
  scale: TimeScale,
): number[] {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  const out: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const x = frameToScreenX(frames[i], scale);
    if (x >= lo && x <= hi) out.push(i);
  }
  return out;
}

/**
 * Clamp a multi-keyframe drag as a bundle.
 *
 * The whole selection is bounded before the offset is applied, so dragging a
 * group into the left edge slides it to a stop instead of collapsing every
 * keyframe onto frame 0 -- the bug the reference implementation calls out and
 * that most timelines ship.
 */
export function clampDragOffset(
  frames: readonly number[],
  offset: number,
  minFrame: number,
  maxFrame: number,
): number {
  if (frames.length === 0) return 0;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const f of frames) {
    if (f < lo) lo = f;
    if (f > hi) hi = f;
  }
  return Math.round(clamp(offset, minFrame - lo, maxFrame - hi));
}

/**
 * Left edge of the playhead pill, clamped inside the lane viewport.
 *
 * Centred on the playhead where there is room, and clamped -- not floored --
 * at both ends, so the pill is always wholly visible and never half-cut
 * against the layer column. The old `Math.max(x - 6, 2)` was a floor, which is
 * why the head detached from its line as soon as the lane was scrolled (T3).
 *
 * Returns a viewport-relative x in CSS pixels.
 */
export function playheadPillLeft(
  x: number,
  pillWidth: number,
  viewportWidth: number,
): number {
  return clamp(x - pillWidth / 2, 0, Math.max(0, viewportWidth - pillWidth));
}

/**
 * Where the playhead's grab handle sits, in lane pixels.
 *
 * The handle is centred on the line it belongs to, then held inside the lane so
 * it stays grabbable at either end. The previous `Math.max(x - 6, 2)` was a
 * floor rather than a clamp: at frame 0 the handle sat 2px right of its own
 * line and covered the first ruler label, and it detached from the line
 * entirely once the lane was scrolled.
 */
export function playheadHandleLeft(
  x: number,
  handleWidth: number,
  viewportWidth: number,
): number {
  const max = Math.max(0, viewportWidth - handleWidth);
  return clamp(x - handleWidth / 2, 0, max);
}

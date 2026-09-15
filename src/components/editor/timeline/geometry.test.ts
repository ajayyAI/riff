import { describe, expect, test } from "bun:test";
import {
  BASE_PX_PER_SECOND,
  clampDragOffset,
  contentXToFrame,
  findFrameStep,
  findGoodStep,
  fitZoom,
  formatTickLabel,
  frameToContentX,
  frameToScreenX,
  getPowArgument,
  getSharp,
  hitTestKeyframes,
  horizontalPanDelta,
  keyframesInBand,
  LANE_INSET,
  MAX_ZOOM,
  MIN_TICK_LABEL_PX,
  MIN_ZOOM,
  makeScale,
  PLAYHEAD_PILL_WIDTH,
  pixelsPerFrame,
  playheadHandleLeft,
  playheadPillLeft,
  rulerTicks,
  screenXToFrame,
  wheelZoomFactor,
  zoomAtCursor,
  zoomByFactor,
} from "./geometry";

describe("frame <-> pixel", () => {
  test("140px per second at 100% zoom, whatever the frame rate", () => {
    for (const fps of [12, 24, 30, 60]) {
      const scale = makeScale(fps, 1);
      expect(pixelsPerFrame(scale) * fps).toBeCloseTo(BASE_PX_PER_SECOND, 10);
      // One second of frames spans exactly 140px.
      expect(
        frameToContentX(fps, scale) - frameToContentX(0, scale),
      ).toBeCloseTo(BASE_PX_PER_SECOND, 10);
    }
  });

  test("frame 0 sits at the lane inset, not at x = 0", () => {
    const scale = makeScale(24, 1, 0, 28);
    expect(frameToContentX(0, scale)).toBe(28);
  });

  test("content and screen conversions round-trip at any zoom and scroll", () => {
    for (const zoom of [0.06, 0.5, 1, 3.7, 8.5]) {
      for (const scrollLeft of [0, 17, 4211]) {
        const scale = makeScale(24, zoom, scrollLeft);
        for (const frame of [0, 1, 7, 240, 3599]) {
          expect(
            contentXToFrame(frameToContentX(frame, scale), scale),
          ).toBeCloseTo(frame, 9);
          expect(
            screenXToFrame(frameToScreenX(frame, scale), scale),
          ).toBeCloseTo(frame, 9);
        }
      }
    }
  });

  test("scrolling shifts screen x by exactly the scroll amount", () => {
    const a = makeScale(24, 2, 0);
    const b = makeScale(24, 2, 250);
    expect(frameToScreenX(60, a) - frameToScreenX(60, b)).toBe(250);
  });

  test("a zero frame rate cannot divide by zero", () => {
    const scale = makeScale(0, 1);
    expect(Number.isFinite(pixelsPerFrame(scale))).toBe(true);
  });
});

describe("zoom at cursor", () => {
  test("the frame under the cursor stays under the cursor", () => {
    for (const zoom of [0.25, 1, 4]) {
      for (const cursorX of [0, 1, 137, 640, 1200]) {
        for (const factor of [1.1, 0.5, 2, 0.93]) {
          const scale = makeScale(24, zoom, 1000);
          const before = screenXToFrame(cursorX, scale);
          const next = zoomByFactor(scale, cursorX, factor);
          const after = screenXToFrame(cursorX, { ...scale, ...next });
          // Only exact while the anchoring scroll is representable, i.e. not
          // clamped against the left edge.
          if (next.scrollLeft > 0) expect(after).toBeCloseTo(before, 6);
        }
      }
    }
  });

  test("clamps scrollLeft at the left edge rather than going negative", () => {
    const scale = makeScale(24, 1, 0);
    const next = zoomByFactor(scale, 500, 0.25);
    expect(next.scrollLeft).toBe(0);
  });

  test("zoom is clamped to the documented range", () => {
    const scale = makeScale(24, 1, 0);
    expect(zoomAtCursor(scale, 100, 10_000).zoom).toBe(MAX_ZOOM);
    expect(zoomAtCursor(scale, 100, 0).zoom).toBe(MIN_ZOOM);
  });

  test("zoom is symmetric: in then out returns to where it started", () => {
    const scale = makeScale(24, 1, 800);
    const inward = zoomByFactor(scale, 300, 1.5);
    const back = zoomByFactor({ ...scale, ...inward }, 300, 1 / 1.5);
    expect(back.zoom).toBeCloseTo(scale.zoom, 9);
    expect(back.scrollLeft).toBeCloseTo(scale.scrollLeft, 6);
  });

  test("wheel factor zooms in on up-scroll and out on down-scroll", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
    // Trackpads emit a stream of tiny deltas; each must be a small change.
    expect(wheelZoomFactor(2)).toBeGreaterThan(0.98);
  });

  test("fit puts the whole document inside the viewport", () => {
    const zoom = fitZoom(120, 24, 900);
    const scale = makeScale(24, zoom, 0);
    expect(frameToContentX(119, scale)).toBeLessThanOrEqual(900);
  });

  test("horizontal wheel pans, vertical does not", () => {
    expect(horizontalPanDelta(30, 5, false)).toBe(30);
    expect(horizontalPanDelta(5, 30, false)).toBe(0);
    expect(horizontalPanDelta(0, 0, false)).toBe(0);
  });

  test("shift+wheel pans horizontally (mouse-wheel convention)", () => {
    expect(horizontalPanDelta(5, 30, true)).toBe(30);
    expect(horizontalPanDelta(30, 5, true)).toBe(30);
  });
});

describe("findGoodStep (ported)", () => {
  test("matches the reference behaviour on the documented cases", () => {
    expect(findGoodStep(1)).toBe(1);
    expect(findGoodStep(2)).toBe(2);
    expect(findGoodStep(5)).toBe(5);
    expect(findGoodStep(10)).toBe(10);
    expect(findGoodStep(11)).toBe(10);
    expect(findGoodStep(0.4)).toBe(0.5);
  });

  test("respects divisionCheck", () => {
    expect(findGoodStep(3, 10)).toBe(2);
  });

  test("degenerate input passes through instead of throwing", () => {
    expect(findGoodStep(0)).toBe(0);
    expect(findGoodStep(Number.NaN)).toBeNaN();
    expect(findGoodStep(Number.POSITIVE_INFINITY)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test("getPowArgument brackets by magnitude", () => {
    expect(getPowArgument(12)).toBe(1);
    expect(getPowArgument(120)).toBe(2);
    expect(getPowArgument(1200)).toBe(3);
    expect(getPowArgument(0)).toBe(1);
  });
});

describe("findFrameStep", () => {
  test("sub-second steps land on divisors of the frame rate", () => {
    for (const fps of [12, 24, 30]) {
      for (const min of [1, 1.5, 3.2, 7, 11]) {
        const step = findFrameStep(min, fps);
        expect(fps % step).toBe(0);
      }
    }
  });

  test("never returns a step smaller than asked for -- labels cannot collide", () => {
    for (const fps of [12, 24, 25, 30, 60]) {
      for (let min = 0.2; min < 400; min *= 1.13) {
        expect(findFrameStep(min, fps)).toBeGreaterThanOrEqual(min);
      }
    }
  });

  test("above one second, steps are whole seconds", () => {
    for (const fps of [12, 24, 30]) {
      for (const min of [fps * 1.1, fps * 3, fps * 40]) {
        expect(findFrameStep(min, fps) % fps).toBe(0);
      }
    }
  });

  test("degenerate input yields a usable step", () => {
    expect(findFrameStep(0, 24)).toBe(1);
    expect(findFrameStep(Number.NaN, 24)).toBe(1);
    expect(findFrameStep(5, 0)).toBe(5);
  });
});

describe("rulerTicks", () => {
  test("labels always have at least the requested pixel gap", () => {
    for (const zoom of [0.06, 0.2, 1, 2.5, 8.5]) {
      const scale = makeScale(24, zoom, 0);
      const ticks = rulerTicks(scale, 1000, 480);
      expect(ticks.major * pixelsPerFrame(scale)).toBeGreaterThanOrEqual(
        MIN_TICK_LABEL_PX,
      );
    }
  });

  test("minor ticks divide the major step evenly, or are absent", () => {
    for (const zoom of [0.06, 0.5, 1, 4, 8.5]) {
      const ticks = rulerTicks(makeScale(24, zoom, 0), 1000, 480);
      if (ticks.minor > 0) expect(ticks.major % ticks.minor).toBe(0);
    }
  });

  test("the range starts on a multiple of the step so ticks do not crawl", () => {
    for (const scrollLeft of [0, 13, 91, 1234]) {
      const ticks = rulerTicks(makeScale(24, 1, scrollLeft), 800, 480);
      expect(ticks.from % ticks.major).toBe(0);
      expect(ticks.from).toBeGreaterThanOrEqual(0);
    }
  });

  test("the visible range covers the viewport", () => {
    const scale = makeScale(24, 1, 300);
    const ticks = rulerTicks(scale, 800, 4800);
    expect(ticks.from).toBeLessThanOrEqual(screenXToFrame(0, scale));
    expect(ticks.to).toBeGreaterThanOrEqual(screenXToFrame(800, scale));
  });

  test("labels drop decimals as the step grows", () => {
    expect(formatTickLabel(24, 24, 24)).toBe("1s");
    expect(formatTickLabel(12, 24, 12)).toBe("0.5s");
    expect(formatTickLabel(2, 24, 2)).toBe("0.08s");
  });
});

describe("getSharp", () => {
  test("an odd-width line lands on a device pixel centre", () => {
    for (const dpr of [1, 2, 3]) {
      for (const pos of [0, 10, 10.4, 137.6]) {
        const device = getSharp(pos, dpr) * dpr;
        expect(device - Math.floor(device)).toBeCloseTo(0.5, 9);
      }
    }
  });

  test("an even-width line lands on a device pixel boundary", () => {
    for (const dpr of [1, 2]) {
      const device = getSharp(10.3, dpr, 2) * dpr;
      expect(device % 1).toBeCloseTo(0, 9);
    }
  });

  test("a zero or absent ratio degrades to 1 rather than dividing by zero", () => {
    expect(Number.isFinite(getSharp(10.3, 0))).toBe(true);
  });
});

describe("keyframe hit testing", () => {
  const scale = makeScale(24, 1, 0);

  test("picks the nearest diamond, not the first in array order", () => {
    const frames = [10, 11, 12];
    const x = frameToScreenX(12, scale);
    expect(hitTestKeyframes(frames, x, scale)).toBe(2);
  });

  test("misses cleanly outside the hit radius", () => {
    expect(hitTestKeyframes([10], frameToScreenX(10, scale) + 40, scale)).toBe(
      -1,
    );
  });

  test("the hit target is at least 20px wide even though the glyph is 9px", () => {
    const centre = frameToScreenX(10, scale);
    expect(hitTestKeyframes([10], centre - 9.5, scale)).toBe(0);
    expect(hitTestKeyframes([10], centre + 9.5, scale)).toBe(0);
  });

  test("an empty track hits nothing", () => {
    expect(hitTestKeyframes([], 100, scale)).toBe(-1);
  });

  test("marquee selects by centre, and is direction-agnostic", () => {
    const frames = [0, 12, 24, 36];
    const lo = frameToScreenX(12, scale) - 1;
    const hi = frameToScreenX(24, scale) + 1;
    expect(keyframesInBand(frames, lo, hi, scale)).toEqual([1, 2]);
    expect(keyframesInBand(frames, hi, lo, scale)).toEqual([1, 2]);
  });
});

describe("clampDragOffset", () => {
  test("bounds the selection as a bundle, preserving spacing at the edge", () => {
    expect(clampDragOffset([2, 5, 9], -100, 0, 100)).toBe(-2);
    expect(clampDragOffset([2, 5, 9], 100, 0, 100)).toBe(91);
  });

  test("snaps to whole frames", () => {
    expect(clampDragOffset([10], 3.7, 0, 100)).toBe(4);
  });

  test("an empty selection moves by nothing", () => {
    expect(clampDragOffset([], 5, 0, 100)).toBe(0);
  });
});

describe("playheadPillLeft", () => {
  test("centres the pill on the playhead when there is room", () => {
    expect(playheadPillLeft(300, 52, 800)).toBe(274);
  });

  test("frame 0 sits at the lane inset and the pill stays fully visible", () => {
    // With scrollLeft 0 the playhead for frame 0 is at LANE_INSET, so a
    // centred 52px pill would start at 2px -- and any narrower lane inset, or
    // a wider pill, would start off-screen. Clamping is what makes the head
    // independent of both numbers.
    expect(playheadPillLeft(LANE_INSET, 52, 800)).toBe(2);
    expect(playheadPillLeft(LANE_INSET, 80, 800)).toBe(0);
  });

  test("never leaves the lane on the left", () => {
    expect(playheadPillLeft(0, 52, 800)).toBe(0);
    expect(playheadPillLeft(-40, 52, 800)).toBe(0);
  });

  test("never leaves the lane on the right", () => {
    expect(playheadPillLeft(800, 52, 800)).toBe(748);
    expect(playheadPillLeft(2000, 52, 800)).toBe(748);
  });

  test("a lane narrower than the pill pins it to the left rather than negative", () => {
    expect(playheadPillLeft(10, 52, 30)).toBe(0);
  });

  test("the pill is wide enough for a two-decimal timecode", () => {
    expect(PLAYHEAD_PILL_WIDTH).toBeGreaterThanOrEqual(52);
  });
});

describe("playheadHandleLeft", () => {
  const W = 13;

  test("centres the handle on its line", () => {
    expect(playheadHandleLeft(100, W, 500)).toBe(100 - W / 2);
  });

  test("never leaves the lane at frame 0", () => {
    expect(playheadHandleLeft(0, W, 500)).toBe(0);
  });

  test("never overhangs the right edge", () => {
    expect(playheadHandleLeft(500, W, 500)).toBe(500 - W);
  });

  test("stays centred once clear of both edges", () => {
    for (const x of [10, 50, 200, 480]) {
      const left = playheadHandleLeft(x, W, 500);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left + W).toBeLessThanOrEqual(500);
    }
  });

  test("a viewport narrower than the handle still yields a real number", () => {
    expect(Number.isFinite(playheadHandleLeft(4, W, 8))).toBe(true);
  });
});

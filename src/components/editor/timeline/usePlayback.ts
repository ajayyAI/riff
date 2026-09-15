"use client";

import { useEffect, useRef } from "react";
import type { EditorStore } from "@/editor/store";

/**
 * Wall-clock playback.
 *
 * The obvious implementation, advance one frame per `requestAnimationFrame`, is
 * wrong, and wrong in a way nobody notices until somebody with a 120Hz display
 * reports that their animation plays at double speed. rAF fires at the display
 * refresh rate, which is not the document's frame rate and is not constant.
 *
 * So: remember when playback started and which frame it started on, and derive
 * the current frame from elapsed milliseconds. The document's rate is then
 * honoured on a 60Hz panel, a 120Hz panel, and a tab that was throttled in the
 * background, and dropped frames stay dropped rather than accumulating into
 * drift.
 *
 * Playback wraps inside the loop range, not inside the whole document. A
 * two-second wave sitting inside a four-second animation has to replay the wave.
 *
 * `prefers-reduced-motion` is deliberately not consulted. The design lock is
 * explicit: this is playback of the user's own animation, which is content, not
 * interface decoration.
 */
export function usePlayback(
  store: EditorStore,
  playing: boolean,
  fps: number,
  loopIn: number,
  loopOut: number,
  loop: boolean,
): void {
  // Survives across rAF ticks without re-running the effect.
  const lastSetFrame = useRef(-1);

  useEffect(() => {
    if (!playing) return;

    const rate = fps > 0 ? fps : 12;
    const start = Math.max(0, Math.round(loopIn));
    const end = Math.max(start + 1, Math.round(loopOut));
    const span = end - start;

    let raf = 0;
    const current = store.getState().ui.frame;
    // Pressing play from outside the loop starts the loop rather than running
    // off the end of it, which is what somebody who just moved the handles
    // expects to happen.
    let originFrame = current >= start && current < end ? current : start;
    let originTime = performance.now();
    lastSetFrame.current = originFrame;
    if (originFrame !== current) store.setFrame(originFrame);

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);

      const live = store.getState().ui.frame;
      // Somebody scrubbed mid-playback. Rebase so playback continues from where
      // they dropped the playhead instead of snapping back.
      if (live !== lastSetFrame.current) {
        originFrame = live;
        originTime = now;
      }

      const advanced = Math.floor(((now - originTime) * rate) / 1000);
      const target = originFrame + advanced;
      if (target === lastSetFrame.current) return;

      if (target >= end) {
        if (loop) {
          const wrapped = start + ((((target - start) % span) + span) % span);
          lastSetFrame.current = wrapped;
          store.setFrame(wrapped);
        } else {
          lastSetFrame.current = end - 1;
          store.setFrame(end - 1);
          store.setUi({ playing: false });
        }
        return;
      }

      lastSetFrame.current = target;
      store.setFrame(target);
    };

    raf = requestAnimationFrame(tick);
    // Stopping the loop the instant playback stops is the whole point of gating
    // on `playing` rather than checking inside the callback.
    return () => cancelAnimationFrame(raf);
  }, [store, playing, fps, loopIn, loopOut, loop]);
}

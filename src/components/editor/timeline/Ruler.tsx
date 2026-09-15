"use client";

/**
 * The time ruler.
 *
 * Painted on a canvas rather than built from elements: a ruler at a fine zoom is
 * hundreds of ticks, and hundreds of absolutely positioned spans that all move
 * together on every scroll is the slowest possible way to draw a straight line.
 *
 * It also owns the loop range, because the loop is a fact about time and time is
 * what this strip shows. The two handles are real buttons on top of the canvas
 * so they can be tabbed to and nudged with the arrow keys; everything else in
 * here is paint.
 */

import { useEffect, useRef } from "react";
import type { Frame } from "@/editor/model/document";
import { cn } from "@/lib/utils";
import { MONO_FALLBACK, readTokens } from "../tokens";
import {
  clamp,
  formatTickLabel,
  frameToScreenX,
  getSharp,
  RULER_HEIGHT,
  rulerTicks,
  screenXToFrame,
  type TimeScale,
} from "./geometry";
import { FEEDBACK, FOCUS_RING } from "./parts";

/**
 * Width of a loop handle.
 *
 * The handles bracket the range rather than sitting inside it: the start handle
 * is to the left of the first looped frame and the end handle to the right of
 * the last. Inside, they cover the very frames a user most wants to click, and
 * the last frame of the animation becomes unreachable with the pointer.
 */
const HANDLE_WIDTH = 9;

export interface RulerProps {
  width: number;
  frameCount: number;
  scale: TimeScale;
  loopIn: Frame;
  loopOut: Frame;
  onScrub: (frame: Frame) => void;
  /** Called on every move of a loop handle. */
  onLoopChange: (loopIn: Frame, loopOut: Frame) => void;
  /** Opens the undo transaction, so one drag is one step back. */
  onLoopDragStart: () => void;
  onLoopDragEnd: () => void;
}

export function Ruler({
  frameCount,
  loopIn,
  loopOut,
  onLoopChange,
  onLoopDragEnd,
  onLoopDragStart,
  onScrub,
  scale,
  width,
}: RulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrubbing = useRef(false);
  const loopDrag = useRef<"in" | "out" | null>(null);

  const lastFrame = Math.max(0, frameCount - 1);
  const inX = frameToScreenX(loopIn, scale);
  const outX = frameToScreenX(loopOut, scale);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.round(RULER_HEIGHT * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${RULER_HEIGHT}px`;

    const tokens = readTokens(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, RULER_HEIGHT);

    // Outside the loop is shaded, so the part of the animation that actually
    // plays is the part that looks lit.
    const left = frameToScreenX(loopIn, scale);
    const right = frameToScreenX(loopOut, scale);
    ctx.fillStyle = tokens["--riff-fill"];
    if (left > 0) ctx.fillRect(0, 0, left, RULER_HEIGHT);
    if (right < width) ctx.fillRect(right, 0, width - right, RULER_HEIGHT);

    const ticks = rulerTicks(scale, width, frameCount);

    if (ticks.minor > 0) {
      ctx.fillStyle = tokens["--riff-hairline-strong"];
      for (let frame = ticks.from; frame <= ticks.to; frame += ticks.minor) {
        if (frame < 0 || frame > lastFrame) continue;
        const x = getSharp(frameToScreenX(frame, scale), dpr);
        ctx.fillRect(x, RULER_HEIGHT - 6, 1, 5);
      }
    }

    ctx.fillStyle = tokens["--riff-faint"];
    ctx.font = `500 10px ${MONO_FALLBACK}, ui-monospace, monospace`;
    ctx.textBaseline = "alphabetic";
    for (let frame = ticks.from; frame <= ticks.to; frame += ticks.major) {
      if (frame < 0 || frame > lastFrame) continue;
      const x = getSharp(frameToScreenX(frame, scale), dpr);
      ctx.fillStyle = tokens["--riff-hairline-strong"];
      ctx.fillRect(x, RULER_HEIGHT - 10, 1, 9);
      ctx.fillStyle = tokens["--riff-faint"];
      ctx.fillText(formatTickLabel(frame, scale.fps, ticks.major), x + 4, 13);
    }

    ctx.fillStyle = tokens["--riff-hairline"];
    ctx.fillRect(0, RULER_HEIGHT - 1, width, 1);
  }, [width, frameCount, scale, loopIn, loopOut, lastFrame]);

  const frameAt = (clientX: number): Frame => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return clamp(
      Math.round(screenXToFrame(clientX - rect.left, scale)),
      0,
      lastFrame,
    );
  };

  const handleStyle =
    "absolute top-0 h-full w-[9px] cursor-ew-resize bg-riff-accent/70 hover:bg-riff-accent";

  return (
    <div
      className="relative select-none"
      style={{ width: Math.max(0, width), height: RULER_HEIGHT }}
    >
      {/* The keyboard path for moving through time lives on the panel itself
          (arrows, Home, End) and on the two loop handles below; this canvas is a
          pointer affordance over the same state, not a separate control. */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block cursor-ew-resize touch-none select-none"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          scrubbing.current = true;
          onScrub(frameAt(event.clientX));
        }}
        onPointerMove={(event) => {
          if (!scrubbing.current) return;
          onScrub(frameAt(event.clientX));
        }}
        onPointerUp={(event) => {
          scrubbing.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          scrubbing.current = false;
        }}
      />

      <button
        type="button"
        aria-label={`Loop starts at ${(loopIn / scale.fps).toFixed(2)} seconds`}
        title="Drag to set where the loop starts"
        className={cn(handleStyle, "rounded-l-[3px]", FEEDBACK, FOCUS_RING)}
        style={{ transform: `translate3d(${inX - HANDLE_WIDTH}px, 0, 0)` }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          loopDrag.current = "in";
          onLoopDragStart();
        }}
        onPointerMove={(event) => {
          if (loopDrag.current !== "in") return;
          onLoopChange(frameAt(event.clientX), loopOut);
        }}
        onPointerUp={(event) => {
          if (loopDrag.current) onLoopDragEnd();
          loopDrag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          if (loopDrag.current) onLoopDragEnd();
          loopDrag.current = null;
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 10 : 1;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            onLoopChange(loopIn - step, loopOut);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            onLoopChange(loopIn + step, loopOut);
          }
        }}
      />

      <button
        type="button"
        aria-label={`Loop ends at ${(loopOut / scale.fps).toFixed(2)} seconds`}
        title="Drag to set where the loop ends"
        className={cn(handleStyle, "rounded-r-[3px]", FEEDBACK, FOCUS_RING)}
        style={{ transform: `translate3d(${outX}px, 0, 0)` }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          loopDrag.current = "out";
          onLoopDragStart();
        }}
        onPointerMove={(event) => {
          if (loopDrag.current !== "out") return;
          onLoopChange(loopIn, frameAt(event.clientX));
        }}
        onPointerUp={(event) => {
          if (loopDrag.current) onLoopDragEnd();
          loopDrag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          if (loopDrag.current) onLoopDragEnd();
          loopDrag.current = null;
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 10 : 1;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            onLoopChange(loopIn, loopOut - step);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            onLoopChange(loopIn, loopOut + step);
          }
        }}
      />
    </div>
  );
}

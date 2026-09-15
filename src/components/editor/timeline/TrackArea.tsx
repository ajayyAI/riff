"use client";

/**
 * The lanes.
 *
 * Everything positions in *content* space and the whole strip is translated by
 * `-scrollLeft`, so horizontal scrolling is one transform on one element rather
 * than a repositioning of every diamond. Content-space coordinates are also what
 * makes hit-testing a pure function of the scale, which is why the maths lives
 * in `geometry.ts` and is tested there rather than being inlined in a handler.
 *
 * A part's own row carries a dot at every frame any of its properties is keyed
 * on. That row is all a beginner ever needs to see: it says where the poses are
 * and it takes a click to go to one. Opening the part is what reveals the
 * per-property rows underneath.
 */

import { useEffect, useRef, useState } from "react";
import type { LayerId, RiffDocument } from "@/editor/model/document";
import { useEditorStore } from "@/editor/ui/context";
import { cn } from "@/lib/utils";
import {
  cycleEasing,
  easingName,
  type KeyRef,
  keyId,
  moveKeyframes,
} from "./edits";
import {
  clamp,
  clampDragOffset,
  frameToContentX,
  KEYFRAME_SIZE,
  keyframesInBand,
  pixelsPerFrame,
  screenXToFrame,
  type TimeScale,
} from "./geometry";
import { FOCUS_RING } from "./parts";
import type { PropertyRow, TimelineRow } from "./rows";

/**
 * Plain names for the motion presets.
 *
 * `edits.ts` names them the way an animator's manual does. This is the word the
 * person who has never opened one sees, and "Smooth" tells them more about what
 * will happen than the name of a curve does.
 */
const MOTION_NAME: Record<string, string> = {
  Hold: "Snap",
  Linear: "Steady",
  Ease: "Soft",
  "Ease in out": "Smooth",
  Overshoot: "Bounce",
};

const motionName = (name: string) => MOTION_NAME[name] ?? name;

type Drag =
  | {
      kind: "keys";
      refs: KeyRef[];
      originDoc: RiffDocument;
      startFrame: number;
      offset: number;
    }
  | { kind: "marquee"; x0: number; y0: number; additive: boolean };

export interface TrackAreaProps {
  rows: readonly TimelineRow[];
  scale: TimeScale;
  frameCount: number;
  viewportWidth: number;
  contentWidth: number;
  bodyHeight: number;
  selectedKeys: ReadonlySet<string>;
  selectedLayerIds: readonly LayerId[];
  onSelectedKeysChange: (next: Set<string>) => void;
  onSelectLayer: (layerId: LayerId, additive: boolean) => void;
  /** Clamped horizontal scroll writer owned by the timeline, for auto-pan. */
  onScrollLeft: (next: number) => void;
}

export function TrackArea({
  bodyHeight,
  contentWidth: contentW,
  frameCount,
  onScrollLeft,
  onSelectLayer,
  onSelectedKeysChange,
  rows,
  scale,
  selectedKeys,
  selectedLayerIds,
  viewportWidth,
}: TrackAreaProps) {
  const store = useEditorStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [marquee, setMarquee] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);

  // Latest scroll writer and scale for the auto-pan loop, which outlives any
  // single render's closures.
  const scrollRef = useRef({ onScrollLeft, scrollLeft: scale.scrollLeft });
  scrollRef.current = { onScrollLeft, scrollLeft: scale.scrollLeft };
  const lastClientX = useRef<number | null>(null);
  const panRaf = useRef(0);

  // Dragging a key past the viewport edge pans the timeline instead of dying at
  // the edge. A rAF loop, not a per-move nudge, so it keeps panning while the
  // pointer is held still against the edge.
  const stopAutoPan = () => {
    if (panRaf.current) cancelAnimationFrame(panRaf.current);
    panRaf.current = 0;
  };
  const tickAutoPan = () => {
    panRaf.current = 0;
    const el = containerRef.current;
    const clientX = lastClientX.current;
    if (dragRef.current && el && clientX !== null) {
      const rect = el.getBoundingClientRect();
      const EDGE = 24;
      const SPEED = 12;
      if (clientX < rect.left + EDGE) {
        scrollRef.current.onScrollLeft(scrollRef.current.scrollLeft - SPEED);
      } else if (clientX > rect.right - EDGE) {
        scrollRef.current.onScrollLeft(scrollRef.current.scrollLeft + SPEED);
      }
    }
    if (dragRef.current) panRaf.current = requestAnimationFrame(tickAutoPan);
  };
  const startAutoPan = () => {
    if (!panRaf.current) panRaf.current = requestAnimationFrame(tickAutoPan);
  };
  useEffect(
    () => () => {
      if (panRaf.current) cancelAnimationFrame(panRaf.current);
    },
    [],
  );

  const ppf = pixelsPerFrame(scale);
  const lastFrame = Math.max(0, frameCount - 1);

  const localPoint = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const propertyRows = rows.filter(
    (row): row is PropertyRow => row.kind === "property",
  );

  const startKeyDrag = (refs: KeyRef[], startFrame: number) => {
    store.begin("timeline:key-drag");
    dragRef.current = {
      kind: "keys",
      refs,
      originDoc: store.getState().doc,
      startFrame,
      offset: 0,
    };
  };

  const selectKey = (
    row: PropertyRow,
    frame: number,
    additive: boolean,
  ): Set<string> => {
    const id = keyId(row.trackId, frame);
    const next = new Set(selectedKeys);
    if (additive) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    } else if (!next.has(id)) {
      next.clear();
      next.add(id);
    }
    onSelectedKeysChange(next);
    return next;
  };

  /** Resolve a selection set against the live document. */
  const refsFor = (selection: ReadonlySet<string>): KeyRef[] => {
    const refs: KeyRef[] = [];
    for (const row of propertyRows) {
      if (!row.track) continue;
      for (const key of row.track.keyframes) {
        if (selection.has(keyId(row.trackId, key.frame))) {
          refs.push({ trackId: row.trackId, frame: key.frame });
        }
      }
    }
    return refs;
  };

  const onKeyPointerDown = (
    event: React.PointerEvent,
    row: PropertyRow,
    frame: number,
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    // Drag the selection the click *produces*, not the one it replaced.
    // Otherwise clicking an unselected diamond drags the old selection.
    const refs = refsFor(
      selectKey(row, frame, event.shiftKey || event.metaKey),
    );
    if (refs.length > 0) startKeyDrag(refs, frame);
    lastClientX.current = event.clientX;
    startAutoPan();
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    lastClientX.current = event.clientX;
    const point = localPoint(event.clientX, event.clientY);
    const frame = screenXToFrame(point.x, scale);

    if (drag.kind === "keys") {
      const offset = clampDragOffset(
        drag.refs.map((r) => r.frame),
        frame - drag.startFrame,
        0,
        lastFrame,
      );
      if (offset === drag.offset) return;
      drag.offset = offset;
      // Recompute from the pointer-down snapshot, never from the last move's
      // result, or a drag that hits a clamp and comes back is off by however
      // far it was clamped.
      store.setDoc(moveKeyframes(drag.originDoc, drag.refs, offset));
      const moved = new Set<string>();
      for (const ref of drag.refs) {
        moved.add(keyId(ref.trackId, ref.frame + offset));
      }
      onSelectedKeysChange(moved);
      return;
    }

    setMarquee({ x0: drag.x0, y0: drag.y0, x1: point.x, y1: point.y });

    const hits = new Set<string>(drag.additive ? selectedKeys : []);
    const top = Math.min(drag.y0, point.y);
    const bottom = Math.max(drag.y0, point.y);
    for (const row of propertyRows) {
      if (row.top + row.height < top || row.top > bottom) continue;
      if (!row.track) continue;
      const frames = row.track.keyframes.map((k) => k.frame);
      for (const index of keyframesInBand(frames, drag.x0, point.x, scale)) {
        hits.add(keyId(row.trackId, frames[index]));
      }
    }
    onSelectedKeysChange(hits);
  };

  const endDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    lastClientX.current = null;
    stopAutoPan();
    setMarquee(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // `commit` records nothing when the document did not move, so a click that
    // only selects a key leaves no undo step to press through.
    if (drag && drag.kind !== "marquee") store.commit();
  };

  const onBackgroundPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const point = localPoint(event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);

    const additive = event.shiftKey || event.metaKey;
    if (!additive) onSelectedKeysChange(new Set());
    dragRef.current = { kind: "marquee", x0: point.x, y0: point.y, additive };
    lastClientX.current = event.clientX;
    startAutoPan();
    setMarquee({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
  };

  return (
    // The lane background is a marquee surface, not a control. Every dot and
    // diamond inside it is a real focusable button with its own keyboard path.
    <div
      ref={containerRef}
      className="relative flex-1 overflow-hidden"
      style={{ minHeight: bodyHeight }}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onLostPointerCapture={endDrag}
    >
      <div
        className="absolute left-0 top-0"
        style={{
          width: contentW,
          transform: `translate3d(${-scale.scrollLeft}px, 0, 0)`,
          willChange: "transform",
        }}
      >
        {rows.map((row) => {
          if (row.kind === "layer") {
            const selected = selectedLayerIds.includes(row.layerId);
            const first = row.keyFrames[0] ?? 0;
            const last = row.keyFrames[row.keyFrames.length - 1] ?? 0;

            return (
              <div
                key={row.id}
                className={cn(
                  "relative",
                  selected ? "bg-riff-accent-soft-opaque" : null,
                )}
                style={{ height: row.height }}
              >
                {row.keyFrames.length > 1 ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute top-1/2 h-px -translate-y-1/2",
                      selected
                        ? "bg-riff-accent/40"
                        : "bg-riff-hairline-strong",
                    )}
                    style={{
                      left: frameToContentX(first, scale),
                      width: (last - first) * ppf,
                    }}
                  />
                ) : null}

                {row.keyFrames.map((frame) => (
                  <button
                    key={frame}
                    type="button"
                    aria-label={`Go to ${row.layer.name} at ${(frame / scale.fps).toFixed(2)} seconds`}
                    title="Go to this pose"
                    className={cn(
                      "absolute top-1/2 grid -translate-x-1/2 -translate-y-1/2",
                      "place-items-center rounded-riff-md p-1.5",
                      FOCUS_RING,
                    )}
                    style={{ left: frameToContentX(frame, scale) }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      onSelectLayer(
                        row.layerId,
                        event.shiftKey || event.metaKey,
                      );
                      store.setFrame(frame);
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "block size-[5px] rounded-full",
                        selected ? "bg-riff-accent" : "bg-riff-keyframe",
                      )}
                    />
                  </button>
                ))}
              </div>
            );
          }

          const keyframes = row.track?.keyframes ?? [];
          const frames = keyframes.map((k) => k.frame);
          const first = frames[0] ?? 0;
          const last = frames[frames.length - 1] ?? 0;

          return (
            <div
              key={row.id}
              className="relative"
              style={{ height: row.height }}
            >
              {frames.length > 1 ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 h-px -translate-y-1/2 bg-riff-hairline-strong"
                  style={{
                    left: frameToContentX(first, scale),
                    width: (last - first) * ppf,
                  }}
                />
              ) : null}

              {keyframes.map((key) => {
                const id = keyId(row.trackId, key.frame);
                const selected = selectedKeys.has(id);
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`${row.label} key at ${(key.frame / scale.fps).toFixed(2)} seconds`}
                    title={`${motionName(easingName(key.easing))}, drag to move it, double-click to change how it moves`}
                    className={cn(
                      // 9px glyph, 21px hit target. Padding, not a bigger glyph.
                      "absolute top-1/2 grid -translate-x-1/2 -translate-y-1/2",
                      "place-items-center rounded-riff-md p-1.5 cursor-ew-resize",
                      FOCUS_RING,
                    )}
                    style={{ left: frameToContentX(key.frame, scale) }}
                    onPointerDown={(event) =>
                      onKeyPointerDown(event, row, key.frame)
                    }
                    onPointerMove={handlePointerMove}
                    onPointerUp={endDrag}
                    onLostPointerCapture={endDrag}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      store.begin(null);
                      store.setDoc(
                        cycleEasing(
                          store.getState().doc,
                          row.trackId,
                          key.frame,
                        ),
                      );
                      store.commit();
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="block rotate-45 rounded-[1.5px]"
                      style={{
                        width: KEYFRAME_SIZE,
                        height: KEYFRAME_SIZE,
                        background: key.easing.hold
                          ? "transparent"
                          : selected
                            ? "var(--riff-accent)"
                            : "var(--riff-keyframe)",
                        border: `1.5px solid ${
                          selected
                            ? "var(--riff-accent)"
                            : "var(--riff-keyframe)"
                        }`,
                      }}
                    />
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {marquee ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute border border-riff-accent bg-riff-accent-soft/40"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      ) : null}

      {/* Past the end of the animation, so the lane stops where the rig does. */}
      {frameToContentX(frameCount, scale) - scale.scrollLeft < viewportWidth ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 bg-riff-hairline/60"
          style={{
            left: Math.max(
              0,
              clamp(
                frameToContentX(frameCount, scale) - scale.scrollLeft,
                0,
                viewportWidth,
              ),
            ),
            right: 0,
          }}
        />
      ) : null}
    </div>
  );
}

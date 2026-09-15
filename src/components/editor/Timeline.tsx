"use client";

import { useEffect, useRef, useState } from "react";
import { evalTrack } from "@/editor/model/animation";
import type { Frame, LayerId } from "@/editor/model/document";
import { useEditor, useEditorStore } from "@/editor/ui/context";
import { cn } from "@/lib/utils";
import {
  addKeyframeAt,
  deleteKeyframes,
  ensureTrack,
  type KeyRef,
  keyId,
  keyPartsAt,
  readAnimatable,
  setDocumentFrameCount,
  setLayerCollapsed,
  setLayerVisible,
  setLoopRange,
} from "./timeline/edits";
import {
  clamp,
  clampScrollLeft,
  contentWidth,
  fitZoom,
  frameToScreenX,
  horizontalPanDelta,
  LANE_INSET,
  LAYER_COLUMN_WIDTH,
  makeScale,
  PANEL_HEIGHT_COLLAPSED,
  PANEL_HEIGHT_DEFAULT,
  PANEL_HEIGHT_MIN,
  playheadHandleLeft,
  RULER_HEIGHT,
  SCROLLBAR_HEIGHT,
  screenXToFrame,
  type TimeScale,
  TRANSPORT_HEIGHT,
  wheelZoomFactor,
  zoomAtCursor,
  zoomByFactor,
} from "./timeline/geometry";
import { LayerColumn } from "./timeline/LayerColumn";
import { FEEDBACK, FOCUS_RING, PanelLabel } from "./timeline/parts";
import { Ruler } from "./timeline/Ruler";
import {
  ANIMATABLE_PROPERTIES,
  flattenRows,
  rowsHeight,
} from "./timeline/rows";
import { TrackArea } from "./timeline/TrackArea";
import { Transport } from "./timeline/Transport";
import { usePlayback } from "./timeline/usePlayback";

export interface TimelineProps {
  className?: string;
}

/**
 * What a part gets keyed on when it has never been keyed before.
 *
 * Rotation first, then position: a pose in a cutout rig is one angle per joint,
 * and keying all seven properties would leave five the user never asked for.
 */
const _POSE_DEFAULTS = ["transform.rotation", "transform.x", "transform.y"];

/**
 * The timeline panel.
 *
 * Layout is a transport bar, a header row (part-column header plus ruler), and a
 * body that scrolls vertically as one unit and horizontally as one shared
 * `scrollLeft`. The ruler sits outside the vertical scroller rather than being
 * `position: sticky` inside it, because sticky needs the scroller to own both
 * axes and this component owns the horizontal axis itself. That is what makes
 * zoom-at-cursor exact.
 */
export function Timeline({ className }: TimelineProps) {
  const store = useEditorStore();

  const doc = useEditor((state) => state.doc);
  const frame = useEditor((state) => state.ui.frame);
  const playing = useEditor((state) => state.ui.playing);
  const loop = useEditor((state) => state.ui.loop);
  const onionSkin = useEditor((state) => state.ui.onionSkin);
  const zoom = useEditor((state) => state.ui.timelineZoom);
  const panelHeight = useEditor((state) => state.ui.timelineHeight);
  const selectedLayerIds = useEditor((state) => state.ui.selection.layerIds);

  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const playheadLayerRef = useRef<HTMLDivElement>(null);
  // Read by the wheel listener, which is registered once and must not be torn
  // down and re-attached on every scroll tick.
  const scrollLeftRef = useRef(0);
  scrollLeftRef.current = scrollLeft;

  const fps = doc.fps > 0 ? doc.fps : 24;
  const frameCount = Math.max(1, doc.frameCount);
  const rows = flattenRows(doc, selectedLayerIds);
  const bodyHeight = rowsHeight(rows);

  const loopIn = Math.min(Math.max(0, doc.loopIn), frameCount - 1);
  const loopOut = Math.min(Math.max(loopIn + 1, doc.loopOut), frameCount);

  const unclamped = makeScale(fps, zoom, 0, LANE_INSET);
  const scale = makeScale(
    fps,
    zoom,
    clampScrollLeft(scrollLeft, frameCount, unclamped, viewportWidth),
    LANE_INSET,
  );
  const contentW = contentWidth(frameCount, scale, viewportWidth);

  // The single writer for horizontal scroll. Raw `setScrollLeft` calls with
  // unclamped values let the state diverge from what is rendered, which is how
  // a fast wheel plus pinch sequence ends up jumping.
  const scrollTo = (next: number) => {
    setScrollLeft(clampScrollLeft(next, frameCount, unclamped, viewportWidth));
  };
  // The wheel listener is registered once, so it reaches the latest writer
  // through a ref rather than closing over a stale one.
  const scrollToRef = useRef(scrollTo);
  scrollToRef.current = scrollTo;

  // The rAF loop's inputs are the playback inputs and nothing else, so panel
  // state changing (a scroll, a resize) never restarts it mid-playback.
  usePlayback(store, playing, fps, loopIn, loopOut, loop);

  // --------------------------------------------------------------- measuring

  useEffect(() => {
    const lanes = lanesRef.current;
    const body = bodyRef.current;
    if (!lanes || !body) return;

    const measure = () => {
      setViewportWidth(lanes.clientWidth);
      // Pad the ruler row by the body's scrollbar so the ruler and the lanes
      // share a right edge on platforms with classic scrollbars.
      setScrollbarWidth(body.offsetWidth - body.clientWidth);
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(lanes);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  // ------------------------------------------------------------------- zoom

  /**
   * Wheel: command or control zooms at the cursor, everything else pans.
   *
   * Registered by hand rather than via `onWheel` because the handler has to call
   * `preventDefault`, and React attaches wheel listeners passively.
   */
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;

    const onWheel = (event: WheelEvent) => {
      const lanes = lanesRef.current;
      if (!lanes) return;
      const rect = lanes.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;

      // A trackpad pinch arrives as a wheel event with ctrlKey set, so pinch
      // and command-scroll are the same code path and cannot drift apart.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const current = store.getState().ui;
        const base = makeScale(
          fps,
          current.timelineZoom,
          scrollLeftRef.current,
          LANE_INSET,
        );
        const next = zoomAtCursor(
          base,
          cursorX,
          current.timelineZoom * wheelZoomFactor(event.deltaY),
        );
        store.setUi({ timelineZoom: next.zoom });
        scrollToRef.current(next.scrollLeft);
        return;
      }

      const pan = horizontalPanDelta(
        event.deltaX,
        event.deltaY,
        event.shiftKey,
      );
      if (pan !== 0) {
        event.preventDefault();
        scrollToRef.current(scrollLeftRef.current + pan);
      }
      // Vertical falls through to the body's native scroll.
    };

    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [store, fps]);

  const zoomAtViewportCentre = (factor: number) => {
    const next = zoomByFactor(scale, viewportWidth / 2, factor);
    store.setUi({ timelineZoom: next.zoom });
    scrollTo(next.scrollLeft);
  };

  const zoomToFit = () => {
    store.setUi({ timelineZoom: fitZoom(frameCount, fps, viewportWidth) });
    scrollTo(0);
  };

  /**
   * Fit the whole animation across the lanes once, as soon as there is a lane
   * to measure.
   *
   * A two-second rig at 100% fills a fifth of the panel and leaves the rest
   * grey, which reads as "nothing here". Fitting once, and only once, means the
   * first thing anyone sees is their whole animation, and any zoom they choose
   * afterwards sticks.
   */
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || viewportWidth <= 0) return;
    fittedRef.current = true;
    store.setUi({
      timelineZoom: fitZoom(
        store.getState().doc.frameCount,
        store.getState().doc.fps || 24,
        viewportWidth,
      ),
    });
  }, [store, viewportWidth]);

  // Keep the playhead on screen during playback, without fighting a user who is
  // scrolling: only nudge when it has actually left the viewport.
  useEffect(() => {
    if (!playing || viewportWidth <= 0) return;
    const x = frameToScreenX(frame, scale);
    if (x >= 0 && x <= viewportWidth - 24) return;
    scrollToRef.current(scale.scrollLeft + x - viewportWidth * 0.2);
  }, [playing, frame, viewportWidth, scale]);

  // ---------------------------------------------------------------- keys

  const propertyRows = rows.filter((row) => row.kind === "property");

  const refsFromSelection = (): KeyRef[] => {
    const refs: KeyRef[] = [];
    for (const row of propertyRows) {
      if (!row.track) continue;
      for (const key of row.track.keyframes) {
        if (selectedKeys.has(keyId(row.trackId, key.frame))) {
          refs.push({ trackId: row.trackId, frame: key.frame });
        }
      }
    }
    return refs;
  };

  const deleteSelectedKeys = () => {
    const refs = refsFromSelection();
    if (refs.length === 0) return;
    store.begin(null);
    store.setDoc(deleteKeyframes(store.getState().doc, refs));
    store.commit();
    setSelectedKeys(new Set());
  };

  const toggleKeyOnRow = (rowId: string) => {
    const row = propertyRows.find((candidate) => candidate.id === rowId);
    if (!row) return;

    store.begin(null);
    const live = store.getState().doc;
    const layer = live.layers[row.layerId];
    const prop = layer ? readAnimatable(layer, row.propertyPath) : null;
    const driven =
      prop?.kind === "track" ? live.tracks[prop.trackId] : undefined;

    // A property that is still one number has no key to remove: creating its
    // seeded values *is* the add. Checking first avoids a create-then-delete
    // that would strand an empty set of values on the part.
    if (!driven) {
      store.setDoc(ensureTrack(live, row.layerId, row.propertyPath, frame).doc);
      store.commit();
      return;
    }
    const existing = driven.keyframes.some((key) => key.frame === frame);
    store.setDoc(
      existing
        ? deleteKeyframes(live, [{ trackId: driven.id, frame }])
        : addKeyframeAt(live, driven.id, frame, evalTrack(driven, frame)),
    );
    store.commit();
  };

  /**
   * Key parts at the playhead.
   *
   * Every property a part already animates is keyed, so pressing K twice in two
   * places makes a pose-to-pose move out of whatever was already moving. A part
   * that animates nothing yet gets rotation and position seeded, because that
   * is what a cutout pose is made of and keying all seven properties would leave
   * five nobody asked for.
   */
  const keyParts = (ids: readonly LayerId[]) => {
    if (ids.length === 0) return;
    store.begin(null);
    store.setDoc((current) =>
      keyPartsAt(current, ids, frame, ANIMATABLE_PROPERTIES),
    );
    store.commit();
  };

  const keySelection = () => keyParts(selectedLayerIds);
  const keyEverything = () =>
    keyParts(doc.artboards[doc.activeArtboardId]?.layerIds ?? []);

  const canAddKeyframe = selectedLayerIds.length > 0;

  // -------------------------------------------------------------- document

  const selectLayer = (layerId: LayerId, additive: boolean) => {
    if (additive) store.toggleSelect(layerId);
    else store.select([layerId]);
  };

  const setDuration = (seconds: number) => {
    const nextCount = Math.max(1, Math.round(seconds * fps));
    if (nextCount === doc.frameCount) return;
    store.begin("timeline:duration");
    // Shortening the animation has to bring the loop with it, or it is left
    // claiming frames the document no longer has.
    store.setDoc((prev) => setDocumentFrameCount(prev, nextCount));
    store.commit();
  };

  const loopDragging = useRef(false);

  const changeLoop = (nextIn: Frame, nextOut: Frame) => {
    if (!loopDragging.current) store.begin("timeline:loop");
    store.setDoc((prev) => setLoopRange(prev, nextIn, nextOut));
    if (!loopDragging.current) store.commit();
  };

  // --------------------------------------------------------------- resizing

  const resizeRef = useRef<{ y: number; height: number } | null>(null);

  const onResizePointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { y: event.clientY, height: panelHeight };
  };

  const onResizePointerMove = (event: React.PointerEvent) => {
    const state = resizeRef.current;
    if (!state) return;
    // Dragging up grows the panel, so the delta is inverted. Never transitioned:
    // a resize that lags the pointer reads as a broken drag.
    store.setUi({
      timelineHeight: Math.max(
        PANEL_HEIGHT_MIN,
        state.height - (event.clientY - state.y),
      ),
    });
  };

  const toggleCollapsed = () => {
    store.setUi({
      timelineHeight:
        panelHeight <= PANEL_HEIGHT_COLLAPSED
          ? PANEL_HEIGHT_DEFAULT
          : PANEL_HEIGHT_COLLAPSED,
    });
  };

  // --------------------------------------------------------------- keyboard

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Typing in the length field must not scrub the playhead.
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement) return;

    const meta = event.metaKey || event.ctrlKey;

    if (meta && (event.key === "=" || event.key === "+")) {
      event.preventDefault();
      zoomAtViewportCentre(1.4);
      return;
    }
    if (meta && event.key === "-") {
      event.preventDefault();
      zoomAtViewportCentre(1 / 1.4);
      return;
    }
    if (meta || event.altKey) return;

    switch (event.key) {
      case " ":
        event.preventDefault();
        store.setUi({ playing: !playing });
        break;
      case "ArrowLeft":
        event.preventDefault();
        store.stepFrame(event.shiftKey ? -10 : -1);
        break;
      case "ArrowRight":
        event.preventDefault();
        store.stepFrame(event.shiftKey ? 10 : 1);
        break;
      case "Home":
        event.preventDefault();
        store.setFrame(0);
        break;
      case "End":
        event.preventDefault();
        store.setFrame(frameCount - 1);
        break;
      case "Delete":
      case "Backspace":
        if (selectedKeys.size > 0) {
          event.preventDefault();
          deleteSelectedKeys();
        }
        break;
      case "Z":
        if (event.shiftKey) {
          event.preventDefault();
          zoomToFit();
        }
        break;
      // K and Shift+K are global (see `shortcuts.ts`): a key that only works
      // when the timeline happens to hold focus is a key that looks broken.
      case "l":
      case "L":
        event.preventDefault();
        store.setUi({ loop: !loop });
        break;
      default:
        break;
    }
  };

  // ----------------------------------------------------------------- render

  const playheadX = frameToScreenX(frame, scale);
  const playheadVisible = playheadX >= -8 && playheadX <= viewportWidth + 8;
  const collapsed = panelHeight <= PANEL_HEIGHT_COLLAPSED;
  const maxScroll = Math.max(0, contentW - viewportWidth);

  return (
    // A focusable region that owns the transport shortcuts. Every control inside
    // it is a real button with its own handler.
    <section
      ref={rootRef}
      aria-label="Time"
      // Programmatically focusable, but not in the tab order: every control
      // inside the panel is independently tabbable and `keydown` bubbles up to
      // here, so the shortcuts work whenever focus is anywhere in the panel
      // without adding a dead stop to the tab sequence.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cn(
        // No border, no shadow: the desk supplies the separation.
        "riff-glass relative flex flex-col overflow-hidden rounded-riff-panel",
        "select-none",
        FOCUS_RING,
        className,
      )}
      style={{ height: panelHeight }}
    >
      {/* Resize grip. A 6px strip is the smallest target that still feels
          deliberate; the visible grabber only appears on hover so the panel
          edge stays quiet. */}
      {/* biome-ignore lint/a11y/useSemanticElements: an <hr> can be neither
          focused nor dragged; a focusable separator carrying a value is the
          established pattern for a resize handle. */}
      <div
        role="separator"
        aria-label="Resize the time panel"
        aria-orientation="horizontal"
        aria-valuenow={Math.round(panelHeight)}
        aria-valuemin={PANEL_HEIGHT_MIN}
        aria-valuemax={1200}
        tabIndex={0}
        className="group absolute inset-x-0 top-0 z-30 grid h-1.5 cursor-ns-resize place-items-center"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={(event) => {
          resizeRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          resizeRef.current = null;
        }}
        onDoubleClick={toggleCollapsed}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            store.setUi({
              timelineHeight: Math.max(
                PANEL_HEIGHT_MIN,
                panelHeight + (event.key === "ArrowUp" ? 16 : -16),
              ),
            });
          }
        }}
      >
        <span
          className={cn(
            "h-1 w-10 rounded-full bg-transparent group-hover:bg-riff-hairline-strong",
            FEEDBACK,
          )}
        />
      </div>

      {/* Double-clicking the transport bar collapses the panel, per the lock. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a redundant
          shortcut for the resize separator above, which is keyboard-operable. */}
      <div onDoubleClick={toggleCollapsed}>
        <Transport
          frame={frame}
          fps={fps}
          frameCount={frameCount}
          playing={playing}
          loop={loop}
          zoom={zoom}
          canAddKeyframe={canAddKeyframe}
          selectedKeyframeCount={selectedKeys.size}
          onTogglePlay={() => store.setUi({ playing: !playing })}
          onSkipToStart={() => store.setFrame(0)}
          onAddKeyframe={keySelection}
          onKeyAll={keyEverything}
          onToggleLoop={() => store.setUi({ loop: !loop })}
          onionSkin={onionSkin}
          onToggleOnionSkin={() => store.setUi({ onionSkin: !onionSkin })}
          onZoomIn={() => zoomAtViewportCentre(1.4)}
          onZoomOut={() => zoomAtViewportCentre(1 / 1.4)}
          onZoomFit={zoomToFit}
          onDurationChange={setDuration}
          onDurationDragStart={() => store.begin("timeline:duration")}
          onDurationDragEnd={() => store.commit()}
        />
      </div>

      {collapsed ? null : (
        <>
          <div className="flex shrink-0 border-riff-hairline border-b bg-black/[0.02]">
            <div
              className="flex shrink-0 items-center border-riff-hairline border-r px-3"
              style={{ width: LAYER_COLUMN_WIDTH, height: RULER_HEIGHT }}
            >
              <PanelLabel>Parts</PanelLabel>
            </div>
            <div className="relative flex-1 overflow-hidden">
              <Ruler
                width={viewportWidth}
                frameCount={frameCount}
                scale={scale}
                loopIn={loopIn}
                loopOut={loopOut}
                onScrub={(next) => store.setFrame(next)}
                onLoopChange={changeLoop}
                onLoopDragStart={() => {
                  loopDragging.current = true;
                  store.begin("timeline:loop");
                }}
                onLoopDragEnd={() => {
                  loopDragging.current = false;
                  store.commit();
                }}
              />
            </div>
          </div>

          <div
            ref={bodyRef}
            className="timeline-scroll riff-scroll relative flex flex-1 overflow-x-hidden overflow-y-auto bg-black/[0.02]"
          >
            <LayerColumn
              rows={rows}
              selectedLayerIds={selectedLayerIds}
              playheadFrame={frame}
              onSelectLayer={selectLayer}
              onToggleCollapsed={(layerId) => {
                // Opening and closing a part is persisted state but not an
                // edit: nobody wants undo to reopen a disclosure triangle.
                const layer = doc.layers[layerId];
                if (!layer) return;
                store.setDoc(setLayerCollapsed(doc, layerId, !layer.collapsed));
              }}
              onToggleVisible={(layerId) => {
                const layer = doc.layers[layerId];
                if (!layer) return;
                store.begin(null);
                store.setDoc(
                  setLayerVisible(
                    store.getState().doc,
                    layerId,
                    !layer.visible,
                  ),
                );
                store.commit();
              }}
              onToggleKeyframe={toggleKeyOnRow}
            />
            <div ref={lanesRef} className="relative flex flex-1">
              <TrackArea
                rows={rows}
                scale={scale}
                frameCount={frameCount}
                viewportWidth={viewportWidth}
                contentWidth={contentW}
                bodyHeight={bodyHeight}
                selectedKeys={selectedKeys}
                selectedLayerIds={selectedLayerIds}
                onSelectedKeysChange={setSelectedKeys}
                onSelectLayer={selectLayer}
                onScrollLeft={scrollTo}
              />
            </div>
          </div>

          {/* Horizontal scrollbar. The lanes own their scroll offset, which is
              what makes zoom-at-cursor exact, so the scrollbar has to be ours
              too. It starts at the part column so it never runs underneath it.
              Clicking the track jumps; dragging the thumb scrolls. */}
          <div
            className="relative shrink-0"
            style={{
              height: SCROLLBAR_HEIGHT,
              marginLeft: LAYER_COLUMN_WIDTH,
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || event.target !== event.currentTarget) {
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio =
                rect.width <= 0 ? 0 : (event.clientX - rect.left) / rect.width;
              scrollTo(ratio * maxScroll);
            }}
          >
            {maxScroll > 0 ? (
              <ScrollThumb
                scrollLeft={scale.scrollLeft}
                maxScroll={maxScroll}
                viewportWidth={viewportWidth}
                contentWidth={contentW}
                onScroll={scrollTo}
              />
            ) : null}
          </div>

          {/* Playhead: a hairline through the whole lane area plus a grabbable
              head in the ruler, inside one clipped overlay so neither can escape
              the lane viewport. The overlay ignores pointer events; only the
              head takes them back. */}
          <div
            ref={playheadLayerRef}
            className="pointer-events-none absolute overflow-hidden"
            style={{
              left: LAYER_COLUMN_WIDTH,
              right: scrollbarWidth,
              top: TRANSPORT_HEIGHT,
              bottom: SCROLLBAR_HEIGHT,
            }}
          >
            {playheadVisible ? (
              <>
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 w-px bg-riff-accent"
                  style={{
                    // Never transitioned. A playhead that eases toward the
                    // pointer is the canonical example of motion making a tool
                    // feel broken.
                    transform: `translate3d(${playheadX}px, 0, 0)`,
                    willChange: "transform",
                  }}
                />
                <PlayheadHandle
                  x={playheadX}
                  frame={frame}
                  frameCount={frameCount}
                  scale={scale}
                  viewportWidth={viewportWidth}
                  layerRef={playheadLayerRef}
                  onScrub={(next) => store.setFrame(next)}
                />
              </>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function ScrollThumb({
  contentWidth: contentW,
  maxScroll,
  onScroll,
  scrollLeft,
  viewportWidth,
}: {
  scrollLeft: number;
  maxScroll: number;
  viewportWidth: number;
  contentWidth: number;
  onScroll: (next: number) => void;
}) {
  const dragRef = useRef<{ x: number; scrollLeft: number } | null>(null);
  const trackWidth = viewportWidth;
  const thumbWidth = Math.max(32, (viewportWidth / contentW) * trackWidth);
  const travel = Math.max(1, trackWidth - thumbWidth);
  const x = (scrollLeft / maxScroll) * travel;

  return (
    <div
      role="scrollbar"
      aria-label="Scroll through time"
      aria-controls="riff-lanes"
      aria-orientation="horizontal"
      aria-valuenow={Math.round((scrollLeft / maxScroll) * 100)}
      tabIndex={0}
      className={cn(
        "absolute top-[3px] h-1 rounded-full bg-riff-hairline-strong",
        "hover:bg-riff-faint cursor-grab active:cursor-grabbing",
        FEEDBACK,
        FOCUS_RING,
      )}
      style={{ width: thumbWidth, transform: `translate3d(${x}px, 0, 0)` }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { x: event.clientX, scrollLeft };
      }}
      onPointerMove={(event) => {
        const state = dragRef.current;
        if (!state) return;
        const delta = ((event.clientX - state.x) / travel) * maxScroll;
        onScroll(clamp(state.scrollLeft + delta, 0, maxScroll));
      }}
      onPointerUp={(event) => {
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        const step = viewportWidth / 4;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onScroll(clamp(scrollLeft - step, 0, maxScroll));
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onScroll(clamp(scrollLeft + step, 0, maxScroll));
        } else if (event.key === "Home") {
          event.preventDefault();
          onScroll(0);
        } else if (event.key === "End") {
          event.preventDefault();
          onScroll(maxScroll);
        }
      }}
    />
  );
}

/** Keeps the handle geometry and its clamp in agreement. */
const PLAYHEAD_HANDLE_WIDTH = 13;

/**
 * The grabbable head, sitting in the ruler.
 *
 * A separate element from the line because the line ignores pointer events
 * across the whole body, and a 1px line you have to hit exactly is not a handle.
 */
function PlayheadHandle({
  frame,
  frameCount,
  layerRef,
  onScrub,
  scale,
  viewportWidth,
  x,
}: {
  x: number;
  frame: number;
  frameCount: number;
  onScrub: (frame: Frame) => void;
  scale: TimeScale;
  viewportWidth: number;
  layerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const draggingRef = useRef(false);

  return (
    <button
      type="button"
      aria-label={`Playhead, ${(frame / scale.fps).toFixed(2)} seconds`}
      title="Drag to move through time"
      className={cn(
        "pointer-events-auto absolute z-20 h-[14px] w-[13px]",
        "cursor-ew-resize rounded-[3px] bg-riff-accent",
        FOCUS_RING,
      )}
      style={{
        top: 3,
        transform: `translate3d(${playheadHandleLeft(x, PLAYHEAD_HANDLE_WIDTH, viewportWidth)}px, 0, 0)`,
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        draggingRef.current = true;
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return;
        const rect = layerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const next = screenXToFrame(event.clientX - rect.left, scale);
        onScrub(clamp(Math.round(next), 0, frameCount - 1));
      }}
      onPointerUp={(event) => {
        draggingRef.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        draggingRef.current = false;
      }}
    />
  );
}

export default Timeline;

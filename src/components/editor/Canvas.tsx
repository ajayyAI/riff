"use client";

/**
 * The canvas surface.
 *
 * Two stacked canvases, and the split is the most important decision in this
 * file. Artwork changes when the document or the frame changes; overlays change
 * on every pointer move. Painting them together would mean re-filling every part
 * to move one handle a pixel.
 *
 * This component subscribes to the store *imperatively* and repaints. It does
 * not re-render on frame changes: playing a rig at twenty-four frames a second
 * must not cost twenty-four React reconciliations for a picture React does not
 * draw.
 */

import { useEffect, useRef } from "react";
import { evalAnimatable } from "@/editor/model/animation";
import {
  constant,
  INK,
  type LayerId,
  type PathGeometry,
  rgbaToCss,
} from "@/editor/model/document";
import { contoursToGeometry } from "@/editor/model/polyline";
import {
  activeArtboard,
  ancestors,
  duplicateParts,
  isOffPage,
  jointPosition,
  patchLayer,
} from "@/editor/model/rig";
import {
  BRUSH_CLOSE_DISTANCE,
  type BrushSample,
  brushStroke,
  ellipsePath,
  rectPath,
} from "@/editor/model/shapes";
import {
  hitTest,
  PathCache,
  type PathCache as PathCacheType,
  renderScene,
} from "@/editor/render/renderer";
import {
  type ResolvedScene,
  resolveScene,
  sceneBounds,
  selectionBounds,
} from "@/editor/render/scene";
import { fitToRect, sharp, toDocument, zoomBy } from "@/editor/render/viewport";
import type { EditorStore, Viewport } from "@/editor/store";
import { useEditorStore } from "@/editor/ui/context";
import { addDrawnPart, nextPartName, setJointAt } from "./draw";
import {
  anchorForHandle,
  axesForHandle,
  cursorForHandle,
  type HandleId,
  handlePositions,
  hitHandle,
  hitRotateHandle,
  ROTATE_HANDLE_RADIUS,
  rotateHandlePosition,
  type ScreenRect,
} from "./handles";
import { collectCandidates, snapAxis, spanOf } from "./snapping";
import { canvasSafeArea } from "./styles";
import {
  type MoveOrigin,
  moveLayers,
  neighbourKeyFrames,
  readAnimatable,
  type ScaleOrigin,
  scaleLayers,
  upsertKeyframe,
} from "./timeline/edits";

/** Overlay colours, read at runtime so a theme change needs no rebuild. */
function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return v.trim() || fallback;
}

const HANDLE_SIZE = 7;
/** How near two edges must be, in screen pixels, before they snap together. */
const SNAP_TOLERANCE = 6;
/** A press shorter than this never becomes a drag. */
const DRAG_THRESHOLD = 3;

type PointerMode =
  | "none"
  | "pan"
  | "marquee"
  | "move"
  | "scale"
  | "rotate"
  | "brush"
  | "shape"
  | "joint";

interface RotateOrigin {
  layerId: LayerId;
  rotation: number;
  /** Angle from the rotation centre to the pointer when the drag started. */
  startAngle: number;
}

interface Pointer {
  mode: PointerMode;
  startX: number;
  startY: number;
  originViewport: Viewport;
  currentX: number;
  currentY: number;
  startDocX: number;
  startDocY: number;
  moveOrigins: MoveOrigin[];
  moveKey: string | null;
  moved: boolean;
  scaleHandle: HandleId | null;
  scaleAnchorDoc: { x: number; y: number };
  scaleStartDoc: { x: number; y: number };
  scaleOrigins: ScaleOrigin[];
  rotateOrigins: RotateOrigin[];
  rotateCentre: { x: number; y: number };
  /** How far the current rotate drag has turned, for the readout. */
  rotateDegrees: number;
  /** Live brush trail, in document space. */
  samples: BrushSample[];
  /** Guides to draw while a snap is active, in document space. */
  guideX: number | null;
  guideY: number | null;
}

export function Canvas() {
  const store = useEditorStore();
  const wrapRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const art = artRef.current;
    const overlay = overlayRef.current;
    if (!wrap || !art || !overlay) return;

    const artCtx = art.getContext("2d");
    const overlayCtx = overlay.getContext("2d");
    if (!artCtx || !overlayCtx) return;

    const cache: PathCacheType = new PathCache();
    const size = { width: 0, height: 0 };
    let dpr = 1;
    let raf = 0;
    let scene: ResolvedScene | null = null;
    let lastDocRef: unknown = null;
    let lastFrame = -1;
    let lastBlink = false;

    const pointer: Pointer = {
      mode: "none",
      startX: 0,
      startY: 0,
      originViewport: { x: 0, y: 0, scale: 1 },
      currentX: 0,
      currentY: 0,
      startDocX: 0,
      startDocY: 0,
      moveOrigins: [],
      moveKey: null,
      moved: false,
      scaleHandle: null,
      scaleAnchorDoc: { x: 0, y: 0 },
      scaleStartDoc: { x: 0, y: 0 },
      scaleOrigins: [],
      rotateOrigins: [],
      rotateCentre: { x: 0, y: 0 },
      rotateDegrees: 0,
      samples: [],
      guideX: null,
      guideY: null,
    };
    let spaceHeld = false;
    let gestureCount = 0;
    let hoverHandle: HandleId | null = null;
    let hoverRotate = false;
    /** Points the pen tool has placed so far, in document space. */
    let penPoints: number[] = [];

    const selectionScreenRect = (
      current: ResolvedScene,
      viewport: Viewport,
      selected: readonly string[],
    ): ScreenRect | null => {
      const bounds = selectionBounds(current, selected as LayerId[]);
      if (!bounds) return null;
      const [x0, y0, x1, y1] = bounds;
      return {
        x: x0 * viewport.scale + viewport.x,
        y: y0 * viewport.scale + viewport.y,
        width: (x1 - x0) * viewport.scale,
        height: (y1 - y0) * viewport.scale,
      };
    };

    // ------------------------------------------------------------- painting

    const paint = () => {
      raf = 0;
      const { doc, ui } = store.getState();

      if (
        doc !== lastDocRef ||
        ui.frame !== lastFrame ||
        ui.previewBlink !== lastBlink
      ) {
        scene = resolveScene(doc, ui.frame, { blinking: ui.previewBlink });
        lastDocRef = doc;
        lastFrame = ui.frame;
        lastBlink = ui.previewBlink;
      }
      if (!scene) return;

      const base = {
        viewport: ui.viewport,
        width: size.width,
        height: size.height,
        dpr,
      };

      // Ghost poses first, so the real one sits on top of them. The first pass
      // is the one that clears and paints the page, whichever pass that is.
      let first = true;
      if (ui.onionSkin) {
        const { before, after } = neighbourKeyFrames(doc, ui.frame);
        for (const at of [before, after]) {
          if (at === null) continue;
          renderScene(
            artCtx,
            resolveScene(doc, at, { blinking: ui.previewBlink }),
            cache,
            { ...base, clear: first, background: first, alpha: 0.22 },
          );
          first = false;
        }
      }
      renderScene(artCtx, scene, cache, {
        ...base,
        clear: first,
        background: first,
      });

      paintOverlay(scene, ui.viewport, ui.selection.layerIds);
    };

    const paintOverlay = (
      current: ResolvedScene,
      viewport: Viewport,
      selected: readonly LayerId[],
    ) => {
      overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      overlayCtx.clearRect(0, 0, size.width, size.height);
      overlayCtx.setTransform(1, 0, 0, 1, 0, 0);

      const accent = token("--riff-accent", "#0A84FF");
      const guideColour = token("--riff-guide", "#FF3B30");
      const { doc, ui } = store.getState();
      const artboard = current.artboard;

      if (artboard) {
        const x = sharp(viewport.x, dpr);
        const y = sharp(viewport.y, dpr);
        overlayCtx.strokeStyle = token("--riff-hairline-strong", "#0000001F");
        overlayCtx.lineWidth = 1;
        overlayCtx.strokeRect(
          x * dpr,
          y * dpr,
          artboard.width * viewport.scale * dpr,
          artboard.height * viewport.scale * dpr,
        );
      }

      /** True when this part and everything it hangs off are visible. */
      const shown = (id: LayerId): boolean =>
        doc.layers[id]?.visible === true &&
        ancestors(doc, id).every((up) => doc.layers[up]?.visible === true);

      // The chain up to the root, drawn faintly: selecting a hand should show
      // at a glance what it is hanging off. A hidden part gets none of this:
      // a crosshair floating over nothing reads as a bug.
      if (selected.length === 1 && shown(selected[0])) {
        const chain = ancestors(doc, selected[0]);
        if (chain.length > 0) {
          overlayCtx.save();
          overlayCtx.globalAlpha = 0.45;
          overlayCtx.strokeStyle = accent;
          overlayCtx.lineWidth = 1 * dpr;
          overlayCtx.setLineDash([3 * dpr, 3 * dpr]);
          for (const id of chain) {
            const rect = selectionScreenRect(current, viewport, [id]);
            if (!rect) continue;
            overlayCtx.strokeRect(
              sharp(rect.x, dpr) * dpr,
              sharp(rect.y, dpr) * dpr,
              rect.width * dpr,
              rect.height * dpr,
            );
          }
          overlayCtx.restore();
          paintChainLinks(viewport, selected[0], accent);
        }
      }

      // Anything over the edge of the page, outlined faintly. The page is what
      // the exported player uses as its canvas, so this is the difference
      // between a part being there and being gone.
      if (artboard) {
        overlayCtx.save();
        overlayCtx.strokeStyle = guideColour;
        overlayCtx.globalAlpha = 0.45;
        overlayCtx.lineWidth = 1 * dpr;
        overlayCtx.setLineDash([4 * dpr, 4 * dpr]);
        for (const item of current.items) {
          if (!isOffPage(doc, item.layerId, ui.frame)) continue;
          const [x0, y0, x1, y1] = item.bounds;
          overlayCtx.strokeRect(
            sharp(x0 * viewport.scale + viewport.x, dpr) * dpr,
            sharp(y0 * viewport.scale + viewport.y, dpr) * dpr,
            (x1 - x0) * viewport.scale * dpr,
            (y1 - y0) * viewport.scale * dpr,
          );
        }
        overlayCtx.restore();
      }

      const rect = selectionScreenRect(current, viewport, selected);
      if (rect && pointer.mode !== "brush" && pointer.mode !== "shape") {
        const sx = sharp(rect.x, dpr) * dpr;
        const sy = sharp(rect.y, dpr) * dpr;
        const sw = rect.width * dpr;
        const sh = rect.height * dpr;

        overlayCtx.strokeStyle = accent;
        overlayCtx.lineWidth = 1 * dpr;
        overlayCtx.strokeRect(sx, sy, sw, sh);

        const half = (HANDLE_SIZE / 2) * dpr;
        const positions = handlePositions(rect);
        const active =
          pointer.mode === "scale" ? pointer.scaleHandle : hoverHandle;
        for (const [id, pos] of Object.entries(positions) as [
          HandleId,
          { x: number; y: number },
        ][]) {
          const hx = pos.x * dpr;
          const hy = pos.y * dpr;
          overlayCtx.beginPath();
          overlayCtx.rect(hx - half, hy - half, half * 2, half * 2);
          overlayCtx.fillStyle = id === active ? accent : "#ffffff";
          overlayCtx.fill();
          overlayCtx.stroke();
        }

        // The rotate grip, on a short stem so it reads as attached.
        const grip = rotateHandlePosition(rect);
        overlayCtx.beginPath();
        overlayCtx.moveTo(sharp(grip.x, dpr) * dpr, sy);
        overlayCtx.lineTo(sharp(grip.x, dpr) * dpr, grip.y * dpr);
        overlayCtx.stroke();
        overlayCtx.beginPath();
        overlayCtx.arc(
          grip.x * dpr,
          grip.y * dpr,
          ROTATE_HANDLE_RADIUS * dpr,
          0,
          Math.PI * 2,
        );
        overlayCtx.fillStyle =
          hoverRotate || pointer.mode === "rotate" ? accent : "#ffffff";
        overlayCtx.fill();
        overlayCtx.stroke();
      }

      // The joint, as a crosshair you can grab. One part at a time: a ring of
      // crosshairs over a whole selection says nothing.
      if (selected.length === 1 && shown(selected[0])) {
        const layer = doc.layers[selected[0]];
        if (layer) {
          const [jx, jy] = jointPosition(layer, doc, ui.frame);
          paintJoint(
            jx * viewport.scale + viewport.x,
            jy * viewport.scale + viewport.y,
            accent,
          );
        }
      }

      if (pointer.mode === "rotate" && pointer.moved) {
        const label = `${Math.round(pointer.rotateDegrees)}°`;
        const x = pointer.currentX * dpr;
        const y = (pointer.currentY - 22) * dpr;
        overlayCtx.save();
        overlayCtx.font = `${12 * dpr}px var(--font-geist-mono), monospace`;
        overlayCtx.textAlign = "center";
        overlayCtx.textBaseline = "middle";
        const width = overlayCtx.measureText(label).width + 14 * dpr;
        overlayCtx.fillStyle = accent;
        overlayCtx.beginPath();
        overlayCtx.roundRect(
          x - width / 2,
          y - 10 * dpr,
          width,
          20 * dpr,
          10 * dpr,
        );
        overlayCtx.fill();
        overlayCtx.fillStyle = "#ffffff";
        overlayCtx.fillText(label, x, y);
        overlayCtx.restore();
      }

      if (pointer.mode === "marquee") {
        const x = Math.min(pointer.startX, pointer.currentX) * dpr;
        const y = Math.min(pointer.startY, pointer.currentY) * dpr;
        const w = Math.abs(pointer.currentX - pointer.startX) * dpr;
        const h = Math.abs(pointer.currentY - pointer.startY) * dpr;
        overlayCtx.save();
        overlayCtx.globalAlpha = 0.12;
        overlayCtx.fillStyle = accent;
        overlayCtx.fillRect(x, y, w, h);
        overlayCtx.restore();
        overlayCtx.strokeStyle = accent;
        overlayCtx.lineWidth = 1 * dpr;
        overlayCtx.strokeRect(x, y, w, h);
      }

      // While the brush is down, show the point the stroke would close onto.
      // "Finish near where you started and it fills" is only a rule someone
      // can follow if they can see where the start is and when they are close
      // enough.
      if (pointer.mode === "brush" && pointer.samples.length > 4) {
        const first = pointer.samples[0];
        const last = pointer.samples[pointer.samples.length - 1];
        const near =
          Math.hypot(last.x - first.x, last.y - first.y) * viewport.scale <=
          BRUSH_CLOSE_DISTANCE;
        const cx = (first.x * viewport.scale + viewport.x) * dpr;
        const cy = (first.y * viewport.scale + viewport.y) * dpr;
        overlayCtx.save();
        overlayCtx.strokeStyle = accent;
        overlayCtx.lineWidth = (near ? 2.5 : 1.5) * dpr;
        overlayCtx.globalAlpha = near ? 1 : 0.5;
        overlayCtx.beginPath();
        overlayCtx.arc(cx, cy, BRUSH_CLOSE_DISTANCE * dpr, 0, Math.PI * 2);
        overlayCtx.stroke();
        if (near) {
          overlayCtx.globalAlpha = 0.14;
          overlayCtx.fillStyle = accent;
          overlayCtx.fill();
        }
        overlayCtx.restore();
      }

      if (pointer.mode === "brush" && pointer.samples.length > 1) {
        overlayCtx.save();
        overlayCtx.strokeStyle = rgbaToCss(INK);
        overlayCtx.lineCap = "round";
        overlayCtx.lineJoin = "round";
        overlayCtx.lineWidth = ui.brushWidth * viewport.scale * dpr;
        overlayCtx.beginPath();
        for (let i = 0; i < pointer.samples.length; i++) {
          const s = pointer.samples[i];
          const x = (s.x * viewport.scale + viewport.x) * dpr;
          const y = (s.y * viewport.scale + viewport.y) * dpr;
          if (i === 0) overlayCtx.moveTo(x, y);
          else overlayCtx.lineTo(x, y);
        }
        overlayCtx.stroke();
        overlayCtx.restore();
      }

      if (pointer.mode === "shape") {
        const x0 = Math.min(pointer.startX, pointer.currentX) * dpr;
        const y0 = Math.min(pointer.startY, pointer.currentY) * dpr;
        const w = Math.abs(pointer.currentX - pointer.startX) * dpr;
        const h = Math.abs(pointer.currentY - pointer.startY) * dpr;
        overlayCtx.strokeStyle = accent;
        overlayCtx.lineWidth = 1 * dpr;
        if (ui.tool === "ellipse") {
          overlayCtx.beginPath();
          overlayCtx.ellipse(
            x0 + w / 2,
            y0 + h / 2,
            w / 2,
            h / 2,
            0,
            0,
            Math.PI * 2,
          );
          overlayCtx.stroke();
        } else {
          overlayCtx.strokeRect(x0, y0, w, h);
        }
      }

      if (penPoints.length >= 2) {
        overlayCtx.save();
        overlayCtx.strokeStyle = accent;
        overlayCtx.lineWidth = 1 * dpr;
        overlayCtx.beginPath();
        for (let i = 0; i < penPoints.length; i += 2) {
          const x = (penPoints[i] * viewport.scale + viewport.x) * dpr;
          const y = (penPoints[i + 1] * viewport.scale + viewport.y) * dpr;
          if (i === 0) overlayCtx.moveTo(x, y);
          else overlayCtx.lineTo(x, y);
        }
        const lx = (pointer.currentX ?? 0) * dpr;
        const ly = (pointer.currentY ?? 0) * dpr;
        overlayCtx.lineTo(lx, ly);
        overlayCtx.stroke();
        for (let i = 0; i < penPoints.length; i += 2) {
          overlayCtx.beginPath();
          overlayCtx.arc(
            (penPoints[i] * viewport.scale + viewport.x) * dpr,
            (penPoints[i + 1] * viewport.scale + viewport.y) * dpr,
            3.5 * dpr,
            0,
            Math.PI * 2,
          );
          overlayCtx.fillStyle = i === 0 ? accent : "#ffffff";
          overlayCtx.fill();
          overlayCtx.stroke();
        }
        overlayCtx.restore();
      }

      for (const [value, horizontal] of [
        [pointer.guideX, false],
        [pointer.guideY, true],
      ] as [number | null, boolean][]) {
        if (value === null) continue;
        overlayCtx.save();
        overlayCtx.strokeStyle = guideColour;
        overlayCtx.lineWidth = 1 * dpr;
        overlayCtx.beginPath();
        if (horizontal) {
          const y = sharp(value * viewport.scale + viewport.y, dpr) * dpr;
          overlayCtx.moveTo(0, y);
          overlayCtx.lineTo(size.width * dpr, y);
        } else {
          const x = sharp(value * viewport.scale + viewport.x, dpr) * dpr;
          overlayCtx.moveTo(x, 0);
          overlayCtx.lineTo(x, size.height * dpr);
        }
        overlayCtx.stroke();
        overlayCtx.restore();
      }
    };

    const paintJoint = (x: number, y: number, colour: string) => {
      const cx = x * dpr;
      const cy = y * dpr;
      const r = 7 * dpr;
      overlayCtx.save();
      overlayCtx.strokeStyle = colour;
      overlayCtx.fillStyle = "#ffffff";
      overlayCtx.lineWidth = 1.5 * dpr;
      overlayCtx.beginPath();
      overlayCtx.arc(cx, cy, r, 0, Math.PI * 2);
      overlayCtx.fill();
      overlayCtx.stroke();
      overlayCtx.beginPath();
      overlayCtx.moveTo(cx - r, cy);
      overlayCtx.lineTo(cx + r, cy);
      overlayCtx.moveTo(cx, cy - r);
      overlayCtx.lineTo(cx, cy + r);
      overlayCtx.stroke();
      overlayCtx.restore();
    };

    /** A hairline from each joint to its parent's, so the chain is literal. */
    const paintChainLinks = (
      viewport: Viewport,
      id: LayerId,
      colour: string,
    ) => {
      const { doc, ui } = store.getState();
      let layer = doc.layers[id];
      overlayCtx.save();
      overlayCtx.globalAlpha = 0.5;
      overlayCtx.strokeStyle = colour;
      overlayCtx.lineWidth = 1 * dpr;
      let guard = 0;
      while (layer?.parentLayerId && guard++ < 64) {
        const parent = doc.layers[layer.parentLayerId];
        if (!parent) break;
        const [ax, ay] = jointPosition(layer, doc, ui.frame);
        const [bx, by] = jointPosition(parent, doc, ui.frame);
        overlayCtx.beginPath();
        overlayCtx.moveTo(
          (ax * viewport.scale + viewport.x) * dpr,
          (ay * viewport.scale + viewport.y) * dpr,
        );
        overlayCtx.lineTo(
          (bx * viewport.scale + viewport.x) * dpr,
          (by * viewport.scale + viewport.y) * dpr,
        );
        overlayCtx.stroke();
        layer = parent;
      }
      overlayCtx.restore();
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };

    // --------------------------------------------------------------- sizing

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      size.width = rect.width;
      size.height = rect.height;
      for (const c of [art, overlay]) {
        c.width = Math.max(1, Math.round(rect.width * dpr));
        c.height = Math.max(1, Math.round(rect.height * dpr));
        c.style.width = `${rect.width}px`;
        c.style.height = `${rect.height}px`;
      }
      schedule();
    };

    /**
     * Fit into the part of the desk no panel covers.
     *
     * The character is fitted, not the page: a rig usually sits in a corner of
     * a much larger artboard, and fitting the artboard is how someone ends up
     * looking at a thumbnail of their own drawing. The artboard is the fallback
     * for a document with nothing in it yet.
     *
     * Fitting to the full viewport would centre everything behind the
     * inspector, which looks like a bug even though the maths is right.
     */
    const fit = () => {
      const { doc, ui } = store.getState();
      const artboard = activeArtboard(doc);
      if (!artboard || size.width === 0) return;
      const safe = canvasSafeArea(size, ui.timelineHeight);
      const selected = store.getState().ui.selection.layerIds;
      const content =
        scene && ui.fitTarget === "selection" && selected.length > 0
          ? selectionBounds(scene, selected)
          : scene
            ? sceneBounds(scene)
            : null;
      const target = content
        ? {
            x: content[0],
            y: content[1],
            width: Math.max(1, content[2] - content[0]),
            height: Math.max(1, content[3] - content[1]),
          }
        : { x: 0, y: 0, width: artboard.width, height: artboard.height };
      // A tighter margin than the default: the panels are glass, so the
      // artwork is allowed to come close to them without being hidden.
      const viewport = fitToRect(
        { width: safe.width, height: safe.height },
        target,
        28,
      );
      store.setUi({
        viewport: {
          ...viewport,
          x: viewport.x + safe.x,
          y: viewport.y + safe.y,
        },
      });
    };

    let lastArtboardKey = "";
    let lastFitNonce = -1;
    let lastFillNonce = -1;
    const maybeFit = () => {
      const { doc, ui } = store.getState();
      const artboard = activeArtboard(doc);
      if (!artboard) return;
      const key = `${artboard.id}:${artboard.width}x${artboard.height}`;
      if (
        key !== lastArtboardKey ||
        ui.fitNonce !== lastFitNonce ||
        ui.fillNonce !== lastFillNonce
      ) {
        if (size.width === 0) return; // Nothing to fit into yet; retry on resize.
        // Fitting reads the draw list, so make sure one exists for this frame
        // before the first paint has had a chance to build it.
        if (doc !== lastDocRef || ui.frame !== lastFrame) {
          scene = resolveScene(doc, ui.frame, { blinking: ui.previewBlink });
          lastDocRef = doc;
          lastFrame = ui.frame;
          lastBlink = ui.previewBlink;
        }
        const cover = ui.fillNonce !== lastFillNonce && lastFillNonce !== -1;
        lastArtboardKey = key;
        lastFitNonce = ui.fitNonce;
        lastFillNonce = ui.fillNonce;
        if (cover) {
          const safe = canvasSafeArea(size, ui.timelineHeight);
          const coverScale = Math.min(
            64,
            Math.max(
              0.02,
              Math.max(
                safe.width / Math.max(1, artboard.width),
                safe.height / Math.max(1, artboard.height),
              ),
            ),
          );
          store.setUi({
            viewport: {
              scale: coverScale,
              x: safe.x + (safe.width - artboard.width * coverScale) / 2,
              y: safe.y + (safe.height - artboard.height * coverScale) / 2,
            },
          });
        } else {
          fit();
        }
      }
    };

    const observer = new ResizeObserver(() => {
      resize();
      maybeFit();
    });
    observer.observe(wrap);
    resize();
    maybeFit();

    // ------------------------------------------------------------- pointers

    const localPoint = (e: PointerEvent | WheelEvent): [number, number] => {
      const rect = art.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };

    /** Bounds of everything that is not being dragged, for snapping. */
    const snapBoxes = (exclude: ReadonlySet<string>) => {
      if (!scene) return [];
      const out: [number, number, number, number][] = [];
      for (const item of scene.items) {
        if (exclude.has(item.layerId)) continue;
        out.push(item.bounds);
      }
      return out;
    };

    const beginMove = (px: number, py: number) => {
      const { doc, ui } = store.getState();
      const [dx0, dy0] = toDocument(ui.viewport, px, py);
      const origins: MoveOrigin[] = [];
      for (const id of ui.selection.layerIds) {
        const layer = doc.layers[id];
        if (!layer || layer.locked) continue;
        origins.push({
          layerId: id,
          x: evalAnimatable(
            readAnimatable(layer, "transform.x"),
            doc.tracks,
            ui.frame,
          ),
          y: evalAnimatable(
            readAnimatable(layer, "transform.y"),
            doc.tracks,
            ui.frame,
          ),
        });
      }
      pointer.mode = "move";
      pointer.moved = false;
      pointer.startDocX = dx0;
      pointer.startDocY = dy0;
      pointer.moveOrigins = origins;
      gestureCount += 1;
      pointer.moveKey = `canvas:move:${gestureCount}`;
    };

    const onPointerDown = (e: PointerEvent) => {
      const [px, py] = localPoint(e);
      const { doc, ui } = store.getState();
      pointer.startX = px;
      pointer.startY = py;
      pointer.currentX = px;
      pointer.currentY = py;
      pointer.originViewport = ui.viewport;
      pointer.guideX = null;
      pointer.guideY = null;

      if (e.button === 1 || spaceHeld || ui.tool === "hand") {
        pointer.mode = "pan";
        art.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      art.setPointerCapture(e.pointerId);

      const [dx, dy] = toDocument(ui.viewport, px, py);

      if (ui.tool === "brush") {
        pointer.mode = "brush";
        pointer.samples = [{ x: dx, y: dy, pressure: e.pressure || 0.5 }];
        schedule();
        return;
      }

      if (ui.tool === "rect" || ui.tool === "ellipse") {
        pointer.mode = "shape";
        schedule();
        return;
      }

      if (ui.tool === "pen") {
        // Clicking the first point closes the shape. Everything else adds one.
        if (penPoints.length >= 4) {
          const closeDistance =
            Math.hypot(dx - penPoints[0], dy - penPoints[1]) *
            ui.viewport.scale;
          if (closeDistance < 12) {
            commitPen(true);
            return;
          }
        }
        penPoints.push(dx, dy);
        schedule();
        return;
      }

      if (ui.tool === "joint") {
        const target =
          ui.selection.layerIds[0] ??
          (scene
            ? hitTest(overlayCtx, scene, cache, dx, dy, 4 / ui.viewport.scale)
                ?.layerId
            : undefined);
        if (target) {
          store.begin(null);
          store.setDoc(
            setJointAt(store.getState().doc, target, dx, dy, ui.frame),
          );
          store.commit();
          store.select([target]);
          store.setTool("select");
        }
        schedule();
        return;
      }

      if (!scene) return;

      // The joint crosshair wins over everything beneath it, so a joint sitting
      // on top of artwork stays grabbable.
      if (ui.selection.layerIds.length === 1) {
        const layer = doc.layers[ui.selection.layerIds[0]];
        if (layer && !layer.locked) {
          const [jx, jy] = jointPosition(layer, doc, ui.frame);
          const sx = jx * ui.viewport.scale + ui.viewport.x;
          const sy = jy * ui.viewport.scale + ui.viewport.y;
          if (Math.hypot(px - sx, py - sy) <= 9) {
            pointer.mode = "joint";
            pointer.moved = false;
            gestureCount += 1;
            pointer.moveKey = `canvas:joint:${gestureCount}`;
            schedule();
            return;
          }
        }
      }

      if (
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        ui.selection.layerIds.length > 0
      ) {
        const rect = selectionScreenRect(
          scene,
          ui.viewport,
          ui.selection.layerIds,
        );
        if (rect && hitRotateHandle(rect, px, py)) {
          const centre = {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
          };
          const origins: RotateOrigin[] = [];
          const startAngle = Math.atan2(py - centre.y, px - centre.x);
          for (const id of ui.selection.layerIds) {
            const layer = doc.layers[id];
            if (!layer || layer.locked) continue;
            origins.push({
              layerId: id,
              rotation: evalAnimatable(
                layer.transform.rotation,
                doc.tracks,
                ui.frame,
              ),
              startAngle,
            });
          }
          pointer.mode = "rotate";
          pointer.moved = false;
          pointer.rotateCentre = centre;
          pointer.rotateOrigins = origins;
          gestureCount += 1;
          pointer.moveKey = `canvas:rotate:${gestureCount}`;
          schedule();
          return;
        }

        const handle = rect ? hitHandle(rect, px, py) : null;
        if (rect && handle) {
          const anchor = anchorForHandle(rect, handle);
          const [ax, ay] = toDocument(ui.viewport, anchor.x, anchor.y);
          const [sx, sy] = toDocument(ui.viewport, px, py);
          const origins: ScaleOrigin[] = [];
          for (const id of ui.selection.layerIds) {
            const layer = doc.layers[id];
            if (!layer || layer.locked) continue;
            const read = (path: string) =>
              evalAnimatable(readAnimatable(layer, path), doc.tracks, ui.frame);
            origins.push({
              layerId: id,
              x: read("transform.x"),
              y: read("transform.y"),
              rotation: read("transform.rotation"),
              scaleX: read("transform.scaleX"),
              scaleY: read("transform.scaleY"),
              pivotX: layer.pivot.x,
              pivotY: layer.pivot.y,
            });
          }
          pointer.mode = "scale";
          pointer.moved = false;
          pointer.scaleHandle = handle;
          pointer.scaleAnchorDoc = { x: ax, y: ay };
          pointer.scaleStartDoc = { x: sx, y: sy };
          pointer.scaleOrigins = origins;
          gestureCount += 1;
          pointer.moveKey = `canvas:scale:${gestureCount}`;
          art.style.cursor = cursorForHandle(handle);
          schedule();
          return;
        }
      }

      const hit = hitTest(
        overlayCtx,
        scene,
        cache,
        dx,
        dy,
        4 / ui.viewport.scale,
      );

      if (hit) {
        const already = ui.selection.layerIds.includes(hit.layerId);
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          store.toggleSelect(hit.layerId);
          pointer.mode = "none";
        } else {
          if (!already) store.select([hit.layerId]);
          // Alt-drag leaves the original behind and moves a copy, which is how
          // a second arm gets made in every tool anyone has used.
          if (e.altKey) {
            const source = store.getState().ui.selection.layerIds;
            store.begin(null);
            const result = duplicateParts(store.getState().doc, source, {
              frame: ui.frame,
              offset: 0,
            });
            store.setDoc(result.doc);
            store.commit();
            if (result.created.length > 0) store.select(result.created);
          }
          beginMove(px, py);
        }
      } else {
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) store.select([]);
        pointer.mode = "marquee";
      }
      schedule();
    };

    const onPointerMove = (e: PointerEvent) => {
      const [px, py] = localPoint(e);

      if (pointer.mode === "none" && e.buttons === 0) {
        pointer.currentX = px;
        pointer.currentY = py;
        const { doc, ui } = store.getState();
        let next: HandleId | null = null;
        let rotate = false;
        let cursor = spaceHeld || ui.tool === "hand" ? "grab" : "";
        if (ui.tool === "brush" || ui.tool === "pen") cursor = "crosshair";
        if (ui.tool === "rect" || ui.tool === "ellipse") cursor = "crosshair";
        if (ui.tool === "joint") cursor = "crosshair";

        if (
          scene &&
          ui.tool === "select" &&
          !spaceHeld &&
          ui.selection.layerIds.length > 0
        ) {
          const rect = selectionScreenRect(
            scene,
            ui.viewport,
            ui.selection.layerIds,
          );
          rotate = rect ? hitRotateHandle(rect, px, py) : false;
          next = rect && !rotate ? hitHandle(rect, px, py) : null;
          if (rotate) cursor = "grab";
          else if (next) cursor = cursorForHandle(next);
          else if (ui.selection.layerIds.length === 1) {
            const layer = doc.layers[ui.selection.layerIds[0]];
            if (layer) {
              const [jx, jy] = jointPosition(layer, doc, ui.frame);
              const sx = jx * ui.viewport.scale + ui.viewport.x;
              const sy = jy * ui.viewport.scale + ui.viewport.y;
              if (Math.hypot(px - sx, py - sy) <= 9) cursor = "move";
            }
          }
        }
        if (next !== hoverHandle || rotate !== hoverRotate) {
          hoverHandle = next;
          hoverRotate = rotate;
          schedule();
        }
        if (penPoints.length > 0) schedule();
        if (art.style.cursor !== cursor) art.style.cursor = cursor;
        return;
      }
      if (pointer.mode === "none") return;
      pointer.currentX = px;
      pointer.currentY = py;

      if (pointer.mode === "pan") {
        store.setUi({
          viewport: {
            ...pointer.originViewport,
            x: pointer.originViewport.x + (px - pointer.startX),
            y: pointer.originViewport.y + (py - pointer.startY),
          },
        });
        schedule();
        return;
      }

      if (pointer.mode === "brush") {
        const { ui } = store.getState();
        const [dx, dy] = toDocument(ui.viewport, px, py);
        const last = pointer.samples[pointer.samples.length - 1];
        // Drop samples the pointer barely moved for: they add nothing and they
        // make the smoothing pass wobble.
        if (
          !last ||
          Math.hypot(dx - last.x, dy - last.y) * ui.viewport.scale > 1.5
        ) {
          pointer.samples.push({ x: dx, y: dy, pressure: e.pressure || 0.5 });
        }
        schedule();
        return;
      }

      if (pointer.mode === "shape") {
        schedule();
        return;
      }

      if (pointer.mode === "joint") {
        if (
          !pointer.moved &&
          Math.hypot(px - pointer.startX, py - pointer.startY) < DRAG_THRESHOLD
        ) {
          return;
        }
        if (!pointer.moved) {
          pointer.moved = true;
          store.begin(pointer.moveKey);
        }
        const { ui } = store.getState();
        const id = ui.selection.layerIds[0];
        if (!id) return;
        const [dx, dy] = toDocument(ui.viewport, px, py);
        store.setDoc(setJointAt(store.getState().doc, id, dx, dy, ui.frame));
        schedule();
        return;
      }

      if (pointer.mode === "move") {
        if (
          !pointer.moved &&
          Math.hypot(px - pointer.startX, py - pointer.startY) < DRAG_THRESHOLD
        ) {
          schedule();
          return;
        }
        if (!pointer.moved) {
          pointer.moved = true;
          store.begin(pointer.moveKey);
          art.style.cursor = "move";
        }
        const { ui } = store.getState();
        const [dx, dy] = toDocument(ui.viewport, px, py);
        let deltaX = dx - pointer.startDocX;
        let deltaY = dy - pointer.startDocY;
        pointer.guideX = null;
        pointer.guideY = null;

        if (ui.snap && !e.altKey && scene) {
          const moving = new Set(pointer.moveOrigins.map((o) => o.layerId));
          const bounds = selectionBounds(scene, [...moving] as LayerId[]);
          if (bounds) {
            const artboard = activeArtboard(store.getState().doc) ?? null;
            const candidates = collectCandidates(
              snapBoxes(moving),
              artboard
                ? { width: artboard.width, height: artboard.height }
                : null,
            );
            const tolerance = SNAP_TOLERANCE / ui.viewport.scale;
            const sx = snapAxis(
              spanOf(bounds[0] + deltaX, bounds[2] + deltaX),
              candidates.x,
              tolerance,
            );
            const sy = snapAxis(
              spanOf(bounds[1] + deltaY, bounds[3] + deltaY),
              candidates.y,
              tolerance,
            );
            deltaX += sx.delta;
            deltaY += sy.delta;
            pointer.guideX = sx.guide;
            pointer.guideY = sy.guide;
          }
        }
        if (e.shiftKey) {
          // Straight-line drag, whichever axis is winning.
          if (Math.abs(deltaX) > Math.abs(deltaY)) deltaY = 0;
          else deltaX = 0;
        }

        store.setDoc(
          moveLayers(
            store.getState().doc,
            pointer.moveOrigins,
            deltaX,
            deltaY,
            ui.frame,
          ),
        );
        schedule();
        return;
      }

      if (pointer.mode === "rotate") {
        if (
          !pointer.moved &&
          Math.hypot(px - pointer.startX, py - pointer.startY) < DRAG_THRESHOLD
        ) {
          return;
        }
        if (!pointer.moved) {
          pointer.moved = true;
          store.begin(pointer.moveKey);
        }
        const { ui } = store.getState();
        const angle = Math.atan2(
          py - pointer.rotateCentre.y,
          px - pointer.rotateCentre.x,
        );
        let degrees =
          ((angle - (pointer.rotateOrigins[0]?.startAngle ?? angle)) * 180) /
          Math.PI;
        // Shift steps in fifteens, which is how a pose gets repeated exactly.
        if (e.shiftKey) degrees = Math.round(degrees / 15) * 15;
        pointer.rotateDegrees =
          (pointer.rotateOrigins[0]?.rotation ?? 0) + degrees;
        store.setDoc((current) => {
          let out = current;
          for (const origin of pointer.rotateOrigins) {
            const layer = out.layers[origin.layerId];
            if (!layer) continue;
            const value = origin.rotation + degrees;
            const prop = layer.transform.rotation;
            if (prop.kind === "track") {
              out = upsertKeyframe(out, prop.trackId, ui.frame, value);
            } else {
              out = patchLayer(out, origin.layerId, {
                transform: { ...layer.transform, rotation: constant(value) },
              });
            }
          }
          return out;
        });
        schedule();
        return;
      }

      if (pointer.mode === "scale" && pointer.scaleHandle) {
        if (
          !pointer.moved &&
          Math.hypot(px - pointer.startX, py - pointer.startY) < DRAG_THRESHOLD
        ) {
          schedule();
          return;
        }
        if (!pointer.moved) {
          pointer.moved = true;
          store.begin(pointer.moveKey);
        }
        const handle = pointer.scaleHandle;
        const axes = axesForHandle(handle);
        const corners = axes.x && axes.y;
        const { ui } = store.getState();
        const [dx, dy] = toDocument(ui.viewport, px, py);
        store.setDoc(
          scaleLayers(
            store.getState().doc,
            pointer.scaleOrigins,
            pointer.scaleAnchorDoc,
            pointer.scaleStartDoc,
            { x: dx, y: dy },
            { axes, uniform: corners && !e.shiftKey },
            ui.frame,
          ),
        );
      }
      schedule();
    };

    /** Finish a brush, rectangle or ellipse into a new part. */
    const commitDrawing = (geometry: PathGeometry | null, filled: boolean) => {
      if (!geometry) return;
      const { doc, ui } = store.getState();
      store.begin(null);
      const result = addDrawnPart(store.getState().doc, geometry, {
        name: nextPartName(doc),
        fill: filled ? ui.drawFill : null,
        stroke: INK,
        strokeWidth: ui.brushWidth,
      });
      store.setDoc(result.doc);
      store.commit();
      store.select([result.layerId]);
    };

    const commitPen = (close: boolean) => {
      if (penPoints.length >= (close ? 6 : 4)) {
        commitDrawing(
          contoursToGeometry([{ points: penPoints.slice(), closed: close }]),
          close,
        );
      }
      penPoints = [];
      schedule();
    };

    const onPointerUp = (e: PointerEvent) => {
      const mode = pointer.mode;
      const { ui } = store.getState();

      if (mode === "brush") {
        // The close test is in screen pixels: at 20% zoom a document-unit
        // tolerance asks for an accuracy nobody has, and the stroke silently
        // comes back as an outline instead of a shape.
        const result = brushStroke(pointer.samples, {
          closeDistance: BRUSH_CLOSE_DISTANCE / ui.viewport.scale,
          dotRadius: ui.brushWidth * 0.75,
        });
        pointer.samples = [];
        pointer.mode = "none";
        if (result) commitDrawing(result.geometry, result.closed);
        if (art.hasPointerCapture(e.pointerId)) {
          art.releasePointerCapture(e.pointerId);
        }
        schedule();
        return;
      }

      if (mode === "shape") {
        const [x0, y0] = toDocument(
          ui.viewport,
          pointer.startX,
          pointer.startY,
        );
        const [x1, y1] = toDocument(
          ui.viewport,
          pointer.currentX,
          pointer.currentY,
        );
        let w = x1 - x0;
        let h = y1 - y0;
        if (e.shiftKey) {
          const side = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * side;
          h = Math.sign(h || 1) * side;
        }
        pointer.mode = "none";
        if (Math.abs(w) > 2 && Math.abs(h) > 2) {
          commitDrawing(
            ui.tool === "ellipse"
              ? ellipsePath(x0 + w / 2, y0 + h / 2, w / 2, h / 2)
              : rectPath(x0, y0, w, h),
            true,
          );
        }
        if (art.hasPointerCapture(e.pointerId)) {
          art.releasePointerCapture(e.pointerId);
        }
        schedule();
        return;
      }

      if (
        mode === "move" ||
        mode === "scale" ||
        mode === "rotate" ||
        mode === "joint"
      ) {
        store.commit();
        pointer.mode = "none";
        pointer.moveOrigins = [];
        pointer.scaleOrigins = [];
        pointer.rotateOrigins = [];
        pointer.scaleHandle = null;
        pointer.moveKey = null;
        pointer.moved = false;
        pointer.guideX = null;
        pointer.guideY = null;
        art.style.cursor = spaceHeld ? "grab" : "";
        if (art.hasPointerCapture(e.pointerId)) {
          art.releasePointerCapture(e.pointerId);
        }
        schedule();
        return;
      }

      if (mode === "marquee" && scene) {
        const [x0, y0] = toDocument(
          ui.viewport,
          pointer.startX,
          pointer.startY,
        );
        const [x1, y1] = toDocument(
          ui.viewport,
          pointer.currentX,
          pointer.currentY,
        );
        if (Math.hypot(x1 - x0, y1 - y0) * ui.viewport.scale > DRAG_THRESHOLD) {
          const ids: LayerId[] = [];
          const minX = Math.min(x0, x1);
          const maxX = Math.max(x0, x1);
          const minY = Math.min(y0, y1);
          const maxY = Math.max(y0, y1);
          for (const item of scene.items) {
            const b = item.bounds;
            if (!(b[2] < minX || b[0] > maxX || b[3] < minY || b[1] > maxY)) {
              if (!ids.includes(item.layerId)) ids.push(item.layerId);
            }
          }
          store.select(ids);
        }
      }
      pointer.mode = "none";
      if (art.hasPointerCapture(e.pointerId)) {
        art.releasePointerCapture(e.pointerId);
      }
      schedule();
    };

    const onDoubleClick = () => {
      // Double-clicking with the pen finishes an open line.
      if (penPoints.length >= 4) commitPen(false);
    };

    /**
     * Wheel: scroll pans, pinch and Command scroll zoom.
     *
     * Scroll-to-pan first, because that is what a trackpad does everywhere else
     * and it is the one navigation gesture nobody has to be taught.
     */
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [px, py] = localPoint(e);
      const { ui } = store.getState();

      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01);
        store.setUi({ viewport: zoomBy(ui.viewport, factor, px, py) });
      } else {
        store.setUi({
          viewport: {
            ...ui.viewport,
            x: ui.viewport.x - e.deltaX,
            y: ui.viewport.y - e.deltaY,
          },
        });
      }
      schedule();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (typing) return;

      if (e.code === "Space" && !spaceHeld) {
        spaceHeld = true;
        art.style.cursor = "grab";
        return;
      }
      if (e.key === "Escape" && penPoints.length > 0) {
        penPoints = [];
        schedule();
        return;
      }
      if (e.key === "Enter" && penPoints.length >= 4) {
        e.preventDefault();
        commitPen(false);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceHeld = false;
        art.style.cursor = "";
      }
    };

    art.addEventListener("pointerdown", onPointerDown);
    art.addEventListener("pointermove", onPointerMove);
    art.addEventListener("pointerup", onPointerUp);
    art.addEventListener("pointercancel", onPointerUp);
    art.addEventListener("dblclick", onDoubleClick);
    art.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const unsubscribe = store.subscribe(() => {
      maybeFit();
      schedule();
    });
    schedule();

    return () => {
      observer.disconnect();
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
      art.removeEventListener("pointerdown", onPointerDown);
      art.removeEventListener("pointermove", onPointerMove);
      art.removeEventListener("pointerup", onPointerUp);
      art.removeEventListener("pointercancel", onPointerUp);
      art.removeEventListener("dblclick", onDoubleClick);
      art.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      cache.clear();
    };
  }, [store]);

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden">
      <canvas ref={artRef} className="absolute inset-0 block" />
      <canvas
        ref={overlayRef}
        className="pointer-events-none absolute inset-0 block"
      />
    </div>
  );
}

/** Fit the active artboard into a viewport. Used by the zoom control. */
export function fitArtboard(
  store: EditorStore,
  view: { width: number; height: number },
) {
  const { doc } = store.getState();
  const artboard = activeArtboard(doc);
  if (!artboard) return;
  store.setUi({
    viewport: fitToRect(view, {
      x: 0,
      y: 0,
      width: artboard.width,
      height: artboard.height,
    }),
  });
}

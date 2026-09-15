"use client";

/**
 * The inspector.
 *
 * Driven entirely by the selection, and it only ever shows what applies to it:
 * nothing selected inspects the artboard, one part shows everything a part has,
 * several parts show what they have in common. A control that cannot act on the
 * current selection is not greyed out here, it is absent, because a panel full
 * of dead controls is a panel nobody reads.
 *
 * Every mutation runs through `edit`, which opens and closes an undo
 * transaction. During a drag the transactions share a merge key and collapse
 * into one history entry, so a scrub is one press of undo rather than ninety.
 */

import {
  AlignHorizontalDistributeCenter,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalDistributeCenter,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  BringToFront,
  ChevronDown,
  ChevronUp,
  Copy,
  Crosshair,
  FlipHorizontal,
  Minus,
  Plus,
  SendToBack,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { evalAnimatable } from "@/editor/model/animation";
import {
  type AnimatableNumber,
  type Artboard,
  applyMatrix,
  constant,
  type Frame,
  type LayerId,
  newId,
  type PartLayer,
  type PathId,
  parseHex,
  type RGBA,
  type RiffDocument,
  rgbaToCss,
  SWATCHES,
  type Swatch,
  type TransformProps,
  toHex,
  type Variant,
} from "@/editor/model/document";
import {
  activeArtboard,
  attachTo,
  duplicateParts,
  isDescendant,
  isOffPage,
  jointPosition,
  mirrorAxisFor,
  moveInDrawOrder,
  patchArtboard,
  patchLayer,
  variantAt,
  variantBounds,
  worldMatrix,
} from "@/editor/model/rig";
import {
  activeVariantIndex,
  canCombine,
  canJoin,
  combineParts,
  hasGeometry,
  joinParts,
  patchVariantAt,
  type ShapeResult,
  simplifyParts,
  smoothParts,
} from "@/editor/model/shape-ops";
import { useEditor, useEditorStore } from "@/editor/ui/context";
import { ScrubInput } from "./ScrubInput";
import {
  FOCUS_RING,
  HINT_TEXT,
  NUMERIC_TEXT,
  PANEL,
  PANEL_TITLE,
  PRESS,
  SECTION_LABEL,
  UI_TEXT,
} from "./styles";
import { Tip } from "./Tooltip";
import { ensureTrack, readAnimatable, upsertKeyframe } from "./timeline/edits";

// ------------------------------------------------------------------ reading

/**
 * The one value several selected parts agree on, or `mixed`.
 *
 * Showing the first part's value for a multi-selection is the classic bug: the
 * field looks authoritative, you nudge it, and four parts silently jump to a
 * fifth part's number.
 */
function agree<T, V>(
  items: T[],
  read: (item: T) => V,
): { value: V | undefined; mixed: boolean } {
  if (items.length === 0) return { value: undefined, mixed: false };
  const first = read(items[0]);
  for (let i = 1; i < items.length; i += 1) {
    if (read(items[i]) !== first) return { value: first, mixed: true };
  }
  return { value: first, mixed: false };
}

function readNumber(
  parts: PartLayer[],
  read: (part: PartLayer) => AnimatableNumber,
  doc: RiffDocument,
  frame: Frame,
) {
  const resolved = parts.map((part) =>
    evalAnimatable(read(part), doc.tracks, frame),
  );
  const { value, mixed } = agree(resolved, (v) => v);
  return {
    value: value ?? 0,
    mixed,
    keyed: parts.some((part) => read(part).kind === "track"),
  };
}

/** A part's bounding box in artboard space, or null when it draws nothing. */
function worldBox(
  doc: RiffDocument,
  part: PartLayer,
  frame: Frame,
): [number, number, number, number] | null {
  const box = variantBounds(variantAt(part, doc, frame), doc);
  if (!box) return null;
  const m = worldMatrix(part, doc, frame);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const corner of [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[0], box[3]],
    [box[2], box[3]],
  ]) {
    const [px, py] = applyMatrix(m, corner[0], corner[1]);
    xs.push(px);
    ys.push(py);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * Convert a move in artboard space into the numbers the part actually stores.
 *
 * A part's position lives in whatever it is attached to, so aligning a hand that
 * hangs off a rotated forearm has to undo the forearm's rotation first. Only the
 * linear part of the matrix applies, because this is a delta and not a point.
 */
function worldDeltaToLocal(
  doc: RiffDocument,
  part: PartLayer,
  frame: Frame,
  dx: number,
  dy: number,
): [number, number] {
  const parent = part.parentLayerId ? doc.layers[part.parentLayerId] : null;
  if (!parent) return [dx, dy];
  const m = worldMatrix(parent, doc, frame);
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) return [dx, dy];
  return [(m.d * dx - m.c * dy) / det, (m.a * dy - m.b * dx) / det];
}

// ------------------------------------------------------------------ writing

type TransformKey = keyof TransformProps;

function constantPatch(
  part: PartLayer,
  path: string,
  value: number,
): Partial<PartLayer> {
  if (path === "opacity") return { opacity: constant(value) };
  if (path === "variant") return { variant: constant(value) };
  const key = path.split(".")[1] as TransformKey;
  return { transform: { ...part.transform, [key]: constant(value) } };
}

/**
 * Set a number on some parts.
 *
 * A property that is already animated gets a key at the playhead instead of
 * losing its animation, which is the only behaviour that lets someone tweak a
 * pose by typing into a field.
 */
function writeValue(
  doc: RiffDocument,
  ids: readonly LayerId[],
  path: string,
  frame: Frame,
  value: number,
): RiffDocument {
  let out = doc;
  for (const id of ids) {
    const part = out.layers[id];
    if (!part || part.locked) continue;
    if (readAnimatable(part, path).kind === "track") {
      const ensured = ensureTrack(out, id, path, frame);
      out = upsertKeyframe(ensured.doc, ensured.trackId, frame, value);
    } else {
      out = patchLayer(out, id, constantPatch(part, path, value));
    }
  }
  return out;
}

/** Move a part by an artboard-space delta. */
function nudge(
  doc: RiffDocument,
  id: LayerId,
  frame: Frame,
  dx: number,
  dy: number,
): RiffDocument {
  const part = doc.layers[id];
  if (!part || part.locked) return doc;
  const [lx, ly] = worldDeltaToLocal(doc, part, frame, dx, dy);
  const x = evalAnimatable(part.transform.x, doc.tracks, frame);
  const y = evalAnimatable(part.transform.y, doc.tracks, frame);
  let out = writeValue(doc, [id], "transform.x", frame, x + lx);
  out = writeValue(out, [id], "transform.y", frame, y + ly);
  return out;
}

/** Apply a style change to whichever drawing each selected part is showing. */
function patchShownVariant(
  doc: RiffDocument,
  ids: readonly LayerId[],
  frame: Frame,
  patch: Partial<Variant>,
): RiffDocument {
  let out = doc;
  for (const id of ids) {
    const part = out.layers[id];
    if (!part || part.locked) continue;
    out = patchVariantAt(out, id, activeVariantIndex(part, out, frame), patch);
  }
  return out;
}

function copyPaths(
  doc: RiffDocument,
  pathIds: readonly PathId[],
): { doc: RiffDocument; ids: PathId[] } {
  const paths = { ...doc.paths };
  const ids: PathId[] = [];
  for (const id of pathIds) {
    const source = doc.paths[id];
    if (!source) continue;
    const nextId = newId("Path");
    paths[nextId] = { ...source, id: nextId };
    ids.push(nextId);
  }
  return { doc: { ...doc, paths }, ids };
}

// ---------------------------------------------------------------- component

export interface InspectorProps {
  className?: string;
  style?: React.CSSProperties;
}

export function Inspector({ className = "", style }: InspectorProps) {
  const store = useEditorStore();
  const doc = useEditor((state) => state.doc);
  const frame = useEditor((state) => state.ui.frame);
  const selection = useEditor((state) => state.ui.selection.layerIds);
  const drawFill = useEditor((state) => state.ui.drawFill);

  // A gesture key makes one drag one undo entry, while leaving two consecutive
  // drags of the same field as two. Refs, not state: a scrub must not re-render
  // the panel sixty times a second to remember its own name.
  const gesture = useRef<string | null>(null);
  const gestureCount = useRef(0);

  function beginGesture(field: string) {
    gestureCount.current += 1;
    gesture.current = `inspector:${field}:${gestureCount.current}`;
  }
  function endGesture() {
    gesture.current = null;
  }
  function edit(patch: (doc: RiffDocument) => RiffDocument) {
    store.begin(gesture.current);
    store.setDoc(patch);
    store.commit();
  }

  const artboard = activeArtboard(doc);
  const parts = selection
    .map((id) => doc.layers[id])
    .filter((part): part is PartLayer => Boolean(part));

  const title =
    parts.length === 0
      ? "Page"
      : parts.length === 1
        ? parts[0].name
        : `${parts.length} parts`;

  return (
    <aside
      aria-label="Details"
      style={style}
      className={`${PANEL} w-[260px] ${className}`}
    >
      <header className="flex h-11 shrink-0 items-center px-3">
        <h2 className={`${PANEL_TITLE} truncate`}>{title}</h2>
      </header>

      <div className="riff-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4">
        {parts.length === 0 ? (
          artboard ? (
            <ArtboardSections
              artboard={artboard}
              edit={edit}
              beginGesture={beginGesture}
              endGesture={endGesture}
            />
          ) : null
        ) : (
          <PartSections
            doc={doc}
            parts={parts}
            frame={frame}
            edit={edit}
            beginGesture={beginGesture}
            endGesture={endGesture}
            drawFill={drawFill}
            onSelect={(ids) => store.select(ids)}
            onUseJointTool={() => store.setTool("joint")}
            onFillPicked={(colour) => store.setUi({ drawFill: colour })}
          />
        )}
      </div>
    </aside>
  );
}

// ----------------------------------------------------------------- artboard

interface SectionActions {
  edit: (patch: (doc: RiffDocument) => RiffDocument) => void;
  beginGesture: (field: string) => void;
  endGesture: () => void;
}

function ArtboardSections({
  artboard,
  edit,
  beginGesture,
  endGesture,
}: SectionActions & { artboard: Artboard }) {
  function patch(next: Partial<Artboard>) {
    edit((doc) => patchArtboard(doc, artboard.id, next));
  }

  return (
    <>
      <Section label="Name and size">
        <TextField
          label="Name"
          value={artboard.name}
          onCommit={(name) => patch({ name })}
        />
        <div className="grid grid-cols-2 gap-2">
          <ScrubInput
            label="W"
            value={artboard.width}
            min={1}
            onScrubStart={() => beginGesture("artboard.width")}
            onScrubEnd={endGesture}
            onChange={(width) => patch({ width })}
          />
          <ScrubInput
            label="H"
            value={artboard.height}
            min={1}
            onScrubStart={() => beginGesture("artboard.height")}
            onScrubEnd={endGesture}
            onChange={(height) => patch({ height })}
          />
        </div>
      </Section>

      <Section label="Background">
        <ColorField
          value={artboard.background}
          swatches={SWATCHES}
          onChange={(background) => patch({ background })}
          clearLabel="Make the background see-through"
        />
      </Section>

      <Section
        label="White outline"
        hint="A thick white outline behind every part, so the character reads as one piece."
      >
        <Toggle
          label="Show it"
          checked={artboard.halo.enabled}
          onChange={(enabled) => patch({ halo: { ...artboard.halo, enabled } })}
        />
        {artboard.halo.enabled ? (
          <ScrubInput
            label="Width"
            value={artboard.halo.width}
            min={0}
            max={80}
            onScrubStart={() => beginGesture("artboard.halo")}
            onScrubEnd={endGesture}
            onChange={(width) => patch({ halo: { ...artboard.halo, width } })}
          />
        ) : null}
      </Section>
    </>
  );
}

// -------------------------------------------------------------------- parts

function PartSections({
  doc,
  parts,
  frame,
  edit,
  beginGesture,
  endGesture,
  onSelect,
  onUseJointTool,
  onFillPicked,
  drawFill,
}: SectionActions & {
  doc: RiffDocument;
  parts: PartLayer[];
  frame: Frame;
  drawFill: RGBA;
  onSelect: (ids: LayerId[]) => void;
  onUseJointTool: () => void;
  onFillPicked: (colour: RGBA) => void;
}) {
  const ids = parts.map((part) => part.id);
  const single = parts.length === 1 ? parts[0] : null;
  const pagePosition = single ? jointPosition(single, doc, frame) : null;
  const offPage = ids.some((id) => isOffPage(doc, id, frame));
  const shown = single ? variantAt(single, doc, frame) : null;
  const intrinsic = shown ? variantBounds(shown, doc) : null;

  function numberField(
    path: string,
    label: string,
    read: (part: PartLayer) => AnimatableNumber,
    options?: {
      step?: number;
      precision?: number;
      suffix?: string;
      min?: number;
      max?: number;
    },
  ) {
    const { value, mixed, keyed } = readNumber(parts, read, doc, frame);
    return (
      <ScrubInput
        label={label}
        value={value}
        mixed={mixed}
        title={keyed ? "Animated. Typing sets a key here." : undefined}
        step={options?.step}
        precision={options?.precision}
        suffix={options?.suffix}
        min={options?.min}
        max={options?.max}
        onScrubStart={() => beginGesture(path)}
        onScrubEnd={endGesture}
        onChange={(next) => edit((d) => writeValue(d, ids, path, frame, next))}
      />
    );
  }

  function sizeField(
    label: string,
    path: string,
    read: (part: PartLayer) => AnimatableNumber,
    span: number,
  ) {
    const { value, mixed } = readNumber(parts, read, doc, frame);
    return (
      <ScrubInput
        label={label}
        value={value * span}
        mixed={mixed}
        precision={1}
        min={1}
        onScrubStart={() => beginGesture(path)}
        onScrubEnd={endGesture}
        onChange={(size) =>
          edit((d) => writeValue(d, ids, path, frame, size / span))
        }
      />
    );
  }

  const width = intrinsic ? intrinsic[2] - intrinsic[0] : 0;
  const height = intrinsic ? intrinsic[3] - intrinsic[1] : 0;
  const sizable = Boolean(single) && width > 0.5 && height > 0.5;

  return (
    <>
      {single ? (
        <Section label="Name">
          <TextField
            label="Part name"
            value={single.name}
            onCommit={(name) => edit((d) => patchLayer(d, single.id, { name }))}
          />
        </Section>
      ) : null}

      <Section label="Position and size">
        <div className="grid grid-cols-2 gap-2">
          {/*
            Shown as where the joint sits on the page, not as the number the
            part stores. A part's own x and y are read in whatever it is
            attached to, so three parts in three places all read zero, which is
            true and useless.
          */}
          <ScrubInput
            label="X"
            value={pagePosition ? pagePosition[0] : 0}
            mixed={!single}
            precision={0}
            disabled={!pagePosition}
            onScrubStart={() => beginGesture("page.x")}
            onScrubEnd={endGesture}
            onChange={(next) =>
              pagePosition &&
              single &&
              edit((d) => nudge(d, single.id, frame, next - pagePosition[0], 0))
            }
          />
          <ScrubInput
            label="Y"
            value={pagePosition ? pagePosition[1] : 0}
            mixed={!single}
            precision={0}
            disabled={!pagePosition}
            onScrubStart={() => beginGesture("page.y")}
            onScrubEnd={endGesture}
            onChange={(next) =>
              pagePosition &&
              single &&
              edit((d) => nudge(d, single.id, frame, 0, next - pagePosition[1]))
            }
          />
          {sizable ? (
            <>
              {sizeField(
                "W",
                "transform.scaleX",
                (p) => p.transform.scaleX,
                width,
              )}
              {sizeField(
                "H",
                "transform.scaleY",
                (p) => p.transform.scaleY,
                height,
              )}
            </>
          ) : (
            <>
              {numberField(
                "transform.scaleX",
                "Wide",
                (p) => p.transform.scaleX,
                { step: 0.01, precision: 2 },
              )}
              {numberField(
                "transform.scaleY",
                "Tall",
                (p) => p.transform.scaleY,
                { step: 0.01, precision: 2 },
              )}
            </>
          )}
          {numberField(
            "transform.rotation",
            "Rotation",
            (p) => p.transform.rotation,
            { precision: 1, suffix: "°" },
          )}
        </div>
        {offPage ? (
          <p className={`${HINT_TEXT} text-riff-danger`}>
            Some of this is off the page. The exported player cuts it off.
          </p>
        ) : null}
      </Section>

      {single ? (
        <Section label="Joint" hint="The point this part turns around.">
          <div className="grid grid-cols-2 gap-2">
            <ScrubInput
              label="X"
              value={single.pivot.x}
              onScrubStart={() => beginGesture("joint.x")}
              onScrubEnd={endGesture}
              onChange={(x) =>
                edit((d) =>
                  patchLayer(d, single.id, { pivot: { ...single.pivot, x } }),
                )
              }
            />
            <ScrubInput
              label="Y"
              value={single.pivot.y}
              onScrubStart={() => beginGesture("joint.y")}
              onScrubEnd={endGesture}
              onChange={(y) =>
                edit((d) =>
                  patchLayer(d, single.id, { pivot: { ...single.pivot, y } }),
                )
              }
            />
          </div>
          <WideButton onClick={onUseJointTool}>
            <Crosshair className="size-3.5" strokeWidth={1.75} />
            Set at click
          </WideButton>
        </Section>
      ) : null}

      {single ? (
        <Section
          label="Attach to"
          hint="This part follows whatever it is attached to."
        >
          <select
            aria-label="Attach to"
            value={single.parentLayerId ?? ""}
            onChange={(event) => {
              const next = event.currentTarget.value;
              edit((d) =>
                attachTo(
                  d,
                  [single.id],
                  next === "" ? null : (next as LayerId),
                  frame,
                ),
              );
            }}
            className={`${UI_TEXT} h-7 w-full rounded-riff-lg bg-riff-fill px-2 text-[12px] ${FOCUS_RING}`}
          >
            <option value="">Nothing</option>
            {(activeArtboard(doc)?.layerIds ?? [])
              .map((id) => doc.layers[id])
              .filter(
                (part): part is PartLayer =>
                  Boolean(part) && !isDescendant(doc, part.id, single.id),
              )
              .map((part) => (
                <option key={part.id} value={part.id}>
                  {part.name}
                </option>
              ))}
          </select>
        </Section>
      ) : null}

      {single?.parentLayerId ? (
        <Section
          label="Overlap"
          hint="Tucks this part under the one it is attached to, so the join does not show."
        >
          <Stepper
            label="Overlap"
            value={single.overlap}
            min={0}
            max={3}
            onChange={(overlap) =>
              edit((d) => patchLayer(d, single.id, { overlap }))
            }
          />
        </Section>
      ) : null}

      <AppearanceSection
        doc={doc}
        parts={parts}
        frame={frame}
        edit={edit}
        beginGesture={beginGesture}
        endGesture={endGesture}
        onOpacity={(percent) =>
          edit((d) => writeValue(d, ids, "opacity", frame, percent / 100))
        }
        onFillPicked={onFillPicked}
        opacity={readNumber(parts, (p) => p.opacity, doc, frame)}
      />

      {single ? (
        <VariantsSection
          doc={doc}
          part={single}
          frame={frame}
          edit={edit}
          beginGesture={beginGesture}
          endGesture={endGesture}
        />
      ) : null}

      <Section
        label="Slant and depth"
        hint="Slant leans a part without turning it. Depth decides what draws in front."
      >
        <div className="grid grid-cols-3 gap-2">
          {numberField("transform.skewX", "Slant X", (p) => p.transform.skewX, {
            precision: 1,
            suffix: "°",
            min: -80,
            max: 80,
          })}
          {numberField("transform.skewY", "Slant Y", (p) => p.transform.skewY, {
            precision: 1,
            suffix: "°",
            min: -80,
            max: 80,
          })}
          {numberField("depth", "Depth", (p) => p.depth, { precision: 0 })}
        </div>
      </Section>

      <ShapeSection
        doc={doc}
        parts={parts}
        frame={frame}
        drawFill={drawFill}
        edit={edit}
        onSelect={onSelect}
      />

      <Section label="Order">
        <div className="flex items-center gap-1">
          <IconButton
            label="Bring forward"
            shortcut="⌘]"
            onClick={() => edit((d) => moveInDrawOrder(d, ids, "forward"))}
          >
            <ChevronUp className="size-4" strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label="Send backward"
            shortcut="⌘["
            onClick={() => edit((d) => moveInDrawOrder(d, ids, "backward"))}
          >
            <ChevronDown className="size-4" strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label="Bring to front"
            shortcut="⌥⌘]"
            onClick={() => edit((d) => moveInDrawOrder(d, ids, "front"))}
          >
            <BringToFront className="size-4" strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label="Send to back"
            shortcut="⌥⌘["
            onClick={() => edit((d) => moveInDrawOrder(d, ids, "back"))}
          >
            <SendToBack className="size-4" strokeWidth={1.75} />
          </IconButton>
        </div>
      </Section>

      <Section
        label="Copy"
        hint="Mirror makes the other side of a part and everything attached to it, in front."
      >
        <div className="flex gap-2">
          <WideButton
            onClick={() => {
              let created: LayerId[] = [];
              edit((d) => {
                const result = duplicateParts(d, ids, { frame });
                created = result.created;
                return result.doc;
              });
              if (created.length > 0) onSelect(created);
            }}
          >
            <Copy className="size-3.5" strokeWidth={1.75} />
            Duplicate
          </WideButton>
          <WideButton
            onClick={() => {
              let created: LayerId[] = [];
              edit((d) => {
                const result = duplicateParts(d, ids, {
                  mirrorAxis: mirrorAxisFor(d, ids[0]),
                  frame,
                });
                created = result.created;
                return result.doc;
              });
              if (created.length > 0) onSelect(created);
            }}
          >
            <FlipHorizontal className="size-3.5" strokeWidth={1.75} />
            Mirror
          </WideButton>
        </div>
      </Section>

      {parts.length > 1 ? (
        <AlignSection doc={doc} parts={parts} frame={frame} edit={edit} />
      ) : null}
    </>
  );
}

// --------------------------------------------------------------- appearance

function AppearanceSection({
  onFillPicked,
  doc,
  parts,
  frame,
  edit,
  beginGesture,
  endGesture,
  opacity,
  onOpacity,
}: SectionActions & {
  doc: RiffDocument;
  parts: PartLayer[];
  frame: Frame;
  opacity: { value: number; mixed: boolean; keyed: boolean };
  onOpacity: (percent: number) => void;
  /** Remembers the colour, so the next part drawn starts in it. */
  onFillPicked: (colour: RGBA) => void;
}) {
  const ids = parts.map((part) => part.id);
  const shown = parts
    .map((part) => variantAt(part, doc, frame))
    .filter((variant): variant is Variant => Boolean(variant));
  if (shown.length === 0) return null;

  const fill = agree(shown, (v) => (v.fill ? rgbaToCss(v.fill) : null));
  const stroke = agree(shown, (v) => (v.stroke ? rgbaToCss(v.stroke) : null));
  const strokeWidth = agree(shown, (v) => v.strokeWidth);

  function patchStyle(patch: Partial<Variant>) {
    edit((d) => patchShownVariant(d, ids, frame, patch));
  }

  return (
    <>
      <Section label="Fill">
        <ColorField
          value={fill.mixed ? null : shown[0].fill}
          mixed={fill.mixed}
          swatches={SWATCHES}
          onChange={(value) => {
            patchStyle({ fill: value });
            // The next part drawn starts in the colour just chosen, so picking
            // a palette once is the whole colour workflow.
            if (value) onFillPicked(value);
          }}
          clearLabel="Remove the fill"
        />
      </Section>

      <Section label="Outline">
        <ColorField
          value={stroke.mixed ? null : shown[0].stroke}
          mixed={stroke.mixed}
          onChange={(value) => patchStyle({ stroke: value })}
          clearLabel="Remove the outline"
        />
        <ScrubInput
          label="Width"
          value={strokeWidth.value ?? 0}
          mixed={strokeWidth.mixed}
          min={0}
          step={0.5}
          precision={1}
          onScrubStart={() => beginGesture("outline.width")}
          onScrubEnd={endGesture}
          onChange={(value) => patchStyle({ strokeWidth: value })}
        />
      </Section>

      <Section label="Opacity">
        <ScrubInput
          label="Opacity"
          value={Math.round(opacity.value * 100)}
          mixed={opacity.mixed}
          title={
            opacity.keyed ? "Animated. Typing sets a key here." : undefined
          }
          min={0}
          max={100}
          suffix="%"
          onScrubStart={() => beginGesture("opacity")}
          onScrubEnd={endGesture}
          onChange={onOpacity}
        />
      </Section>
    </>
  );
}

// ----------------------------------------------------------------- variants

function VariantsSection({
  doc,
  part,
  frame,
  edit,
}: SectionActions & { doc: RiffDocument; part: PartLayer; frame: Frame }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const active = activeVariantIndex(part, doc, frame);

  function show(index: number) {
    edit((d) => writeValue(d, [part.id], "variant", frame, index));
  }

  function add() {
    edit((d) => {
      const source = d.layers[part.id];
      if (!source) return d;
      const from = source.variants[active];
      const copied = copyPaths(d, from?.pathIds ?? []);
      const variants = [
        ...source.variants,
        {
          ...(from ?? {
            fill: null,
            fillRule: "nonzero" as const,
            stroke: null,
            strokeWidth: 0,
            image: null,
          }),
          id: newId("Variant"),
          name: `Variant ${source.variants.length + 1}`,
          pathIds: copied.ids,
        },
      ];
      return patchLayer(copied.doc, part.id, { variants });
    });
  }

  function remove(index: number) {
    edit((d) => {
      const source = d.layers[part.id];
      if (!source || source.variants.length <= 1) return d;
      const variants = source.variants.filter((_, i) => i !== index);
      const blink =
        source.blinkVariant === null
          ? null
          : source.blinkVariant === index
            ? null
            : source.blinkVariant > index
              ? source.blinkVariant - 1
              : source.blinkVariant;
      const out = patchLayer(d, part.id, {
        variants,
        blinkVariant: blink,
      });
      return writeValue(
        out,
        [part.id],
        "variant",
        frame,
        Math.min(active, variants.length - 1),
      );
    });
  }

  return (
    <Section
      label="Variants"
      hint="Other drawings for this part, like an open and a closed hand."
    >
      <div className="flex flex-wrap gap-1.5">
        {part.variants.map((variant, index) => {
          const selected = index === active;
          if (renaming === variant.id) {
            return (
              <input
                key={variant.id}
                ref={(node) => node?.select()}
                defaultValue={variant.name}
                aria-label="Variant name"
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim();
                  setRenaming(null);
                  if (name && name !== variant.name) {
                    edit((d) => patchVariantAt(d, part.id, index, { name }));
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    event.currentTarget.value = variant.name;
                    event.currentTarget.blur();
                  }
                }}
                className={`${UI_TEXT} h-7 w-24 rounded-riff-pill bg-riff-panel px-2 outline-2 outline-riff-accent`}
              />
            );
          }
          return (
            <span
              key={variant.id}
              className={`inline-flex h-7 items-center rounded-riff-pill pl-2.5 ${
                selected
                  ? "bg-riff-accent text-white"
                  : "bg-riff-fill text-riff-text hover:bg-riff-fill-hover"
              } ${part.variants.length > 1 ? "pr-0.5" : "pr-2.5"}`}
            >
              <button
                type="button"
                onClick={() => show(index)}
                onDoubleClick={() => setRenaming(variant.id)}
                title="Click to show. Double-click to rename."
                className={`${UI_TEXT} ${selected ? "text-white" : ""} ${FOCUS_RING} max-w-[96px] truncate`}
              >
                {variant.name}
              </button>
              {part.variants.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Delete ${variant.name}`}
                  onClick={() => remove(index)}
                  className={`ml-1 grid size-5 place-items-center rounded-riff-pill ${
                    selected
                      ? "text-white/80 hover:bg-white/20"
                      : "text-riff-faint hover:bg-riff-fill-hover"
                  } ${FOCUS_RING}`}
                >
                  <X className="size-3" strokeWidth={2} />
                </button>
              ) : null}
            </span>
          );
        })}
        <button
          type="button"
          onClick={add}
          className={`inline-flex h-7 items-center gap-1 rounded-riff-pill bg-riff-fill px-2.5 ${UI_TEXT} hover:bg-riff-fill-hover ${PRESS} ${FOCUS_RING}`}
        >
          <Plus className="size-3" strokeWidth={2.5} />
          Add
        </button>
      </div>

      {part.variants.length > 1 ? (
        <Row label="Blinks with">
          <select
            aria-label="Blinks with"
            value={part.blinkVariant === null ? "" : String(part.blinkVariant)}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              edit((d) =>
                patchLayer(d, part.id, {
                  blinkVariant: raw === "" ? null : Number(raw),
                }),
              );
            }}
            className={`${UI_TEXT} h-7 w-full rounded-riff-lg bg-riff-fill px-2 text-[12px] ${FOCUS_RING}`}
          >
            <option value="">Never</option>
            {part.variants.map((variant, index) => (
              <option key={variant.id} value={index}>
                {variant.name}
              </option>
            ))}
          </select>
        </Row>
      ) : null}
    </Section>
  );
}

// -------------------------------------------------------------------- shape

function ShapeSection({
  doc,
  parts,
  frame,
  drawFill,
  edit,
  onSelect,
}: {
  doc: RiffDocument;
  parts: PartLayer[];
  frame: Frame;
  /** The colour a new shape gets, so a joined outline becomes a filled part. */
  drawFill: RGBA;
  edit: (patch: (doc: RiffDocument) => RiffDocument) => void;
  onSelect: (ids: LayerId[]) => void;
}) {
  const ids = parts.map((part) => part.id);
  if (!hasGeometry(doc, ids, frame)) return null;

  const joinable = canJoin(doc, ids, frame);
  const combinable = canCombine(doc, ids, frame);

  function shape(run: (d: RiffDocument) => ShapeResult) {
    let landed: LayerId | null = null;
    edit((d) => {
      const result = run(d);
      landed = result.keeperId;
      return result.doc;
    });
    if (landed) onSelect([landed]);
  }

  return (
    <Section
      label="Shape"
      hint="Join turns separate lines into one filled shape."
    >
      <div className="flex flex-wrap gap-1.5">
        <Chip
          onClick={() => shape((d) => joinParts(d, ids, frame, drawFill))}
          disabled={!joinable}
        >
          Join
        </Chip>
        <Chip
          onClick={() => shape((d) => combineParts(d, ids, "union", frame))}
          disabled={!combinable}
        >
          Add
        </Chip>
        <Chip
          onClick={() => shape((d) => combineParts(d, ids, "subtract", frame))}
          disabled={!combinable}
        >
          Subtract
        </Chip>
        <Chip
          onClick={() => shape((d) => combineParts(d, ids, "intersect", frame))}
          disabled={!combinable}
        >
          Overlap only
        </Chip>
        <Chip onClick={() => edit((d) => simplifyParts(d, ids, frame))}>
          Simplify
        </Chip>
        <Chip onClick={() => edit((d) => smoothParts(d, ids, frame))}>
          Smooth
        </Chip>
      </div>
    </Section>
  );
}

// -------------------------------------------------------------------- align

function AlignSection({
  doc,
  parts,
  frame,
  edit,
}: {
  doc: RiffDocument;
  parts: PartLayer[];
  frame: Frame;
  edit: (patch: (doc: RiffDocument) => RiffDocument) => void;
}) {
  const boxed = parts
    .map((part) => ({ part, box: worldBox(doc, part, frame) }))
    .filter(
      (
        entry,
      ): entry is { part: PartLayer; box: [number, number, number, number] } =>
        Boolean(entry.box),
    );
  if (boxed.length < 2) return null;

  const left = Math.min(...boxed.map((b) => b.box[0]));
  const right = Math.max(...boxed.map((b) => b.box[2]));
  const top = Math.min(...boxed.map((b) => b.box[1]));
  const bottom = Math.max(...boxed.map((b) => b.box[3]));

  function align(
    pick: (box: [number, number, number, number]) => [number, number],
  ) {
    edit((d) => {
      let out = d;
      for (const entry of boxed) {
        const [dx, dy] = pick(entry.box);
        out = nudge(out, entry.part.id, frame, dx, dy);
      }
      return out;
    });
  }

  function distribute(axis: "x" | "y") {
    const sorted = [...boxed].sort((a, b) =>
      axis === "x"
        ? (a.box[0] + a.box[2]) / 2 - (b.box[0] + b.box[2]) / 2
        : (a.box[1] + a.box[3]) / 2 - (b.box[1] + b.box[3]) / 2,
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const centre = (box: [number, number, number, number]) =>
      axis === "x" ? (box[0] + box[2]) / 2 : (box[1] + box[3]) / 2;
    const span = centre(last.box) - centre(first.box);
    const step = span / (sorted.length - 1);
    edit((d) => {
      let out = d;
      sorted.forEach((entry, index) => {
        if (index === 0 || index === sorted.length - 1) return;
        const target = centre(first.box) + step * index;
        const delta = target - centre(entry.box);
        out = nudge(
          out,
          entry.part.id,
          frame,
          axis === "x" ? delta : 0,
          axis === "x" ? 0 : delta,
        );
      });
      return out;
    });
  }

  return (
    <Section label="Line up">
      <div className="flex items-center gap-1">
        <IconButton
          label="Line up on the left"
          onClick={() => align((box) => [left - box[0], 0])}
        >
          <AlignHorizontalJustifyStart className="size-4" strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label="Centre across"
          onClick={() =>
            align((box) => [(left + right) / 2 - (box[0] + box[2]) / 2, 0])
          }
        >
          <AlignHorizontalJustifyCenter className="size-4" strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label="Line up on the right"
          onClick={() => align((box) => [right - box[2], 0])}
        >
          <AlignHorizontalJustifyEnd className="size-4" strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label="Line up at the top"
          onClick={() => align((box) => [0, top - box[1]])}
        >
          <AlignVerticalJustifyStart className="size-4" strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label="Centre down"
          onClick={() =>
            align((box) => [0, (top + bottom) / 2 - (box[1] + box[3]) / 2])
          }
        >
          <AlignVerticalJustifyCenter className="size-4" strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label="Line up at the bottom"
          onClick={() => align((box) => [0, bottom - box[3]])}
        >
          <AlignVerticalJustifyEnd className="size-4" strokeWidth={1.75} />
        </IconButton>
      </div>
      {boxed.length > 2 ? (
        <div className="flex items-center gap-1">
          <IconButton label="Space out across" onClick={() => distribute("x")}>
            <AlignHorizontalDistributeCenter
              className="size-4"
              strokeWidth={1.75}
            />
          </IconButton>
          <IconButton label="Space out down" onClick={() => distribute("y")}>
            <AlignVerticalDistributeCenter
              className="size-4"
              strokeWidth={1.75}
            />
          </IconButton>
        </div>
      ) : null}
    </Section>
  );
}

// -------------------------------------------------------------- primitives

function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className={SECTION_LABEL}>{label}</h3>
      {children}
      {hint ? <p className={HINT_TEXT}>{hint}</p> : null}
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[68px] shrink-0 text-[11px] leading-4 text-riff-muted">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function TextField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="text"
      aria-label={label}
      value={draft ?? value}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => {
        const next = event.currentTarget.value.trim();
        setDraft(null);
        if (next && next !== value) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
      className={`${UI_TEXT} h-7 w-full rounded-riff-lg bg-riff-fill px-2 outline-none focus:bg-riff-accent-soft focus:outline-2 focus:outline-riff-accent`}
    />
  );
}

/**
 * Colour swatch, hex, and one click to a sensible colour.
 *
 * `null` is a real value here, no fill or a see-through background, and it reads
 * as the transparency checkerboard rather than as an empty field.
 */
function ColorField({
  value,
  mixed = false,
  swatches,
  onChange,
  clearLabel,
}: {
  value: RGBA | null;
  mixed?: boolean;
  swatches?: readonly Swatch[];
  onChange: (value: RGBA | null) => void;
  clearLabel: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const hex = value ? toHex(value) : "";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="relative size-7 shrink-0 overflow-hidden rounded-riff-md">
          <span
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              backgroundColor: "var(--riff-panel)",
              backgroundImage:
                "conic-gradient(var(--riff-hairline) 0 25%, transparent 0 50%, var(--riff-hairline) 0 75%, transparent 0)",
              backgroundSize: "8px 8px",
            }}
          />
          {value ? (
            <span
              aria-hidden="true"
              className="absolute inset-0"
              style={{ backgroundColor: rgbaToCss(value) }}
            />
          ) : null}
          <input
            type="color"
            aria-label="Colour"
            value={hex || "#ffffff"}
            onChange={(event) => {
              const parsed = parseHex(event.currentTarget.value);
              if (parsed) onChange({ ...parsed, a: value?.a ?? 1 });
            }}
            className={`absolute inset-0 size-full cursor-pointer opacity-0 ${FOCUS_RING}`}
          />
        </span>

        <input
          type="text"
          aria-label="Colour code"
          spellCheck={false}
          placeholder={mixed ? "Mixed" : "None"}
          value={draft ?? hex}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={(event) => {
            const parsed = parseHex(event.currentTarget.value);
            setDraft(null);
            if (parsed) onChange({ ...parsed, a: value?.a ?? 1 });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraft(null);
              event.currentTarget.blur();
            }
          }}
          className={`${NUMERIC_TEXT} h-7 min-w-0 flex-1 rounded-riff-lg bg-riff-fill px-2 text-riff-text uppercase outline-none placeholder:normal-case placeholder:text-riff-faint focus:bg-riff-accent-soft focus:outline-2 focus:outline-riff-accent`}
        />

        <Tip label={clearLabel} side="left">
          <button
            type="button"
            disabled={!value}
            onClick={() => onChange(null)}
            aria-label={clearLabel}
            className={`inline-flex size-7 shrink-0 items-center justify-center rounded-riff-lg text-riff-muted hover:bg-riff-fill disabled:pointer-events-none disabled:opacity-30 ${PRESS} ${FOCUS_RING}`}
          >
            <span aria-hidden="true" className="text-[13px] leading-none">
              ⌀
            </span>
          </button>
        </Tip>
      </div>

      {swatches ? (
        <div className="flex flex-wrap gap-1">
          {swatches.map((swatch) => (
            <button
              key={swatch.hex}
              type="button"
              aria-label={swatch.name}
              title={swatch.name}
              onClick={() => {
                const parsed = parseHex(swatch.hex);
                if (parsed) onChange({ ...parsed, a: value?.a ?? 1 });
              }}
              style={{ backgroundColor: swatch.hex }}
              className={`size-[18px] rounded-riff-sm ring-1 ring-riff-hairline-strong ring-inset ${PRESS} ${FOCUS_RING} ${
                hex.toLowerCase() === swatch.hex.toLowerCase()
                  ? "outline outline-2 outline-riff-accent outline-offset-1"
                  : ""
              }`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`flex h-8 w-full items-center justify-between rounded-riff-lg bg-riff-fill px-2 ${UI_TEXT} ${PRESS} ${FOCUS_RING}`}
    >
      <span>{label}</span>
      <span
        aria-hidden="true"
        className={`relative h-4 w-7 rounded-riff-pill transition-colors duration-[120ms] ease-riff ${
          checked ? "bg-riff-accent" : "bg-riff-hairline-strong"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 size-3 rounded-riff-pill bg-riff-panel transition-transform duration-[120ms] ease-riff ${
            checked ? "translate-x-3" : ""
          }`}
        />
      </span>
    </button>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex h-7 items-center justify-between rounded-riff-lg bg-riff-fill px-1">
      <button
        type="button"
        aria-label={`Less ${label.toLowerCase()}`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className={`grid size-6 place-items-center rounded-riff-md text-riff-muted hover:bg-riff-fill-hover disabled:pointer-events-none disabled:opacity-30 ${FOCUS_RING}`}
      >
        <Minus className="size-3.5" strokeWidth={2} />
      </button>
      <output className={`${NUMERIC_TEXT} text-riff-text`}>{value}</output>
      <button
        type="button"
        aria-label={`More ${label.toLowerCase()}`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className={`grid size-6 place-items-center rounded-riff-md text-riff-muted hover:bg-riff-fill-hover disabled:pointer-events-none disabled:opacity-30 ${FOCUS_RING}`}
      >
        <Plus className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}

function WideButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-riff-lg bg-riff-fill ${UI_TEXT} hover:bg-riff-fill-hover ${PRESS} ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}

function Chip({
  onClick,
  disabled = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 items-center rounded-riff-pill bg-riff-fill px-2.5 ${UI_TEXT} hover:bg-riff-fill-hover disabled:pointer-events-none disabled:opacity-30 ${PRESS} ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tip label={label} shortcut={shortcut} side="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`inline-flex size-7 shrink-0 items-center justify-center rounded-riff-md text-riff-muted hover:bg-riff-fill hover:text-riff-text ${PRESS} ${FOCUS_RING}`}
      >
        {children}
      </button>
    </Tip>
  );
}

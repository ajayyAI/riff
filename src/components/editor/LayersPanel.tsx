"use client";

/**
 * The parts panel.
 *
 * One list, two jobs, and the whole panel is designed around keeping them
 * distinguishable. The vertical order is the draw order, front of the stack at
 * the top, exactly matching what the canvas shows. The indent is the skeleton:
 * what is attached to what. They are independent in the model, so a part can be
 * attached to the body and still draw behind it, and the panel has to be able to
 * say that.
 *
 * Rows come from a flattened list rather than from recursive components because
 * shift-click needs a range and a range needs an order. The flattening respects
 * `collapsed`, so a shift-click selects what the user can actually see.
 */

import {
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  Lock,
  LockOpen,
  Shapes,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  Layer,
  LayerId,
  PathGeometry,
  RGBA,
  RiffDocument,
} from "@/editor/model/document";
import { rgbaToCss } from "@/editor/model/document";
import {
  activeArtboard,
  ancestors,
  attachTo,
  deleteParts,
  duplicateParts,
  groupParts,
  isDescendant,
  mirrorAxisFor,
  moveInDrawOrder,
  patchLayer,
  reorderTo,
  treeOrder,
  ungroupParts,
  variantAt,
  variantBounds,
  variantPaths,
} from "@/editor/model/rig";
import {
  canCombine,
  canJoin,
  combineParts,
  hasGeometry,
  joinParts,
  type ShapeResult,
  simplifyParts,
  smoothParts,
} from "@/editor/model/shape-ops";
import { useEditor, useEditorStore } from "@/editor/ui/context";
import {
  FOCUS_RING,
  HINT_TEXT,
  indentFor,
  LAYER_ROW_HEIGHT,
  PANEL,
  PANEL_TITLE,
  POPUP,
  POPUP_LAYER,
  PRESS,
  ROW_BUTTON,
  UI_TEXT,
} from "./styles";
import { Tip } from "./Tooltip";

/** How far into a row counts as "drop between" rather than "drop onto". */
const EDGE_BAND = 0.25;

interface Row {
  layer: Layer;
  /** How deep in the skeleton, for the indent. */
  depth: number;
  /** True when this part or anything it is attached to is hidden. */
  dimmed: boolean;
  hasChildren: boolean;
}

/**
 * The rig as rows.
 *
 * `treeOrder` nests by what each part is attached to and orders siblings front
 * of the stack first, so the indent answers "what does this follow" and the
 * vertical order answers "what is on top". Parts under a closed part are left
 * out entirely.
 */
function flatten(doc: RiffDocument): Row[] {
  const rows: Row[] = [];
  for (const node of treeOrder(doc)) {
    const layer = doc.layers[node.id];
    if (!layer) continue;
    const chain = ancestors(doc, node.id);
    if (chain.some((id) => doc.layers[id]?.collapsed)) continue;
    rows.push({
      layer,
      depth: node.depth,
      dimmed: !layer.visible || chain.some((id) => !doc.layers[id]?.visible),
      hasChildren: node.hasChildren,
    });
  }
  return rows;
}

type DropTarget =
  | { kind: "between"; index: number }
  | { kind: "onto"; id: LayerId };

interface MenuState {
  x: number;
  y: number;
  id: LayerId;
}

export interface LayersPanelProps {
  className?: string;
  style?: React.CSSProperties;
}

export function LayersPanel({ className = "", style }: LayersPanelProps) {
  const store = useEditorStore();
  const doc = useEditor((state) => state.doc);
  const frame = useEditor((state) => state.ui.frame);
  const selection = useEditor((state) => state.ui.selection.layerIds);
  const drawFill = useEditor((state) => state.ui.drawFill);

  const [renaming, setRenaming] = useState<LayerId | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Where a shift-click measures its range from.
  const anchor = useRef<LayerId | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: LayerId; y: number; started: boolean } | null>(
    null,
  );

  const rows = flatten(doc);
  const selected = new Set(selection);

  // Every part between a selected part and its root, tinted so the chain that
  // carries the selection is visible at a glance.
  const chain = new Set<LayerId>();
  for (const id of selection) {
    for (const parentId of ancestors(doc, id)) chain.add(parentId);
  }

  function edit(
    patch: (current: RiffDocument) => RiffDocument,
    mergeKey?: string,
  ) {
    store.begin(mergeKey ?? null);
    store.setDoc(patch);
    store.commit();
  }

  function onRowPointerDown(id: LayerId, event: React.PointerEvent) {
    if (event.button === 2) return;
    if (event.button !== 0) return;

    if (event.shiftKey && anchor.current) {
      const from = rows.findIndex((row) => row.layer.id === anchor.current);
      const to = rows.findIndex((row) => row.layer.id === id);
      if (from !== -1 && to !== -1) {
        const lo = Math.min(from, to);
        const hi = Math.max(from, to);
        store.select(rows.slice(lo, hi + 1).map((row) => row.layer.id));
      }
    } else if (event.metaKey || event.ctrlKey) {
      store.toggleSelect(id);
      anchor.current = id;
    } else {
      if (!selected.has(id)) store.select([id]);
      anchor.current = id;
    }

    drag.current = { id, y: event.clientY, started: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function targetFor(clientY: number): DropTarget | null {
    const list = listRef.current;
    if (!list || rows.length === 0) return null;
    const rect = list.getBoundingClientRect();
    const local = clientY - rect.top;
    const raw = local / LAYER_ROW_HEIGHT;
    const index = Math.floor(raw);

    if (index < 0) return { kind: "between", index: 0 };
    if (index >= rows.length) return { kind: "between", index: rows.length };

    const fraction = raw - index;
    if (fraction < EDGE_BAND) return { kind: "between", index };
    if (fraction > 1 - EDGE_BAND) return { kind: "between", index: index + 1 };
    return { kind: "onto", id: rows[index].layer.id };
  }

  function onRowPointerMove(event: React.PointerEvent) {
    const state = drag.current;
    if (!state) return;
    if (!state.started) {
      if (Math.abs(event.clientY - state.y) < 4) return;
      state.started = true;
    }
    const next = targetFor(event.clientY);
    // Attaching a part to something hanging off itself is the one move the
    // skeleton cannot represent, so it never lights up as a target.
    if (
      next?.kind === "onto" &&
      (next.id === state.id || isDescendant(doc, next.id, state.id))
    ) {
      setDrop(null);
      return;
    }
    setDrop(next);
  }

  function onRowPointerUp(event: React.PointerEvent) {
    const state = drag.current;
    const target = drop;
    drag.current = null;
    setDrop(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!state?.started || !target) return;

    const moving = selected.has(state.id) ? [...selection] : [state.id];

    if (target.kind === "onto") {
      if (moving.some((id) => isDescendant(doc, target.id, id))) return;
      edit((current) => attachTo(current, moving, target.id, frame));
      return;
    }

    // Display order is the reverse of the draw order, so an insertion point
    // above a row is an insertion point after it in the stored array.
    const artboard = activeArtboard(doc);
    if (!artboard) return;
    const ids = artboard.layerIds;
    const drawIndex =
      target.index < rows.length
        ? ids.indexOf(rows[target.index].layer.id) + 1
        : ids.indexOf(rows[rows.length - 1].layer.id);
    if (drawIndex < 0) return;
    edit((current) => reorderTo(current, moving, drawIndex));
  }

  function onRowContextMenu(id: LayerId, event: React.MouseEvent) {
    event.preventDefault();
    if (!selected.has(id)) store.select([id]);
    setMenu({ x: event.clientX, y: event.clientY, id });
  }

  function focusRow(index: number) {
    const list = listRef.current;
    if (!list) return;
    const next = list.querySelector<HTMLElement>(
      `[data-row-index="${Math.max(0, Math.min(index, rows.length - 1))}"]`,
    );
    next?.focus();
  }

  return (
    <aside
      aria-label="Parts"
      style={style}
      className={`${PANEL} w-60 ${className}`}
    >
      <header className="flex h-11 shrink-0 items-center justify-between px-3">
        <h2 className={PANEL_TITLE}>Parts</h2>
        {rows.length > 0 ? (
          <span className="text-[11px] leading-4 text-riff-faint">
            {rows.length}
          </span>
        ) : null}
      </header>

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="riff-scroll min-h-0 flex-1 overflow-y-auto px-1.5">
            <div
              ref={listRef}
              role="tree"
              aria-label="Parts, front of the stack first"
              aria-multiselectable="true"
              className="relative"
            >
              {rows.map((row, index) => (
                <PartRow
                  key={row.layer.id}
                  row={row}
                  index={index}
                  doc={doc}
                  frame={frame}
                  selected={selected.has(row.layer.id)}
                  inChain={chain.has(row.layer.id)}
                  dropOnto={drop?.kind === "onto" && drop.id === row.layer.id}
                  renaming={renaming === row.layer.id}
                  onPointerDown={(event) =>
                    onRowPointerDown(row.layer.id, event)
                  }
                  onPointerMove={onRowPointerMove}
                  onPointerUp={onRowPointerUp}
                  onContextMenu={(event) =>
                    onRowContextMenu(row.layer.id, event)
                  }
                  onStartRename={() => setRenaming(row.layer.id)}
                  onRename={(name) => {
                    setRenaming(null);
                    if (name && name !== row.layer.name) {
                      edit((current) =>
                        patchLayer(current, row.layer.id, { name }),
                      );
                    }
                  }}
                  onToggleCollapsed={() =>
                    edit((current) =>
                      patchLayer(current, row.layer.id, {
                        collapsed: !row.layer.collapsed,
                      }),
                    )
                  }
                  onToggleVisible={() =>
                    edit((current) =>
                      patchLayer(current, row.layer.id, {
                        visible: !row.layer.visible,
                      }),
                    )
                  }
                  onToggleLocked={() =>
                    edit((current) =>
                      patchLayer(current, row.layer.id, {
                        locked: !row.layer.locked,
                      }),
                    )
                  }
                  onMoveFocus={(delta) => focusRow(index + delta)}
                  onActivate={(additive) => {
                    if (additive) store.toggleSelect(row.layer.id);
                    else store.select([row.layer.id]);
                    anchor.current = row.layer.id;
                  }}
                />
              ))}

              {drop?.kind === "between" ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-riff-accent"
                  style={{ top: drop.index * LAYER_ROW_HEIGHT - 1 }}
                />
              ) : null}
            </div>
          </div>

          <p className={`${HINT_TEXT} shrink-0 px-3 pt-2 pb-3`}>
            Drag onto a part to attach it. Drag between to reorder.
          </p>
        </>
      )}

      {menu ? (
        <RowMenu
          state={menu}
          doc={doc}
          frame={frame}
          drawFill={drawFill}
          selection={selection}
          onClose={() => setMenu(null)}
          onRename={(id) => setRenaming(id)}
        />
      ) : null}
    </aside>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 pb-10 text-center">
      <Shapes className="size-6 text-riff-faint" strokeWidth={1.5} />
      <p className={UI_TEXT}>No parts yet</p>
      <p className="text-[12px] leading-4 text-riff-muted">
        Pick the Brush and draw one. Every stroke becomes a part.
      </p>
    </div>
  );
}

interface PartRowProps {
  row: Row;
  index: number;
  doc: RiffDocument;
  frame: number;
  selected: boolean;
  inChain: boolean;
  dropOnto: boolean;
  renaming: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onToggleCollapsed: () => void;
  onToggleVisible: () => void;
  onToggleLocked: () => void;
  onMoveFocus: (delta: number) => void;
  onActivate: (additive: boolean) => void;
}

function PartRow({
  row,
  index,
  doc,
  frame,
  selected,
  inChain,
  dropOnto,
  renaming,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onContextMenu,
  onStartRename,
  onRename,
  onToggleCollapsed,
  onToggleVisible,
  onToggleLocked,
  onMoveFocus,
  onActivate,
}: PartRowProps) {
  const { layer, depth, dimmed, hasChildren } = row;
  const variant = variantAt(layer, doc, frame);
  const paths = variantPaths(variant, doc);
  const bounds = variantBounds(variant, doc);

  const background = dropOnto
    ? "bg-riff-accent-soft-opaque outline-2 outline-riff-accent outline"
    : selected
      ? "bg-riff-accent-soft-opaque"
      : inChain
        ? "bg-riff-accent-soft"
        : "hover:bg-riff-fill";

  return (
    <div
      role="treeitem"
      tabIndex={0}
      data-row-index={index}
      aria-selected={selected}
      aria-level={depth + 1}
      aria-expanded={hasChildren ? !layer.collapsed : undefined}
      aria-label={`${layer.name}, part`}
      style={{ height: LAYER_ROW_HEIGHT, paddingLeft: indentFor(depth, 4) }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onContextMenu={onContextMenu}
      onDoubleClick={onStartRename}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate(event.metaKey || event.ctrlKey);
        } else if (event.key === "F2") {
          event.preventDefault();
          onStartRename();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onMoveFocus(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          onMoveFocus(-1);
        } else if (
          event.key === "ArrowRight" &&
          hasChildren &&
          layer.collapsed
        ) {
          event.preventDefault();
          onToggleCollapsed();
        } else if (
          event.key === "ArrowLeft" &&
          hasChildren &&
          !layer.collapsed
        ) {
          event.preventDefault();
          onToggleCollapsed();
        }
      }}
      className={`group flex cursor-default select-none items-center gap-1.5 rounded-riff-lg pr-1 ${FOCUS_RING} ${background}`}
    >
      {hasChildren ? (
        <button
          type="button"
          aria-label={
            layer.collapsed
              ? `Show what is attached to ${layer.name}`
              : `Fold away what is attached to ${layer.name}`
          }
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapsed();
          }}
          className={`inline-flex size-4 shrink-0 items-center justify-center rounded-riff-md text-riff-faint ${FOCUS_RING}`}
        >
          <ChevronRight
            className={`size-3.5 transition-transform duration-[120ms] ease-riff ${
              layer.collapsed ? "" : "rotate-90"
            }`}
          />
        </button>
      ) : (
        // Reserved, so a part with children and one without line up.
        <span aria-hidden="true" className="size-4 shrink-0" />
      )}

      {paths.length > 0 && bounds ? (
        <Thumbnail
          paths={paths}
          bounds={bounds}
          fill={variant?.fill ?? null}
          stroke={variant?.stroke ?? null}
        />
      ) : (
        <Folder
          aria-hidden="true"
          strokeWidth={1.75}
          className={`size-4 shrink-0 ${selected ? "text-riff-accent" : "text-riff-faint"}`}
        />
      )}

      {renaming ? (
        <input
          // Focus and select on mount rather than `autoFocus`: the field only
          // exists because the user just asked to rename, and pre-selecting the
          // old name means they can type straight over it.
          ref={(node) => node?.select()}
          defaultValue={layer.name}
          aria-label="Name"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onBlur={(event) => onRename(event.currentTarget.value.trim())}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = layer.name;
              event.currentTarget.blur();
            }
          }}
          className={`${UI_TEXT} min-w-0 flex-1 rounded-riff-md bg-riff-panel px-1 outline-2 outline-riff-accent`}
        />
      ) : (
        <span
          className={`min-w-0 flex-1 truncate text-[13px] leading-[18px] font-[450] ${
            dimmed ? "text-riff-faint" : "text-riff-text"
          }`}
        >
          {layer.name}
        </span>
      )}

      {/*
        Both toggles stay mounted and only fade, so the row never reflows on
        hover and the layout is identical whether or not a part is hidden.
      */}
      <Tip label={layer.locked ? "Unlock" : "Lock"} side="left">
        <button
          type="button"
          aria-label={
            layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`
          }
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onToggleLocked();
          }}
          className={`${ROW_BUTTON} ${
            layer.locked
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          }`}
        >
          {layer.locked ? (
            <Lock className="size-3.5" strokeWidth={1.75} />
          ) : (
            <LockOpen className="size-3.5" strokeWidth={1.75} />
          )}
        </button>
      </Tip>
      {/*
        The glyph shows what is on screen, not what this row's own flag says.
        A part whose parent is hidden is not on screen, and an open eye next to
        an invisible part is the tree contradicting the canvas.
      */}
      <Tip
        label={layer.visible ? "Hide" : "Show"}
        hint={
          dimmed && layer.visible
            ? "Hidden because what it is attached to is hidden."
            : undefined
        }
        side="left"
      >
        <button
          type="button"
          aria-label={
            layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`
          }
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onToggleVisible();
          }}
          className={`${ROW_BUTTON} ${
            dimmed
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          }`}
        >
          {dimmed ? (
            <EyeOff className="size-3.5" strokeWidth={1.75} />
          ) : (
            <Eye className="size-3.5" strokeWidth={1.75} />
          )}
        </button>
      </Tip>
    </div>
  );
}

/**
 * A 20px picture of the part.
 *
 * Drawn from the same `d` strings the canvas draws, fitted to the box, so the
 * row and the artboard can never disagree about what a part looks like.
 */
function Thumbnail({
  paths,
  bounds,
  fill,
  stroke,
}: {
  paths: PathGeometry[];
  bounds: [number, number, number, number];
  fill: RGBA | null;
  stroke: RGBA | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fillCss = fill ? rgbaToCss(fill) : null;
  const strokeCss = stroke ? rgbaToCss(stroke) : null;
  const [x0, y0, x1, y1] = bounds;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = 20;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const width = Math.max(1e-6, x1 - x0);
    const height = Math.max(1e-6, y1 - y0);
    const pad = 2;
    const scale = Math.min((size - pad * 2) / width, (size - pad * 2) / height);
    ctx.translate(
      pad + (size - pad * 2 - width * scale) / 2,
      pad + (size - pad * 2 - height * scale) / 2,
    );
    ctx.scale(scale, scale);
    ctx.translate(-x0, -y0);

    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const path of paths) {
      const shape = new Path2D(path.d);
      if (fillCss) {
        ctx.fillStyle = fillCss;
        ctx.fill(shape);
      }
      if (strokeCss) {
        ctx.strokeStyle = strokeCss;
        // A hairline in device pixels, whatever the fit scale turned out to be.
        ctx.lineWidth = 1 / scale;
        ctx.stroke(shape);
      }
    }
  }, [paths, fillCss, strokeCss, x0, y0, x1, y1]);

  return (
    // The picture is wrapped rather than labelled: the row already names the
    // part, and the lint rules rightly treat a bare canvas as interactive.
    <span aria-hidden="true" className="inline-flex size-4 shrink-0">
      <canvas ref={ref} style={{ width: 16, height: 16 }} />
    </span>
  );
}

interface MenuItem {
  label: string;
  shortcut?: string;
  run: () => void;
  danger?: boolean;
  /** Draw a rule above this item, to break the list into groups. */
  startsGroup?: boolean;
}

/**
 * The right-click menu.
 *
 * A plain fixed-position surface rather than a menu primitive, because it has to
 * open exactly where the pointer was and the list of actions is short enough to
 * read in one glance.
 */
function RowMenu({
  state,
  doc,
  frame,
  drawFill,
  selection,
  onClose,
  onRename,
}: {
  state: MenuState;
  doc: RiffDocument;
  frame: number;
  /** The colour a joined outline becomes, matching the inspector. */
  drawFill: RGBA;
  selection: readonly LayerId[];
  onClose: () => void;
  onRename: (id: LayerId) => void;
}) {
  const store = useEditorStore();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

  const layer = doc.layers[state.id];
  if (!layer) return null;

  const ids = selection.includes(state.id) ? [...selection] : [state.id];

  /** One undoable step. Selection moves only after the document has. */
  function apply(
    patch: (current: RiffDocument) => RiffDocument,
    after?: (next: RiffDocument) => LayerId[],
  ) {
    store.begin(null);
    store.setDoc(patch);
    store.commit();
    if (after) store.select(after(store.getState().doc));
  }

  /** Duplicate, optionally mirrored, then select what was made. */
  function copy(mirrorAxis: number | null) {
    const result = duplicateParts(store.getState().doc, ids, {
      mirrorAxis,
      frame,
    });
    store.begin(null);
    store.setDoc(result.doc);
    store.commit();
    if (result.created.length > 0) store.select(result.created);
  }

  /** A shape operation, which may land the result in a different part. */
  function shape(run: (current: RiffDocument) => ShapeResult) {
    let landed: LayerId | null = null;
    store.begin(null);
    store.setDoc((current) => {
      const result = run(current);
      landed = result.keeperId;
      return result.doc;
    });
    store.commit();
    if (landed) store.select([landed]);
  }

  const joinable = canJoin(doc, ids, frame);
  const combinable = canCombine(doc, ids, frame);
  const drawn = hasGeometry(doc, ids, frame);

  const items: MenuItem[] = [
    { label: "Rename", shortcut: "F2", run: () => onRename(state.id) },
    { label: "Duplicate", shortcut: "⌘D", run: () => copy(null) },
    {
      label: "Mirror",
      shortcut: "⇧⌘M",
      run: () => copy(mirrorAxisFor(store.getState().doc, ids[0])),
    },
    {
      startsGroup: true,
      label: "Attach to nothing",
      run: () => apply((current) => attachTo(current, ids, null, frame)),
    },
    {
      label: "Group",
      shortcut: "⌘G",
      run: () => {
        const result = groupParts(store.getState().doc, ids, frame);
        store.begin(null);
        store.setDoc(result.doc);
        store.commit();
        if (result.groupId) store.select([result.groupId]);
      },
    },
    {
      label: "Ungroup",
      shortcut: "⇧⌘G",
      run: () => apply((current) => ungroupParts(current, ids, frame)),
    },
    {
      startsGroup: true,
      label: "Bring forward",
      shortcut: "⌘]",
      run: () => apply((current) => moveInDrawOrder(current, ids, "forward")),
    },
    {
      label: "Send backward",
      shortcut: "⌘[",
      run: () => apply((current) => moveInDrawOrder(current, ids, "backward")),
    },
    {
      label: "Bring to front",
      shortcut: "⌥⌘]",
      run: () => apply((current) => moveInDrawOrder(current, ids, "front")),
    },
    {
      label: "Send to back",
      shortcut: "⌥⌘[",
      run: () => apply((current) => moveInDrawOrder(current, ids, "back")),
    },
    {
      label: layer.locked ? "Unlock" : "Lock",
      run: () =>
        apply((current) => {
          let next = current;
          for (const id of ids) {
            next = patchLayer(next, id, { locked: !layer.locked });
          }
          return next;
        }),
    },
    {
      label: layer.visible ? "Hide" : "Show",
      run: () =>
        apply((current) => {
          let next = current;
          for (const id of ids) {
            next = patchLayer(next, id, { visible: !layer.visible });
          }
          return next;
        }),
    },
    ...(joinable
      ? [
          {
            startsGroup: true,
            label: "Join",
            run: () => shape((d) => joinParts(d, ids, frame, drawFill)),
          },
        ]
      : []),
    ...(combinable
      ? ([
          {
            label: "Add",
            run: () => shape((d) => combineParts(d, ids, "union", frame)),
          },
          {
            label: "Subtract",
            run: () => shape((d) => combineParts(d, ids, "subtract", frame)),
          },
          {
            label: "Overlap only",
            run: () => shape((d) => combineParts(d, ids, "intersect", frame)),
          },
        ] as MenuItem[])
      : []),
    ...(drawn
      ? ([
          {
            label: "Simplify",
            run: () => apply((current) => simplifyParts(current, ids, frame)),
          },
          {
            label: "Smooth",
            run: () => apply((current) => smoothParts(current, ids, frame)),
          },
        ] as MenuItem[])
      : []),
    {
      startsGroup: true,
      label: "Delete",
      shortcut: "⌫",
      danger: true,
      run: () =>
        apply(
          (current) => deleteParts(current, ids, frame),
          () => [],
        ),
    },
  ];

  // Keep the menu on screen when the row was right-clicked near an edge.
  const width = 196;
  const rules = items.filter((item) => item.startsGroup).length;
  const height = items.length * 28 + rules * 9 + 8;
  const x = Math.min(state.x, window.innerWidth - width - 8);
  const y = Math.min(state.y, window.innerHeight - height - 8);

  // Portalled to the body. The panel carries a backdrop filter, which makes it
  // the containing block for anything fixed inside it, so a menu rendered in
  // place would be clipped by the card it belongs to.
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${layer.name}`}
      className={`${POPUP} ${POPUP_LAYER} fixed`}
      style={{ left: Math.max(8, x), top: Math.max(8, y), width }}
    >
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.startsGroup ? (
            <span
              aria-hidden="true"
              className="my-1 block h-px bg-riff-hairline"
            />
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              item.run();
              onClose();
            }}
            className={`flex w-full items-center justify-between gap-3 rounded-riff-lg px-2 py-1.5 text-left ${UI_TEXT} ${PRESS} ${FOCUS_RING} ${
              item.danger
                ? "text-riff-danger hover:bg-riff-danger/10"
                : "hover:bg-riff-fill"
            }`}
          >
            <span>{item.label}</span>
            {item.shortcut ? (
              <span className="font-mono text-[11px] leading-4 text-riff-faint">
                {item.shortcut}
              </span>
            ) : null}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

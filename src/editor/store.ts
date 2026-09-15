/**
 * Editor store.
 *
 * The document lives outside React. Every editor of this kind does the same,
 * and the reason is playback: scrubbing the timeline changes the current frame
 * sixty times a second, and routing that through React state means sixty
 * reconciliations a second to move one line on a canvas the renderer was going
 * to repaint anyway.
 *
 * So: a plain observable class, subscribed to by `useSyncExternalStore`. React
 * components read the slices they actually render. The canvas subscribes
 * directly and repaints imperatively, never re-rendering.
 *
 * Undo is a transaction, not a diff. `begin` snapshots, `commit` pushes an entry
 * only if something actually changed, and a drag that ends where it started
 * leaves no trace in the history. Consecutive transactions with the same
 * `mergeKey` collapse, which is what makes one drag one undo step instead of
 * ninety.
 */

import {
  type ArtboardId,
  emptyDocument,
  type Frame,
  type LayerId,
  NEUTRAL_FILL,
  type RGBA,
  type RiffDocument,
} from "./model/document";

/**
 * The seven tools, and nothing else.
 *
 * Every one of them serves the rig: point at parts, draw them, place their
 * joints, move the view. A tool that does not is a tool someone has to try
 * before they learn it does nothing here.
 */
export type ToolId =
  | "select"
  | "brush"
  | "pen"
  | "joint"
  | "rect"
  | "ellipse"
  | "hand";

export interface Viewport {
  /** Canvas-space translation, in device-independent pixels. */
  x: number;
  y: number;
  /** 1 = 100%. */
  scale: number;
}

export interface Selection {
  layerIds: LayerId[];
}

/** UI state that is not part of the saved document. */
export interface EditorUi {
  tool: ToolId;
  viewport: Viewport;
  selection: Selection;
  frame: Frame;
  playing: boolean;
  loop: boolean;
  /** Timeline horizontal zoom, as a multiplier on the base 140px/s. */
  timelineZoom: number;
  timelineHeight: number;
  /**
   * Bumped to ask the canvas to fit the artboard.
   *
   * Fitting needs the canvas element's real size, which only the canvas knows,
   * so the request travels as state rather than as a call. A counter rather
   * than a boolean means two fits in a row both land.
   */
  fitNonce: number;
  /** What the next fit aims at: everything, or only what is selected. */
  fitTarget: "content" | "selection";
  /** Same as `fitNonce`, but the artboard covers the visible desk. */
  fillNonce: number;
  /** Snap to other parts' bounds, centres and the artboard while dragging. */
  snap: boolean;
  /** Nominal brush weight, in document units. */
  brushWidth: number;
  /** The fill a new drawing gets. Follows the last colour the user picked. */
  drawFill: RGBA;
  /** Preview the blink variant, so a blink can be judged without playing. */
  previewBlink: boolean;
  /** Draw the pose before and after this one, faintly, to pose against. */
  onionSkin: boolean;
}

export interface EditorState {
  doc: RiffDocument;
  ui: EditorUi;
}

interface HistoryEntry {
  doc: RiffDocument;
  selection: Selection;
  mergeKey: string | null;
}

const MAX_HISTORY = 200;

export class EditorStore {
  private state: EditorState;
  private listeners = new Set<() => void>();
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  /** Snapshot taken at `begin`, held until `commit` or `abort`. */
  private pending: HistoryEntry | null = null;

  constructor(doc: RiffDocument = emptyDocument()) {
    this.state = {
      doc,
      ui: {
        tool: "select",
        viewport: { x: 0, y: 0, scale: 1 },
        selection: { layerIds: [] },
        frame: 0,
        playing: false,
        loop: true,
        timelineZoom: 1,
        timelineHeight: 208,
        fitNonce: 0,
        fitTarget: "content",
        fillNonce: 0,
        snap: true,
        brushWidth: 7,
        drawFill: NEUTRAL_FILL,
        previewBlink: false,
        onionSkin: false,
      },
    };
  }

  // ------------------------------------------------------------ subscription

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): EditorState => this.state;

  private emit() {
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------ transactions

  /**
   * Open an undo transaction.
   *
   * `mergeKey` collapses consecutive transactions into one history entry, pass
   * a stable key for the duration of a drag so the whole drag undoes at once,
   * and null for discrete actions that should each be undoable.
   */
  begin(mergeKey: string | null = null) {
    if (this.pending) return; // Already inside a transaction; nesting is a no-op.
    this.pending = {
      doc: this.state.doc,
      selection: this.state.ui.selection,
      mergeKey,
    };
  }

  /**
   * Close the transaction, recording history only if the document moved.
   *
   * The identity check is the whole point: a click that selects nothing, or a
   * drag returning to its origin, must not leave an undo step the user has to
   * press through.
   */
  commit() {
    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.doc === this.state.doc) return;

    const last = this.past[this.past.length - 1];
    const mergeable =
      last && pending.mergeKey !== null && last.mergeKey === pending.mergeKey;

    if (!mergeable) {
      this.past.push(pending);
      if (this.past.length > MAX_HISTORY) this.past.shift();
    }
    this.future.length = 0;
    this.emit();
  }

  /** Discard the transaction and restore the document as it was at `begin`. */
  abort() {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    this.state = {
      doc: pending.doc,
      ui: { ...this.state.ui, selection: pending.selection },
    };
    this.emit();
  }

  undo() {
    const entry = this.past.pop();
    if (!entry) return;
    this.future.push({
      doc: this.state.doc,
      selection: this.state.ui.selection,
      mergeKey: null,
    });
    // Restoring the selection alongside the document is what makes undo feel
    // like stepping backwards rather than teleporting.
    this.state = {
      doc: entry.doc,
      ui: { ...this.state.ui, selection: entry.selection },
    };
    this.emit();
  }

  redo() {
    const entry = this.future.pop();
    if (!entry) return;
    this.past.push({
      doc: this.state.doc,
      selection: this.state.ui.selection,
      mergeKey: null,
    });
    this.state = {
      doc: entry.doc,
      ui: { ...this.state.ui, selection: entry.selection },
    };
    this.emit();
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  // --------------------------------------------------------------- mutation

  /** Replace the document. Call inside a transaction for the change to be undoable. */
  setDoc(next: RiffDocument | ((prev: RiffDocument) => RiffDocument)) {
    const doc =
      typeof next === "function"
        ? (next as (p: RiffDocument) => RiffDocument)(this.state.doc)
        : next;
    if (doc === this.state.doc) return;
    this.state = { ...this.state, doc };
    this.emit();
  }

  /** UI changes are never undoable, nobody wants to undo a pan. */
  setUi(next: Partial<EditorUi> | ((prev: EditorUi) => Partial<EditorUi>)) {
    const patch =
      typeof next === "function"
        ? (next as (p: EditorUi) => Partial<EditorUi>)(this.state.ui)
        : next;
    this.state = { ...this.state, ui: { ...this.state.ui, ...patch } };
    this.emit();
  }

  // ---------------------------------------------------------- UI convenience

  setTool(tool: ToolId) {
    this.setUi({ tool });
  }

  setFrame(frame: Frame) {
    const max = Math.max(0, this.state.doc.frameCount - 1);
    this.setUi({ frame: Math.round(Math.min(Math.max(frame, 0), max)) });
  }

  /**
   * Advance by `delta` frames, wrapping inside the loop range when looping.
   *
   * The loop range, not the document, is what wraps: a two-second wave inside a
   * four-second document has to replay the wave.
   */
  stepFrame(delta: number) {
    const { frame } = this.state.ui;
    const { loopIn, loopOut } = this.loopRange();
    const span = Math.max(1, loopOut - loopIn);
    const next = frame + delta;
    if (this.state.ui.loop) {
      this.setUi({
        frame: loopIn + ((((next - loopIn) % span) + span) % span),
      });
    } else {
      this.setFrame(next);
    }
  }

  /** The loop range, clamped into the document. Never inverted, never empty. */
  loopRange(): { loopIn: Frame; loopOut: Frame } {
    const count = Math.max(1, this.state.doc.frameCount);
    const loopIn = Math.min(Math.max(0, this.state.doc.loopIn), count - 1);
    const loopOut = Math.min(
      Math.max(loopIn + 1, this.state.doc.loopOut),
      count,
    );
    return { loopIn, loopOut };
  }

  /**
   * Ask the canvas to fit into the visible desk.
   *
   * The canvas owns its own size, so the request travels as state rather than
   * as a call, and a counter rather than a boolean means two fits in a row both
   * land.
   */
  requestFit(target: "content" | "selection" = "content") {
    this.setUi((ui) => ({ fitNonce: ui.fitNonce + 1, fitTarget: target }));
  }

  /** Ask the canvas to cover the visible desk with the artboard. */
  requestFill() {
    this.setUi((ui) => ({ fillNonce: ui.fillNonce + 1 }));
  }

  select(layerIds: LayerId[]) {
    this.setUi({ selection: { layerIds } });
  }

  toggleSelect(layerId: LayerId) {
    const current = this.state.ui.selection.layerIds;
    const next = current.includes(layerId)
      ? current.filter((id) => id !== layerId)
      : [...current, layerId];
    this.select(next);
  }

  get activeArtboardId(): ArtboardId {
    return this.state.doc.activeArtboardId;
  }
}

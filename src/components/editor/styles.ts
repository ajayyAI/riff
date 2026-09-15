/**
 * Shared class strings for the editor chrome.
 *
 * Every value here resolves to a token from the design lock in AGENTS.md. If a
 * component needs a hex, a radius or a shadow that is not reachable from this
 * file, that is a design decision to raise, not a literal to inline.
 */

/**
 * The focus ring. An outline rather than a ring so it never participates in
 * layout and never gets clipped by a parent's `overflow-hidden`.
 */
export const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-riff-accent focus-visible:outline";

/** Hover, focus and press feedback. `press` is the utility from globals.css. */
export const PRESS = "press";

/**
 * 32px square icon button, 10px radius: the toolbar and transport button.
 *
 * The idle and active variants are mutually exclusive strings rather than one
 * base plus an override, because a hover utility and an active utility of equal
 * specificity in the same class list resolve by stylesheet order, not by the
 * order they are written. That is how a white glyph ends up on a 4% black
 * background and disappears.
 */
const TOOL_BUTTON_BASE = `inline-flex size-8 shrink-0 items-center justify-center rounded-riff-btn disabled:pointer-events-none disabled:opacity-35 ${PRESS} ${FOCUS_RING}`;

export const TOOL_BUTTON = `${TOOL_BUTTON_BASE} text-riff-muted hover:bg-riff-fill hover:text-riff-text`;

/** The same button holding the active tool: solid accent, white glyph. */
export const TOOL_BUTTON_ACTIVE = `${TOOL_BUTTON_BASE} bg-riff-accent text-white`;

/** Smaller square button for panel rows. */
export const ROW_BUTTON = `inline-flex size-6 shrink-0 items-center justify-center rounded-riff-md text-riff-faint hover:bg-riff-fill hover:text-riff-text disabled:pointer-events-none disabled:opacity-35 ${PRESS} ${FOCUS_RING}`;

/**
 * A floating panel: a card of frosted glass over the canvas.
 *
 * The canvas runs edge to edge underneath every panel, which is what makes the
 * artwork read as the whole surface rather than as a window between two
 * sidebars. `riff-glass` carries the translucency, the blur and the hairline.
 */
export const PANEL =
  "riff-glass flex flex-col overflow-hidden rounded-riff-panel text-riff-text";

/** The same surface for the small floating pills: toolbar, zoom, document menu. */
export const PILL = "riff-glass rounded-riff-pill";

/** Panel title: 13/18, 600. */
export const PANEL_TITLE =
  "text-[13px] leading-[18px] font-semibold tracking-[-0.01em] text-riff-text";

/** Section label: 11/16, 500, muted. The editor workhorse size. */
export const SECTION_LABEL =
  "text-[11px] leading-4 font-medium tracking-[-0.005em] text-riff-muted";

/** UI default: 11/16, 500, -0.01em. */
export const UI_TEXT =
  "text-[11px] leading-4 font-medium tracking-[-0.01em] text-riff-text";

/** Tertiary copy: hint paragraphs, ruler numbers, counts. */
export const HINT_TEXT = "text-[11px] leading-relaxed text-riff-faint";

/** Numeric field: 12/16, tabular. Mono is not optional here. */
export const NUMERIC_TEXT =
  "font-mono text-[12px] leading-4 font-medium tracking-[0.01em] tabular-nums";

/**
 * The numeric chip: 4% black at rest, 6% on hover, accent-soft on focus.
 * The single highest-leverage component in a dense editor: almost every value
 * a user touches is one of these.
 */
export const NUMERIC_CHIP =
  "flex h-7 items-center gap-1 rounded-riff-lg bg-riff-fill px-2 transition-colors duration-[140ms] ease-riff hover:bg-riff-fill-hover focus-within:bg-riff-accent-soft";

/** Row height shared by the parts panel and the timeline parts column. */
export const LAYER_ROW_HEIGHT = 32;

/**
 * How far one level of the rig indents a row, and how many levels it keeps
 * doing that for.
 *
 * Real rigs are three or four deep, but nothing stops someone attaching forty
 * parts in a chain, and a row whose name has been pushed off the right edge is
 * a row nobody can read or rename. Past the cap the tree still nests, it just
 * stops widening.
 */
export const INDENT_STEP = 12;
export const MAX_INDENT_LEVELS = 8;

export function indentFor(depth: number, base = 0): number {
  return base + Math.min(depth, MAX_INDENT_LEVELS) * INDENT_STEP;
}

/**
 * The layer every transient surface sits on.
 *
 * Panels are positioned and carry a z-index, so a portalled popover at body
 * level with `z-index: auto` paints *underneath* them no matter how late it
 * appears in the document. Every positioner therefore states its layer.
 */
export const POPUP_LAYER = "z-[60]";

/** Popovers and menus genuinely float, so they are the one place shadow is allowed. */
export const POPUP = `rounded-[12px] border border-black/[0.08] bg-riff-panel p-1 shadow-riff-pop origin-[var(--transform-origin)] transition-[transform,opacity] duration-[120ms] ease-riff data-[ending-style]:scale-[.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[.97] data-[starting-style]:opacity-0`;

// ---------------------------------------------------------------- geometry

/** Viewport inset, and the gap between every pair of panels. */
export const GAP = 12;

/** Toolbar pill: a 32px button row plus its 4px padding. */
export const TOOLBAR_HEIGHT = 40;

/** Left panel width, from the design lock. */
export const LAYERS_WIDTH = 240;

/** Right panel width, from the design lock. */
export const INSPECTOR_WIDTH = 260;

/** The zoom pill, so anything sharing its band can start after it. */
export const ZOOM_WIDTH = 168;

/**
 * The region of the desk no panel covers.
 *
 * The canvas is full-bleed on purpose, artwork running under a floating panel
 * is what makes the panels read as floating. But "fit to screen" has to fit
 * inside what the user can actually see, or it centres the artboard behind the
 * inspector.
 */
export function canvasSafeArea(
  view: { width: number; height: number },
  timelineHeight: number,
): { x: number; y: number; width: number; height: number } {
  const left = GAP + LAYERS_WIDTH + GAP;
  const right = GAP + INSPECTOR_WIDTH + GAP;
  const top = GAP + TOOLBAR_HEIGHT + GAP;
  const bottom = timelineHeight + GAP * 2;
  return {
    x: left,
    y: top,
    width: Math.max(1, view.width - left - right),
    height: Math.max(1, view.height - top - bottom),
  };
}

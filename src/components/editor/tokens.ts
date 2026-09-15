/**
 * The design-lock tokens, mirrored in TypeScript.
 *
 * `globals.css` is the source of truth for anything the DOM paints. A canvas
 * cannot resolve `var(--riff-accent)` on its own, so canvas code resolves the
 * variable off a live element and falls back to the literal here when the
 * element is not styled yet (first paint, SSR handoff, a test harness).
 *
 * Changing one is a design decision, not an implementation detail.
 */

export const TOKEN_FALLBACKS = {
  "--riff-accent": "#0A84FF",
  "--riff-accent-soft": "rgb(10 132 255 / 0.12)",
  "--riff-accent-soft-opaque": "#E2F0FF",

  "--riff-desk": "#E0E0E0",
  "--riff-panel": "#FFFFFF",
  "--riff-bg": "#F5F5F5",

  "--riff-text": "#1D1D1F",
  "--riff-muted": "#86868B",
  "--riff-faint": "#AEAEB2",

  "--riff-hairline": "rgb(0 0 0 / 0.07)",
  "--riff-hairline-strong": "rgb(0 0 0 / 0.12)",

  "--riff-keyframe": "#48484A",
  "--riff-danger": "#FF3B30",
  "--riff-good": "#248A3D",
  "--riff-guide": "#FF3B30",

  "--riff-fill-subtle": "rgb(0 0 0 / 0.035)",
  "--riff-fill": "rgb(0 0 0 / 0.04)",
  "--riff-fill-track": "rgb(0 0 0 / 0.045)",
  "--riff-fill-hover": "rgb(0 0 0 / 0.06)",
  "--riff-fill-strong": "rgb(0 0 0 / 0.12)",

  /**
   * The clip bar's hover fill, and the grip pips on its ends.
   *
   * The lock enumerates a fill at 0.12 for the clip bar but pairs every other
   * surface with a hover step (0.04 -> 0.06, 0.05 hover); 0.18 is the reference
   * measured partner for 0.12. The grips are
   * separate tokens rather than `black/30` inline because they invert on the
   * selected (accent) bar and again in dark mode, and three inline literals in
   * a hot render path is how a theme goes wrong.
   */
  "--riff-fill-strong-hover": "rgb(0 0 0 / 0.18)",
  "--riff-grip": "rgb(0 0 0 / 0.3)",
  "--riff-grip-on-accent": "rgb(255 255 255 / 0.8)",
} as const satisfies Record<string, string>;

export type TokenName = keyof typeof TOKEN_FALLBACKS;

/** The mono stack, resolved the same way. Not a colour, so not in the record. */
export const MONO_FALLBACK = "monospace";

export function readToken(style: CSSStyleDeclaration, name: TokenName): string {
  return style.getPropertyValue(name).trim() || TOKEN_FALLBACKS[name];
}

/** Resolve every token against a live element, once, for a canvas repaint. */
export function readTokens(el: Element): Record<TokenName, string> {
  const style = getComputedStyle(el);
  const out = {} as Record<TokenName, string>;
  for (const name of Object.keys(TOKEN_FALLBACKS) as TokenName[]) {
    out[name] = readToken(style, name);
  }
  return out;
}

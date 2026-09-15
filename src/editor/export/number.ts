/**
 * The one place a number becomes output.
 *
 * Two rules the whole export layer depends on: a non-finite value never reaches
 * a file (it would make the JSON unparseable and the SVG silently blank), and
 * `-0` is normalised, because `String(-0)` is `"-0"` and that is a byte per
 * occurrence in a file that is 95% coordinates (docs/compression.md).
 */
export function roundTo(value: number, precision: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/** Shortest round-trip string. Never `toFixed`, trailing zeros are pure bytes. */
export function numString(value: number, precision: number): string {
  return String(roundTo(value, precision));
}

/**
 * Snapping while dragging on the canvas.
 *
 * Pure functions over numbers, so the behaviour that is impossible to eyeball
 * (does the left edge win over the centre when both are inside the tolerance?)
 * is settled by a test rather than by staring at a screen.
 *
 * The rule: the three interesting coordinates of the moving selection (its two
 * edges and its centre) are each tested against every candidate, and the single
 * smallest correction wins. Applying more than one would fight itself.
 */

/** The three coordinates of a selection that are worth aligning, on one axis. */
export interface SnapSpan {
  min: number;
  centre: number;
  max: number;
}

export interface SnapAxisResult {
  /** Amount to add to the drag delta on this axis. Zero when nothing snapped. */
  delta: number;
  /** The document-space coordinate a guide should be drawn at, or null. */
  guide: number | null;
}

const NO_SNAP: SnapAxisResult = { delta: 0, guide: null };

export function snapAxis(
  span: SnapSpan,
  candidates: readonly number[],
  tolerance: number,
): SnapAxisResult {
  if (tolerance <= 0 || candidates.length === 0) return NO_SNAP;

  let best = NO_SNAP;
  let bestDistance = tolerance;
  for (const value of [span.min, span.centre, span.max]) {
    for (const candidate of candidates) {
      const distance = Math.abs(candidate - value);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { delta: candidate - value, guide: candidate };
      }
    }
  }
  return best;
}

export function spanOf(min: number, max: number): SnapSpan {
  return { min, centre: (min + max) / 2, max };
}

/**
 * Candidate coordinates to snap against, on both axes.
 *
 * Every other part's edges and centre, plus the artboard's edges and centre.
 * The artboard is included because centring a character on the page is the one
 * alignment every rig needs and the one nothing else can supply.
 */
export interface SnapCandidates {
  x: number[];
  y: number[];
}

export function collectCandidates(
  boxes: readonly [number, number, number, number][],
  artboard: { width: number; height: number } | null,
): SnapCandidates {
  const x: number[] = [];
  const y: number[] = [];
  for (const [x0, y0, x1, y1] of boxes) {
    x.push(x0, (x0 + x1) / 2, x1);
    y.push(y0, (y0 + y1) / 2, y1);
  }
  if (artboard) {
    x.push(0, artboard.width / 2, artboard.width);
    y.push(0, artboard.height / 2, artboard.height);
  }
  return { x, y };
}

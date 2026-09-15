/**
 * Numeric-field arithmetic: expression evaluation and scrub math.
 *
 * Kept free of React so it can be tested directly, which matters because both
 * halves fail quietly. A parser that mis-reads `50+10*2` gives a plausible
 * wrong number, and scrub math that accumulates instead of resolving from the
 * drag origin drifts a few tenths per gesture -- neither throws, and neither is
 * visible until a user notices their layout is subtly wrong.
 *
 * The evaluator is hand-written on purpose. `eval` and `new Function` would be
 * four lines, and both hand the contents of a text field to the JavaScript
 * engine. A tool that will one day open documents made by other people does not
 * get to do that.
 */

// ------------------------------------------------------------------- numbers

export function clamp(value: number, min?: number, max?: number): number {
  let out = value;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}

/** Decimal places in a number's shortest representation. `0.1` -> 1, `10` -> 0. */
export function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = String(Math.abs(value));
  const exponent = text.indexOf("e");
  if (exponent !== -1) {
    // 1e-7 and friends. The exponent is the only place the precision lives.
    const power = Number(text.slice(exponent + 1));
    const mantissa = text.slice(0, exponent).split(".")[1]?.length ?? 0;
    return Math.max(0, mantissa - power);
  }
  return text.split(".")[1]?.length ?? 0;
}

/**
 * Round to a fixed number of decimals.
 *
 * Shifts the decimal point in the *string* rather than by multiplying. Both of
 * the obvious forms are wrong at two places on 1.005: `toFixed(2)` gives 1.00
 * and `Math.round(v * 100) / 100` gives 1, because 1.005 is stored as
 * 1.00499999999999989. Re-parsing "1.005e2" reads the shortest decimal that
 * round-trips, which is the number the user actually typed, and rounds that.
 */
export function roundTo(value: number, places: number): number {
  if (!Number.isFinite(value)) return value;
  const p = Math.min(Math.max(Math.trunc(places), 0), 12);
  const text = String(value);
  // Already in exponential form; shifting the point textually would produce
  // "1e-7e2". These are far below any precision a field commits at anyway.
  if (text.includes("e") || text.includes("E")) {
    const fixed = Number(value.toFixed(p));
    return fixed === 0 ? 0 : fixed;
  }
  const out = Number(`${Math.round(Number(`${text}e${p}`))}e-${p}`);
  return out === 0 ? 0 : out; // Normalise -0, which formats as "-0".
}

// ------------------------------------------------------------- expressions

type Token =
  | { kind: "number"; value: number }
  | { kind: "symbol"; value: string };

const OPERATORS = new Set(["+", "-", "*", "/", "%", "^", "(", ")"]);

/**
 * Split an expression into numbers and operator symbols.
 *
 * Returns null on any character the grammar does not know, which is what keeps
 * identifiers -- and therefore anything resembling code -- out of the parser
 * entirely.
 */
export function tokenize(input: string): Token[] | null {
  // A comma is a decimal separator in most of the world, and pasting `1,5`
  // into a field that silently reads 1 is worse than rejecting it.
  const text = input.replace(/,/g, ".");
  const tokens: Token[] = [];
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (char === " " || char === "\t") {
      i += 1;
      continue;
    }

    if (OPERATORS.has(char)) {
      tokens.push({ kind: "symbol", value: char });
      i += 1;
      continue;
    }

    if ((char >= "0" && char <= "9") || char === ".") {
      let j = i;
      let seenDot = false;
      while (j < text.length) {
        const c = text[j];
        if (c >= "0" && c <= "9") {
          j += 1;
        } else if (c === "." && !seenDot) {
          seenDot = true;
          j += 1;
        } else {
          break;
        }
      }
      const value = Number(text.slice(i, j));
      if (!Number.isFinite(value)) return null; // A lone ".".
      tokens.push({ kind: "number", value });
      i = j;
      continue;
    }

    return null;
  }

  return tokens;
}

/**
 * Evaluate `120/2`, `50 + 10`, `(3+1)*2^2`, `-4`.
 *
 * Returns null for anything malformed, unparseable, or non-finite, so callers
 * can revert to the previous value rather than committing a NaN.
 *
 * Grammar (`^` binds tightest and associates right, matching every calculator
 * a user has already learned):
 *
 *   expr   := term (("+" | "-") term)*
 *   term   := unary (("*" | "/" | "%") unary)*
 *   unary  := ("+" | "-") unary | power
 *   power  := primary ("^" unary)?
 *   primary:= number | "(" expr ")"
 */
export function evaluateExpression(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const tokens = tokenize(trimmed);
  if (!tokens || tokens.length === 0) return null;

  let at = 0;
  let failed = false;

  const peek = (): Token | undefined => tokens[at];
  const eatSymbol = (value: string): boolean => {
    const token = peek();
    if (token && token.kind === "symbol" && token.value === value) {
      at += 1;
      return true;
    }
    return false;
  };

  function parsePrimary(): number {
    const token = peek();
    if (!token) {
      failed = true;
      return 0;
    }
    if (token.kind === "number") {
      at += 1;
      return token.value;
    }
    if (token.value === "(") {
      at += 1;
      const value = parseExpr();
      if (!eatSymbol(")")) failed = true;
      return value;
    }
    failed = true;
    return 0;
  }

  function parsePower(): number {
    const base = parsePrimary();
    if (eatSymbol("^")) return base ** parseUnary();
    return base;
  }

  function parseUnary(): number {
    if (eatSymbol("-")) return -parseUnary();
    if (eatSymbol("+")) return parseUnary();
    return parsePower();
  }

  function parseTerm(): number {
    let left = parseUnary();
    for (;;) {
      if (failed) return left;
      const token = peek();
      if (!token || token.kind !== "symbol") return left;
      if (token.value === "*") {
        at += 1;
        left *= parseUnary();
      } else if (token.value === "/") {
        at += 1;
        const right = parseUnary();
        if (right === 0) {
          failed = true;
          return left;
        }
        left /= right;
      } else if (token.value === "%") {
        at += 1;
        const right = parseUnary();
        if (right === 0) {
          failed = true;
          return left;
        }
        left %= right;
      } else {
        return left;
      }
    }
  }

  function parseExpr(): number {
    let left = parseTerm();
    for (;;) {
      if (failed) return left;
      if (eatSymbol("+")) left += parseTerm();
      else if (eatSymbol("-")) left -= parseTerm();
      else return left;
    }
  }

  const result = parseExpr();
  if (failed || at !== tokens.length || !Number.isFinite(result)) return null;
  return result;
}

// -------------------------------------------------------------- scrub math

/**
 * Pointer travel, in CSS pixels, that advances the value by one step.
 *
 * Two is the number that lets a 1px-step field cross a 1080px artboard in a
 * comfortable drag while still letting you land on an exact value.
 */
export const SCRUB_PX_PER_STEP = 2;

/** Shift: one tenth of a step per increment. */
export const FINE_MULTIPLIER = 0.1;
/** Command or Alt: ten steps per increment. */
export const COARSE_MULTIPLIER = 10;

export interface ScrubModifiers {
  /** Shift. */
  fine?: boolean;
  /** Command (or Alt, for keyboards without one). */
  coarse?: boolean;
}

/**
 * Fine wins when both are held: reaching for Shift is the deliberate gesture,
 * and Alt in particular is easy to be holding for an unrelated reason.
 */
export function scrubMultiplier(modifiers: ScrubModifiers): number {
  if (modifiers.fine) return FINE_MULTIPLIER;
  if (modifiers.coarse) return COARSE_MULTIPLIER;
  return 1;
}

export interface ScrubOptions {
  step: number;
  /** Decimal places to commit at. Raised automatically for fine scrubs. */
  precision: number;
  min?: number;
  max?: number;
}

/**
 * How many decimals a scrub should commit at.
 *
 * A field declared `precision: 0` still has to produce tenths under Shift, or
 * fine scrubbing silently does nothing at all -- every increment rounds back to
 * where it started.
 */
export function scrubPrecision(
  options: ScrubOptions,
  modifiers: ScrubModifiers,
): number {
  // Derived by adding place counts rather than measuring `step * multiplier`.
  // The product is a float: 0.1 * 0.1 is 0.010000000000000002, which measures
  // as eighteen decimal places and would drag every fine scrub to the cap.
  const extra =
    scrubMultiplier(modifiers) < 1 ? decimalPlaces(FINE_MULTIPLIER) : 0;
  const needed = decimalPlaces(options.step) + extra;
  return Math.min(6, Math.max(options.precision, needed));
}

/**
 * The value a drag of `dx` pixels from `start` should produce.
 *
 * Resolved from the drag origin every time rather than accumulated from the
 * previous frame. Accumulation compounds rounding once per pointermove, which
 * is why scrubbers in other tools drift, and it also makes a drag that returns
 * to its starting x fail to return to its starting value.
 */
export function scrubValue(
  start: number,
  dx: number,
  options: ScrubOptions,
  modifiers: ScrubModifiers = {},
): number {
  const increment = options.step * scrubMultiplier(modifiers);
  const steps = Math.round(dx / SCRUB_PX_PER_STEP);
  const places = scrubPrecision(options, modifiers);
  return clamp(
    roundTo(start + steps * increment, places),
    options.min,
    options.max,
  );
}

/** Round and clamp a typed or pasted value the same way a scrub would. */
export function normalizeValue(value: number, options: ScrubOptions): number {
  return clamp(roundTo(value, options.precision), options.min, options.max);
}

/** Display form. Fixed decimals so the field cannot reflow mid-scrub. */
export function formatValue(
  value: number,
  precision: number,
  suffix?: string,
): string {
  const text = Number.isFinite(value) ? value.toFixed(precision) : "0";
  return suffix ? `${text}${suffix}` : text;
}

/** Editing form: no suffix, and no trailing zeros to delete before retyping. */
export function editableValue(value: number, precision: number): string {
  return String(roundTo(value, precision));
}

/**
 * Backwards-compatible re-export.
 *
 * H2: two expression parsers existed (`scrub.ts` + this file) with two
 * behaviours. The implementation lives in `../scrub` now, it is the tested
 * superset (adds `%`, `^`, comma decimals). This module keeps the old name so
 * existing imports and tests keep working against the single implementation.
 */
export { evaluateExpression as parseNumericExpression } from "../scrub";

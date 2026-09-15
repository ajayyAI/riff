import { describe, expect, test } from "bun:test";
import { TOKEN_FALLBACKS, type TokenName } from "./tokens";

const REQUIRED: TokenName[] = [
  "--riff-accent",
  "--riff-accent-soft",
  "--riff-accent-soft-opaque",
  "--riff-desk",
  "--riff-panel",
  "--riff-bg",
  "--riff-text",
  "--riff-muted",
  "--riff-faint",
  "--riff-hairline",
  "--riff-hairline-strong",
  "--riff-keyframe",
  "--riff-danger",
  "--riff-good",
  "--riff-guide",
  "--riff-fill-subtle",
  "--riff-fill",
  "--riff-fill-track",
  "--riff-fill-hover",
  "--riff-fill-strong",
];

describe("design tokens", () => {
  test("every token in the design lock has a fallback", () => {
    for (const name of REQUIRED) {
      expect(TOKEN_FALLBACKS[name]).toBeString();
    }
  });

  test("every fallback is a hex or an rgb() literal a canvas can parse", () => {
    for (const [name, value] of Object.entries(TOKEN_FALLBACKS)) {
      const ok =
        /^#[0-9A-F]{6}$/.test(value) ||
        /^rgb\(\d+ \d+ \d+( \/ [\d.]+)?\)$/.test(value);
      expect(ok, `${name} = ${value}`).toBe(true);
    }
  });

  test("the accent is Apple system blue and nothing else", () => {
    expect(TOKEN_FALLBACKS["--riff-accent"]).toBe("#0A84FF");
  });

  test("no token name survives from the old iris/ink/line set", () => {
    for (const name of Object.keys(TOKEN_FALLBACKS)) {
      expect(name).not.toMatch(/iris|ink|--riff-line|time|sunken/);
    }
  });
});

describe("clip bar tokens", () => {
  test("the clip bar has a rest fill, a hover fill and two grip colours", () => {
    // The reference's measured values: 12% at rest, 18% on hover, a 30% grip
    // on the grey bar and an 80% white grip on the selected blue one.
    // The row fill a selected part gets.
    expect(TOKEN_FALLBACKS["--riff-fill-strong"]).toBe("rgb(0 0 0 / 0.12)");
    expect(TOKEN_FALLBACKS["--riff-fill-strong-hover"]).toBe(
      "rgb(0 0 0 / 0.18)",
    );
    expect(TOKEN_FALLBACKS["--riff-grip"]).toBe("rgb(0 0 0 / 0.3)");
    expect(TOKEN_FALLBACKS["--riff-grip-on-accent"]).toBe(
      "rgb(255 255 255 / 0.8)",
    );
  });
});

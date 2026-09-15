import { describe, expect, test } from "bun:test";
import { filenameFor } from "./download";

describe("filenameFor", () => {
  test("uses the document name and the given extension", () => {
    expect(filenameFor("Gorilla", "svg")).toBe("Gorilla.svg");
  });

  test("falls back to riff when the name is empty or only separators", () => {
    expect(filenameFor("", "svg")).toBe("riff.svg");
    expect(filenameFor("   ", "svg")).toBe("riff.svg");
    expect(filenameFor("///", "svg")).toBe("riff.svg");
  });

  test("strips characters a file system will not take", () => {
    expect(filenameFor('a/b:c*d?e"f<g>h|i', "svg")).toBe(
      "a b c d e f g h i.svg",
    );
  });

  test("collapses runs of whitespace", () => {
    expect(filenameFor("two   words", "svg")).toBe("two words.svg");
  });

  test("never ends the stem in a dot or a space", () => {
    expect(filenameFor("trailing. ", "svg")).toBe("trailing.svg");
  });

  test("caps a very long name", () => {
    const name = filenameFor("x".repeat(500), "svg");
    expect(name.length).toBeLessThanOrEqual(84);
    expect(name.endsWith(".svg")).toBe(true);
  });
});

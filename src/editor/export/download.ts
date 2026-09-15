/**
 * Turning an export into a file the user actually has.
 *
 * Kept separate from the writers so the writers stay pure and testable: they
 * return strings, this decides what a browser does with one. `filenameFor` is
 * pure and tested; `downloadText` touches the DOM and is not.
 */

/** Characters a file name cannot carry on the platforms we target. */
const UNSAFE = /[\\/:*?"<>|]/g;

/**
 * A safe, meaningful file name for an export.
 *
 * The document name is the user's, so it can be empty, absurdly long, or full
 * of path separators. Falling back to "riff" is better than writing a file
 * called ".svg" that some systems then treat as hidden.
 */
export function filenameFor(documentName: string, extension: string): string {
  const cleaned = documentName
    .replace(UNSAFE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, "");
  const stem = cleaned.length > 0 ? cleaned : "riff";
  return `${stem}.${extension}`;
}

/** Hand a text artifact to the browser as a download. */
export function downloadText(
  text: string,
  filename: string,
  mimeType: string,
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can race the download in some browsers; one frame is
  // enough and keeps us from leaking the blob for the life of the page.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

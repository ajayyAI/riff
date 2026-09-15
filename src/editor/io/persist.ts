/**
 * Autosave to localStorage.
 *
 * A rig editor with no account and no server still owes the user their work
 * back after a reload, and a browser tab is closed by accident far more often
 * than a file is saved on purpose. Writes are debounced because serialising a
 * whole document on every pointer move would stall the drag.
 *
 * Every read is wrapped: storage can be full, disabled, or holding a file from
 * an older build, and none of those is a reason to refuse to open the editor.
 */

import type { RiffDocument } from "../model/document";
import { deserializeProject, serializeProject } from "./project";

const KEY = "riff.rig.autosave";

export interface SavedState {
  doc: RiffDocument;
  savedAt: number;
}

export function loadAutosave(): SavedState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: number };
    return {
      doc: deserializeProject(parsed),
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveAutosave(doc: RiffDocument): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...serializeProject(doc), savedAt: Date.now() }),
    );
    return true;
  } catch {
    // Quota, private mode, or a disabled store. The editor still works.
    return false;
  }
}

export function clearAutosave(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do, and nothing worth telling the user about.
  }
}

/**
 * Debounced writer.
 *
 * Returns a cancel function so a component can stop a pending write on unmount
 * and never save a document that has already been replaced.
 */
export function createAutosaver(delay = 1200) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: RiffDocument | null = null;
  let lastSaved = 0;

  const flush = () => {
    timer = null;
    const doc = pending;
    pending = null;
    if (doc && saveAutosave(doc)) lastSaved = Date.now();
  };

  return {
    schedule(doc: RiffDocument) {
      pending = doc;
      if (timer) return;
      timer = setTimeout(flush, delay);
    },
    flush() {
      if (timer) clearTimeout(timer);
      flush();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
    get lastSaved() {
      return lastSaved;
    },
  };
}

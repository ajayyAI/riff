"use client";

/**
 * The editor, assembled.
 *
 * The store is created once per mount and handed to everything below through
 * context. It is deliberately not a module singleton: two editors on a page, or
 * a remount in development, must not share history.
 *
 * First open loads whatever was autosaved, and failing that the sample
 * character. An editor that opens on an empty page asks the user to imagine
 * what it does; one that opens on a rig that already waves does not.
 */

import { useEffect, useRef, useState } from "react";
import { downloadText, filenameFor } from "@/editor/export/download";
import {
  importLegacyStudio,
  isLegacyStudioFile,
} from "@/editor/io/legacy-studio";
import {
  clearAutosave,
  createAutosaver,
  loadAutosave,
} from "@/editor/io/persist";
import { exportPlayerHtml } from "@/editor/io/player";
import { deserializeProject, projectToJson } from "@/editor/io/project";
import { emptyDocument } from "@/editor/model/document";
import { sampleDocument } from "@/editor/model/sample";
import { EditorStore } from "@/editor/store";
import { EditorProvider } from "@/editor/ui/context";
import { AgentBridge } from "./AgentBridge";
import { showHints } from "./ArtboardEmptyState";
import { Canvas } from "./Canvas";
import { EditorShell } from "./EditorShell";
import { useEditorShortcuts } from "./shortcuts";
import { Timeline } from "./Timeline";

export function Editor() {
  const [store] = useState(() => new EditorStore());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  const [hintNonce, setHintNonce] = useState(0);

  // One-shot restore. Runs before the autosaver subscribes, so restoring does
  // not immediately write back what it just read.
  useEffect(() => {
    const restored = loadAutosave();
    if (restored && Object.keys(restored.doc.layers).length > 0) {
      store.setDoc(restored.doc);
      setSavedLabel("Restored");
    } else {
      store.setDoc(sampleDocument());
    }
    store.requestFit();
  }, [store]);

  useEffect(() => {
    const autosaver = createAutosaver();
    let previous = store.getState().doc;
    const unsubscribe = store.subscribe(() => {
      const next = store.getState().doc;
      if (next === previous) return;
      previous = next;
      autosaver.schedule(next);
      setSavedLabel("Saving");
    });
    const settle = setInterval(() => {
      if (autosaver.lastSaved > 0) setSavedLabel("Saved");
    }, 1500);
    return () => {
      autosaver.flush();
      unsubscribe();
      clearInterval(settle);
    };
  }, [store]);

  const flash = (message: string) => {
    setStatus(message);
    window.setTimeout(() => setStatus(null), 3200);
  };

  const handleExport = () => {
    const { doc } = store.getState();
    downloadText(
      projectToJson(doc),
      filenameFor(doc.name, "json"),
      "application/json",
    );
    downloadText(
      exportPlayerHtml(doc),
      filenameFor(`${doc.name} player`, "html"),
      "text/html",
    );
    flash("Saved two files: the character, and a page that plays it.");
  };

  const handleOpen = () => fileInputRef.current?.click();

  const handleFiles = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      flash(
        "That file is not a character. Pick a .json file this editor made.",
      );
      return;
    }
    store.begin(null);
    if (isLegacyStudioFile(parsed)) {
      const result = importLegacyStudio(parsed);
      store.setDoc(result.doc);
      store.commit();
      store.requestFit();
      flash(
        result.warnings.length > 0
          ? `Opened ${file.name}. ${result.warnings[0]}`
          : `Opened ${file.name}.`,
      );
      return;
    }
    try {
      store.setDoc(deserializeProject(parsed));
      store.commit();
      store.requestFit();
      flash(`Opened ${file.name}.`);
    } catch (error) {
      store.abort();
      flash(
        error instanceof Error ? error.message : "That file could not be read.",
      );
    }
  };

  const handleNew = () => {
    store.begin(null);
    store.setDoc(emptyDocument());
    store.commit();
    store.select([]);
    store.requestFit();
    clearAutosave();
    flash("Started over. Pick the Brush and draw the first part.");
  };

  const handleLoadSample = () => {
    store.begin(null);
    store.setDoc(sampleDocument());
    store.commit();
    store.select([]);
    store.requestFit();
    flash("Sample character loaded. Press Play, or pick a part to pose it.");
  };

  return (
    <EditorProvider store={store}>
      <AgentBridge store={store} />
      <Shortcuts
        store={store}
        onExport={handleExport}
        onOpen={handleOpen}
        onSave={() => {
          setSavedLabel("Saved");
          flash("Kept in this browser. Use Export to get a file.");
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        tabIndex={-1}
        aria-label="Open a saved character"
        className="sr-only"
        onChange={(event) => {
          void handleFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <EditorShell
        canvas={<Canvas />}
        timeline={<Timeline />}
        hintNonce={hintNonce}
        savedLabel={savedLabel}
        onNew={handleNew}
        onLoadSample={handleLoadSample}
        onOpen={handleOpen}
        onExport={handleExport}
        onShowSteps={() => {
          showHints();
          setHintNonce((n) => n + 1);
        }}
        onFitToScreen={() => store.requestFit()}
        onFillScreen={() => store.requestFill()}
      />
      {status ? (
        <output
          className="-translate-x-1/2 fixed bottom-3 left-1/2 z-50 rounded-riff-pill bg-riff-text px-3.5 py-2 text-[12px] text-white shadow-riff-pop"
          aria-live="polite"
        >
          {status}
        </output>
      ) : null}
    </EditorProvider>
  );
}

/**
 * The shortcut listener, as a child.
 *
 * A hook cannot be called conditionally and the actions it needs are defined in
 * the parent, so it lives one component down rather than forcing the parent to
 * hold a ref to itself.
 */
function Shortcuts({
  store,
  onExport,
  onOpen,
  onSave,
}: {
  store: EditorStore;
  onExport: () => void;
  onOpen: () => void;
  onSave: () => void;
}) {
  useEditorShortcuts(store, { onExport, onOpen, onSave });
  return null;
}

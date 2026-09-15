"use client";

/**
 * Every keyboard shortcut that belongs to the document rather than to one panel.
 *
 * One listener, one place, so two panels can never both claim a key and quietly
 * do two things. Panel-local keys (scrubbing inside the timeline, renaming
 * inside the parts list) stay where they are and are skipped here by checking
 * what the event came from.
 */

import { useEffect } from "react";
import { constant } from "@/editor/model/document";
import {
  deleteParts,
  duplicateParts,
  groupParts,
  mirrorAxisFor,
  moveInDrawOrder,
  patchLayer,
  ungroupParts,
  variantAt,
} from "@/editor/model/rig";
import type { EditorStore } from "@/editor/store";
import { isTypingTarget } from "./Toolbar";
import { keyPartsAt, upsertKeyframe } from "./timeline/edits";
import { ANIMATABLE_PROPERTIES } from "./timeline/rows";

export interface ShortcutActions {
  onSave: () => void;
  onExport: () => void;
  onOpen: () => void;
}

/** True when the key belongs to the timeline, which owns its own arrows. */
function insideTimeline(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('[aria-label="Timeline"]') !== null
  );
}

export function useEditorShortcuts(
  store: EditorStore,
  actions: ShortcutActions,
) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      const { ui } = store.getState();
      const ids = ui.selection.layerIds;
      const frame = ui.frame;

      const edit = (
        patch: (
          doc: ReturnType<typeof store.getState>["doc"],
        ) => ReturnType<typeof store.getState>["doc"],
      ) => {
        store.begin(null);
        store.setDoc(patch);
        store.commit();
      };

      if (meta) {
        const key = event.key.toLowerCase();
        if (key === "s") {
          event.preventDefault();
          actions.onSave();
          return;
        }
        if (key === "e") {
          event.preventDefault();
          actions.onExport();
          return;
        }
        if (key === "o") {
          event.preventDefault();
          actions.onOpen();
          return;
        }
        if (key === "a") {
          event.preventDefault();
          const doc = store.getState().doc;
          const artboard = doc.artboards[doc.activeArtboardId];
          store.select(artboard ? [...artboard.layerIds] : []);
          return;
        }
        if (key === "d" && ids.length > 0) {
          event.preventDefault();
          store.begin(null);
          const result = duplicateParts(store.getState().doc, ids, { frame });
          store.setDoc(result.doc);
          store.commit();
          store.select(result.created);
          return;
        }
        if (key === "m" && event.shiftKey && ids.length > 0) {
          event.preventDefault();
          store.begin(null);
          const doc = store.getState().doc;
          const result = duplicateParts(doc, ids, {
            frame,
            mirrorAxis: mirrorAxisFor(doc, ids[0]),
          });
          store.setDoc(result.doc);
          store.commit();
          store.select(result.created);
          return;
        }
        if (key === "g" && ids.length > 0) {
          event.preventDefault();
          if (event.shiftKey) {
            edit((doc) => ungroupParts(doc, ids, frame));
          } else {
            store.begin(null);
            const result = groupParts(store.getState().doc, ids, frame);
            store.setDoc(result.doc);
            store.commit();
            if (result.groupId) store.select([result.groupId]);
          }
          return;
        }
        if ((event.key === "]" || event.key === "[") && ids.length > 0) {
          event.preventDefault();
          const forward = event.key === "]";
          const move = event.altKey
            ? forward
              ? "front"
              : "back"
            : forward
              ? "forward"
              : "backward";
          edit((doc) => moveInDrawOrder(doc, ids, move));
          return;
        }
        return;
      }

      if (event.altKey) return;

      // Key the pose. Global, because the instruction on screen says "press K"
      // and it has to be true wherever the user is looking.
      if (event.key === "k" || event.key === "K") {
        const doc = store.getState().doc;
        const targets = event.shiftKey
          ? (doc.artboards[doc.activeArtboardId]?.layerIds ?? [])
          : ids;
        if (targets.length === 0) return;
        event.preventDefault();
        edit((current) =>
          keyPartsAt(current, targets, frame, ANIMATABLE_PROPERTIES),
        );
        return;
      }

      // Ghost poses. Global for the same reason K is: it is a thing you turn on
      // while looking at the canvas, not at the timeline. O is the ellipse
      // tool, so this is G.
      if (event.key === "g" || event.key === "G") {
        event.preventDefault();
        store.setUi((current) => ({ onionSkin: !current.onionSkin }));
        return;
      }

      if (event.key === "Escape") {
        store.select([]);
        return;
      }

      if (event.shiftKey && (event.key === "!" || event.key === "1")) {
        event.preventDefault();
        store.requestFit("content");
        return;
      }
      if (event.shiftKey && (event.key === "@" || event.key === "2")) {
        event.preventDefault();
        store.requestFit(ids.length > 0 ? "selection" : "content");
        return;
      }

      // Step the shown drawing. The fastest way to check a blink or a hand
      // swap, and the reason it is a bare key rather than a menu.
      if ((event.key === "," || event.key === ".") && ids.length > 0) {
        event.preventDefault();
        const step = event.key === "." ? 1 : -1;
        edit((doc) => {
          let out = doc;
          for (const id of ids) {
            const layer = out.layers[id];
            if (!layer || layer.variants.length < 2) continue;
            const current = variantAt(layer, out, frame);
            const index = layer.variants.findIndex((v) => v.id === current?.id);
            const next =
              (index + step + layer.variants.length) % layer.variants.length;
            if (layer.variant.kind === "track") {
              out = upsertKeyframe(out, layer.variant.trackId, frame, next);
            } else {
              out = patchLayer(out, id, { variant: constant(next) });
            }
          }
          return out;
        });
        return;
      }

      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        ids.length > 0 &&
        !insideTimeline(event.target)
      ) {
        event.preventDefault();
        edit((doc) => deleteParts(doc, ids, frame));
        store.select([]);
        return;
      }

      if (
        ids.length > 0 &&
        !insideTimeline(event.target) &&
        (event.key === "ArrowLeft" ||
          event.key === "ArrowRight" ||
          event.key === "ArrowUp" ||
          event.key === "ArrowDown")
      ) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx =
          event.key === "ArrowLeft"
            ? -step
            : event.key === "ArrowRight"
              ? step
              : 0;
        const dy =
          event.key === "ArrowUp"
            ? -step
            : event.key === "ArrowDown"
              ? step
              : 0;
        // One merge key per direction, so holding an arrow is one undo step.
        store.begin(`nudge:${dx}:${dy}`);
        store.setDoc((doc) => {
          let out = doc;
          for (const id of ids) {
            const layer = out.layers[id];
            if (!layer || layer.locked) continue;
            for (const [axis, delta] of [
              ["x", dx],
              ["y", dy],
            ] as const) {
              if (delta === 0) continue;
              const prop = layer.transform[axis];
              if (prop.kind === "track") {
                const track = out.tracks[prop.trackId];
                if (!track) continue;
                const value =
                  track.keyframes.find((k) => k.frame === frame)?.value ?? 0;
                out = upsertKeyframe(out, prop.trackId, frame, value + delta);
              } else {
                const updated = out.layers[id];
                if (!updated) continue;
                out = patchLayer(out, id, {
                  transform: {
                    ...updated.transform,
                    [axis]: constant(prop.value + delta),
                  },
                });
              }
            }
          }
          return out;
        });
        store.commit();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, actions]);
}

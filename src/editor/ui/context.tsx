"use client";

/**
 * React's window onto the editor store.
 *
 * The store lives outside React (see `src/editor/store.ts`) because playback
 * mutates the current frame sixty times a second. Components opt back in
 * through `useSyncExternalStore`, which is the only subscription primitive that
 * is safe against tearing when a concurrent render reads a store that a rAF
 * loop is writing.
 *
 * `getServerSnapshot` is passed deliberately: the shell renders inside an app
 * router tree, and omitting it throws during SSR rather than at runtime in the
 * browser, which is a uniquely confusing failure to debug.
 */

import {
  createContext,
  type ReactNode,
  use,
  useSyncExternalStore,
} from "react";
import type { EditorState, EditorStore } from "../store";

const StoreContext = createContext<EditorStore | null>(null);

export function EditorProvider({
  store,
  children,
}: {
  store: EditorStore;
  children: ReactNode;
}) {
  return <StoreContext value={store}>{children}</StoreContext>;
}

/** The store instance itself, for writes and for imperative subscriptions. */
export function useEditorStore(): EditorStore {
  const store = use(StoreContext);
  if (!store) {
    throw new Error(
      "useEditorStore must be called inside an <EditorProvider>.",
    );
  }
  return store;
}

/**
 * Read a slice of editor state.
 *
 * The selector runs *after* `useSyncExternalStore` rather than inside it. That
 * is not an oversight: `getSnapshot` must return a referentially stable value
 * or React loops forever, and selectors that build objects or arrays -- which
 * every interesting selector here does -- cannot promise that. Subscribing to
 * the whole state and narrowing afterwards costs a render the compiler will
 * mostly elide, and it removes an entire class of infinite-loop bug.
 */
export function useEditor<T>(selector: (state: EditorState) => T): T {
  const store = useEditorStore();
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  return selector(state);
}

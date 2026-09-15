"use client";

/**
 * The editor's handle for anything that is not a person.
 *
 * Two surfaces, one list of tools. `navigator.modelContext` is the WebMCP API a
 * browser agent discovers on its own; `window.riffTools` is the same map by
 * hand, which is what a console, a test harness or a browser automation script
 * can reach without any of that. Both call the same functions the panels do, so
 * an agent cannot do anything a person could not undo.
 *
 * Nothing here renders. Registration belongs to the lifetime of the store, not
 * to a place on screen.
 */

import { useEffect } from "react";
import {
  type AgentTool,
  createAgentTools,
  toolMap,
} from "@/editor/agent-tools";
import type { EditorStore } from "@/editor/store";

interface ModelContextTool {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (input: Record<string, unknown>) => unknown;
}

interface ModelContext {
  registerTool?: (tool: ModelContextTool) => unknown;
}

type RiffToolMap = Record<
  string,
  (input?: Record<string, unknown>) => unknown
> & {
  list?: () => { name: string; description: string; inputSchema: unknown }[];
};

declare global {
  interface Navigator {
    modelContext?: ModelContext;
  }
  interface Window {
    riffTools?: RiffToolMap;
  }
}

/** Whatever `registerTool` handed back, turned into one way to undo it. */
function releaser(handle: unknown): (() => void) | null {
  if (typeof handle === "function") return handle as () => void;
  if (handle && typeof handle === "object" && "unregister" in handle) {
    const unregister = (handle as { unregister: unknown }).unregister;
    if (typeof unregister === "function") {
      return () => {
        (unregister as () => void).call(handle);
      };
    }
  }
  return null;
}

export function AgentBridge({ store }: { store: EditorStore }) {
  useEffect(() => {
    const tools: AgentTool[] = createAgentTools(store);

    const map = toolMap(tools) as RiffToolMap;
    map.list = () =>
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    window.riffTools = map;

    const releases: (() => void)[] = [];
    const register = navigator.modelContext?.registerTool;
    if (register) {
      for (const tool of tools) {
        const release = releaser(
          register.call(navigator.modelContext, {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            execute: tool.execute,
          }),
        );
        if (release) releases.push(release);
      }
    }

    return () => {
      for (const release of releases) release();
      if (window.riffTools === map) window.riffTools = undefined;
    };
  }, [store]);

  return null;
}

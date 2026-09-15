"use client";

/**
 * The floating toolbar pill.
 *
 * Seven tools, history, and the two file actions. Every one of them serves the
 * rig; a tool that does not is a tool someone has to try before they learn it
 * does nothing here. Each button carries its name and its key in a tooltip that
 * appears instantly, because an icon nobody can name is a control nobody uses.
 */

import {
  Brush,
  Circle,
  Crosshair,
  Download,
  FolderOpen,
  Hand,
  MousePointer2,
  Redo2,
  Spline,
  Square,
  Undo2,
} from "lucide-react";
import { type ComponentType, useEffect } from "react";
import type { ToolId } from "@/editor/store";
import { useEditor, useEditorStore } from "@/editor/ui/context";
import { TOOL_BUTTON, TOOL_BUTTON_ACTIVE } from "./styles";
import { Tip } from "./Tooltip";

interface ToolSpec {
  id: ToolId;
  label: string;
  /** One line under the name in the tooltip. The only instruction anyone needs. */
  hint: string;
  /** The single key that selects it. Compared lower case. */
  shortcut: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
}

/** Point, draw, rig, look around. That is the order people work in. */
export const TOOLS: ToolSpec[] = [
  {
    id: "select",
    label: "Select",
    hint: "Click a part, drag to move it, drag the corners to resize.",
    shortcut: "V",
    icon: MousePointer2,
  },
  {
    id: "brush",
    label: "Brush",
    hint: "Draw a part. Finish near where you started and it fills.",
    shortcut: "B",
    icon: Brush,
  },
  {
    id: "pen",
    label: "Pen",
    hint: "Click to place corners, click the first point to close.",
    shortcut: "P",
    icon: Spline,
  },
  {
    id: "joint",
    label: "Joint",
    hint: "Click on a part to set the point it turns around.",
    shortcut: "J",
    icon: Crosshair,
  },
  {
    id: "rect",
    label: "Rectangle",
    hint: "Drag out a box. Hold Shift for a square.",
    shortcut: "R",
    icon: Square,
  },
  {
    id: "ellipse",
    label: "Ellipse",
    hint: "Drag out an oval. Hold Shift for a circle.",
    shortcut: "O",
    icon: Circle,
  },
  {
    id: "hand",
    label: "Move around",
    hint: "Drag to pan. Scrolling does the same at any time.",
    shortcut: "H",
    icon: Hand,
  },
];

const SHORTCUTS = new Map<string, ToolId>(
  TOOLS.map((tool) => [tool.shortcut.toLowerCase(), tool.id]),
);

/**
 * True when a keystroke belongs to whatever the user is typing into.
 *
 * Without this, renaming a part to "Brow" switches tools twice and leaves the
 * rectangle armed.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "OPTION" ||
    target.closest("[contenteditable='true']") !== null
  );
}

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px bg-riff-hairline" />;
}

export interface ToolbarProps {
  onImport?: () => void;
  onExport?: () => void;
  className?: string;
}

export function Toolbar({ onImport, onExport, className = "" }: ToolbarProps) {
  const store = useEditorStore();
  const tool = useEditor((state) => state.ui.tool);
  // Read through the store on every emit so the buttons disable the moment the
  // last history entry is consumed. `canUndo` is a getter, not state.
  useEditor((state) => state.doc);
  const canUndo = store.canUndo;
  const canRedo = store.canRedo;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;

      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase();
        if (key === "z") {
          event.preventDefault();
          if (event.shiftKey) store.redo();
          else store.undo();
        } else if (key === "y") {
          event.preventDefault();
          store.redo();
        }
        return;
      }

      if (event.altKey || event.shiftKey) return;
      const next = SHORTCUTS.get(event.key.toLowerCase());
      if (next) {
        event.preventDefault();
        store.setTool(next);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);

  return (
    <div
      role="toolbar"
      aria-label="Tools"
      aria-orientation="horizontal"
      className={`riff-glass flex items-center gap-0.5 rounded-riff-pill p-1 ${className}`}
    >
      {TOOLS.map((spec) => {
        const Icon = spec.icon;
        const active = tool === spec.id;
        return (
          <Tip
            key={spec.id}
            label={spec.label}
            hint={spec.hint}
            shortcut={spec.shortcut}
          >
            <button
              type="button"
              aria-label={spec.label}
              aria-pressed={active}
              onClick={() => store.setTool(spec.id)}
              className={active ? TOOL_BUTTON_ACTIVE : TOOL_BUTTON}
            >
              <Icon className="size-4" strokeWidth={1.75} />
            </button>
          </Tip>
        );
      })}

      <Divider />

      <Tip label="Undo" shortcut="⌘Z">
        <button
          type="button"
          aria-label="Undo"
          disabled={!canUndo}
          onClick={() => store.undo()}
          className={TOOL_BUTTON}
        >
          <Undo2 className="size-4" strokeWidth={1.75} />
        </button>
      </Tip>
      <Tip label="Redo" shortcut="⇧⌘Z">
        <button
          type="button"
          aria-label="Redo"
          disabled={!canRedo}
          onClick={() => store.redo()}
          className={TOOL_BUTTON}
        >
          <Redo2 className="size-4" strokeWidth={1.75} />
        </button>
      </Tip>

      <Divider />

      <Tip
        label="Open"
        hint="Open a character you saved earlier."
        shortcut="⌘O"
      >
        <button
          type="button"
          aria-label="Open a saved character"
          disabled={!onImport}
          onClick={onImport}
          className={TOOL_BUTTON}
        >
          <FolderOpen className="size-4" strokeWidth={1.75} />
        </button>
      </Tip>
      <Tip
        label="Export"
        hint="Saves two files: the character, and a page that plays it."
        shortcut="⌘E"
      >
        <button
          type="button"
          aria-label="Export"
          disabled={!onExport}
          onClick={onExport}
          className={TOOL_BUTTON}
        >
          <Download className="size-4" strokeWidth={1.75} />
        </button>
      </Tip>
    </div>
  );
}

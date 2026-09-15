"use client";

/**
 * The document menu.
 *
 * Top-left, where a file menu has been on every computer since 1984. It holds
 * the four things that are about the file rather than about the drawing, so the
 * toolbar can stay nothing but tools. The rig's name is the trigger, so it is
 * always visible and always editable.
 */

import { Menu } from "@base-ui/react/menu";
import {
  ChevronDown,
  FileDown,
  FilePlus2,
  FolderOpen,
  HelpCircle,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { useEditor, useEditorStore } from "@/editor/ui/context";
import { FOCUS_RING, POPUP, POPUP_LAYER, PRESS, UI_TEXT } from "./styles";

export interface DocumentMenuProps {
  onNew: () => void;
  onLoadSample: () => void;
  onOpen: () => void;
  onExport: () => void;
  onShowSteps: () => void;
  /** Rendered next to the name: "Saved", or the last error. */
  status: string | null;
  className?: string;
}

export function DocumentMenu({
  onNew,
  onLoadSample,
  onOpen,
  onExport,
  onShowSteps,
  status,
  className = "",
}: DocumentMenuProps) {
  const store = useEditorStore();
  const name = useEditor((state) => state.doc.name);
  const [editing, setEditing] = useState(false);

  return (
    <div
      className={`riff-glass flex h-10 items-center gap-1 rounded-riff-pill pr-2 pl-3 ${className}`}
    >
      {editing ? (
        <input
          ref={(node) => node?.select()}
          defaultValue={name}
          aria-label="Character name"
          onBlur={(event) => {
            const next = event.currentTarget.value.trim();
            setEditing(false);
            if (next && next !== name) {
              store.begin(null);
              store.setDoc((doc) => ({ ...doc, name: next }));
              store.commit();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = name;
              event.currentTarget.blur();
            }
          }}
          className={`${UI_TEXT} h-7 w-36 rounded-riff-md bg-riff-fill px-1.5 text-[13px] outline-2 outline-riff-accent`}
        />
      ) : (
        <button
          type="button"
          onDoubleClick={() => setEditing(true)}
          onClick={() => setEditing(true)}
          title="Rename this character"
          className={`max-w-[180px] truncate rounded-riff-md px-1 text-[13px] leading-[18px] font-semibold text-riff-text hover:bg-riff-fill ${FOCUS_RING}`}
        >
          {name}
        </button>
      )}

      {status ? (
        <span className="ml-0.5 shrink-0 text-[11px] leading-4 text-riff-faint">
          {status}
        </span>
      ) : null}

      <Menu.Root>
        <Menu.Trigger
          aria-label="File actions"
          className={`inline-flex size-7 shrink-0 items-center justify-center rounded-riff-md text-riff-muted hover:bg-riff-fill hover:text-riff-text ${PRESS} ${FOCUS_RING}`}
        >
          <ChevronDown className="size-4" strokeWidth={2} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            side="bottom"
            align="start"
            sideOffset={8}
            className={POPUP_LAYER}
          >
            <Menu.Popup className={`${POPUP} w-56`}>
              <Item icon={FilePlus2} label="New character" onSelect={onNew} />
              <Item
                icon={Sparkles}
                label="Load sample character"
                onSelect={onLoadSample}
              />
              <Item
                icon={FolderOpen}
                label="Open a saved character"
                shortcut="⌘O"
                onSelect={onOpen}
              />
              <Item
                icon={FileDown}
                label="Export"
                shortcut="⌘E"
                onSelect={onExport}
              />
              <span
                aria-hidden="true"
                className="my-1 block h-px bg-riff-hairline"
              />
              <Item
                icon={HelpCircle}
                label="Show the four steps"
                onSelect={onShowSteps}
              />
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

function Item({
  icon: Icon,
  label,
  shortcut,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  shortcut?: string;
  onSelect: () => void;
}) {
  return (
    <Menu.Item
      onClick={onSelect}
      className={`flex w-full cursor-default items-center gap-2.5 rounded-riff-lg px-2 py-1.5 text-left ${UI_TEXT} text-[12px] outline-none data-[highlighted]:bg-riff-fill`}
    >
      <Icon
        className="size-3.5 shrink-0 text-riff-muted"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span className="flex-1">{label}</span>
      {shortcut ? (
        <kbd className="font-mono text-[11px] text-riff-faint">{shortcut}</kbd>
      ) : null}
    </Menu.Item>
  );
}

"use client";

/**
 * Canvas zoom.
 *
 * Sits bottom-left of the canvas area. Fit and Fill need the size of the
 * viewport the canvas is drawn into, which this component does not own, so they
 * are passed in and the entries disappear when they are not wired up -- an
 * inert "Fit" is worse than no "Fit".
 */

import { Popover } from "@base-ui/react/popover";
import { Maximize2, Minus, Plus } from "lucide-react";
import { useEditor, useEditorStore } from "@/editor/ui/context";
import { clamp } from "./scrub";
import {
  FOCUS_RING,
  NUMERIC_TEXT,
  POPUP,
  POPUP_LAYER,
  PRESS,
  TOOL_BUTTON,
  UI_TEXT,
} from "./styles";
import { Tip } from "./Tooltip";

/** A quarter more or less per press, which is what most tools settled on. */
const ZOOM_RATIO = 1.25;
const MIN_SCALE = 0.02;
const MAX_SCALE = 64;

const PRESETS = [0.5, 1, 2];

export interface ZoomControlProps {
  /** Scale the artboard to sit fully inside the canvas viewport. */
  onFit?: () => void;
  /** Scale the artboard to cover the canvas viewport. */
  onFill?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export function ZoomControl({
  onFit,
  onFill,
  className = "",
  style,
}: ZoomControlProps) {
  const store = useEditorStore();
  const scale = useEditor((state) => state.ui.viewport.scale);

  function setScale(next: number) {
    store.setUi((ui) => ({
      viewport: { ...ui.viewport, scale: clamp(next, MIN_SCALE, MAX_SCALE) },
    }));
  }

  const percent = Math.round(scale * 100);

  return (
    <div
      style={style}
      className={`riff-glass flex items-center gap-0.5 rounded-riff-pill p-1 ${className}`}
    >
      <Tip label="Zoom out" shortcut="⌘−">
        <button
          type="button"
          aria-label="Zoom out"
          disabled={scale <= MIN_SCALE}
          onClick={() => setScale(scale / ZOOM_RATIO)}
          className={TOOL_BUTTON}
        >
          <Minus className="size-4" strokeWidth={1.75} />
        </button>
      </Tip>

      <Popover.Root>
        <Tip label="Zoom" hint="Pick a size, or Fit to bring everything back.">
          <Popover.Trigger
            aria-label={`Zoom level, currently ${percent} percent`}
            className={`${NUMERIC_TEXT} ${PRESS} ${FOCUS_RING} h-8 w-14 rounded-riff-btn text-center text-riff-muted hover:bg-riff-fill hover:text-riff-text`}
          >
            {percent}%
          </Popover.Trigger>
        </Tip>
        <Popover.Portal>
          <Popover.Positioner
            side="top"
            align="start"
            sideOffset={8}
            className={POPUP_LAYER}
          >
            <Popover.Popup className={`${POPUP} w-32`}>
              {PRESETS.map((preset) => (
                <PresetItem
                  key={preset}
                  label={`${Math.round(preset * 100)}%`}
                  active={Math.abs(scale - preset) < 0.001}
                  onSelect={() => setScale(preset)}
                />
              ))}
              {onFit ? (
                <PresetItem label="Fit" hint="Everything" onSelect={onFit} />
              ) : null}
              {onFill ? (
                <PresetItem
                  label="Fill"
                  hint="Fill the view"
                  onSelect={onFill}
                />
              ) : null}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      <Tip label="Zoom in" shortcut="⌘+">
        <button
          type="button"
          aria-label="Zoom in"
          disabled={scale >= MAX_SCALE}
          onClick={() => setScale(scale * ZOOM_RATIO)}
          className={TOOL_BUTTON}
        >
          <Plus className="size-4" strokeWidth={1.75} />
        </button>
      </Tip>

      <Tip
        label="Fit on screen"
        hint="Brings the character back if it goes off screen."
        shortcut="⇧1"
      >
        <button
          type="button"
          aria-label="Fit on screen"
          disabled={!onFit}
          onClick={onFit}
          className={TOOL_BUTTON}
        >
          <Maximize2 className="size-4" strokeWidth={1.75} />
        </button>
      </Tip>
    </div>
  );
}

function PresetItem({
  label,
  hint,
  active = false,
  onSelect,
}: {
  label: string;
  hint?: string;
  active?: boolean;
  onSelect: () => void;
}) {
  return (
    <Popover.Close
      onClick={onSelect}
      className={`flex w-full items-center justify-between gap-2 rounded-riff-lg px-2 py-1.5 text-left ${UI_TEXT} ${FOCUS_RING} ${
        active ? "bg-riff-accent-soft text-riff-accent" : "hover:bg-riff-fill"
      }`}
    >
      <span>{label}</span>
      {hint ? (
        <span className="text-[11px] leading-4 text-riff-faint">{hint}</span>
      ) : null}
    </Popover.Close>
  );
}

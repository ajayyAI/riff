"use client";

/**
 * The transport bar.
 *
 * Left cluster is playback, right cluster is the document. Play is always the
 * biggest, loudest control in the panel, because it is the one thing somebody
 * who has never opened an animation tool will reach for first.
 *
 * The readout sits between the two clusters in mono tabular figures so the
 * digits do not shuffle sideways while the playhead moves. In a motion tool a
 * jittering readout is a correctness problem, not a typographic preference.
 */

import {
  Ghost,
  Maximize2,
  Minus,
  Pause,
  Play,
  Plus,
  Repeat,
  SkipBack,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tip } from "../Tooltip";
import { formatTimecode } from "./geometry";
import { Diamond, FEEDBACK, FOCUS_RING, NumericField } from "./parts";

/**
 * A labelled icon button.
 *
 * A plain `<button>` rather than the shared `IconButton`, because the tooltip
 * renders through its trigger and an intrinsic element is the one thing that is
 * guaranteed to forward every prop it is handed.
 */
function Action({
  active,
  children,
  disabled,
  hint,
  label,
  onClick,
  shortcut,
  small,
}: {
  label: string;
  hint?: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  small?: boolean;
  onClick: (event: React.MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <Tip label={label} hint={hint} shortcut={shortcut}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          "grid shrink-0 place-items-center rounded-riff-btn text-riff-muted",
          small ? "size-7" : "size-8",
          "hover:bg-riff-fill hover:text-riff-text",
          "disabled:pointer-events-none disabled:opacity-40",
          active &&
            "bg-riff-accent-soft text-riff-accent hover:bg-riff-accent-soft",
          FEEDBACK,
          FOCUS_RING,
        )}
      >
        {children}
      </button>
    </Tip>
  );
}

export interface TransportProps {
  frame: number;
  fps: number;
  frameCount: number;
  playing: boolean;
  loop: boolean;
  zoom: number;
  /** True when at least one part is selected, so there is something to key. */
  canAddKeyframe: boolean;
  selectedKeyframeCount: number;
  onTogglePlay: () => void;
  onSkipToStart: () => void;
  onAddKeyframe: () => void;
  onKeyAll: () => void;
  onToggleLoop: () => void;
  /** True when the poses either side of the playhead are drawn faintly. */
  onionSkin: boolean;
  onToggleOnionSkin: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
  onDurationChange: (seconds: number) => void;
  onDurationDragStart: () => void;
  onDurationDragEnd: () => void;
}

export function Transport({
  canAddKeyframe,
  frame,
  fps,
  frameCount,
  loop,
  onAddKeyframe,
  onDurationChange,
  onDurationDragEnd,
  onDurationDragStart,
  onKeyAll,
  onSkipToStart,
  onToggleLoop,
  onionSkin,
  onToggleOnionSkin,
  onTogglePlay,
  onZoomFit,
  onZoomIn,
  onZoomOut,
  playing,
  selectedKeyframeCount,
  zoom,
}: TransportProps) {
  const duration = frameCount / (fps > 0 ? fps : 1);

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-riff-hairline px-3">
      <Action
        label="Back to start"
        hint="Jump back to the beginning."
        shortcut="Home"
        onClick={onSkipToStart}
      >
        <SkipBack className="size-4" strokeWidth={1.75} />
      </Action>

      <Tip
        label={playing ? "Pause" : "Play"}
        hint="Watch the animation run."
        shortcut="Space"
      >
        <button
          type="button"
          onClick={onTogglePlay}
          aria-label={playing ? "Pause" : "Play"}
          aria-pressed={playing}
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-riff-btn",
            "bg-riff-accent text-white hover:opacity-90",
            FEEDBACK,
            FOCUS_RING,
          )}
        >
          {playing ? (
            <Pause className="size-4" fill="currentColor" strokeWidth={0} />
          ) : (
            <Play className="size-4" fill="currentColor" strokeWidth={0} />
          )}
        </button>
      </Tip>

      {/*
        One control, not two. Keying the selection and keying everything are
        the same idea at two scopes, and two near-identical diamonds in a row
        is the classic pair of buttons nobody can tell apart.
      */}
      {/*
        Labelled, not an icon. A diamond means nothing to anyone who has not
        used an animation tool before, and this is the button the on-screen
        instructions name.
      */}
      <Tip
        label="Key"
        hint="Remember this pose here. Hold Shift to key every part."
        shortcut="K"
      >
        <button
          type="button"
          disabled={!canAddKeyframe}
          onClick={(event) => {
            if (event.shiftKey) onKeyAll();
            else onAddKeyframe();
          }}
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 rounded-riff-btn px-2.5",
            "text-riff-muted hover:bg-riff-fill hover:text-riff-text",
            "disabled:pointer-events-none disabled:opacity-40",
            FEEDBACK,
            FOCUS_RING,
          )}
        >
          <Diamond size={8} />
          <span className="text-[12px] leading-4 font-medium">Key</span>
        </button>
      </Tip>

      <Action
        label={loop ? "Looping" : "Play once"}
        hint="Repeat between the two handles in the ruler."
        shortcut="L"
        active={loop}
        onClick={onToggleLoop}
      >
        <Repeat className="size-4" strokeWidth={1.75} />
      </Action>

      <Action
        label="Before and after"
        hint="Draws the pose before and the pose after, faintly, so you can pose against them."
        shortcut="G"
        active={onionSkin}
        onClick={onToggleOnionSkin}
      >
        <Ghost className="size-4" strokeWidth={1.75} />
      </Action>

      <output
        // Fixed width, fixed decimals: the readout must never reflow the bar.
        className="ml-2 w-[104px] font-mono text-[12px] tabular-nums leading-4 tracking-[0.01em] text-riff-muted"
        aria-live="off"
      >
        {formatTimecode(frame, fps)} / {duration.toFixed(2)} s
      </output>

      {selectedKeyframeCount > 1 ? (
        <span className="rounded-riff-md bg-riff-accent-soft px-1.5 py-0.5 text-[11px] leading-4 text-riff-accent">
          {selectedKeyframeCount} keys
        </span>
      ) : null}

      <div className="flex-1" />

      <div className="flex items-center gap-0.5">
        <Action
          label="Zoom out"
          hint="See more of the animation at once."
          shortcut="⌘−"
          small
          onClick={onZoomOut}
        >
          <Minus className="size-3.5" strokeWidth={1.75} />
        </Action>
        <output
          className="w-[46px] text-center font-mono text-[11px] tabular-nums leading-4 text-riff-faint"
          title="How far the time strip is zoomed in"
        >
          {Math.round(zoom * 100)}%
        </output>
        <Action
          label="Zoom in"
          hint="Spread the keys further apart."
          shortcut="⌘+"
          small
          onClick={onZoomIn}
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
        </Action>
        <Action
          label="Fit"
          hint="Show the whole animation end to end."
          shortcut="⇧Z"
          small
          onClick={onZoomFit}
        >
          <Maximize2 className="size-3.5" strokeWidth={1.75} />
        </Action>
      </div>

      <div className="ml-3">
        <NumericField
          label="Length"
          value={duration}
          onChange={onDurationChange}
          onDragStart={onDurationDragStart}
          onDragEnd={onDurationDragEnd}
          step={0.1}
          min={1 / (fps > 0 ? fps : 1)}
          max={600}
          decimals={2}
          suffix="s"
          width={80}
        />
      </div>
    </div>
  );
}

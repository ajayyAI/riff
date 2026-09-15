"use client";

import { type ComponentProps, type ReactNode, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { evaluateExpression } from "../scrub";
import { KEYFRAME_SIZE } from "./geometry";

/**
 * The focus ring, in one place.
 *
 * The design lock asks for a visible `--riff-accent` ring on every control. One
 * shared string is the only way that survives contact with a file this size.
 */
export const FOCUS_RING =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-riff-accent";

/** Hover/press feedback at the locked 120ms, dropped to 1ms under reduced motion. */
export const FEEDBACK =
  "transition-colors duration-120 ease-riff motion-reduce:duration-[1ms]";

export function IconButton({
  className,
  active,
  ...props
}: ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-riff-btn text-riff-muted",
        "hover:bg-riff-fill hover:text-riff-text",
        "disabled:pointer-events-none disabled:opacity-40",
        active &&
          "bg-riff-accent-soft text-riff-accent hover:bg-riff-accent-soft",
        FEEDBACK,
        FOCUS_RING,
        className,
      )}
      {...props}
    />
  );
}

/**
 * The keyframe glyph: a 9px square rotated 45 degrees.
 *
 * A rotated div rather than an SVG path -- it costs nothing, it is crisp at any
 * DPR, and the border/fill split gives the empty state for free.
 */
export function Diamond({
  filled = true,
  selected = false,
  size = KEYFRAME_SIZE,
  className,
}: {
  filled?: boolean;
  selected?: boolean;
  size?: number;
  className?: string;
}) {
  const colour = selected ? "var(--riff-accent)" : "var(--riff-keyframe)";
  return (
    <span
      aria-hidden="true"
      className={cn("block rotate-45 rounded-[1.5px]", className)}
      style={{
        width: size,
        height: size,
        background: filled ? colour : "transparent",
        border: `1.5px solid ${colour}`,
      }}
    />
  );
}

/**
 * A number you can drag or type.
 *
 * Drag-first, keyboard-complete: a horizontal drag scrubs, a click without a
 * drag focuses for typing, and typing accepts arithmetic. Arrow keys nudge, so
 * the control is fully operable without a pointer at all.
 */
export function NumericField({
  value,
  onChange,
  onDragStart,
  onDragEnd,
  step = 0.1,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  decimals = 2,
  suffix,
  label,
  width = 72,
}: {
  value: number;
  onChange: (next: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  step?: number;
  min?: number;
  max?: number;
  decimals?: number;
  suffix?: string;
  label: string;
  width?: number;
}) {
  const [text, setText] = useState<string | null>(null);
  const drag = useRef<{ x: number; from: number; moved: boolean } | null>(null);

  const commit = (raw: string) => {
    const parsed = evaluateExpression(raw);
    setText(null);
    if (parsed !== null) onChange(Math.min(Math.max(parsed, min), max));
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] leading-4 text-riff-muted">{label}</span>
      <div
        className={cn(
          "flex h-7 items-center rounded-riff-lg bg-riff-fill pr-1.5",
          "focus-within:bg-riff-accent-soft",
          FEEDBACK,
        )}
        style={{ width }}
      >
        <input
          aria-label={label}
          inputMode="decimal"
          className={cn(
            "h-full w-full cursor-ew-resize bg-transparent px-1.5 text-right",
            "font-mono text-[12px] tabular-nums leading-4 tracking-[0.01em] text-riff-text",
            "focus:cursor-text",
            FOCUS_RING,
          )}
          value={text ?? value.toFixed(decimals)}
          onChange={(event) => setText(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit(event.currentTarget.value);
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setText(null);
              event.currentTarget.blur();
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              const direction = event.key === "ArrowUp" ? 1 : -1;
              const magnitude = event.shiftKey ? step * 10 : step;
              onChange(
                Math.min(Math.max(value + direction * magnitude, min), max),
              );
            }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || text !== null) return;
            drag.current = { x: event.clientX, from: value, moved: false };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const state = drag.current;
            if (!state) return;
            const delta = event.clientX - state.x;
            if (!state.moved) {
              if (Math.abs(delta) < 3) return;
              state.moved = true;
              onDragStart?.();
            }
            const next = state.from + Math.round(delta / 4) * step;
            onChange(Math.min(Math.max(next, min), max));
          }}
          onPointerUp={(event) => {
            const state = drag.current;
            drag.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            if (state?.moved) {
              onDragEnd?.();
              // A drag is not a click; don't leave a text caret behind.
              event.currentTarget.blur();
            } else {
              setText(value.toFixed(decimals));
              event.currentTarget.select();
            }
          }}
        />
        {suffix ? (
          <span className="shrink-0 text-[11px] leading-4 text-riff-faint">
            {suffix}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function PanelLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase leading-4 tracking-[0.02em] text-riff-faint">
      {children}
    </span>
  );
}

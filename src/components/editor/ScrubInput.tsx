"use client";

/**
 * The numeric field.
 *
 * Three affordances in one control, and the design lock requires all three:
 * drag the label to scrub, type into the field to set a value, and type an
 * expression to compute one. The label is the drag handle rather than the whole
 * field so that clicking the number does what clicking a number should -- put a
 * caret in it.
 *
 * Arithmetic and drag maths live in `./scrub`, tested in `ScrubInput.test.ts`.
 */

import {
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from "react";
import {
  editableValue,
  evaluateExpression,
  formatValue,
  normalizeValue,
  SCRUB_PX_PER_STEP,
  scrubValue,
} from "./scrub";
import { NUMERIC_TEXT } from "./styles";

export interface ScrubInputProps {
  /** Short, lower case. Doubles as the drag handle and the accessible name. */
  label: string;
  value: number;
  onChange: (value: number) => void;
  /**
   * Called once as a drag begins and once as it ends. Open an undo transaction
   * here so a whole scrub collapses into a single history entry.
   */
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  min?: number;
  max?: number;
  /** Value change per scrub increment, and the arrow-key nudge. */
  step?: number;
  /** Decimal places to display and commit at. */
  precision?: number;
  /** Rendered after the number and stripped before editing. */
  suffix?: string;
  /** Several layers selected with different values. */
  mixed?: boolean;
  disabled?: boolean;
  /** Why the field is disabled, e.g. the property is keyframed. */
  title?: string;
  className?: string;
}

export function ScrubInput({
  label,
  value,
  onChange,
  onScrubStart,
  onScrubEnd,
  min,
  max,
  step = 1,
  precision = 0,
  suffix,
  mixed = false,
  disabled = false,
  title,
  className = "",
}: ScrubInputProps) {
  // null means "not editing" -- the field shows the live value, which keeps it
  // correct while a scrub or the playhead moves underneath it.
  const [draft, setDraft] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const origin = useRef<{ x: number; value: number } | null>(null);

  const options = { step, precision, min, max };
  const display = mixed ? "Mixed" : formatValue(value, precision, suffix);

  function commit(text: string) {
    const result = evaluateExpression(text);
    // Unparseable input reverts rather than clearing. Losing a value to a typo
    // is worse than ignoring the typo.
    if (result !== null) onChange(normalizeValue(result, options));
    setDraft(null);
  }

  function nudge(
    direction: number,
    event: { shiftKey: boolean; altKey: boolean; metaKey: boolean },
  ) {
    const base = draft === null ? value : (evaluateExpression(draft) ?? value);
    const modifiers = {
      fine: event.shiftKey,
      coarse: event.metaKey || event.altKey,
    };
    // Reuse the scrub path so keyboard and pointer cannot disagree about what
    // one increment means.
    onChange(
      scrubValue(base, direction * SCRUB_PX_PER_STEP, options, modifiers),
    );
    setDraft(null);
  }

  function beginScrub(event: ReactPointerEvent<HTMLElement>) {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = { x: event.clientX, value };
    setScrubbing(true);
    // The cursor has to follow the pointer off the label, or the gesture looks
    // like it ended the moment you leave a 20px target.
    document.body.style.cursor = "ew-resize";
    onScrubStart?.();
  }

  function moveScrub(event: ReactPointerEvent<HTMLElement>) {
    const start = origin.current;
    if (!start) return;
    const next = scrubValue(start.value, event.clientX - start.x, options, {
      fine: event.shiftKey,
      coarse: event.metaKey || event.altKey,
    });
    if (next !== value) onChange(next);
  }

  function endScrub(event: ReactPointerEvent<HTMLElement>) {
    if (!origin.current) return;
    origin.current = null;
    setScrubbing(false);
    document.body.style.cursor = "";
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onScrubEnd?.();
  }

  return (
    <div
      title={title}
      className={`flex h-7 items-center gap-1.5 rounded-riff-lg bg-riff-fill px-2 transition-colors duration-[140ms] ease-riff hover:bg-riff-fill-hover focus-within:bg-riff-accent-soft focus-within:outline-2 focus-within:outline-riff-accent ${
        disabled ? "opacity-40" : ""
      } ${className}`}
    >
      {/*
        The scrub is a pointer-only enhancement of the label, so the span is
        `aria-hidden`: the input beside it carries the same affordance on the
        arrow keys, and announcing the label twice helps nobody.
      */}
      <span
        aria-hidden="true"
        onPointerDown={beginScrub}
        onPointerMove={moveScrub}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onLostPointerCapture={endScrub}
        className={`shrink-0 touch-none select-none text-[11px] leading-4 text-riff-muted transition-colors duration-[120ms] ease-riff ${
          disabled ? "" : "cursor-ew-resize hover:text-riff-accent"
        } ${scrubbing ? "text-riff-accent" : ""}`}
      >
        {label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        disabled={disabled}
        value={draft ?? display}
        placeholder={mixed ? "Mixed" : undefined}
        onFocus={(event) => {
          setDraft(mixed ? "" : editableValue(value, precision));
          event.currentTarget.select();
        }}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(event.currentTarget.value);
            event.currentTarget.select();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(null);
            event.currentTarget.blur();
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            nudge(1, event);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            nudge(-1, event);
          }
        }}
        className={`${NUMERIC_TEXT} w-full min-w-0 bg-transparent text-riff-text outline-none placeholder:text-riff-faint`}
      />
    </div>
  );
}

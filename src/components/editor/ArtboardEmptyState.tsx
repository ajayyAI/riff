"use client";

/**
 * The four steps that teach the whole editor, and the empty artboard.
 *
 * There is exactly one place in this app where anything is explained, and this
 * is it. Four steps, in the order someone actually does them, each naming a
 * control they can see. Anything that needs more explanation than a line here
 * is a control that needs redesigning, not documenting.
 *
 * An empty artboard gets the full version. A loaded one gets a single strip in
 * the same band as the zoom control, so the character is never hidden behind
 * its own instructions, and the strip opens when it is asked to.
 */

import { ChevronUp, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useEditor } from "@/editor/ui/context";
import { FOCUS_RING, PRESS } from "./styles";

const DISMISS_KEY = "riff.rig.hintsDismissed";

export const STEPS: { title: string; body: string }[] = [
  {
    title: "Draw a part",
    body: "Pick the Brush and draw. Finish near where you started and it fills.",
  },
  {
    title: "Attach it",
    body: "In Parts, drag one part onto another. It now follows that part.",
  },
  {
    title: "Place the joint",
    body: "Pick Joint and click where the part should turn.",
  },
  {
    title: "Make it move",
    body: "Drag the blue line in the timeline, turn the part, press K. Then press Play.",
  },
];

function StepNumber({ value }: { value: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-5 shrink-0 place-items-center rounded-riff-pill bg-riff-accent-soft font-mono text-[11px] leading-none text-riff-accent"
    >
      {value}
    </span>
  );
}

export interface ArtboardEmptyStateProps {
  /** Builds the sample character. */
  onLoadSample?: () => void;
  /** How far the strip must sit above the bottom of the viewport. */
  bottomInset: number;
  /** Where the strip starts, so it clears the parts panel. */
  leftInset: number;
  /** Where the strip must stop, so it never runs under the inspector. */
  rightInset: number;
}

export function ArtboardEmptyState({
  onLoadSample,
  bottomInset,
  leftInset,
  rightInset,
}: ArtboardEmptyStateProps) {
  const doc = useEditor((state) => state.doc);
  const tool = useEditor((state) => state.ui.tool);
  const artboard = doc.artboards[doc.activeArtboardId];
  const [dismissed, setDismissed] = useState(true);
  const [open, setOpen] = useState(false);

  // The expanded card sits over the canvas, so it closes the way every other
  // transient surface does rather than waiting to be told twice.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-riff-steps]")) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  // Read the flag after mount: the server has no localStorage, and rendering
  // the strip on the server would make it flash for someone who dismissed it.
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  const empty = !artboard || artboard.layerIds.length === 0;
  // The card sits over the middle of the page, which is where the first stroke
  // gets drawn. It is click-through, but it is also opaque, so it has to get
  // out of the way the moment a drawing tool is picked or the stroke is drawn
  // behind the instructions telling you to draw it.
  const drawing = tool !== "select" && tool !== "hand";

  if (empty) {
    if (drawing) return null;
    return (
      <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center px-6">
        {/*
          On its own card, not straight onto the page. An empty artboard shows
          the transparency checkerboard, and display type over a chequerboard is
          unreadable at exactly the moment someone is reading it for the first
          time.
        */}
        {/*
          The card takes no pointer events. It sits over the middle of the page,
          which is exactly where the first stroke gets drawn, and a card that
          eats step one of its own instructions is worse than no card at all.
          Only the button takes them back.
        */}
        <div className="riff-glass pointer-events-none flex w-[470px] max-w-full flex-col items-center gap-5 rounded-riff-panel px-8 py-8 text-center">
          <h1 className="font-bold text-[40px] text-riff-text leading-[44px] tracking-[-0.02em]">
            Make a character move
          </h1>
          <ol className="flex w-full flex-col gap-2.5">
            {STEPS.map((step, index) => (
              <li
                key={step.title}
                className="flex items-start gap-2.5 text-left"
              >
                <span className="mt-px">
                  <StepNumber value={index + 1} />
                </span>
                <span className="min-w-0">
                  <span className="font-semibold text-[13px] text-riff-text leading-[18px]">
                    {step.title}.{" "}
                  </span>
                  <span className="text-[13px] text-riff-muted leading-[18px]">
                    {step.body}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            disabled={!onLoadSample}
            onClick={onLoadSample}
            className={`pointer-events-auto inline-flex h-10 items-center gap-1.5 rounded-riff-btn bg-riff-accent px-4 font-semibold text-[13px] text-white hover:opacity-90 disabled:pointer-events-none disabled:opacity-35 ${PRESS} ${FOCUS_RING}`}
          >
            <Sparkles
              className="size-4"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            Load the sample character
          </button>
        </div>
      </div>
    );
  }

  if (dismissed) return null;

  return (
    // Bounded on both sides. The inspector is on top of this band, and a
    // dismiss button sitting underneath a panel is a strip you cannot close.
    <div
      data-riff-steps
      style={{ bottom: bottomInset, left: leftInset, right: rightInset }}
      className="pointer-events-none absolute z-10 flex flex-col items-start gap-2"
    >
      {open ? (
        <ol className="riff-glass pointer-events-auto w-[380px] max-w-[calc(100vw-48px)] rounded-riff-panel p-4">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex items-start gap-2.5 py-1">
              <span className="mt-px">
                <StepNumber value={index + 1} />
              </span>
              <span className="min-w-0">
                <span className="font-semibold text-[13px] text-riff-text leading-[18px]">
                  {step.title}.{" "}
                </span>
                <span className="text-[13px] text-riff-muted leading-[18px]">
                  {step.body}
                </span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="riff-glass pointer-events-auto flex h-10 max-w-full items-center gap-2 overflow-hidden rounded-riff-pill pr-1.5 pl-3">
        <span className="shrink-0 font-medium text-[12px] text-riff-text">
          New here?
        </span>
        {/* The steps are the first thing to go when the band gets narrow; the
            two buttons are what must never be unreachable. */}
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {STEPS.map((step, index) => (
            <button
              key={step.title}
              type="button"
              onClick={() => setOpen(true)}
              title={step.body}
              className={`flex shrink-0 items-center gap-1.5 rounded-riff-pill px-1.5 py-1 text-[12px] text-riff-muted hover:bg-riff-fill hover:text-riff-text ${FOCUS_RING}`}
            >
              <StepNumber value={index + 1} />
              {step.title}
            </button>
          ))}
        </span>
        <button
          type="button"
          aria-label={open ? "Hide the details" : "Show the details"}
          onClick={() => setOpen(!open)}
          className={`inline-flex size-7 shrink-0 items-center justify-center rounded-riff-md text-riff-faint hover:bg-riff-fill hover:text-riff-text ${PRESS} ${FOCUS_RING}`}
        >
          <ChevronUp
            className={`size-4 transition-transform duration-[120ms] ease-riff ${open ? "rotate-180" : ""}`}
            strokeWidth={2}
          />
        </button>
        <button
          type="button"
          aria-label="Hide these steps"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(DISMISS_KEY, "1");
            } catch {
              // Nothing to do; the strip simply returns next session.
            }
          }}
          className={`inline-flex size-7 shrink-0 items-center justify-center rounded-riff-md text-riff-faint hover:bg-riff-fill hover:text-riff-text ${PRESS} ${FOCUS_RING}`}
        >
          <X className="size-4" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

/** Let the document menu bring the steps back. */
export function showHints() {
  try {
    localStorage.removeItem(DISMISS_KEY);
  } catch {
    // Nothing to do.
  }
}

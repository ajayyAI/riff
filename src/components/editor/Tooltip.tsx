"use client";

/**
 * The editor's tooltip.
 *
 * Every icon-only control in the chrome carries one: the control's name, its
 * key, and one line saying what it does. An icon nobody can name is a control
 * nobody uses, and a shortcut that lives only in a `title` is a shortcut nobody
 * learns. The delay is short because the first thing a new user does is hover
 * everything.
 */

import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { NUMERIC_TEXT, POPUP_LAYER } from "./styles";

export function TooltipProvider({ children }: { children: ReactNode }) {
  // Once one tooltip is up, the neighbours open instantly -- scanning a toolbar
  // should not cost 600ms a button.
  return (
    <Tooltip.Provider delay={200} closeDelay={0}>
      {children}
    </Tooltip.Provider>
  );
}

export interface TipProps {
  /** The control's name, in the words the panel would use. */
  label: string;
  /** One line saying what it does. The only instruction a control ever gets. */
  hint?: string;
  /** Rendered as a key cap. Omit for controls with no binding. */
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement<Record<string, unknown>>;
}

export function Tip({
  label,
  hint,
  shortcut,
  side = "bottom",
  children,
}: TipProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={8} className={POPUP_LAYER}>
          <Tooltip.Popup className="max-w-[240px] rounded-riff-lg bg-riff-panel px-2.5 py-1.5 text-[12px] leading-4 text-riff-text shadow-riff-pop transition-[transform,opacity] duration-[120ms] ease-riff data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
            <span className="flex items-center gap-1.5">
              <span className="font-medium">{label}</span>
              {shortcut ? (
                <kbd className={`${NUMERIC_TEXT} text-riff-faint`}>
                  {shortcut}
                </kbd>
              ) : null}
            </span>
            {hint ? (
              <span className="mt-0.5 block text-[11px] leading-4 text-riff-muted">
                {hint}
              </span>
            ) : null}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

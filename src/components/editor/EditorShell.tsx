"use client";

/**
 * The editor layout.
 *
 * A desk filling the viewport with panels floating over it at a 12px inset,
 * exactly as the design lock's layout map draws it. Nothing docks flush and
 * nothing is in normal flow, so a panel populating cannot push another panel
 * around: the only way to guarantee "no layout shift when panels populate" is
 * for the panels not to share a layout in the first place.
 *
 * The canvas and the timeline arrive as props. This file must not import them:
 * the shell is what lets the three parts be built at the same time.
 */

import type { CSSProperties, ReactNode } from "react";
import { useEditor } from "@/editor/ui/context";
import { ArtboardEmptyState } from "./ArtboardEmptyState";
import { DocumentMenu } from "./DocumentMenu";
import { Inspector } from "./Inspector";
import { LayersPanel } from "./LayersPanel";
import {
  GAP,
  INSPECTOR_WIDTH,
  LAYERS_WIDTH,
  TOOLBAR_HEIGHT,
  ZOOM_WIDTH,
} from "./styles";
import { Toolbar } from "./Toolbar";
import { TooltipProvider } from "./Tooltip";
import { ZoomControl } from "./ZoomControl";

export interface EditorShellProps {
  /** Full-bleed canvas surface. Rendered beneath the panels. */
  canvas: ReactNode;
  /** Timeline. Rendered into the bottom band at `ui.timelineHeight`. */
  timeline: ReactNode;
  /** Bumped to bring the four steps back after they were dismissed. */
  hintNonce: number;
  savedLabel: string | null;
  onNew: () => void;
  onLoadSample: () => void;
  onOpen: () => void;
  onExport: () => void;
  onShowSteps: () => void;
  onFitToScreen?: () => void;
  onFillScreen?: () => void;
}

export function EditorShell({
  canvas,
  timeline,
  hintNonce,
  savedLabel,
  onNew,
  onLoadSample,
  onOpen,
  onExport,
  onShowSteps,
  onFitToScreen,
  onFillScreen,
}: EditorShellProps) {
  const timelineHeight = useEditor((state) => state.ui.timelineHeight);

  // Panels stop one gap above the timeline, which is itself one gap off the
  // bottom edge.
  const aboveTimeline: CSSProperties = { bottom: timelineHeight + GAP * 2 };
  const panelBounds: CSSProperties = {
    top: GAP + TOOLBAR_HEIGHT + GAP,
    ...aboveTimeline,
  };

  return (
    <TooltipProvider>
      <div className="relative h-dvh w-full overflow-hidden bg-riff-desk">
        {/*
          `data-riff-content` marks the user's own animation, which is exempt
          from the reduced-motion floor in globals.css. Playback is content.
        */}
        <div data-riff-content className="absolute inset-0">
          {canvas}
        </div>

        <ArtboardEmptyState
          key={hintNonce}
          onLoadSample={onLoadSample}
          bottomInset={timelineHeight + GAP * 2}
          leftInset={GAP + LAYERS_WIDTH + GAP + ZOOM_WIDTH + GAP}
          rightInset={GAP + INSPECTOR_WIDTH + GAP}
        />

        <DocumentMenu
          onNew={onNew}
          onLoadSample={onLoadSample}
          onOpen={onOpen}
          onExport={onExport}
          onShowSteps={onShowSteps}
          status={savedLabel}
          className="absolute top-3 left-3 z-30"
        />

        <Toolbar
          onImport={onOpen}
          onExport={onExport}
          className="absolute top-3 left-1/2 z-30 -translate-x-1/2"
        />

        <LayersPanel style={panelBounds} className="absolute left-3 z-20" />

        <Inspector style={panelBounds} className="absolute right-3 z-20" />

        <ZoomControl
          onFit={onFitToScreen}
          onFill={onFillScreen}
          style={{ ...aboveTimeline, left: GAP + LAYERS_WIDTH + GAP }}
          className="absolute z-20"
        />

        <div
          data-riff-content
          style={{ height: timelineHeight }}
          className="absolute inset-x-3 bottom-3 z-20 overflow-hidden rounded-riff-panel"
        >
          {timeline}
        </div>
      </div>
    </TooltipProvider>
  );
}

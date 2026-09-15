"use client";

/**
 * The part column.
 *
 * This is the same list the Parts panel shows, at the same row heights, which is
 * why the row list is computed once in `rows.ts` and handed to both. Two
 * renderings of one list that disagree by two pixels is the kind of thing nobody
 * files a bug about and everybody feels.
 */

import { ChevronDown, ChevronRight, Eye, EyeOff, Lock } from "lucide-react";
import type { LayerId } from "@/editor/model/document";
import { cn } from "@/lib/utils";
import { indentFor } from "../styles";
import { Tip } from "../Tooltip";
import { LAYER_COLUMN_WIDTH } from "./geometry";
import { Diamond, FEEDBACK, FOCUS_RING } from "./parts";
import type { TimelineRow } from "./rows";

export interface LayerColumnProps {
  rows: readonly TimelineRow[];
  selectedLayerIds: readonly LayerId[];
  /** Where the playhead is, so a property row can show whether it is keyed here. */
  playheadFrame: number;
  onSelectLayer: (layerId: LayerId, additive: boolean) => void;
  onToggleCollapsed: (layerId: LayerId) => void;
  onToggleVisible: (layerId: LayerId) => void;
  onToggleKeyframe: (rowId: string) => void;
}

/** "a" or "an", so a generated sentence does not read as a typo. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

export function LayerColumn({
  onSelectLayer,
  onToggleCollapsed,
  onToggleKeyframe,
  onToggleVisible,
  playheadFrame,
  rows,
  selectedLayerIds,
}: LayerColumnProps) {
  return (
    <div
      className="shrink-0 border-riff-hairline border-r"
      style={{ width: LAYER_COLUMN_WIDTH }}
    >
      {rows.map((row) => {
        const selected = selectedLayerIds.includes(row.layerId);

        if (row.kind === "layer") {
          const { layer } = row;
          return (
            <div
              key={row.id}
              className={cn(
                "flex items-center gap-1 pr-1.5",
                selected ? "bg-riff-accent-soft-opaque" : "hover:bg-riff-fill",
                FEEDBACK,
              )}
              style={{
                height: row.height,
                paddingLeft: indentFor(row.depth, 6),
              }}
            >
              <button
                type="button"
                onClick={() => onToggleCollapsed(row.layerId)}
                disabled={!row.expandable}
                aria-expanded={!layer.collapsed}
                aria-label={
                  layer.collapsed
                    ? `Show what is attached to ${layer.name}`
                    : `Fold away what is attached to ${layer.name}`
                }
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-riff-md text-riff-faint",
                  "hover:text-riff-text disabled:opacity-0",
                  FEEDBACK,
                  FOCUS_RING,
                )}
              >
                {layer.collapsed ? (
                  <ChevronRight className="size-3.5" strokeWidth={2} />
                ) : (
                  <ChevronDown className="size-3.5" strokeWidth={2} />
                )}
              </button>

              <button
                type="button"
                onClick={(event) =>
                  onSelectLayer(row.layerId, event.shiftKey || event.metaKey)
                }
                className={cn(
                  "min-w-0 flex-1 truncate rounded-riff-md py-0.5 text-left",
                  "text-[13px] leading-[18px]",
                  layer.visible ? "text-riff-text" : "text-riff-faint",
                  FOCUS_RING,
                )}
                title={layer.name}
              >
                {layer.name}
              </button>

              {layer.locked ? (
                <Lock
                  className="size-3.5 shrink-0 text-riff-faint"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
              ) : null}

              <Tip
                label={layer.visible ? "Hide this part" : "Show this part"}
                side="left"
              >
                <button
                  type="button"
                  onClick={() => onToggleVisible(row.layerId)}
                  aria-pressed={layer.visible}
                  aria-label={`${layer.visible ? "Hide" : "Show"} ${layer.name}`}
                  className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-riff-md text-riff-faint",
                    "hover:bg-riff-fill hover:text-riff-text",
                    FEEDBACK,
                    FOCUS_RING,
                  )}
                >
                  {layer.visible ? (
                    <Eye className="size-3.5" strokeWidth={1.75} />
                  ) : (
                    <EyeOff className="size-3.5" strokeWidth={1.75} />
                  )}
                </button>
              </Tip>
            </div>
          );
        }

        const keyed =
          row.track?.keyframes.some((k) => k.frame === playheadFrame) ?? false;
        return (
          <div
            key={row.id}
            className={cn("flex items-center gap-1 pr-2", FEEDBACK)}
            style={{
              height: row.height,
              paddingLeft: indentFor(row.depth, 12),
            }}
          >
            <span className="min-w-0 flex-1 truncate text-[11px] leading-4 text-riff-muted">
              {row.label}
            </span>
            <Tip
              label={keyed ? "Remove this key" : "Add a key here"}
              shortcut="K"
              side="left"
            >
              <button
                type="button"
                onClick={() => onToggleKeyframe(row.id)}
                aria-pressed={keyed}
                aria-label={
                  keyed
                    ? `Remove the ${row.label} key here`
                    : `Add ${article(row.label)} ${row.label} key here`
                }
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-riff-md",
                  "hover:bg-riff-fill",
                  FEEDBACK,
                  FOCUS_RING,
                )}
              >
                <Diamond filled={keyed} size={7} />
              </button>
            </Tip>
          </div>
        );
      })}
    </div>
  );
}

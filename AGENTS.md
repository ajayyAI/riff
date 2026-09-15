<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# riff

Draw a character, attach its parts, and make it move. A 2D cutout rig editor.

**Start at [`docs/handoff.md`](docs/handoff.md)** for the current state, what
works, what is missing, and how to verify a change.

The product is the loop: draw a part, attach it to another, place the joint that
it turns around, key a pose, play it back, export a player anyone can open. Every
decision below serves someone who has never opened an animation tool getting
through that loop without being told anything.

## Non-negotiables

- **Read the Next.js docs in `node_modules/next/dist/docs/` before writing any
  Next-specific code.** This version differs from training data.
- The React Compiler is on (`babel-plugin-react-compiler`). Do not hand-write
  `useMemo`, `useCallback` or `React.memo`. The compiler handles it, and manual
  memoization now actively fights it. Optimise by fixing the data flow instead.
- `bun` is the package manager. `biome` is the linter and formatter.
- `ref/` is cloned reference material and is gitignored. Read it freely; never
  import from it. Port what you need into `src/` with attribution in a comment.
- **No em dashes** in code, comments, docs or anything the user reads.

<!-- BEGIN:design-lock -->
# Design lock

Use the tokens. Do not invent new hex values, radii or shadows in component
code. Changing anything here is a design decision, not an implementation
detail: open an issue, do not edit it in passing.

## Direction

riff should feel like a premium, friendly workspace. Cards of frosted glass
floating over one continuous canvas, rounded humanist type, filled icons,
physical press feedback, one blue accent. Quiet chrome so the user's artwork is
the only saturated thing on screen. Everything the user can do is discoverable
from a hint under the section it belongs to.

**Plain words only.** The visible vocabulary is Part, Joint, Attach to, Overlap,
Variants, Slant, Depth, Key, Play, Fill, Outline, Page. Never bone, pivot, FK,
slot, attachment, track, keyframe, easing curve or bezier in anything the user
reads. A control that needs more explanation than one line under its section is a
control that needs redesigning.

## Colour

| Token | Value | Use |
|---|---|---|
| `--riff-accent` | `#0A84FF` | Active tool, selection, playhead, toggles, primary action, focus ring |
| `--riff-accent-soft` | `#0A84FF1F` | Numeric-field focus, chips, hint blocks |
| `--riff-accent-soft-opaque` | `#E2F0FF` | Selected row fill, drop-target fill |
| `--riff-desk` | `#E0E0E0` | The surround behind artboards (user-settable later) |
| `--riff-panel` | `#FFFFFF` | Every floating panel |
| `--riff-bg` | `#F5F5F5` | Page and default artboard background |
| `--riff-text` | `#1D1D1F` | Primary text |
| `--riff-muted` | `#86868B` | Labels, inactive icons |
| `--riff-faint` | `#AEAEB2` | Hints, ruler numbers, counts, placeholder |
| `--riff-hairline` | `#00000012` | Internal 1px dividers |
| `--riff-hairline-strong` | `#0000001F` | Dividers that must separate |
| `--riff-keyframe` | `#48484A` | Unselected keyframe diamond; accent when selected |
| `--riff-danger` | `#FF3B30` | Destructive, invalid, auto-key armed (12% tint bg) |
| `--riff-good` | `#248A3D` / bg `#E7F7EA` | Completed job, saved state |
| `--riff-guide` | `#FF3B30` | Snap guides |

Surfaces inside panels are black alphas, not greys, so one set composes on
white and on the desk: `black/[0.035]` inputs and cards, `0.04` numeric field
rest, `0.05` hover and ruler shading, `0.06` numeric hover, `0.12` strong fill,
`0.15` toggle off, `0.20` major tick.

The artboard defaults to `--riff-bg` with a checkerboard when transparent.

## Type

- **Interface: Inter** (`--font-sans`, via `next/font`). Every label, button,
  panel and hint. Weights 500 for labels, 600 for titles, 700 for display.
- **Numbers: Geist Mono** (`--font-geist-mono`). Every field holding a number
  the user drags or scrubs. Tabular figures stop values jittering mid-scrub.

| Role | Size / line | Weight | Tracking |
|---|---|---|---|
| Panel label | 11 / 16 | 500 | `0.01em` |
| UI default | 12 / 16 | 500 | `0` |
| Numeric field | 12 / 16 | 500 | `0.01em`, tabular |
| Panel title | 13 / 18 | 600 | `0` |
| Hint | 11 / 16 | 400 | `0`, `--riff-faint` |
| Display | 48+ | 700 | `-0.02em` |

## Icons

`lucide-react`, 16px in the toolbar, 14px in the transport, 12 to 13px in
panels. Every icon-only control carries an `aria-label` naming the action in
active voice, and a tooltip carrying its name, its key and one line saying what
it does. An icon nobody can name is a control nobody uses.

## Shape, depth, feedback

| Token | Value | Use |
|---|---|---|
| `--riff-r-sm` | `4px` | Tiny controls |
| `--riff-r-md` | `6px` | Keyframe toggle, row icon buttons |
| `--riff-r-lg` | `8px` | Numeric inputs, clip bars, layer rows |
| `--riff-r-btn` | `10px` | All 32px toolbar and transport buttons |
| `--riff-r-panel` | `16px` | Every floating panel, popover, dialog |
| `--riff-r-pill` | `999px` | Toggles, canvas hint toast, avatar |

Editor panels are **frosted glass** (`riff-glass`): 74% white, a 28px backdrop
blur, and a soft card shadow whose first layer is the hairline. They are inset 12px from the
viewport and from each other, and the canvas runs edge to edge underneath them,
which is what makes the artwork read as the whole surface.

```
--riff-panel-glass: rgb(255 255 255 / 0.74);
--riff-shadow-card: 0 0 0 .5px rgba(0,0,0,.07), 0 1px 2px rgba(0,0,0,.04), 0 16px 40px rgba(0,0,0,.08);
--riff-shadow-pop:  0 12px 40px rgba(0,0,0,.14);
```

`--riff-shadow-pop` stays for transient layers that float above and can be
dismissed: menus, popovers, dialogs, toasts, drag ghosts. Every portalled
surface must also carry `POPUP_LAYER` (`z-[60]`), because a portal at body level
with `z-index: auto` paints *underneath* a panel that has one.

A backdrop filter makes a panel the containing block for anything `fixed` inside
it. Menus rendered inside a panel must be portalled to `document.body` or they
are clipped by the card they belong to.

Every pressable control uses `.press`: `active:transform: scale(.96)` over
`140ms cubic-bezier(.23,1,.32,1)`. Buttons are 32px; the active tool is
`--riff-accent` with white glyph; disabled is `opacity: .3`.

## Spacing

4px base. Panel padding 16px, section gap 16px, control gap 8px, icon-to-label
6px. Panels sit 12px off the viewport edge and 12px from each other.

## Motion

Functional feedback only. Hover, focus, press: `120ms cubic-bezier(.2,0,0,1)`.
Panel and popover entry: `180ms`. Nothing decorative animates. Dragging,
scrubbing, and canvas transforms are never transitioned. Honour
`prefers-reduced-motion` by dropping to `1ms`, but never disable playback of
the user's own animation.

## Layout

Panels float over one continuous canvas at a 12px inset. Nothing docks flush and
nothing is in normal flow, so a panel populating cannot push another panel
around.

| Region | Size |
|---|---|
| Toolbar pill | 40 tall, centred, top 12 |
| Parts panel | 240 wide |
| Inspector | 260 wide, `p-4` |
| Zoom pill | bottom-left, after the parts panel |
| Timeline | 208 tall default, double-click the handle collapses it to 80 |
| Timeline parts column | 220 |
| Ruler | 30 |
| Part row | 32 |
| Property row | 26 |
| Time scale | 140px per second at 100% zoom |

Row heights are shared between the Parts panel and the timeline parts column.
They are the same tree; two row heights for one tree is a bug.

## The signature

**The rig answers back.** Selecting a part draws its joint as a grabbable
crosshair, outlines the chain it hangs off in a dashed accent, and links each
joint to its parent with a hairline. A cutout rig is a claim about what follows
what, and the canvas states that claim rather than hiding it in a panel. This is
the one place to spend effort on delight.

## Quality floor

- Every control reachable and operable by keyboard, with a visible
  `--riff-accent` focus ring. Canvas tools get single-key shortcuts.
- Contrast: 4.5:1 body text, 3:1 UI boundaries.
- Numeric inputs are drag-scrubbable and accept expressions (`120/2`).
- Every destructive action is undoable; prefer undo over confirmation dialogs.
  Never `window.confirm`.
- No layout shift when panels populate. Reserve the space.
- Dark mode is planned; define every colour through the tokens above so it
  is a token swap, not a rewrite.

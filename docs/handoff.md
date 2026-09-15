# Handoff

Read this before changing the editor. It is the map a contributor needs:
what is here, what is not, and how to prove a change works.

## What this is

riff is a **2D cutout character rig editor**. You draw a character out of parts,
attach each part to another, place the joint it turns around, key poses on a
timeline, and export a single HTML file that plays the result anywhere.

It used to be a video-to-vector tool. That is gone: there is no video import, no
tracer, no frame sequence, no animated-SVG export, and nothing in the UI mentions
any of it. The git history has them if they are ever wanted back.

The product is one loop, and everything here serves someone getting through it
without being told anything:

1. Draw a part with the Brush. Every stroke becomes a part.
2. In Parts, drag one part onto another. It now follows that part.
3. Pick Joint and click where the part should turn.
4. Move the playhead, turn the part, press K. Then press Play.

## How to run it

```sh
bun install
bun run dev          # http://localhost:3000
```

First open loads the sample character, because an editor that opens empty asks
the user to imagine what it does. **New rig** in the document menu clears it.

## Gates

```sh
bunx biome check     # lint and format, 0 errors and 0 warnings
bunx tsc --noEmit    # types
bun test             # 367 tests
bun run build        # the production build, which type-checks again
```

All three are green as of this writing. `bunfig.toml` pins the test root to
`./src` so `ref/` suites do not run.

## The model, in one screen

One layer kind, `PartLayer`, in `src/editor/model/document.ts`:

- `parentLayerId` is the **skeleton**. A part follows whatever it is attached to.
- `artboard.layerIds` is the **draw order**, index 0 at the back. It is a
  separate fact: in a cutout rig the back arm hangs off the torso and draws
  behind it, and a model that forces one list to mean both cannot say that.
- `pivot` is the **joint**, in the part's own coordinates, and is not animated.
  `composeLayerMatrix` puts the joint at `position + joint`, so moving a joint
  never moves the artwork at rest. That is the difference between a rig joint and
  a design tool's anchor point.
- `transform` is `x, y, rotation, scaleX, scaleY, skewX, skewY`, all animatable.
  Slant (the two skews) plus a rotation is what makes a flat cutout read as
  turning rather than sliding.
- `depth` is animatable and re-sorts the draw list at each frame, so an arm can
  swing in front of the body and back behind it. Ties keep the artboard's order.
- `overlap` (0 to 3) repeats the part's fill a few pixels toward its parent,
  under the part itself, so the parent's outline hides the gap at the joint.
- `variants` are alternative drawings sharing one transform and one joint. The
  shown index is animatable and keys with hold easing, so a mouth shape snaps
  rather than blending.
- A part with no variants is a null joint. That is what Group makes, and it is
  the same type as everything else, so there is no "unavailable for groups"
  anywhere.

Paths are immutable: editing mints a new `PathId`, which is why the renderer's
`Path2D` cache can never go stale.

## What works

- **Canvas.** Canvas2D, back to front, forward kinematics through the parent
  chain, rotation about the joint, an optional white halo pass over the whole
  rig, the overlap tuck, and pressure-bucketed marker strokes. Artwork and
  overlays are two stacked canvases so dragging a handle does not repaint the
  rig. Scroll pans, Command or pinch zooms, space drags, Fit always brings the
  artwork back.
- **Tools.** Select, Brush, Pen, Joint, Rectangle, Ellipse, Move around. Nothing
  else. Select covers click, shift-click, marquee, drag-move with snapping to
  other parts and to the page, corner and edge resize, a rotate grip, a
  draggable joint crosshair, and arrow-key nudge.
- **Parts panel.** The rig as a tree, nested by what each part is attached to,
  siblings front of the stack first. Drag onto a part to attach it, drag between
  to reorder. Rename, lock, hide, thumbnails, a right-click menu with every
  action, and the selected part's whole chain tinted.
- **Inspector.** Only what applies to the selection: position and size, slant,
  depth, joint with "Set at click", Attach to, overlap, fill with swatches,
  outline, opacity, variants, Join, Add, Subtract, Overlap only, Simplify,
  Smooth, draw order, duplicate, mirror, align and distribute.
- **Timeline.** Play, a playhead, one quiet row per part carrying its key dots,
  and property rows only for what a part actually animates. Keys drag to retime,
  double-click cycles the motion preset (Snap, Steady, Soft, Smooth, Bounce),
  marquee-select and delete work, and the loop range has handles in the ruler
  that bracket it rather than sitting on the frames you want to click. "Before
  and after" draws the pose either side of the playhead faintly, to pose
  against.
- **Persistence.** Autosave to localStorage, restored on open. Command S says so.
- **Files.** Command E writes the project JSON and a standalone player HTML.
  Opening accepts either a riff project or a rig-legacy studio file and converts
  the latter (parts to parts, poses and steps to keys, radians to degrees).
- **The player.** One file, one canvas, no libraries, no network. Exposes
  `window.rig.play() / .pause() / .restart() / .goto(frame)`.

## What was found by testing, and fixed

A first-time user was put in front of it with no help. The fixes that came out of
that are the ones most worth not undoing:

- The empty-state card is click-through and disappears the moment a drawing tool
  is picked. It used to sit over the middle of the page and swallow the first
  stroke, which is step one of its own instructions.
- K is a global shortcut, not a timeline one. A key that only works when a
  particular panel has focus is a key that looks broken, and the on-screen
  instruction says to press it.
- The brush shows the point it would close onto, as a ring that fills when the
  pointer is inside it, and the tolerance is measured in screen pixels rather
  than document units. "Finish near where you started" is only a rule someone
  can follow if they can see where the start is.
- The page is drawn as a card with a shadow. The panels are glass and the canvas
  runs underneath them, so without a lifted edge there is no way to tell a part
  drawn on the page from one drawn beside it.
- Position reads as where the joint sits on the page. A part stores its position
  in whatever it is attached to, so three parts in three places all read zero,
  which is true and useless.
- The inspector and the parts column have a permanently visible scrollbar. Both
  overflow, and an overlay scrollbar only appears once you already know to
  scroll, so people concluded the missing controls did not exist.
- The active tool button is a separate class string, not a base plus an
  override. A hover utility and an active utility of equal specificity resolve
  by stylesheet order, which is how a white glyph ended up invisible on a 4%
  black background.
- Hiding a part shows its children as hidden too, and the joint crosshair and
  chain stop being drawn for anything off screen.
- The rotate grip shows the angle while you drag it.
- The onboarding strip is bounded on both sides, so its own dismiss button can
  never end up underneath the inspector on a small window.
- A single click with the brush leaves a dot. Doing nothing at all is how a
  drawing tool convinces someone it is broken.
- Mirror carries the whole chain and lands it in front. An upper arm mirrored
  without its forearm and hand is not the other arm, and a copy hidden behind
  the body is a copy that looks like it was never made.
- A part hanging off the page is outlined faintly on the canvas and named in the
  inspector, because the page is what the exported player uses as its canvas.

## What is missing

- **No per-point editing.** The Pen places corners and the Brush smooths, but
  there is no way to grab a vertex afterwards. Simplify and Smooth are the only
  shape edits.
- **No curve editor.** Motion presets only; there is no graph view and no way to
  author a custom curve.
- **No images.** The model carries an image attachment on a variant and the
  renderer ignores it. Nothing imports one.
- **No inverse kinematics, no meshes, no deform.** This is a cutout rig.
- **One artboard.** The model has a list; the UI assumes one.
- **No onion skin, no ghosting, no motion trail.**
- **Boolean ops are Greiner-Hormann with a jitter retry.** Two shapes that touch
  exactly along an edge can still fall back to leaving the subject unchanged.
- **Undo does not cover the viewport, the playhead or the selection alone**, on
  purpose. Nobody wants to undo a pan.
- **Not deployed, no accounts, no mobile layout.**
- **No tests drive the React components.** The model, the maths and the tool
  surface are covered; the panels are verified by hand in a browser.

## How to verify a change

Run the three gates, then drive the real thing:

```sh
bun run dev
export AGENT_BROWSER_SESSION="riff"
agent-browser set viewport 1512 945
agent-browser open http://localhost:3000
```

Exercise the loop and look at the screenshots: load the sample, select the
Forearm and turn it (the upper arm must stay, the hand must follow), drag the
Hand onto the Forearm in Parts, draw three brush strokes and Join them into one
filled shape, Add two ovals together, set two keys and press Play, export and
open the player on its own, then reload and check the rig came back.

`agent-browser console` must be empty of errors at every step.

## Driving the editor from an agent

Every action the UI performs is also a named tool. They go through the same store
transactions the UI does, so anything a tool does is undoable and anything the UI
does is visible to a tool.

- `window.riffTools` is always present in the browser. Call
  `window.riffTools.list()` for the names, descriptions and input schemas, then
  `window.riffTools.<name>(input)`.
- They are also registered with the WebMCP API when the browser has one, through
  `navigator.modelContext.registerTool`. Absence is a silent no-op.
- Source: `src/editor/agent-tools.ts`, registered by
  `src/components/editor/AgentBridge.tsx`.

| Tool | Example call |
|---|---|
| `newDocument` | `riffTools.newDocument({})` |
| `loadSample` | `riffTools.loadSample({})` |
| `listLayers` | `riffTools.listLayers({})` |
| `select` | `riffTools.select({ ids: ["Layer_3"] })` |
| `drawStroke` | `riffTools.drawStroke({ points: [[10,10,0.5],[80,12,0.7],[80,90,0.6]], closed: true, name: "Body", fill: "#C7CDD6" })` |
| `rect` | `riffTools.rect({ x: 40, y: 40, width: 120, height: 80, name: "Torso" })` |
| `ellipse` | `riffTools.ellipse({ cx: 100, cy: 60, rx: 50, ry: 40, name: "Head" })` |
| `join` | `riffTools.join({ ids: ["Layer_3","Layer_4","Layer_5"] })` |
| `union` | `riffTools.union({ ids: ["Layer_3","Layer_4"] })` |
| `subtract` | `riffTools.subtract({ ids: ["Layer_3","Layer_4"] })` |
| `intersect` | `riffTools.intersect({ ids: ["Layer_3","Layer_4"] })` |
| `simplify` | `riffTools.simplify({ id: "Layer_3", tolerance: 1.5 })` |
| `attach` | `riffTools.attach({ childId: "Layer_7", parentId: "Layer_5" })` |
| `setJoint` | `riffTools.setJoint({ id: "Layer_5", x: 158, y: 244 })` |
| `setTransform` | `riffTools.setTransform({ id: "Layer_5", rotation: -110, skewX: -12, depth: 2 })` |
| `setOverlap` | `riffTools.setOverlap({ id: "Layer_5", overlap: 2 })` |
| `addVariant` | `riffTools.addVariant({ id: "Layer_9", name: "Eyes closed" })` |
| `setVariant` | `riffTools.setVariant({ id: "Layer_9", name: "Eyes closed" })` |
| `mirror` | `riffTools.mirror({ id: "Layer_5" })` |
| `group` | `riffTools.group({ ids: ["Layer_5","Layer_6"] })` |
| `reorder` | `riffTools.reorder({ id: "Layer_5", index: 0 })` |
| `setPlayhead` | `riffTools.setPlayhead({ frame: 24 })` |
| `key` | `riffTools.key({ ids: ["Layer_5"], props: ["transform.rotation"] })` |
| `keyAll` | `riffTools.keyAll({})` |
| `play` | `riffTools.play({})` |
| `pause` | `riffTools.pause({})` |
| `exportJson` | `riffTools.exportJson({})` |
| `importJson` | `riffTools.importJson({ json: "{...}" })` |
| `exportPlayerHtml` | `riffTools.exportPlayerHtml({})` |
| `undo` | `riffTools.undo({})` |
| `redo` | `riffTools.redo({})` |
| `state` | `riffTools.state({})` |
| `screenshotHints` | `riffTools.screenshotHints({})` |

Animatable property paths, for `key`: `transform.x`, `transform.y`,
`transform.rotation`, `transform.scaleX`, `transform.scaleY`, `transform.skewX`,
`transform.skewY`, `opacity`, `depth`, `variant`.

`screenshotHints` returns each part's box in screen pixels, so an agent testing
the real UI can aim a click at a part rather than guessing.

## Ground rules that will bite you

- **The React Compiler is on.** Never `useMemo`, `useCallback` or `React.memo`.
  No bare `try/finally` in a component body. No `??=` on a compiled path.
- **The store lives outside React** (`src/editor/store.ts`, read through
  `useEditor`). The canvas subscribes imperatively and repaints without
  re-rendering. Playback must not cost React reconciliations.
- **Every edit is a transaction**: `store.begin(mergeKey)` then `setDoc` then
  `commit()`. A drag shares one merge key so it is one undo step, and `commit`
  records nothing when the document did not actually move.
- **Paths are immutable.** Editing mints a new `PathId`.
- **Plain words only.** The visible vocabulary is in the design lock in
  `AGENTS.md`. Never bone, pivot, FK, slot, attachment, track, keyframe, easing
  curve or bezier in anything a user reads.
- **No em dashes** anywhere, in code, comments, docs or copy.
- **A backdrop filter makes a panel the containing block for anything `fixed`
  inside it.** Portal every menu to `document.body` and give it `POPUP_LAYER`.
- **Copy open-source code, do not rewrite it.** `ref/` is cloned reference
  material, gitignored, never imported from. Attribute at the top of every
  ported file. Currently ported: the timeline ruler maths from
  animation-timeline-control (MIT), the boolean clipper from the
  Greiner-Hormann paper by way of w8r's MIT implementation, and the marker
  smoothing, overlap tuck and player shape from the single-file prototype riff
  grew out of.

## Where things are

```
src/editor/model/document.ts    the shape of a rig
src/editor/model/rig.ts         skeleton, draw order, forward kinematics, duplicate, mirror
src/editor/model/polyline.ts    flatten, simplify, smooth, join
src/editor/model/boolean.ts     Greiner-Hormann union, subtract, intersect
src/editor/model/shape-ops.ts   what Join, Add, Subtract, Simplify and Smooth do
src/editor/model/shapes.ts      what the rectangle, ellipse and brush tools produce
src/editor/model/sample.ts      the sample character
src/editor/render/scene.ts      document plus frame to a flat draw list
src/editor/render/renderer.ts   Canvas2D, the halo pass, overlap, pressure buckets
src/editor/io/                  project files, the player, legacy studio import, autosave
src/editor/store.ts             the store, outside React
src/editor/agent-tools.ts       the programmatic surface
src/components/editor/          the shell, canvas, panels and timeline
src/components/editor/draw.ts   what the drawing tools do to the document
src/components/editor/snapping.ts    snap maths, tested without a canvas
src/components/editor/shortcuts.ts   every document-level keyboard shortcut
```

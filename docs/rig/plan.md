# riff rig plan: eleven agent-days

Written 2026-09-15. Read `feature-gaps.md` first for why these and not others, and
`sources.md` for every repo, path and licence named here.

## Rules this plan obeys

- **Port, do not rewrite.** Every phase names the exact repo, file and licence. Put
  the attribution at the top of the ported file, as `AGENTS.md` requires.
- **`ref/` is read only.** Never import from it. Copy into `src/` with attribution.
- **React Compiler is on.** No `useMemo`, `useCallback`, `React.memo` anywhere.
- **The store lives outside React.** Every edit is `store.begin(mergeKey)` then
  `store.commit()`. Every new operation in this plan is a pure `doc -> doc` function
  in `src/editor/model/`, called from a transaction, exactly like `rig.ts` today.
- **Paths are immutable.** Editing mints a new `PathId`.
- **Mom test.** Every control in this plan has a plain language label and a default
  that is correct for someone who has never rigged anything. The label column is not
  decoration; it is the acceptance criterion.
- **Time is integer frames.** Nothing here introduces float seconds.
- **Every feature gets an agent tool.** `src/editor/agent-tools.ts` already exposes the
  editor as ~33 callable tools that go through the same store transactions the panels
  do. A phase is not done until its new operations are in there, named in the same
  plain vocabulary as the UI labels below. That surface is how a rig gets built from a
  prompt, which is the fastest version of "build cool mascots faster".

## The labels, in one place

If a control's label needs a sentence of explanation, it is the wrong control.

| The industry calls it | riff calls it | Default |
|---|---|---|
| Bone role / bone name convention | Part is a | Auto-guessed from the template |
| Inverse kinematics chain | Grab handle (on the hand and the foot) | On for arms and legs of a template body |
| IK bend direction | Elbow bends this way / Knee bends this way | Whatever the template says |
| Skinned mesh deformation | Smooth bend | Off |
| Joint overlap | Tuck under | 2 |
| Draw order offset | In front / behind | 0 |
| Skew | Slant | 0 |
| Secondary motion spring | Floppy | Off |
| Spring stiffness | Looseness | 0.5 |
| Spring damping | Bounce | 0.3 |
| Parameter with keypoints | Turn (or a custom slider the user names) | None |
| Parameter binding | "riff remembered this pose at this slider position" | n/a |
| Pose | Pose | n/a |
| Animation / action | Action | "Idle" |
| Motion preset retargeting | Add motion | n/a |
| Onion skin | Show the pose before and after | Off |
| Auto blink | Blink on its own | On once a blink drawing exists |
| Look at constraint | Watch the dot | Off |
| Stroke streamline | Steady hand | 0.5 |
| Douglas Peucker plus smoothing | Tidy | 0.3 |
| Image trace | Turn a picture into shapes | n/a |
| Runtime JSON export | Export for the app | n/a |

---

# Phase 1: Roles, a body to start from, and flip

**Why first.** Everything downstream joins on a part's role: presets retarget by it,
IK chains are auto built from it, mirroring pairs by it, flip swaps by it, and the
runtime export names by it. And a template body removes the blank canvas, which is
where most first attempts die.

## Features

- A `role` on every part, with a picker in the inspector.
- Three template bodies the user can start from: **Simple body** (head, torso, two
  arms, two legs), **Blob** (head, body, two arms, no legs), **Critter** (head, body,
  four legs, tail). Ship Simple body first; the other two are data, not code.
- **Flip the character**: negate root scaleX and swap every left/right role pairing so
  draw order and part names stay honest.
- **Mirror to the other side** already exists (`duplicateParts` with a `mirrorAxis`);
  make it set the mirrored side tag automatically.

## Port

| What | From | Path | Licence |
|---|---|---|---|
| Nothing to port. This is riff-native data. | | | |

Read `ref/skel2d/README.md` sections "Defining a skeleton hierarchy" and "Bone
properties" for the naming conventions, and
`the app repo/references/rig-research/README.md` for the parts sheet.

## Model changes

```ts
// src/editor/model/roles.ts (new)

/**
 * What a part is, structurally. The join key for presets, IK, mirroring, flip and
 * export. `none` is always allowed: a rig that does not fit the list still works,
 * it just gets no automatic help.
 */
export type PartRole =
  | "none"
  | "root" | "hips" | "torso" | "chest" | "neck" | "head"
  | "armUpper" | "armLower" | "hand"
  | "legUpper" | "legLower" | "foot"
  | "eyes" | "brows" | "mouth" | "ear" | "tail" | "hair"
  | "cosmetic";

/** Which copy of a paired role this is. */
export type Side = "center" | "left" | "right";

export interface RoleTag {
  role: PartRole;
  side: Side;
}

export const ROLE_LABELS: Record<PartRole, string>; // "Upper arm", "Hand", ...

/** Pairs a role tag with its opposite. Used by flip and by pose mirroring. */
export function oppositeSide(side: Side): Side;

/** Best guess from a part's name, so imported and hand built rigs get help too. */
export function guessRole(name: string): RoleTag;
```

```ts
// src/editor/model/document.ts (added to PartLayer)

export interface PartLayer {
  // ... existing fields unchanged ...

  /**
   * What this part is. Purely advisory: nothing breaks when it is `none`, and
   * everything automatic (presets, IK, flip, mirror) keys off it.
   */
  role: PartRole;
  side: Side;
}
```

```ts
// src/editor/model/templates.ts (new)

export interface RigTemplate {
  id: string;
  name: string;          // "Simple body"
  hint: string;          // "Head, body, two arms, two legs."
  /** Builds a complete document, art included, ready to redraw over. */
  build(width: number, height: number, fps: number): RiffDocument;
}

export const RIG_TEMPLATES: RigTemplate[];
```

```ts
// src/editor/model/rig.ts (added)

/** Mirror the whole rig left to right. Pure doc -> doc, like everything here. */
export function flipCharacter(doc: RiffDocument): RiffDocument;
```

## UI

- **Empty state** (`ArtboardEmptyState.tsx`): three big cards, "Simple body", "Blob",
  "Critter", plus "Start empty" and "Open a picture". Picking one builds the document.
- **Inspector**, a new row inside the existing "Attach to" section: a dropdown
  labelled **"Part is a"** with the role list and a left/right/centre segmented
  control next to it. Shows the guessed value with a faint "guessed" hint until the
  user confirms or changes it.
- **Toolbar**: a **Flip** button next to undo/redo.
- **Layers panel**: role shown as a faint suffix on the row, right aligned, so a user
  can see at a glance that the rig is tagged.

## Verify in the browser

1. `bun run dev`, open the editor with an empty autosave. The three body cards show.
2. Click **Simple body**. Fourteen named parts appear in Layers, the skeleton is
   correct (drag the torso, everything follows; drag the forearm, only the hand
   follows), and the inspector shows a role for each.
3. Click **Flip**. The character faces the other way, left arm is still called left
   arm, and the arm that was in front is still in front.
4. Undo once. The flip reverses in one step.
5. Rename a part to "left hand" on an untagged rig and confirm the role guess fires.

---

# Phase 2: Turn a picture into shapes

**Why second.** The fastest route to a good looking mascot is a drawing the user
already made. This is the on ramp for everyone who cannot draw with a mouse.

## Features

- Drop a PNG, JPG or SVG on the canvas.
- SVG: parse straight into paths (riff already has `parsePathData`).
- Raster: trace in a Web Worker, produce one part per colour region, preview before
  committing.
- One slider, **"How much detail"**, with three stops (Bold, Normal, Detailed) that
  drive the trace parameters behind the scenes.
- **"Split into parts"**: after tracing, each disconnected region becomes its own part,
  named by size and position ("Part 1" ... ), so the user can rename and parent them.

## Port

| What | From | Path | Licence |
|---|---|---|---|
| Colour quantise, edge trace, path fit | `ref/imagetracerjs` | `imagetracer_v1.2.6.js`: `colorquantization`, `layering`, `pathscan` (boundary walk), `pointinpoly` plus `boundingboxincludes` (hole nesting), `internodes`, `tracepath` / `fitseq` | Unlicense (public domain only; the "dual MIT" claim is false and irrelevant, since public domain is strictly better) |
| Polyline to cubic beziers, the step between the tracer and riff's `PathGeometry` | `soswow/fit-curve` | `fitCurve(points, maxError)`, Schneider's Graphics Gems algorithm, ~300 lines | MIT |
| Contour simplification after trace | already in `src/editor/model/polyline.ts` | `simplifyContour`, `smoothContour` | riff |
| Upgrade path when trace quality is the complaint | `ref/vtracer` | The browser build is the `webapp/` crate (`wasm-pack build --target web`); the npm package is a Node build. **Pass `hierarchical: 'cutout'` or you get no holes**, because the default stacking strategy deliberately avoids them. | MIT OR Apache-2.0 (dual) |

**Pipeline:** threshold, `pathscan` plus `pointinpoly` for contours with nested holes,
`simplifyContour`, `fitCurve` for cubics, then boolean ops to cut into parts.

Do **not** link potrace in any form. It, and every JS, wasm, Python and Go port of it,
is GPL-2.0-or-later. Peter Selinger sells a proprietary build, which is exactly why no
port has ever been relicensed. Also avoid the `marchingsquares` npm package: it is
AGPL-3.0 and looks like an innocuous contour helper.

## Model changes

None to the document. New module only:

```ts
// src/editor/io/trace.ts (new)

export interface TraceOptions {
  /** 3 presets exposed as "Bold" | "Normal" | "Detailed". */
  detail: "bold" | "normal" | "detailed";
  /** Number of colours to quantise to. Derived from `detail`, overridable. */
  colors: number;
  /** Drop regions smaller than this many pixels. Kills speckle. */
  minArea: number;
}

export interface TracedRegion {
  /** SVG path data in image pixel space. */
  d: string;
  fill: RGBA;
  bounds: [number, number, number, number];
  areaPx: number;
}

/** Runs in a worker. Never call on the main thread; a 2000px image blocks for seconds. */
export function traceImage(
  data: ImageData,
  options: TraceOptions,
): Promise<TracedRegion[]>;

/** Turn traced regions into parts on the active artboard, back to front by area. */
export function regionsToParts(
  doc: RiffDocument,
  regions: TracedRegion[],
  opts: { splitIntoParts: boolean; fitTo: [number, number, number, number] },
): RiffDocument;
```

## UI

- **Canvas drop target**: dropping an image opens a dialog (uses `--riff-shadow-pop`,
  `--riff-r-panel`, per the design lock).
- **Dialog**: the image on the left, the traced preview on the right, updating live.
  One segmented control, **"How much detail"**: Bold / Normal / Detailed, default
  Normal. One checkbox, **"Split into separate parts"**, default on. Primary button
  **"Add it"**.
- **Job tray** (already in the design lock) shows trace progress for large images.
- **Toolbar Import** menu gains "Open a picture".

## Verify in the browser

1. Drag a flat PNG mascot onto the canvas. The dialog opens, preview renders in under
   two seconds for a 1024px image.
2. Switch Bold / Normal / Detailed and watch the preview path count change.
3. Click **Add it**. Parts appear in Layers, named and stacked back to front, and the
   canvas matches the source picture at a glance.
4. Undo once, the whole import reverses in one step.
5. Drop an SVG. It imports without going near the tracer.

---

# Phase 3: Drawing that feels good

**Why third.** Drawing is the daily activity. The engines are already in `src/`; what
is missing is the feel and the toolbar.

## Features

- Pressure brush upgraded to perfect-freehand's outline maths.
- **"Steady hand"** slider (perfect-freehand's `streamline`).
- **"Tidy"** slider after a stroke (existing `simplifyContour` plus `smoothContour`
  behind one number).
- **Symmetry**: draw one eye, get both, mirrored across the part's vertical axis.
- **Merge** and **Punch a hole** in the toolbar, wired to the existing `clipPolygons`.

## Port

| What | From | Path | Licence |
|---|---|---|---|
| Stroke outline from pressure samples | `ref/perfect-freehand` | `packages/perfect-freehand/src/getStroke.ts`, `getStrokePoints.ts`, `getStrokeOutlinePoints.ts`, `getStrokeRadius.ts`, `vec.ts`, `constants.ts` | MIT |
| Pressure simulation when the device gives none | `ref/perfect-freehand` | `packages/perfect-freehand/src/simulatePressure.ts` | MIT |
| Only if riff's own `boolean.ts` proves insufficient for Merge and Punch a hole | `@velipso/polybool` | TypeScript, CCW exteriors and CW holes (which matches riff's `subpathClosed` model), and a `shape()` builder that speaks `moveTo` / `lineTo` / `bezierCurveTo` / `closePath` | **0BSD**, no attribution required |

Do not reach for `polygon-clipping`: it has been abandoned since 2024 with open
correctness bugs on self-intersecting input.

`getStrokePoints` already carries `streamline`, `size`, `thinning`, `smoothing`,
`easing`, `start`/`end` taper. That is every knob riff needs; expose two of them.

## Model changes

```ts
// src/editor/model/shapes.ts (replace the body of brushStroke)

export interface BrushOptions {
  /** Nominal width in document units. Already on the store as `brushWidth`. */
  size: number;
  /** 0 = raw pointer, 1 = very smoothed. Labelled "Steady hand". */
  streamline: number;
  /** How much pressure changes the width. 0 = uniform line. */
  thinning: number;
  /** Close the shape when the end lands near the start. Existing behaviour. */
  closeDistance: number;
}

/** Ported from perfect-freehand (MIT, Stephen Ruiz Ltd). */
export function brushStroke(
  samples: BrushSample[],
  options: BrushOptions,
): BrushResult;
```

```ts
// src/editor/store.ts (EditorUi additions)
  /** "Steady hand". 0..1. */
  brushStreamline: number;   // default 0.5
  /** Mirror strokes across the part's vertical axis while drawing. */
  symmetry: boolean;         // default false
```

## UI

- **Toolbar**: the brush tool's popover gains **Size**, **Steady hand**, and a
  **Symmetry** toggle showing a mirror glyph.
- **Inspector**, appears only right after a stroke, in a "Shape" section: a single
  **Tidy** slider, default 0.3, with the hint "Smooths out the wobbles."
- **Toolbar**, shown when two or more parts are selected: **Merge** and **Punch a
  hole**, both `--riff-r-btn` icon buttons with `aria-label`s.

## Verify in the browser

1. Draw a fast loop with a trackpad. With Steady hand at 0 it is jagged; at 1 it is a
   smooth arc. The line tapers where you moved fast.
2. On a pen tablet, pressure changes the width; on a mouse, `simulatePressure` still
   gives a lively line.
3. Turn Symmetry on, draw one eye, both appear.
4. Draw two overlapping blobs, select both, press Merge: one part with one outline.
5. Every one of the above undoes in a single step.

---

# Phase 4: Two bone IK, grab the hand

**Why fourth.** It is the single biggest posing speed up, and it is the feature a
beginner instantly understands: you drag the hand where you want it.

## Features

- A two bone IK chain per arm and per leg, created automatically from roles when a
  template body is used.
- A round handle on each hand and foot in the canvas. Drag it, the shoulder and elbow
  solve.
- **"Elbow bends this way"** toggle (the bend direction), default set by the template.
- **"Hold strength"** slider (the IK weight), default 1, animatable so an arm can
  hand off between IK and direct posing.
- Alt-drag the handle to flip the bend in place.

## Port

| What | From | Path | Licence |
|---|---|---|---|
| The two bone solver, verbatim maths. **Start here**: it is already TypeScript. | `ref/dragonbones-js` | `DragonBones/src/dragonBones/armature/Constraint.ts`, `IKConstraint._computeB` (two bone, ~90 lines) and `_computeA` (single bone aim) | MIT |
| Radian normalisation helper it depends on | `ref/dragonbones-js` | `DragonBones/src/dragonBones/geom/Transform.ts`, `Transform.normalizeRadian` | MIT |
| Constraint ordering and the "solve after tracks, before world matrices" shape | `ref/dragonbones-js` | `DragonBones/src/dragonBones/armature/Armature.ts` (`_sortBones`, the `_constraints` loop) | MIT |
| The richer solver, if softness, stretch or compress is ever wanted. Law of cosines in the parent's inverse world space, plus `invertDirection` and a strength blend. | `ref/rive-runtime` | `src/constraints/ik_constraint.cpp`, `solve1` / `solve2` / `constrainRotation` (301 lines, C++) | MIT |
| Dirty propagation and dependency ordering for constraints, which is cleaner than the DragonBones version | `ref/rive-runtime` | `src/constraints/ik_constraint.cpp`, `buildDependencies` / `constrain` | MIT |

`_computeB` is a closed form circle intersection, not an iterative solver. It handles
the unreachable and the degenerate cases already, which is where a hand written solver
goes wrong. Port it, do not reimplement it. The FABRIK and CCD libraries on GitHub are
all 3D or toys; there is nothing better to install.

## Model changes

This phase introduces the one structural change the rest of the plan stands on: a
**single evaluation pass** that resolves a frame into matrices, so constraints,
springs and parameters all have one place to live.

```ts
// src/editor/model/evaluate.ts (new)

/**
 * One frame of the rig, fully resolved.
 *
 * Today `worldMatrix` reads animatables directly and recurses. That works until
 * something has to run *between* reading the tracks and composing the matrices:
 * IK writes rotations, springs write rotations, parameters add offsets. All three
 * need the same seam, so there is one pass and everything hooks into it.
 */
export interface EvaluatedRig {
  frame: Frame;
  /** Post-constraint local transform scalars, keyed by layer. */
  locals: Map<LayerId, ResolvedTransform>;
  /** Part to document matrix. */
  worlds: Map<LayerId, Matrix>;
  /** Which parts had their rotation written by a constraint, for the inspector. */
  drivenRotation: Set<LayerId>;
}

export interface ResolvedTransform {
  x: number; y: number; rotation: number;
  scaleX: number; scaleY: number; skewX: number; skewY: number;
  opacity: number; depth: number; variantIndex: number;
}

export interface EvaluateOptions {
  /** Spring state carried between frames during playback. Absent while scrubbing. */
  springs?: SpringState;
  /** Live parameter values, before they are keyframed. */
  params?: Map<ParamId, number>;
  /** Canvas drag overrides, so a drag does not have to write the document per move. */
  overrides?: Map<LayerId, Partial<ResolvedTransform>>;
}

export function evaluateRig(
  doc: RiffDocument,
  frame: Frame,
  options?: EvaluateOptions,
): EvaluatedRig;
```

`render/scene.ts resolveScene` switches to consuming an `EvaluatedRig` instead of
calling `worldMatrix` itself. `rig.ts worldMatrix` stays for hit testing and the
inspector, delegating to the same pass.

```ts
// src/editor/model/ik.ts (new)

export type IkId = Id<"Ik">;

/**
 * A two bone chain. `root` is the upper bone (shoulder, hip), `mid` is the lower
 * bone (elbow, knee), `tip` is the part whose joint is the thing you grab.
 *
 * Bone length is not stored. It is the distance between consecutive joints in rest
 * space, computed on demand, because a stored length that can disagree with the rig
 * is a bug waiting for a user to move a joint.
 */
export interface IkChain {
  id: IkId;
  name: string;              // "Left arm"
  rootLayerId: LayerId;
  midLayerId: LayerId;
  tipLayerId: LayerId;
  /** Target in document space. Animatable, so the handle keyframes like anything. */
  targetX: AnimatableNumber;
  targetY: AnimatableNumber;
  /** "Elbow bends this way." */
  bendPositive: boolean;
  /** "Hold strength", 0..1. Animatable so IK can fade in and out. */
  weight: AnimatableNumber;
  enabled: boolean;
}

/**
 * Ported from DragonBones `IKConstraint._computeB` (MIT, DragonBones team).
 * Writes rotations into `locals`; nothing downstream knows IK happened.
 */
export function solveTwoBone(
  chain: IkChain,
  doc: RiffDocument,
  frame: Frame,
  locals: Map<LayerId, ResolvedTransform>,
  worlds: Map<LayerId, Matrix>,
): void;

/** Build chains for every arm and leg it can find from roles. Idempotent. */
export function autoIkChains(doc: RiffDocument): RiffDocument;
```

```ts
// src/editor/model/document.ts (added to RiffDocument)
  iks: Record<IkId, IkChain>;
  /** Solve order. A chain whose root hangs off another chain's tip solves second. */
  ikIds: IkId[];
```

## UI

- **Canvas**: a filled circle handle at each enabled chain's tip joint, in
  `--riff-accent`, 10px, drawn on top of everything. Cursor is a grab cursor. Dragging
  it runs one transaction with merge key `ik:<chainId>`.
- **Inspector**, a section titled **"Grab handle"**, shown when the selected part is a
  chain's root, mid or tip: an on/off switch **"Drag the hand to pose the arm"**, an
  **"Elbow bends this way"** two-way toggle with a small diagram, and a **"Hold
  strength"** scrub field.
- **Timeline**: the chain gets its own row under the tip part, with `Target X` and
  `Target Y` property rows, so `ANIMATABLE_PROPERTIES` in `timeline/rows.ts` gains a
  chain-aware branch.
- Auto-key: dragging the handle with auto-key armed writes target keys at the playhead.

## Verify in the browser

1. Start from **Simple body**. A handle sits on each hand and each foot.
2. Drag the left hand across the chest. The elbow bends, the shoulder rotates, the
   hand ends up under the pointer, and the upper arm never detaches from the torso.
3. Drag the hand far away, past the arm's reach. The arm straightens and points at the
   target instead of exploding or flipping.
4. Toggle **Elbow bends this way**. The elbow flips to the other side without the hand
   moving.
5. Set **Hold strength** to 0. The handle stops affecting the arm; the arm returns to
   its keyframed rotations.
6. Drag, then undo. One step.
7. Scrub the timeline with keys on Target X. The arm follows the handle's path.

---

# Phase 5: Poses, actions, onion skin

**Why fifth.** This is the house style made into a tool: six to ten strong poses,
held, per action.

## Features

- A **Poses** panel. **"Save this pose"** captures the current rig. Clicking a saved
  pose applies it at the playhead with **hold** easing, which is what gives the
  stepped look for free.
- **Mirror this pose** makes the opposite-side version.
- **Update** rewrites a saved pose from the current rig.
- Poses store a thumbnail rendered from the canvas, so the panel is a contact sheet.
- **Actions**: several named timelines in one document ("Idle", "Wave", "Celebrate").
- **Onion skin**: show the previous and next pose at low alpha.
- **Make it loop**: copies the first pose to the end.

## Port

| What | From | Path | Licence |
|---|---|---|---|
| The pose plus sequence-of-steps data shape, and `sampleAt` (angles interpolate, variants hold) | `the app repo/the single-file prototype` | `createCore`: `timeline`, `sampleAt`, `samplePose` | maintainer's own prototype |
| Named animations, timelines and easing vocabulary as a spec | `ref/skel2d` | `src/skel2d_core.js` (`Skel2DAnimation`, timeline classes), `README.md` "Animation" | **no LICENSE file: read only, do not copy code** |

The pose model below is riff-native. Nothing is copied from skel2d; it is read for its
vocabulary only, because the repo carries no licence (see `sources.md`).

## Model changes

```ts
// src/editor/model/pose.ts (new)

export type PoseId = Id<"Pose">;

/**
 * A saved pose: absolute property values for the parts the pose has an opinion about.
 *
 * Sparse on purpose. A pose that says "the arms are up" must not also silently reset
 * the head, or a user who saved a pose while the head happened to be turned gets a
 * pose that fights every other pose.
 */
export interface Pose {
  id: PoseId;
  name: string;
  /** `${layerId}:${property}` -> value. Property strings match `Track.property`. */
  values: Record<string, number>;
  /** Small PNG data URL rendered at save time. The panel is a contact sheet. */
  thumbnail: string | null;
}

/** Capture the parts in `layerIds` (or all of them) at `frame`. */
export function capturePose(
  doc: RiffDocument,
  frame: Frame,
  name: string,
  layerIds?: LayerId[],
): Pose;

/**
 * Write the pose as keyframes at `frame`.
 *
 * `hold` defaults to true, which is the whole point: the stepped look is not a render
 * setting, it is what happens when every keyframe holds until the next one.
 */
export function applyPose(
  doc: RiffDocument,
  pose: Pose,
  frame: Frame,
  opts?: { hold?: boolean; easing?: Easing },
): RiffDocument;

/** Swap left and right parts by role, negate the mirrored rotations and x offsets. */
export function mirrorPose(doc: RiffDocument, pose: Pose): Pose;
```

```ts
// src/editor/model/document.ts (added to RiffDocument)

export type ClipId = Id<"Clip">;

/** One named action. Several of them share one skeleton and one set of drawings. */
export interface Clip {
  id: ClipId;
  name: string;            // "Idle", "Wave"
  inFrame: Frame;
  outFrame: Frame;         // exclusive
  loop: boolean;
}

export interface RiffDocument {
  // ... existing ...
  poses: Record<PoseId, Pose>;
  poseIds: PoseId[];
  clips: Record<ClipId, Clip>;
  clipIds: ClipId[];
  activeClipId: ClipId;
}
```

`frameCount`, `loopIn` and `loopOut` become derived from the active clip. Bump
`DOCUMENT_VERSION` and migrate old files by wrapping their single range in one clip
named "Idle".

## UI

- **Poses panel**: a new panel, same white card treatment, docked under Layers, or a
  tab beside it if vertical space runs out. A grid of thumbnails at 64px, each with its
  name underneath. Top row: **"Save this pose"**. Right click or a hover menu on a
  thumbnail gives Rename, Update, Mirror, Delete.
- **Timeline transport**: an **Action** dropdown on the left of the transport showing
  the current clip name, plus "New action".
- **Toolbar**: an onion-skin toggle labelled **"Show the pose before and after"**.
- **Timeline overflow menu**: **"Make it loop"**.

## Verify in the browser

1. Pose the template body, click **Save this pose**, name it "Arms up". A thumbnail
   appears.
2. Move the playhead to frame 12, click the thumbnail. Keys appear on every posed
   property at frame 12, all with hold easing.
3. Play. The character snaps between poses with no in-betweens. That is correct.
4. Change one keyframe's easing to "ease" in the easing popover. That one transition
   smooths, the rest stay stepped.
5. Click **Mirror this pose**. A new pose appears; apply it, the arms are swapped.
6. Turn on onion skin, scrub. Faint copies of the neighbouring poses render behind.
7. Create a second action called "Wave". The timeline empties; switching back to
   "Idle" brings the first set of keys back.
8. Reload. Poses, thumbnails and both actions survive the autosave round trip.

---

# Phase 6: Export for the app

**Why sixth.** The loop has to close. Until a rig can run inside the React Native app,
every phase after this is speculative.

## Features

- **Export for the app**: one `.json` file for the Skia runtime, plus, on request, a
  reference player component to paste into the app.
- The existing HTML player is regenerated from the same evaluator so the two can never
  drift.
- **Export a GIF** for sharing.
- **Export a picture** (PNG of the current frame).

## Port

| What | From | Path | Licence |
|---|---|---|---|
| Nothing. The exporter is riff-native; the runtime is written against `@shopify/react-native-skia`. | | | |

## The contract

The React Native side does three things and no more: parse once, evaluate at a time
value, draw a flat list. Everything structural is resolved at export time.

```ts
// src/editor/export/runtime.ts (new)

/**
 * The file the React Native app loads.
 *
 * Flat number arrays rather than objects per keyframe, because the app parses this on
 * a cold start and object churn is the only part of this that is ever slow. Ids are
 * array indices, not strings, for the same reason.
 */
export interface RigRuntime {
  format: "riff-runtime";
  version: 1;
  fps: number;
  /** Artboard size in document units. The app scales this itself. */
  size: [number, number];

  /** SVG path data, indexed. `Skia.Path.MakeFromSVGString` eats these directly. */
  paths: string[];
  /** Data URLs or bundle-relative names for raster attachments. */
  images: string[];

  /**
   * Parts in **hierarchy** order: a part's parent always has a lower index, so the
   * app builds world matrices in one forward pass with no recursion and no sort.
   */
  parts: RuntimePart[];
  /**
   * Draw order, back to front, as indices into `parts`. **Not** the same list.
   *
   * This is the invariant riff's document model exists to protect: a back arm hangs
   * off the torso but draws behind it, so hierarchy order and draw order genuinely
   * disagree, and a format that ships one array meaning both cannot express a cutout
   * rig. Add each part's resolved `depth` to its position here at runtime.
   */
  drawOrder: number[];
  clips: RuntimeClip[];
  params: RuntimeParam[];

  /** The white sticker outline, applied as a first pass over every part. */
  halo: { width: number; color: string } | null;
}

export interface RuntimePart {
  name: string;
  role: string;
  /** Index into `parts`, or -1 for a root. Always less than this part's own index. */
  parent: number;
  pivot: [number, number];
  /** Rest transform: x, y, rotationDeg, scaleX, scaleY, skewXDeg, skewYDeg. */
  rest: [number, number, number, number, number, number, number];
  /** Rest opacity, rest depth. */
  restOpacity: number;
  restDepth: number;
  /** 0..3, the joint tuck. The runtime repeats the fill this far toward the parent. */
  overlap: number;
  variants: RuntimeVariant[];
  /** Index into `variants`, or -1. */
  blinkVariant: number;
  /** looseness, bounce, limitDeg, gravity. null when the part is not floppy. */
  spring: [number, number, number, number] | null;
}

export interface RuntimeVariant {
  /** Indices into `RigRuntime.paths`. */
  paths: number[];
  /** "#rrggbbaa" or null. */
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  fillRule: "nonzero" | "evenodd";
  /** Index into `RigRuntime.images`, or -1. */
  image: number;
  /**
   * Per-vertex bone weights for a smooth-bend part (phase 11). Absent means the
   * variant draws as a rigid cutout, which is the default and always will be.
   */
  skin?: RuntimeSkin;
}

export interface RuntimeSkin {
  /** Part indices this variant's vertices are weighted to. */
  bones: number[];
  /** Per vertex: [count, (boneSlot, weight, restX, restY) * count], flattened. */
  weights: number[];
  /** Triangle indices, only present for image-backed parts. */
  triangles?: number[];
}

export interface RuntimeClip {
  name: string;
  /** Length in frames. Time is frames everywhere, as in the editor. */
  frames: number;
  loop: boolean;
  tracks: RuntimeTrack[];
}

/** Property codes. Kept as numbers so the app does not string-compare per frame. */
export const enum RuntimeProp {
  X = 0, Y = 1, Rotation = 2, ScaleX = 3, ScaleY = 4,
  SkewX = 5, SkewY = 6, Opacity = 7, Depth = 8, Variant = 9,
}

export interface RuntimeTrack {
  /** Index into `RigRuntime.parts`. */
  part: number;
  prop: RuntimeProp;
  /**
   * Seven numbers per key: frame, value, easeX1, easeY1, easeX2, easeY2, hold.
   * Flat so the app can build one Float64Array and binary search it.
   */
  keys: number[];
}

export interface RuntimeParam {
  name: string;              // "Turn"
  keypoints: number[];
  defaultValue: number;
  bindings: RuntimeBinding[];
}

export interface RuntimeBinding {
  part: number;
  prop: RuntimeProp;
  /** One offset per keypoint, parallel to `RuntimeParam.keypoints`. */
  values: number[];
  /** Variant bindings step; transform bindings interpolate. */
  step: boolean;
}

export function exportRuntime(doc: RiffDocument): RigRuntime;
```

**What the app does with it**, in order, once per frame:

1. Binary search each track for the playhead frame, evaluate the cubic easing (the
   same closed form as `animation.ts easeFactor`, which is ~40 lines and ports as is).
2. Add each parameter's bindings as offsets, interpolating between keypoints.
3. Run the spring integrator for any part with `spring` set, using the parent's world
   matrix from the previous frame as the driver.
4. Compose local matrices with the same order as `composeLayerMatrix`.
5. Walk `parts` in index order (guaranteed parents first) multiplying into world
   matrices. One forward pass, no recursion.
6. Walk `drawOrder`, stable-sorted by each part's resolved `depth`, and draw: the halo
   pass first over every part, then per part the overlap fill copies, then the
   variant's paths.

`@shopify/react-native-skia` (MIT, npm 2.11.2) covers all of it. The primitives,
verified in its source:

| Need | Primitive |
|---|---|
| A part's outline | `Skia.Path.MakeFromSVGString(d)`, then `<Path>` or `canvas.drawPath` |
| The bone hierarchy | `<Group transform>` / `<Group matrix>` / `<Group origin>`, where `origin` is the pivot |
| Image-backed skinned parts (phase 11) | `<Vertices vertices textures indices mode>` with a sibling `<ImageShader>`, or imperative `canvas.drawVertices` |
| One draw call for many rigid parts, if profiling ever demands it | `<Atlas>` / `canvas.drawAtlas` with `Skia.RSXform` |

Two traps to write into the player component's comments:

- `<Vertices>` `blendMode` defaults to `dstOver` when `colors` is present and `srcOver`
  when it is absent. Omit `colors` for pure texturing.
- `RSXform` is rotate, scale and translate only. No skew, no non-uniform scale. riff's
  Slant and any squash and stretch **cannot** go through `<Atlas>`; use `Group matrix`.

One useful property of this choice: react-native-skia runs in the browser through
`canvaskit-wasm`, so the exported runtime and its player can be smoke tested on the web
before the app ever sees the file.

## UI

- **Toolbar**, the export button: a menu with **"Export for the app"**, **"Export a
  GIF"**, **"Export a picture"**, **"Export a web page"** (the existing player).
- **Export dialog** for the app export: shows the file size, the part count, the clip
  list, and a plain warning when the rig uses something the runtime cannot do yet.
- A **"Copy the player code"** button that puts a ready to paste `<RigPlayer />` React
  Native component on the clipboard.

## Verify in the browser

1. Export a posed rig. Open the JSON: `parts` are in draw order, every `parent` index
   is lower than its own index, and no track is empty.
2. Open the exported HTML player. Frame for frame it matches the editor; step both to
   frame 7 and compare.
3. Export a GIF of a 24 frame action and open it. It loops.
4. Export a rig with two actions. Both clips are present with the right frame counts.

---

# Phase 7: Motion presets

**Why seventh.** Now that a rig can be built and shipped, this is the feature that
makes the product feel like magic: click "Wave", the character waves.

## Features

- An **Add motion** menu with six hand authored presets: **Idle breathe**, **Wave**,
  **Nod yes**, **Shake no**, **Jump**, **Celebrate**.
- Presets retarget by part role, so one preset fits every rig that uses the template
  roles. A rig missing a part simply drops that track.
- Applying a preset creates a new action, or appends to the current one.
- **"Make it yours"**: after applying, every keyframe is a normal keyframe the user can
  drag.

## Port

| What | From | Path | Licence |
|---|---|---|---|
| Nothing. The presets are authored content, not code. | | | |
| Read for pose timing and the poses themselves | `the app repo/the single-file prototype` | the `sampleProject` poses and `anim` steps | maintainer's own prototype |

Author the presets **inside riff** once phase 5 exists, then serialise them. Writing
preset JSON by hand is how presets end up looking wrong.

## Model changes

```ts
// src/editor/model/presets.ts (new)

export interface PresetKey {
  /** Frame at 24 fps. Rescaled to the document's fps on apply. */
  frame: number;
  value: number;
  easing: keyof typeof EASING;
}

export interface PresetTrack {
  role: PartRole;
  side: Side;
  /** Matches `Track.property`, e.g. "transform.rotation". */
  property: string;
  /** Absolute values, so a preset does not depend on the rig's rest pose. */
  keys: PresetKey[];
}

export interface MotionPreset {
  id: string;
  name: string;       // "Wave"
  hint: string;       // "One arm goes up and waves twice."
  frames: number;     // at 24 fps
  loop: boolean;
  tracks: PresetTrack[];
  /** Roles the preset needs. Shown greyed out with a reason when absent. */
  requires: PartRole[];
}

export const MOTION_PRESETS: MotionPreset[];

export interface RetargetResult {
  doc: RiffDocument;
  /** Tracks that found no part. Shown as "riff skipped the tail; this rig has none." */
  skipped: PresetTrack[];
}

export function applyPreset(
  doc: RiffDocument,
  preset: MotionPreset,
  opts: { clipId: ClipId; startFrame: Frame },
): RetargetResult;
```

## UI

- **Toolbar**: an **Add motion** button (not buried in a menu; this is the headline
  feature). Opens a popover listing the six presets, each with its name, its hint, and
  a tiny looping preview rendered from the user's own rig on hover.
- Presets that cannot apply are shown at `opacity: .3` with the reason underneath.
- After applying, a toast: "Added Wave. Every keyframe is yours to move."

## Verify in the browser

1. Start from **Simple body**, click **Add motion**, hover **Wave**: the preview shows
   the user's rig waving.
2. Apply it. The timeline fills with keys on the arm roles only. Play; it waves.
3. Apply **Wave** to a **Blob** rig with no legs. It still works; the toast names what
   was skipped.
4. Drag one of the applied keyframes. The wave changes. Nothing is locked.
5. Apply **Idle breathe** on top in the same action. Both play together (breathe keys
   the torso scale, wave keys the arm rotation, they do not collide).

---

# Phase 8: Alive for free

**Why eighth.** Springs, blinking and a look at target are the highest ratio of
perceived life to user effort anywhere in this plan, and every one of them is a single
toggle.

## Features

- **Floppy**: turn it on for an ear, a tail, a ponytail or a scarf. It lags behind the
  parent, overshoots and settles, with no keyframes at all.
- Two sliders only: **Looseness** and **Bounce**, both 0 to 1.
- **Blink on its own**: on by default the moment a part has a blink drawing.
- **Watch the dot**: drag a dot on the canvas, the eyes follow it. Off by default.
- **Breathing**: a subtle torso scale, available as a checkbox on the root, because it
  is the one bit of idle life every mascot needs.

## Port

| What | From | Path | Licence |
|---|---|---|---|
| Rigid pendulum and spring pendulum models, RK4 integrator, the angle damping and limit handling | `ref/inochi2d` | `source/inochi2d/nodes/legacy/simplephysics.d` (`Pendulum`, `SpringPendulum`), `source/inochi2d/core/phys/system.d` (`PhysicsSystem`, the `tick`/RK4 helper) | BSD-2-Clause |
| The blink timing (120 ms blink every 3 to 5 seconds, irregular) | `the app repo/the single-file prototype` | `createCore.idle` | maintainer's own prototype |

The Inochi2D physics is D, so this is a port of the maths rather than a copy of the
text. The licence permits it; keep the attribution comment anyway. A fixed step RK4 at
the document's fps is enough; do not build a variable step integrator.

## Model changes

```ts
// src/editor/model/spring.ts (new)

/**
 * Secondary motion on one part. Two sliders and two guard rails, nothing else.
 *
 * Deliberately not a general physics system. A user who wants a cloth simulation is
 * not the user this product is for, and every extra knob here is a knob someone has
 * to be taught.
 */
export interface Spring {
  /** 0 stiff, 1 loose. Drives the pendulum's frequency. */
  looseness: number;
  /** 0 stops dead, 1 wobbles for a long time. Drives the damping. */
  bounce: number;
  /** Degrees the part may swing away from its posed angle. The guard rail. */
  limitDeg: number;
  /** How hard the part hangs down when the character is still. 0 to 1. */
  gravity: number;
}

/** Per-part integrator state, carried between frames. Never saved. */
export interface SpringState {
  /** layerId -> [angle, angularVelocity] in radians. */
  angles: Map<LayerId, [number, number]>;
  lastFrame: Frame;
}

/**
 * Ported from Inochi2D `SpringPendulum` (BSD-2, Inochi2D Project).
 *
 * Advances one part by one frame. The driver is the parent's world position, so the
 * spring responds to the whole chain above it for free.
 */
export function stepSpring(
  spring: Spring,
  state: [number, number],
  parentWorld: Matrix,
  previousParentWorld: Matrix,
  restAngleRad: number,
  dt: number,
): [number, number];
```

```ts
// src/editor/model/document.ts (added to PartLayer)
  /** null means rigid, which is the default and the common case. */
  spring: Spring | null;
  /** Automatic blinking, once `blinkVariant` is set. */
  autoBlink: boolean;
  /** This part's rotation tracks the look-at dot. Eyes and heads only. */
  lookAt: { weight: number; maxDeg: number } | null;
```

```ts
// src/editor/model/document.ts (added to Artboard)
  /** The dot the eyes watch, in document space. Animatable, so it keyframes. */
  lookTarget: { x: AnimatableNumber; y: AnimatableNumber; visible: boolean } | null;
```

Springs and look-at both run inside `evaluateRig` (phase 4), after IK, before world
matrix composition. During scrubbing, springs are evaluated by running the integrator
forward from the clip start rather than by carrying live state, so scrubbing is
deterministic and matches playback.

## UI

- **Inspector**, a section titled **"Floppy"**, one switch: **"Let this part swing on
  its own"**. Turning it on reveals **Looseness** and **Bounce** sliders and a faint
  hint: "Good for ears, hair, tails and scarves."
- **Inspector**, inside the existing variants section, a checkbox **"Blink on its
  own"**, shown only once a variant is marked as the blink drawing.
- **Inspector**, on eye and head parts: **"Watch the dot"** switch. Turning it on puts
  a draggable dot on the canvas.
- **Transport**: playback is required to see springs, so add a small hint next to the
  play button the first time a Floppy part exists: "Press play to see it swing."

## Verify in the browser

1. Turn **Floppy** on for an ear. Play the **Wave** preset. The ear lags the head,
   overshoots on the stop, and settles. It never spins, and it never leaves the head.
2. Set Looseness to 1 and Bounce to 1. It wobbles a lot but still stays inside the
   limit.
3. Set Looseness to 0. It is rigid again.
4. Scrub the playhead backwards and forwards across the same frame twice. The ear is in
   the same place both times.
5. Mark an eye variant as the blink drawing. The character blinks during playback,
   irregularly, roughly every three to five seconds.
6. Turn on **Watch the dot**, drag the dot around the canvas. The eyes follow, and they
   stop at the limit rather than rolling into the head.
7. Export for the app. The `spring` field is present with four numbers.

---

# Phase 9: Turn

**Why ninth.** This is the feature that makes a flat mascot read as a character. It
comes after springs because it is the most model-heavy phase left, and because it is
authored as drawings, which the maintainer is already good at.

## Features

- A **Turn** slider, from facing left through front to facing right.
- Set the slider to a position, then pose the head and swap drawings. riff remembers
  that as a keypoint.
- Between keypoints, transforms interpolate (that is the parallax) and variants step
  (that is the drawing swap).
- The slider is animatable, so a turn is a keyframe like anything else.
- The same machinery, with a second axis, becomes "look up and down" later. Ship one
  axis first.

## Port

| What | From | Path | Licence |
|---|---|---|---|
| The parameter, keypoint and typed binding design | `ref/inochi2d` | `source/inochi2d/param/package.d`, `param/parameters/param1d.d`, `param/parameters/param2d.d`, `param/bindings/package.d`, `param/bindings/property.d`, `param/utils.d` (`interpolateKeypoint`) | BSD-2-Clause |

Read Live2D Cubism's parameter docs and Moho's Smart Bone docs as background. Neither
is portable; Inochi2D is, and its design is the same idea with a cleaner data model.

Three facts from those tools that this phase is built on:

- **Character Animator's Head and Body Turner steps between views, it does not cross
  fade**, and its entire control surface is three parameters. The professional tool
  aimed squarely at non-animators arrived at the stepped answer independently. Its
  cost, which riff avoids, is that every view needs a duplicate eye and mouth sub-rig;
  in riff the eyes stay one part and only their drawing and offsets change.
- **Moho's Smart Bone dial is a second time axis**: `[Min, Max]` degrees map linearly
  onto `[1, Duration]` frames of a named action, and the live bone angle scrubs it.
  riff hides the action: instead of asking the user to author one, it records what
  changed at the nearest keypoint. That is the one place riff should be simpler than
  Moho rather than equivalent.
- **Live2D interpolates linearly along one axis and bilinearly across a 2D grid** (3x3
  being the common authoring case). Build the one axis version so the second axis is a
  data change, not a rewrite.

## Model changes

```ts
// src/editor/model/parameter.ts (new)

export type ParamId = Id<"Param">;
export type BindingId = Id<"Binding">;

/**
 * A named slider that drives many properties at once.
 *
 * Deliberately one axis. A 2D grid is the obvious generalisation and Inochi2D has it,
 * but a grid of keypoints is the point where this feature stops being a slider and
 * starts being a tool. Add the second axis only when a user asks for it by name.
 */
export interface Parameter {
  id: ParamId;
  name: string;              // "Turn"
  /**
   * Positions along the axis, ascending, **in degrees**.
   *
   * Degrees rather than a normalised -1 to 1 because a user can reason about 30
   * degrees and cannot reason about 0.7. Live2D has shipped -30 to 30 for
   * `ParamAngleX` for a decade and -10 to 10 for body angle; use those defaults.
   * A turn slider starts with three keypoints at -30, 0 and 30.
   */
  keypoints: number[];
  /** Current value. Animatable, so a turn keyframes like any other property. */
  value: AnimatableNumber;
  defaultValue: number;
  /** Labels the two ends, so the slider reads "Facing left ... Facing right". */
  minLabel: string;
  maxLabel: string;
  /**
   * Suggested name per keypoint, borrowed from Character Animator's tags:
   * Left Profile, Left Quarter, Frontal, Right Quarter, Right Profile.
   */
  keypointLabels: string[];
}

export type BindingProperty =
  | "transform.x" | "transform.y" | "transform.rotation"
  | "transform.scaleX" | "transform.scaleY"
  | "transform.skewX" | "transform.skewY"
  | "opacity" | "depth" | "variant";

/**
 * "At keypoint k, this part's property moves by this much."
 *
 * Offsets, not absolutes. The pose keyframes set the base and the parameter adds on
 * top, so a head that is turned and nodding does both, rather than the turn wiping
 * out the nod. `variant` is the exception: an index is not a thing you add, so
 * variant bindings are absolute and always step.
 */
export interface Binding {
  id: BindingId;
  paramId: ParamId;
  layerId: LayerId;
  property: BindingProperty;
  /** One entry per keypoint of the parameter. Parallel array, same length. */
  values: number[];
  /** True for `variant`, false for everything else. */
  step: boolean;
}

/** Linear between the bracketing keypoints; hold at the ends. */
export function sampleBinding(
  binding: Binding,
  parameter: Parameter,
  value: number,
): number;

/**
 * Record whatever the user just changed as a binding at the nearest keypoint.
 *
 * This is the whole interaction: move the slider, change the rig, riff writes the
 * binding. There is no "add binding" button and there must never be one.
 */
export function rememberAtKeypoint(
  doc: RiffDocument,
  paramId: ParamId,
  keypointIndex: number,
  changed: Map<LayerId, Partial<ResolvedTransform>>,
): RiffDocument;
```

```ts
// src/editor/model/document.ts (added to RiffDocument)
  params: Record<ParamId, Parameter>;
  paramIds: ParamId[];
  bindings: Record<BindingId, Binding>;
```

Parameters are applied inside `evaluateRig` after track evaluation and before IK, so a
turned head still solves its IK chains correctly.

## UI

- **Inspector**, an artboard-level section titled **"Sliders"**, with **"Add a
  slider"** and a suggestion chip: **"Turn (face left and right)"**, which creates the
  parameter pre-named with three keypoints at -1, 0 and 1.
- Each slider renders as a labelled track with a dot at each keypoint. Dragging the
  handle snaps to a keypoint on release unless the user holds a modifier.
- A recording indicator: when the handle is on a keypoint and the user changes the rig,
  a small `--riff-accent` dot appears with the text **"Remembered."**
- **"Add a position"** adds a keypoint at the handle's current value.
- **Timeline**: the parameter appears as its own property row, so the turn keyframes.
- **Layers panel**: a part with any binding gets a small slider glyph.

## Verify in the browser

1. Add a **Turn** slider. The handle sits at 0 and nothing changes.
2. Drag the handle to -1. Rotate the head slightly, slant it, nudge the eyes 8px left,
   and swap the face to the "three quarter left" variant. "Remembered." appears.
3. Drag the handle back to 0. Everything returns. Drag to -1. The three quarter pose
   comes back.
4. Drag slowly from 0 to -1. The eyes slide (parallax) and the face drawing snaps at
   the halfway point (stepped). That combination is the whole trick.
5. Keyframe the slider at frame 0 and frame 12 and play. The head turns over time.
6. Apply **Nod yes** while the turn is at -1. The head nods while still facing left.
7. Export for the app. `params` and `bindings` are present; the HTML player reproduces
   the turn.

---

# Phase 10: Cosmetics and a crew

**Why tenth.** Explicitly in the project's direction, and it is what turns one mascot
into a product's worth of characters.

## Features

- **Cosmetic slots**: a part can be declared a slot ("Hat", "Outfit", "Prop"), and its
  variants are the things that go in it.
- A **Dress up** panel: one row per slot, a horizontal strip of variant thumbnails,
  click to wear.
- **"Make another one"**: duplicate the whole character into a new artboard, then
  recolour with one palette control.
- **Palette**: name the colours a rig uses; changing one recolours every part that uses
  it.

## Port

| What | From | Path | Licence |
|---|---|---|---|
| Skins and skin placeholders as a design reference | `ref/skel2d` | `src/skel2d_core.js` skin handling, `README.md` "Skins" | **no LICENSE file: read only** |
| Existing duplication machinery | `src/editor/model/rig.ts` | `duplicateParts`, `DuplicateResult` | riff |

## Model changes

```ts
// src/editor/model/document.ts (added to PartLayer)
  /**
   * When set, this part is a cosmetic slot and its variants are the options.
   *
   * A slot is not a new layer kind. It is a label on a part, because a hat is a part
   * with hat drawings in it, and inventing a second kind of layer for that is how an
   * editor ends up with "this action is not available for a slot".
   */
  slot: { label: string; allowEmpty: boolean } | null;
```

```ts
// src/editor/model/palette.ts (new)

export interface PaletteEntry {
  id: string;
  name: string;     // "Fur", "Shirt", "Skin"
  color: RGBA;
}

/** Variant fills and strokes may point at a palette entry instead of a literal. */
export type ColorRef = { kind: "literal"; color: RGBA } | { kind: "palette"; id: string };

export function recolour(doc: RiffDocument, entryId: string, next: RGBA): RiffDocument;

/** Copy every part, path, pose, clip, parameter and binding onto a new artboard. */
export function duplicateCharacter(doc: RiffDocument, name: string): RiffDocument;
```

`Variant.fill` and `Variant.stroke` change from `RGBA | null` to `ColorRef | null`.
Bump `DOCUMENT_VERSION` and migrate every existing literal in place.

## UI

- **Inspector**, a section on any part: **"This part is a dress-up slot"** switch, with
  a name field and an **"Allow nothing"** checkbox.
- **Dress up panel**: sits where the Poses panel does, as a second tab. One row per
  slot, thumbnails at 48px, the current choice ringed in `--riff-accent`.
- **Inspector**, artboard level, a **Colours** section: named swatches. Clicking one
  opens the picker; changing it recolours everything using it, live, in one
  transaction.
- **Toolbar**: **"Make another one"** in the document menu.

## Verify in the browser

1. Mark a part as a slot named "Hat", give it three hat drawings plus an empty variant.
   The Dress up panel shows four thumbnails.
2. Click through them. The hat changes, and nothing else moves.
3. Save a pose while wearing hat 2, apply it while wearing hat 3. The hat does not
   change, because the pose does not have an opinion about the slot unless the user
   captured it.
4. Name a colour "Fur", assign it to five parts, change it. All five update in one
   undo step.
5. **Make another one**, recolour the copy, rename it. Both characters play their own
   actions in their own artboards.
6. Export both. Two runtime files, each self contained.

---

# Phase 11: Smooth bend

**Why last.** It is the only feature here that changes how art is stored, it is
strictly an upgrade on something that already works (`overlap`), and it must stay
optional forever. Cutout is the default. This is the per-chain escape hatch for an arm
whose outline visibly breaks at 90 degrees.

## Features

- A per-part switch: **"Smooth bend"**. On means the part's outline bends with the
  joint instead of pivoting rigidly.
- Weights are generated automatically from distance to the bone segments. There is no
  weight painting UI in this phase and probably ever.
- **"Bend zone"** slider: how far the blend reaches either side of the joint. One
  number, default good.

## The key simplification

riff's art is vector, not texture. That means smooth bend does **not** need
triangulation for the common case: transform the path's control points and tangents by
the same weighted matrix blend, then rebuild the `Path2D`. Triangulation is only
required for raster attachments, where the pixels between the vertices have to go
somewhere.

So:

| Part backing | Skinning method | Needs earcut |
|---|---|---|
| Vector paths (the default, and what a drawn or traced part is) | Weighted blend of bone matrices applied per control point and per tangent | No |
| Imported image | Triangulate, then `drawVertices` with the image as a shader | Yes |

Ship the vector path first. The image path can wait until someone imports a photo of an
arm and complains.

This is not a riff invention: Rive's runtime does exactly this. `CubicWeight` gives a
bezier vertex's in and out tangents their own weights, and `src/shapes/cubic_vertex.cpp`
applies them. The design is proven and the code is MIT.

It also happens to be the reason riff can stay on Canvas2D. Canvas2D has no
textured-triangle primitive, which is why DragonBones never shipped a Canvas2D backend
for meshes and why no library on GitHub fills the gap. Skinning control points sidesteps
the problem entirely. If the image-backed case ever becomes important, the answer is to
move the canvas to CanvasKit (react-native-skia already runs on web through
`canvaskit-wasm`, so the editor and the app would render bit for bit), **not** to write
a Canvas2D triangle rasteriser.

## Port

| What | From | Path | Licence |
|---|---|---|---|
| **The skinning kernel.** Up to four influences per vertex, weighted sum of bone matrices, 25 lines. | `ref/rive-runtime` | `src/bones/weight.cpp`, `Weight::deform` | MIT |
| **Skinning the in and out tangents of a bezier control point.** This is the file that makes the whole vector path above work, and riff's `PathGeometry` already stores `vertices`, `tangentsIn` and `tangentsOut` as exactly the parallel arrays it wants. | `ref/rive-runtime` | `include/rive/bones/cubic_weight.hpp`, applied in `src/shapes/cubic_vertex.cpp` | MIT |
| Bone palette: `boneTransforms[i] = bone.worldTransform * tendon.inverseBind` | `ref/rive-runtime` | `src/bones/skin.cpp`, `src/bones/tendon.cpp` | MIT |
| The same skinning loop in TypeScript, if translating C++ is not worth it | `ref/dragonbones-js` | `Pixi/8.x/src/dragonBones/pixi/PixiSlot.ts`, `_updateMesh`, the `weightData !== null` branch | MIT |
| The weight data layout (bone count per vertex, then bone index, weight, rest x, rest y) | `ref/dragonbones-js` | `DragonBones/src/dragonBones/model/DisplayData.ts` (`WeightData`, `GeometryData`) | MIT |
| Triangulation, for the image-backed case only | `ref/earcut` plus `delaunator` and `Constrainautor` | See the note below: earcut alone is the wrong tool for skinning | ISC |
| Free form deformer as a design reference, if bend-zone tuning turns out not to be enough | `ref/inochi2d` | `source/inochi2d/nodes/deformer/meshdeformer.d`, `latticedeformer.d`, `source/inochi2d/core/math/deform.d` | BSD-2-Clause |

**On triangulation.** Earcut is a fill triangulator: ear clipping adds no interior
vertices and produces slivers at thin spots, which is exactly what a skinned limb
cannot have. For the image-backed case, seed interior points, run **Delaunator plus
Constrainautor** (both ISC) with the outline and hole rings as constraint edges, then
drop triangles whose centroid falls outside the outline or inside a hole. Keep earcut
for ordinary fills.

**On automatic weights.** There is no permissively licensed bounded-biharmonic-weights
implementation in existence; libigl's is MPL-2.0 file-level copyleft. Distance falloff
written from scratch is what the DragonBones and Spine editors actually ship, and for a
two bone limb it is sufficient. That is what `autoWeights` below does.

## Model changes

```ts
// src/editor/model/skin.ts (new)

/**
 * Per-vertex bone weights for one variant.
 *
 * Stored on the variant, not the part, because a part's open hand and closed fist are
 * different geometries and each needs its own weights.
 */
export interface SkinWeights {
  /** Layer ids the weights refer to. Usually two: this part and its parent. */
  bones: LayerId[];
  /**
   * Parallel to the variant's flattened vertex list. For vertex i:
   * `boneCounts[i]` entries starting at `offsets[i]` in the three packed arrays.
   */
  offsets: Uint32Array;
  boneCounts: Uint8Array;
  /** Index into `bones`. */
  boneIndices: Uint8Array;
  weights: Float64Array;
  /** Vertex position in that bone's rest space, interleaved x,y. */
  restPositions: Float64Array;
  /** Triangles, only for image-backed variants. */
  triangles?: Uint32Array;
}

// added to Variant
  /** null means rigid cutout, which is the default and always will be. */
  skin: SkinWeights | null;
```

```ts
// src/editor/model/skin.ts

/**
 * Generate weights from distance to the bone segments.
 *
 * Every vertex nearer the parent's joint than `zone` blends toward the parent; every
 * vertex past it blends toward this part; in between it is a smoothstep. This is not
 * how a professional tool does it (heat diffusion, bounded biharmonic) and it does not
 * need to be: a cutout limb is two bones and a tube.
 */
export function autoWeights(
  variant: Variant,
  doc: RiffDocument,
  layerId: LayerId,
  opts: { zone: number },
): SkinWeights;

/**
 * Ported from DragonBones `_updateMesh` (MIT, DragonBones team).
 * Returns a new PathGeometry with deformed vertices and tangents.
 */
export function deformPath(
  geometry: PathGeometry,
  skin: SkinWeights,
  worlds: Map<LayerId, Matrix>,
  inverseSelf: Matrix,
): PathGeometry;
```

Deformation happens in `evaluateRig` and the result is cached per (variant, frame) so
playback does not rebuild every path every frame. Invalidate on any transform change in
the variant's bone set.

## UI

- **Inspector**, a section titled **"Smooth bend"**: a single switch, **"Let the
  outline bend at this joint"**, default off, with a hint: "Slower, but no seam. Try it
  on an arm."
- Turning it on reveals one **Bend zone** scrub field with a sensible default computed
  from the part's size.
- Turning it on also sets `overlap` to 0 automatically, because the two solve the same
  problem and running both looks wrong. Show that in a toast: "Turned off Tuck under;
  Smooth bend handles the joint now."
- **Layers panel**: a faint glyph on a part with smooth bend on, so the performance
  cost is visible.

## Verify in the browser

1. Take a template arm, bend the elbow to 90 degrees with the IK handle. Note the seam.
2. Turn on **Smooth bend** for the forearm. The seam closes and the outline curves
   through the joint.
3. Bend to 150 degrees. The outline pinches but does not fold inside out.
4. Adjust **Bend zone**. A larger zone spreads the bend further up the arm.
5. Turn it off. The part returns to rigid, `overlap` comes back, nothing is lost.
6. Play a 48 frame action with four smooth-bend parts. Frame rate stays at 60.
7. Export for the app. The variant carries a `skin` block; the HTML player reproduces
   the bend.

---

## What is deliberately not in this plan

Written down so a later agent does not add them by accident. Each was rated in
`feature-gaps.md`.

Lattice deformers. Pose blending with weights. A graph editor. Motion paths. Transform
and path constraints. A general driver graph. Audio lip sync. A walk cycle generator.
Sprite sheet export. Rive export. Real time collaboration.

## Risks

| Risk | Where it bites | What to do |
|---|---|---|
| `evaluateRig` is introduced in phase 4 but four later phases depend on its shape | Phases 8, 9, 11 | Get the `EvaluateOptions` seam right in phase 4 even though only IK uses it then. |
| `DOCUMENT_VERSION` is bumped in phases 5 and 10 | Saved files | Write the migration in the same commit as the change; `io/project.ts` already has the pattern. |
| Springs must be deterministic under scrubbing | Phase 8 | Integrate forward from the clip start rather than carrying live state. Test it explicitly. |
| Smooth bend rebuilds paths per frame | Phase 11 | Cache per (variant, frame); measure before shipping. |
| The runtime contract is frozen at phase 6 but phases 8 to 11 add to it | The app | Version the runtime format from day one and have the app tolerate unknown fields. |
| Presets authored against the template roles break on hand built rigs | Phase 7 | `guessRole` from phase 1, plus the explicit "riff skipped these" report. |

# Feature gaps: riff as a 2D cutout character rig editor

Written 2026-09-15. Read `sources.md` for licences and `plan.md` for the build order.

## The goal this is rated against

> "Build cool mascots/characters faster, with animations. Easy to understand, dead
> simple, mom test."

Product motion style, from the project's direction:

- Low pose count, stepped. 6 to 10 strong poses per action, held, not blended.
- One viewing direction to start.
- Cosmetics are swappable attachments (hair, outfit, props).
- The character ships inside a React Native app, rendered by Skia from exported JSON.

Every rating below answers one question: does this make a non-animator produce a
better mascot in less time. A feature that a professional would call essential and
a beginner would call a wall is rated Later or Skip.

**Rating key**

| Rating | Means |
|---|---|
| Must | Without it the project's stated goal is not met. Ship in the first pass. |
| Should | Clear value, not load bearing. Ship once the Musts are green. |
| Later | Real feature, wrong audience or wrong time. Keep the model able to grow into it. |
| Skip | Costs more than it returns for this product. Do not build it. |

## What riff already has

Read before assuming a gap. The current `src/editor/model` is further along than a
blank slate, and several "missing" rig features are already representable.

| Capability | Where | Notes |
|---|---|---|
| Skeleton as a parent chain | `document.ts` `PartLayer.parentLayerId` | Flat table, cycle safe helpers in `rig.ts`. |
| Draw order independent of skeleton | `Artboard.layerIds` plus `PartLayer.depth` | `depth` is animatable, so draw order changes per pose are already possible. |
| Joint (pivot) separate from transform | `PartLayer.pivot` | `composeLayerMatrix` keeps artwork still when the joint moves. This is the hard part and it is done. |
| Slant (shear) per part | `TransformProps.skewX/skewY` | The cheap 2.5D lever. Already animatable. |
| Variants (drawing swaps) per part | `Variant[]` plus `PartLayer.variant` | This is Spine's skin placeholder and Toon Boom's drawing substitution, already in the model. |
| Blink variant | `PartLayer.blinkVariant` | Slot exists. Nothing drives it yet. |
| Joint seam hiding | `PartLayer.overlap` plus `scene.ts overlapShift` | The cutout answer to a bending elbow. Ported from the the prototype prototype. |
| Halo (sticker outline) | `Artboard.halo` | One pass over the whole rig. |
| Overlapping action | `PartLayer.timeOffset` | Per part time offset, the follow through cheat. |
| Keyframes, cubic easing, hold | `animation.ts` | Closed form cubic solve. Hold easing is what makes stepped poses possible. |
| Integer frame time | `Frame` everywhere | Right call for a stepped tool. |
| Path model with subpaths and pressure | `path.ts`, `PathGeometry` | Typed arrays, `d` cached for `new Path2D`. |
| Boolean ops | `boolean.ts` `clipPolygons` | Union, subtract, intersect on flattened contours. |
| Simplify and smooth | `polyline.ts` | Douglas Peucker plus Chaikin style smoothing. |
| Mirror a part | `rig.ts` `duplicateParts(doc, ids, { mirrorAxis })` plus `mirrorAxisFor` | Makes the other arm. |
| Duplicate a subtree | `rig.ts` `duplicateParts` | The basis of a crew of variants. |
| Web player export | `io/player.ts` `exportPlayerHtml` | Single file HTML. |
| Project JSON | `io/project.ts` `StoredProject` | Versioned, path arrays flattened. |

**What is genuinely absent:** inverse kinematics, mesh or weight deformation, any
free form deformer, a pose as a first class object, a pose library, motion presets,
onion skinning, secondary motion, drivers or parameters (so no head turn), auto
blink, look at, image trace import, a template body to start from, cosmetic slots as
a named concept, and any runtime export other than the HTML player.

---

## 1. Rig basics

| Feature | Rating | One line |
|---|---|---|
| Two bone IK (drag the hand, the elbow solves) | **Must** | A beginner can place a hand where they want it; they cannot guess two joint angles that put it there. |
| Bone weights and mesh deformation (skinned outline) | **Should** | The seamless elbow is a visible quality jump, but `overlap` already hides the seam, so this is an upgrade path, never the default. |
| Lattice deformer (free form grid) | **Later** | Powerful and unlearnable. A grid of 16 handles fails the mom test on sight. |
| Curve or bend deformer (tails, hair, antennae) | **Should** | One bend slider on a tail reads as squash and stretch and costs one control, unlike a lattice. |
| Pose blending (weighted mix of two poses) | **Later** | The house style is stepped. Blending is what the style deliberately refuses. |
| Pose library (named poses, click to apply) | **Must** | A pose is the unit of the project's workflow. Six to ten of them per action is literally the spec. |
| Pose mirroring (flip a pose to the other side) | **Must** | Halves the work on every walk, wave and reach. Cheap: negate the mirrored chain's rotations and swap left and right part ids. |
| Symmetry drawing (draw one eye, get two) | **Should** | Faces are where beginners lose the most time, and symmetry is one toggle. |
| Auto rig from a template skeleton | **Must** | "Start from a body" is the single biggest time saver and the most mom testable thing in the whole list. |
| Onion skinning (see the neighbouring poses) | **Should** | Pose to pose without onion skin is guesswork. Cheap to draw: the existing renderer at another frame with low alpha. |
| Ghosting (trail of recent frames during playback) | **Later** | Reads as a smear effect; useful for pros checking arcs, confusing for everyone else. |
| Secondary motion springs (ears, hair, tail follow through) | **Must** | The highest ratio of perceived life to user effort in the entire list. One toggle per floppy part, zero keyframes. |
| Smart bones / drivers (one slider drives many properties) | **Should** | Needed as the mechanism under head turn; not worth exposing as a general driver graph. |
| Look at constraint (eyes track a target) | **Should** | One dot to drag, the character follows it. Very high charm per line of code. |
| Follow / parent constraint at runtime | **Later** | Parenting already covers it; a separate constraint is a pro escape hatch. |
| Transform constraint (Spine style scaled copy of another bone) | **Skip** | Pure rigger tooling. No mascot author will find or use it. |
| Path constraint (bone follows a spline) | **Skip** | Belongs to motion graphics, not cutout character work. |
| Draw order changes per pose | **Must (already have it)** | `PartLayer.depth` is animatable. Needs UI, not model work: an arm crossing the body is the other half of fake 3D. |
| Physics collision (Character Animator "collide") | **Skip** | Tuning collision shapes is a second job. |

**Notes that matter for implementation**

- IK in a cutout rig needs a **bone length**, which riff does not store. The cheapest
  honest source is the distance from a part's joint to its child's joint, computed on
  demand. That avoids adding a redundant field that can disagree with the rig.
- Every serious tool makes IK a *constraint that writes rotations*, not a separate
  posing mode. DragonBones's `IKConstraint` (MIT) resolves target, root and bone into
  rotations on the existing bones, so the rest of the pipeline never learns about IK.
  Copy that shape: after evaluating tracks and before composing world matrices, run
  the constraint pass and overwrite the two rotations.
- Skinning is a per-vertex weighted sum of bone matrices. The riff path model is
  already flat `Float64Array` vertices, which is the right storage. What is missing is
  a triangulation (earcut, ISC) and a weight table.

---

## 2. Two and a half D, turning, and flipping

| Feature | Rating | One line |
|---|---|---|
| Angle slider driving per angle part swaps (head turn) | **Must** | The one feature that makes a flat mascot read as a character rather than a sticker, and it is authored as drawings, which is what the maintainer is good at. |
| Parallax offsets driven by the same angle | **Must** | Free with the slider: eyes and nose shift a few pixels against the head and the turn stops looking like a substitution. |
| Multi view (per angle drawings for the whole body) | **Should** | Same machinery as head turn with more keypoints. Ships later because it multiplies the drawing work. |
| Side view as a separate rig sharing one skeleton | **Later** | Two rigs in one document is a data model decision, not a feature; the angle parameter subsumes most of the need. |
| Flip whole character | **Must** | One button, negative scale on the root, plus a left/right part name swap so draw order stays sane. |
| Live2D style warp deformer for the head turn | **Skip** | Authoring a warp grid per keypoint is the exact opposite of dead simple. Swap drawings instead. |
| Rotation deformer / joint chains for hair | **Later** | The bend deformer above covers the same want with one control. |

**How the established tools do it, and which one to copy**

| Tool | Method | Verdict for riff |
|---|---|---|
| Adobe Character Animator, **Head and Body Turner** | Layers named Frontal, Left Quarter, Left Profile, Right Quarter, Right Profile (Upward and Downward tagged by hand) under a Head group. The behaviour **steps** discretely between views at yaw thresholds. It does not cross fade. Whole control surface: Camera Input, Controlled by, Sensitivity. | Closest to our audience and it already arrived at the stepped answer. Three parameters is the mom test standard to beat. **Its cost is the thing riff avoids:** every view group needs its own duplicate eye and mouth sub-rig. |
| Moho, Smart Bone dial | An action named after the bone; "Make Smart Bone Dial" maps the bone's `[Min, Max]` degrees linearly onto the action's `[1, Duration]` frames; the live bone angle scrubs that action. Two actions per bone maximum. | The cleanest mechanism: a driver is a second time axis and the angle is a playhead on it. riff should be *simpler*: record what changed at the nearest keypoint instead of asking the user to author an action. |
| Live2D Cubism, parameter binding | A parameter with keys; each key holds a **keyform**, a full snapshot of the bound geometry. Linear along one axis, bilinear across a 2D grid (3x3 is the common case). Standard ranges are degrees: `ParamAngleX/Y/Z` run -30 to 30, `ParamBodyAngleX/Y/Z` run -10 to 10. | The right data shape, and the right units: label the slider in degrees, not a normalised float. We store part transforms plus a variant index at each keypoint instead of a mesh. |
| Toon Boom, drawing substitution | The drawing exposed in a layer is itself keyframed | Already in riff as `PartLayer.variant`. |
| Inochi2D, `Parameter` with 1D and 2D keypoint grids and typed bindings | Parameter holds a grid of keypoints; each binding maps (parameter, node, property) to a value per keypoint; interpolation is per binding | **Copy this design.** It is BSD-2, the grid generalises from a turn slider to an X/Y look around with no model change, and the binding table is the same shape as riff's track table. |
| Rive, joysticks and solos | A solo shows exactly one of N children; a joystick is a 2D driver with a draggable puck | Solos are already riff's `variant`. The joystick is the 2D version of the same parameter. |

**Recommended riff shape:** a `Parameter` is a named driver with keypoints along one
axis (later two). A `Binding` says "at keypoint k, part P's property Q is V". The
existing `Animatable` union gains no new case: a parameter resolves to numbers, those
numbers feed the same compose step. In the UI it is a single slider labelled
**"Turn"** with a row of keypoint dots, and the instruction is "move the slider, then
pose the head; riff remembers".

---

## 3. Face and expression

| Feature | Rating | One line |
|---|---|---|
| Expression sets (one click sets eyes, brows, mouth together) | **Must** | Variants already exist per part; naming a combination is what turns them into "happy". |
| Auto blink | **Must** | `blinkVariant` is already in the model and unwired; a 120 ms blink every 3 to 5 seconds is the cheapest sign of life there is. |
| Glance automation (idle eye darts) | **Should** | Same engine as auto blink, one more toggle, big payoff. |
| Eye tracking target (look at) | **Should** | Duplicate of the look at constraint above; ship them as one thing. |
| Lip sync from audio visemes | **Later** | Real work (Rhubarb is a native binary; a browser path means WebAssembly or a server), and a mascot that mouths words is not the stated product. |
| Manual viseme track (type a word, get mouth shapes) | **Later** | Cheaper than audio lip sync and worth doing first if talking ever becomes a requirement. |
| Brow and pupil micro offsets driven by expression | **Should** | Falls out of parameters for free once section 2 lands. |

---

## 4. Animation workflow

| Feature | Rating | One line |
|---|---|---|
| Pose to pose authoring with explicit holds | **Must** | This is the house style. Hold easing exists; a pose-shaped UI over it does not. |
| Motion preset library (idle, wave, jump, nod, bounce) | **Must** | The fastest route from "I have a character" to "I have an animation", and the strongest mom test moment in the product. |
| Retarget a preset onto any rig by part role | **Must** | A preset library is worthless if presets only fit the rig they were authored on. Roles (head, armL, handL) are the join key. |
| Walk cycle generator | **Later** | A generated walk that does not match the character's silhouette looks worse than no walk. Ship walk as a hand made preset first and judge. Supporting evidence: Character Animator's Walk behaviour is itself a canned procedural side-view cycle driven off tagged handles, not an IK solve. Even Adobe did not generate it. |
| Cycle and loop tools (make last pose match first) | **Should** | One button, "make it loop", removes the most common beginner bug. |
| Retiming (drag a pose, everything after shifts) | **Should** | Timing is where a stepped animation lives or dies. |
| Motion paths on canvas | **Skip** | Belongs to a tool where things travel across a scene. Mascots pose in place. |
| Graph editor (curve editing per property) | **Later** | The easing popover covers the 95 percent. A graph editor is a second interface to learn. |
| Audio track with waveform | **Later** | Only pays off with lip sync. |
| Onion skin during pose editing | **Should** | Listed in section 1; it belongs to this workflow. |
| Action clips (several named animations per document) | **Must** | "Idle", "wave", "celebrate" must coexist in one file or the app cannot ship one rig with several behaviours. |

**The one structural decision here:** riff's document currently has one timeline
(`frameCount`, `loopIn`, `loopOut`). A mascot in an app needs several named actions.
Add a `Clip` table (name, in, out, loop flag) rather than several documents, so all
actions share one skeleton and one set of drawings. This must land before the export
contract is frozen.

---

## 5. Drawing

| Feature | Rating | One line |
|---|---|---|
| Pressure brush | **Must (mostly have it)** | `shapes.ts brushStroke` already carries pressure; swap the outline maths for perfect-freehand's, which is better tuned and MIT. |
| Stroke stabiliser | **Should** | Turns a shaky trackpad line into a confident one. Perfect-freehand's `streamline` option is exactly this, one number. |
| Vector boolean ops | **Should (have the engine)** | `boolean.ts` works; it needs a toolbar: merge two shapes into one part, punch a hole. |
| Path simplify and smooth | **Should (have the engine)** | `polyline.ts` works; expose as a single "Tidy" slider after a stroke, not two technical sliders. |
| Fill bucket | **Later** | Closed shapes with a fill colour already cover the common case; a real flood fill on vectors is a research project. |
| Symmetry drawing | **Should** | One toggle, mirrors strokes across the part's vertical axis while drawing. |
| Image trace to vector (import a hand drawing or a PNG) | **Must** | The fastest path to a good looking mascot is a drawing the user already made. This is the on ramp. |
| Photo trace (posterise a photo into shapes) | **Later** | Same code path as image trace with different settings; not the first use case. |
| Pen tool with bezier handles | **Should (have it)** | Tool exists in `ToolId`. Keep it, do not feature it. |
| Corner rounding, stroke to outline, offset path | **Later** | Nice polish, none of it blocks a mascot. |

**Trace engine choice.** Three candidates are already in `ref/`:

| Engine | Licence | Output | Verdict |
|---|---|---|---|
| imagetracerjs | Unlicense (public domain) | Colour quantised polygons plus optional quadratic curves, pure JS, no build step | **Start here.** Zero integration risk, runs in a worker, good enough for flat mascot art. |
| vtracer | MIT | Clean colour clustering and cubic bezier output, Rust compiled to WebAssembly | **Upgrade to this** when trace quality becomes the complaint. Already vendored. |
| potrace | **GPL-2.0** | Best in class bitmap to bezier for one bit images | **Do not link.** GPL. Read the algorithm if useful; ship one of the two above. |

---

## 6. Export and runtime

| Target | Rating | One line |
|---|---|---|
| Skia runtime JSON for React Native | **Must** | This is the product's actual delivery format; everything else is a preview. |
| Web player (single HTML file) | **Must (have it)** | `io/player.ts` already ships one; keep it in step with the runtime. |
| Animated GIF or MP4 preview | **Should** | Not a delivery format, a sharing format. One canvas capture, worth a day at most. |
| PNG sequence | **Later** | The escape hatch when the runtime cannot render something. |
| Sprite sheet | **Later** | Kills the whole point of a rig (no runtime posing, no cosmetics swap) but is the universal fallback. |
| Lottie JSON | **Should, with a hard caveat** | Transform hierarchies and shape morphs export cleanly; bones and skinned meshes do not exist in the Lottie schema at all. |
| `.lottie` (dotLottie) | **Later** | A zip around the above. |
| Rive `.riv` export | **Skip** | The framing format is public but the object and property schema is not published in its current form and there is no first party writer specification, so the property key numbering moves with the editor. Note that the Rive **runtime** is MIT and is a first class porting source; only the export target is off the table. |
| Spine JSON export | **Later** | Well documented and would open every existing Spine runtime, but the Spine *runtimes* licence requires a Spine editor licence per user, so it buys less than it looks like. |

**What breaks when exporting a rig to Lottie**

| riff concept | Lottie equivalent | Result |
|---|---|---|
| Part hierarchy, transforms, opacity | Layer `parent`, `ks` transform, `ao` | Clean. |
| Joint (pivot) | Anchor point `a` | Clean. |
| Slant (skew) | `sk` / `sa` on the transform | Clean, but skew keyframing support is uneven across players. |
| Variant swap | Multiple shape layers with in/out points, or keyframed opacity | Works; file size grows with variant count. |
| Draw order changes over time | **No equivalent** | Must be baked by duplicating the layer at each order and toggling visibility. Ugly but correct. |
| `overlap` copies | Extra shape groups | Works, triples the shape count at joints. |
| Halo | A duplicated stroke pass per shape | Works, doubles the shape count. |
| Bones and mesh weights | **No equivalent, and this is not a subtlety.** A grep of the entire official `lottie/lottie-spec` repository for bone, armature, skeleton, skinning, weighted vertex, puppet and mesh returns zero hits. Layer types are precomp, image, null, solid and shape, and that is the whole list. | Must bake to per frame path keyframes, which explodes file size, or refuse to export skinned parts. Every After Effects rigging tool (DUIK, Limber, RubberHose) bakes on export for the same reason, and Puppet Pin does not export at all. |
| Springs / parameters / look at | **No equivalent** | Runtime behaviour must be baked to keyframes at export. |

Recommendation: Lottie export is a *baked* export, always. Warn plainly ("this
export freezes the animation; springs and turning will not respond in the app") and
keep the Skia JSON as the live format.

**Skia runtime JSON contract, summarised** (full sketch in `plan.md`)

The React Native side should have to do three things and no more: parse once, evaluate
at a time value, and draw a flat list. That means the exporter resolves everything
structural at build time and the runtime keeps only what must be dynamic (time,
parameter values, spring state, look at target).

---

## 7. Speed, templates, and variants

| Feature | Rating | One line |
|---|---|---|
| Start from a base body (template rigs) | **Must** | Removes the blank canvas, which is where most attempts die. |
| Part roles (head, torso, armL, forearmL, handL, ...) | **Must** | The join key for presets, mirroring, IK defaults, auto rig and flip. Nothing else scales without it. |
| Duplicate to make a crew | **Should (have the engine)** | `duplicateParts` exists; the missing piece is duplicating a whole *character* and recolouring it. |
| Cosmetic slots (hair, hat, outfit, prop) | **Must** | Explicitly in the project's direction, and the model already supports it as parts with variants; the gap is naming and a picker. |
| Palette swap across a character | **Should** | One control that recolours a crew member in a click. |
| Real time multi user collaboration | **Skip** | Wrong product stage by a mile. |
| Share link to a read only preview | **Should** | The web player plus a URL. Cheap, and it is how a mascot gets feedback. |
| Version history beyond undo | **Later** | Autosave plus undo covers the first year. |

---

## The Must list, consolidated

1. Part roles and a template body to start from (auto rig).
2. Image trace import.
3. Two bone IK with drag handles on hands and feet.
4. Pose library, pose mirroring, and stepped pose to pose authoring with holds.
5. Named action clips in one document.
6. Motion preset library that retargets by part role.
7. Secondary motion springs on ears, hair and tails.
8. Auto blink.
9. Turn: an angle parameter with per angle part swaps and parallax.
10. Flip the character.
11. Draw order changes per pose (model exists, UI does not).
12. Cosmetic slots.
13. Expression sets.
14. Skia runtime JSON export, plus the web player kept in step.
15. Pressure brush quality (upgrade the existing one).

Everything else waits.

## The things most likely to be built by mistake

These all look essential when you read a professional tool's feature list, and all
of them fail the mom test. Written down so nobody reaches for them:

- A graph editor.
- A lattice deformer.
- Transform constraints and a general driver graph.
- Pose blending with weights.
- Audio lip sync.
- Motion paths.
- A walk cycle generator, before walk exists as a hand made preset.
- Sprite sheet export, before the Skia runtime works.

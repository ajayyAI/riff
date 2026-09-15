# Sources and licences

Written 2026-09-15. Licences were read from each repo's own `LICENSE` file or the
GitHub licence API on that date, not from memory. Re-check before shipping anything
that links a dependency.

**The rule this repo already has:** `ref/` is cloned reference material and is
gitignored. Read it freely, never import from it, port what you need into `src/` with
an attribution comment at the top of the ported file.

**The rule that governs which repos may be ported from:**

| Licence | What we may do |
|---|---|
| MIT, BSD-2, BSD-3, Apache-2.0, ISC, Unlicense | Copy code into `src/` with attribution. |
| GPL, AGPL, LGPL | Read as a spec. Never copy a line. Never link. |
| No LICENSE file at all | **Treat as all rights reserved.** Read as a spec, copy nothing. |
| Custom / proprietary (Spine Runtimes, Live2D SDK) | Read the public docs as a spec. Copy nothing. |

---

## Cloned into `ref/` for this work

All six were cloned shallow and had their `.git` directories removed.

| Directory | Repo | Licence | Stars | Why |
|---|---|---|---|---|
| `ref/rive-runtime` | github.com/rive-app/rive-runtime | **MIT** (`LICENSE`, "Copyright (c) 2020 Rive") | 1.2k | The best licensed 2D skinning and IK code found anywhere. It is the Rive editor's own core (the `WITH_RIVE_EDITOR` ifdefs are visible in `src/bones/skin.cpp`). Critically, it skins **bezier control points and their tangents**, not just mesh vertices, which is exactly what a vector cutout editor needs and what lets riff skip triangulation entirely. |
| `ref/dragonbones-js` | github.com/DragonBones/DragonBonesJS | **MIT** (`LICENSE`, and a full MIT header in every source file) | 850 | Already TypeScript, so the cheapest direct port: the two bone IK solver, the linear blend skinning loop, the weight data layout, the constraint evaluation ordering. |
| `ref/perfect-freehand` | github.com/steveruizok/perfect-freehand | **MIT** | 5.7k | Pressure brush outline maths, stroke stabilisation, pressure simulation. |
| `ref/inochi2d` | github.com/Inochi2D/inochi2d | **BSD-2-Clause** | 1.8k | The parameter and typed-binding design behind the head turn, and the pendulum / spring pendulum physics behind Floppy. Written in D, so this is a maths port, not a text copy. |
| `ref/earcut` | github.com/mapbox/earcut | **ISC** | 2.6k | Polygon triangulation with holes. Needed only for skinning image-backed parts (phase 11); vector parts skin their control points directly and never need it. Note the caveat below: ear clipping produces no interior vertices and slivers at thin spots, so it is a fill triangulator, not a good skinning triangulator. |
| `ref/skel2d` | github.com/urraka/skel2d | **NO LICENCE FILE** | small | The cleanest small model of a cutout rig: bones, slots, path attachments, skins, draw order, named animations with easing. **Read only. Copy nothing.** |

### Correction to a prior note

`the app repo/references/rig-research/README.md` describes skel2d as "MIT". That is
wrong. The repository contains no `LICENSE` file and the GitHub licence API returns
null for it. Same for `Cani2D` and `bonehead`, also referenced there. All three are
readable as specifications and none of them may be copied from. Worth fixing in that
README.

### Exactly what to port, with file paths

**`ref/rive-runtime` (MIT)**

This is C++, so it is a maths port rather than a text copy. Every file below is small.

| Port | Path | Lines | Used by |
|---|---|---|---|
| **Vertex skinning kernel.** Up to four influences, bone index and weight packed one byte each into two `uint32`s; returns the weighted sum of bone matrices applied to the world point. | `src/bones/weight.cpp`, `Weight::deform` | 25 | Plan phase 11 |
| **Skinning a bezier control point's in and out tangents**, so an outline bends rather than a triangle mesh. This is the single most important file in the whole survey for riff, because riff's `PathGeometry` already stores `vertices`, `tangentsIn` and `tangentsOut` as parallel arrays. | `include/rive/bones/cubic_weight.hpp`, applied in `src/shapes/cubic_vertex.cpp` | 18 plus the call site | Plan phase 11 |
| Bone palette: `boneTransforms[i] = bone.worldTransform * tendon.inverseBind` | `src/bones/skin.cpp`, `src/bones/tendon.cpp` | 159, 77 | Plan phase 11 |
| **Two bone IK with softness, stretch and compress.** Law of cosines in the parent's inverse world space, plus `invertDirection` and a strength blend. Richer than the DragonBones solver; pick one. | `src/constraints/ik_constraint.cpp`, `solve1` (aim) and `solve2` (two bone), `constrainRotation` | 301 | Plan phase 4 |
| Dirty propagation and dependency ordering for constraints | `src/constraints/ik_constraint.cpp`, `buildDependencies` / `constrain` | | Plan phase 4 (`evaluateRig`) |
| Other constraints, if any are ever wanted | `src/constraints/{distance,rotation,scale,translation,transform,follow_path,draggable}_constraint.cpp` | | Mostly rated Skip |
| Matrix decomposition into translate, rotate, scale and skew | `include/rive/math/mat2d.hpp`, `include/rive/math/transform_components.hpp` | | Any phase |
| Triangle-mesh skinning path, for the image-backed case | `src/shapes/mesh_vertex.cpp`, `src/shapes/deformer.cpp` | | Plan phase 11 |

**`ref/dragonbones-js` (MIT)**

| Port | Path | Used by |
|---|---|---|
| Two bone IK, closed form circle intersection, including the unreachable and degenerate cases | `DragonBones/src/dragonBones/armature/Constraint.ts`, `IKConstraint._computeB` | Plan phase 4 |
| Single bone aim (a bone points at a target), the basis of look-at | `DragonBones/src/dragonBones/armature/Constraint.ts`, `IKConstraint._computeA` | Plan phases 4 and 8 |
| Radian normalisation the solver depends on | `DragonBones/src/dragonBones/geom/Transform.ts`, `Transform.normalizeRadian` | Plan phase 4 |
| "Solve constraints after tracks, before world matrices" evaluation order, and bone sorting so a constrained bone updates after its driver | `DragonBones/src/dragonBones/armature/Armature.ts`, `_sortBones` and the `_constraints` loop | Plan phase 4 (`evaluateRig`) |
| Linear blend skinning: per vertex, sum of (bone matrix times rest position) times weight | `Pixi/8.x/src/dragonBones/pixi/PixiSlot.ts`, `_updateMesh`, the `weightData !== null` branch | Plan phase 11 |
| Weight storage layout (per vertex bone count, then bone index, weight, rest x, rest y) | `DragonBones/src/dragonBones/model/DisplayData.ts` (`WeightData`, `GeometryData`, `MeshDisplayData`) | Plan phase 11 |
| Free form deformer as an alternative to bone weights (a bone whose children sample a bilinear grid, the DragonBones answer to Live2D's warp deformer) | `DragonBones/src/dragonBones/armature/Surface.ts` | Read only, if bend zones prove insufficient |
| Path constraint, if a tail on a spline is ever wanted | `DragonBones/src/dragonBones/armature/Constraint.ts`, `PathConstraint` | Rated Skip; noted for completeness |
| **A complete, standalone, MIT description of a shipping rig JSON format.** 2,133 lines, 44 exported classes covering the whole DragonBones 5.x format. Read this before inventing the riff runtime schema; it is a proven answer to the same problem. | `Tools` repo (separate clone, MIT): `src/format/dragonBonesFormat.ts` | Plan phase 6 |
| **A third party MIT description of the Spine JSON data model.** 463 lines. A file format is not runtime code, so this is the legally safe way to read Spine's schema without touching the Spine Runtimes licence. | `Tools` repo: `src/format/spineFormat.ts`, plus `src/action/fromSpine.ts` and `toSpine.ts` | Reading only |

**`ref/perfect-freehand` (MIT)**

| Port | Path |
|---|---|
| Stroke outline from pressure samples | `packages/perfect-freehand/src/getStrokeOutlinePoints.ts` |
| Sample preparation, and `streamline` (the "Steady hand" control) | `packages/perfect-freehand/src/getStrokePoints.ts` |
| Public entry point and options shape | `packages/perfect-freehand/src/getStroke.ts`, `types.ts` |
| Pressure to radius, including thinning and easing | `packages/perfect-freehand/src/getStrokeRadius.ts` |
| Pressure simulation for mice and trackpads | `packages/perfect-freehand/src/simulatePressure.ts` |
| Vector helpers it depends on | `packages/perfect-freehand/src/vec.ts`, `constants.ts` |

**`ref/inochi2d` (BSD-2-Clause)**

| Port | Path |
|---|---|
| Parameter with keypoints, one axis | `source/inochi2d/param/parameters/param1d.d` |
| The same with a 2D keypoint grid, for the later "look around" axis | `source/inochi2d/param/parameters/param2d.d` |
| Typed bindings: (parameter, node, property) to a value per keypoint, with an interpolation mode | `source/inochi2d/param/bindings/package.d`, `bindings/property.d`, `bindings/node.d` |
| Keypoint interpolation | `source/inochi2d/param/utils.d`, `interpolateKeypoint` |
| Rigid pendulum and spring pendulum, with angle damping and limits | `source/inochi2d/nodes/legacy/simplephysics.d` |
| RK4 integrator and the variable registration pattern | `source/inochi2d/core/phys/system.d` |
| Mesh and lattice deformers, read only unless bend zones fail | `source/inochi2d/nodes/deformer/meshdeformer.d`, `latticedeformer.d`, `source/inochi2d/core/math/deform.d` |

**`ref/earcut` (ISC)**

| Port | Path |
|---|---|
| Ear clipping triangulation with hole support | `src/earcut.js` (the `holeIndices` argument matches riff's `subpathStarts`) |

**`ref/skel2d` (no licence: read only)**

| Read for | Path |
|---|---|
| Skeleton, slot and attachment vocabulary; path attachments as vector shapes rather than images | `README.md`, sections "Adding slots/attachments" and "Path attachments" |
| Named animations, timelines and easing vocabulary | `README.md` "Animation"; `src/skel2d_core.js` |
| Skins as a set of attachment overrides | `README.md` "Defining skins" |
| Draw order as an explicit list separate from the hierarchy | `README.md` "Defining the draw order" |

---

## Already in `ref/` before this work

| Directory | Licence | Relevance to the rig |
|---|---|---|
| `ref/imagetracerjs` | **Unlicense** (public domain) | The trace engine to ship first (plan phase 2). Pure JS, no build step, runs in a worker. |
| `ref/vtracer` | **MIT** | The trace upgrade path. Rust to WebAssembly, cleaner curves and colour clustering. |
| `ref/glaxnimate` | **GPL-3.0** | **Spec only.** Good reading on Lottie shape structure and animated path handling. Do not copy. |
| `ref/Graphite` | Apache-2.0 | Shape dragging and snapping, already used by riff. |
| `ref/animation-editor` | MIT | Bezier maths and the pen tool, already used by riff. |
| `ref/lottie-tools` | MIT | Lottie writing, relevant to the baked Lottie export. |
| `ref/animation-timeline-control` | MIT | Timeline interaction reference. |
| `ref/anim8` | vendor teardown | The visual direction lock. |
| `ref/FrameSVG`, `ref/svg2fbf`, `ref/svgasm` | see each | Video pipeline, not rig work. |

---

## Not cloned: read the docs, copy nothing

### Spine (Esoteric Software)

Documentation is the best written specification for cutout rigging that exists. Read
`esotericsoftware.com/spine-docs` for meshes, weights, IK constraints, transform
constraints, path constraints, skins, skin placeholders and draw order keys, and
`esotericsoftware.com/spine-json-format` for the runtime format.

**The runtimes are not open source.** `github.com/EsotericSoftware/spine-runtimes`
carries the *Spine Runtimes License Agreement*, which requires that "each user of the
Products must obtain their own Spine Editor license". GitHub reports the licence as
NOASSERTION for exactly this reason. Do not copy a line of it, and treat "export Spine
JSON so existing runtimes work" as a dead end: it would require every riff user to buy
a Spine editor licence.

Concepts worth stealing (as ideas, which are not copyrightable):

- Draw order is a separate keyed timeline from the bone hierarchy. riff already does
  this with `Artboard.layerIds` plus an animatable `depth`.
- A slot holds an attachment; a skin remaps slots to attachments. riff's `Variant` is
  the attachment and a cosmetic slot is the skin (plan phase 10).
- IK, transform and path constraints all run as a post-track pass that writes bone
  transforms. That is the shape `evaluateRig` copies.

### Rive: the runtime is portable, the export target is not

Two separate questions, and they have opposite answers.

**The code is MIT and it is now cloned into `ref/rive-runtime`.** See the port table
above. `rive-app/rive-wasm` and `rive-app/rive-react-native` are MIT bindings over the
same C++, so the C++ is the porting source.

**Writing a `.riv` file from riff is not a supported path, so Rive export stays
Skip.** The framing specification is public, but the object and property schema is not
published in its current form (the `rive-cpp-legacy` definitions are stale) and there
is no first party writer specification. The property keys are recoverable from the MIT
generated headers (`include/rive/generated/bones/*_base.hpp` and
`constraints/*_base.hpp`, each declaring a `typeKey` and numbered `*PropertyKey`s), so
it is *possible*; it is not *supportable*, because the numbering moves with the editor.

Read `rive.app/docs` for design, not code. The features worth stealing as ideas:

| Rive feature | riff equivalent |
|---|---|
| Solos (exactly one of N children visible) | `PartLayer.variant`, already in the model |
| Joysticks (a 2D driver with a draggable puck) | `Parameter` with a 2D keypoint grid, plan phase 9's later axis |
| Constraint list (IK, distance, translation, rotation, scale, transform, follow path) | Only IK and a look-at are in scope; the rest are rated Skip |
| State machines | Named actions plus the app's own logic. A state machine editor fails the mom test. |

### Adobe Character Animator

Behaviours worth reading up on, all in Adobe's help pages: Face (lip sync, eye gaze,
blink), **Head Turner**, Walk, Physics (Dangle, Collide, Wind), Handles and Draggers,
Cycle Layers, Triggers and Swap Sets.

**Head Turner** is the closest thing in a shipping product to what our Turn slider
does, and it works by *layer naming*. The artist names layer groups after the view
they represent and Character Animator auto-tags them:

| Layer name | View |
|---|---|
| Frontal | Facing the camera |
| Left Quarter / Right Quarter | Three quarter |
| Left Profile / Right Profile | Side on |
| Upward / Downward | Optional vertical views |

The behaviour lives on the parent group and **steps discretely between views at yaw
thresholds**. It does not cross fade. That is worth knowing: the professional tool
aimed at exactly our audience arrived at the same stepped answer the project's direction
asks for, which is strong confirmation that riff should step the drawing swap and
interpolate only the parallax offsets.

The behaviour is actually called **Head and Body Turner**. Tags are auto-applied from
layer names under a Head group; Upward and Downward are tagged by hand. Two to seven
views are supported. And its entire control surface is **three parameters**: Camera
Input, Controlled by (head or body), and Sensitivity. That is the mom test standard to
beat, from the one company that has genuinely tried to sell puppet rigging to
non-animators.

The layer naming convention is worth copying almost verbatim as the suggested names for
a Turn slider's keypoints.

**The cost riff avoids.** In Character Animator, each view group needs its **own
duplicate eye and mouth sub-rig**, because a view is a whole separate layer group. riff
does not: a part keeps its identity across the whole turn and only its drawing and
offsets change, so the eyes are one part with several drawings rather than five
separate eye rigs that have to be kept in sync. Say this out loud in the UI copy; it is
the concrete reason the riff version is less work.

(Unrelated trap, noted so nobody copies it: Character Animator's `+` layer name prefix
marks Warp Independent layers. It has nothing to do with view tagging.)

**Walk** is a procedural side-view cycle driven off tagged handles, with Step Speed
driving the phase and Body Speed decoupling translation. It is **not** IK. Relevant to
the "walk cycle generator" rating: even Adobe ships walk as a canned cycle rather than
solving it, which supports shipping walk as a hand made preset first.

**Dangle** is the same idea as our Floppy, with the same two-slider surface (stiffness
and damping) plus a collision option we are deliberately not building.

Closed source. Docs only.

### Moho (Lost Marble)

**Smart Bones** are the cleanest mechanism in any 2D tool for "one control drives many
properties", and the mechanics are simple enough to state exactly:

- Create an action named after the bone.
- "Make Smart Bone Dial" maps the bone's angle range `[Min, Max]` **linearly** onto the
  action's frames `[1, Duration]`.
- The bone's live angle then scrubs that action.
- A bone may carry at most two actions (one per direction).

So a Moho driver is literally a second time axis, and the angle is a playhead on it.
riff's `Parameter` keypoints are the same idea with the timeline hidden: instead of
asking the user to author an action, riff records what changed at the nearest keypoint.
That is the one place riff should be *simpler* than Moho rather than equivalent.

Also worth reading: bone strength and region binding versus point binding versus layer
binding, Actions, Switch Layers.

Closed source. Docs only.

### Toon Boom Harmony

Deformers (bone, curve, envelope, game bone), drawing substitutions, Master Controller,
rigging with pegs, and Cutter plus Auto-patch for seamless elbows.

Two things to take: **drawing substitution** (already in riff as `PartLayer.variant`),
and **Auto-patch**, which is a smarter version of our `overlap`: it draws a patch of
the child's fill under the parent's line so the joint never shows. Worth revisiting in
phase 11 as a cheaper alternative to skinning.

Closed source. Docs only.

### Live2D Cubism

The reference implementation of 2.5D from flat art. Warp and rotation deformers,
keyforms, parameter binding, and a physics settings file with pendulum inputs and
outputs.

Mechanics worth knowing precisely:

- A **keyform** is a full snapshot of the bound geometry at one parameter key.
- Interpolation is **linear** along a single parameter axis and **bilinear** across a
  two parameter grid (a 3x3 grid is the common authoring case).
- The standard parameter ranges are conventions, not arbitrary: `ParamAngleX`,
  `ParamAngleY`, `ParamAngleZ` run **-30 to 30**; `ParamBodyAngleX/Y/Z` run **-10 to
  10**. Degrees, not a normalised -1 to 1.

Two decisions for riff fall out of this. First, label the Turn slider in **degrees**,
because a number a user can reason about beats a normalised float, and -30 to 30 is a
range a decade of Live2D rigs says is right. Second, the bilinear 3x3 grid is exactly
what a later "look around" axis becomes, so build the one axis version with the grid
generalisation in mind and do not paint yourself into a 1D corner.

The warp deformer authoring is exactly the complexity riff refuses. Live2D authors a
mesh deformation per keypoint; riff swaps a drawing and slides a few offsets.

The `.moc3` runtime and the Cubism SDK are proprietary with commercial licence tiers.
Docs only.

### Inochi2D and its fork

`inochi2d.com` and `github.com/Inochi2D`, BSD-2-Clause, written in D. The open source
answer to Live2D. Cloned into `ref/` (see above) because the licence permits porting.

There is a fork, **nijilive** (the runtime) and **nijigenerate** (the editor),
`github.com/nijigenerate`, both BSD-2-Clause, both maintained through mid 2026.
nijigenerate (298 stars) is, as far as an exhaustive survey could establish, **the only
actively maintained rig editor in existence under a permissive licence**. It is written
in D and is a desktop application, so porting means translating by hand, but it is the
only place several editor-side algorithms exist under a licence we can use:

| Algorithm | Path in `nijigenerate` | Why it matters |
|---|---|---|
| Auto-mesh from an image's alpha channel, by contour sampling at several scales | `source/nijigenerate/viewport/vertex/automesh/contours.d`, plus `grid.d`, `optimum.d`, `alpha_provider.d` | The generic version of riff's trace import |
| **Auto-skeleton from a drawing**, Zhang-Suen thinning, 176 lines | `source/nijigenerate/core/math/skeletonize.d`, plus `commands/depth/bone.d` | If "drop a drawing, get a rig" ever becomes a phase, this is the algorithm |
| Mesh editing tools: point, connect, lasso, brush, grid, path deform, bezier deform | `source/nijigenerate/viewport/common/mesheditor/tools/*.d` | Reference only; riff is deliberately not building these |
| Weight and deform binding commands | `commands/model/set_deform_binding.d`, `actions/deformable.d`, `viewport/model/deform.d` | Phase 9 and 11 reference |

In `nijilive` (the runtime fork), `source/nijilive/core/nodes/meshgroup/package.d` holds
**MeshGroup**: binds child parts to a parent triangle mesh and transfers deformation
barycentrically. That is the cleanest small implementation of "one deformer drives
several parts" anywhere in the survey. Supporting maths in `math/triangle.d`
(`isPointInTriangle`, `findSurroundingTriangle`, `calcOffsetInTriangleCoords`,
`calculateAffineTransform`).

**Not cloned**, because nothing in the eleven-phase plan needs it yet. Clone it the day
an auto-rig-from-a-drawing phase is written.

### OpenToonz, Synfig, Pencil2D, Krita, Blender Grease Pencil

All GPL. **Specification reading only, never a line of code.**

| Project | Read for |
|---|---|
| OpenToonz | The plastic (skeleton) deformation tool: how a mesh is bound to a skeleton in a 2D paint program. |
| Synfig | Skeleton and skeleton-deformation layers, and how link-to-bone works on a vertex. |
| Pencil2D | Nothing rig related; it is a frame by frame tool. Useful only for onion skin UI. |
| Krita animation | Onion skin controls, which are the best in class: per-frame colour tinting and independent before/after counts. Copy the *interface*, which is not licensed. |
| Blender Grease Pencil | Armature modifier on strokes: how vertex groups and weights are painted onto a 2D stroke. The auto-weight-by-distance behaviour is exactly what plan phase 11's `autoWeights` does. |

---

## Libraries, with verified licences

Checked via the GitHub licence API and each repo's LICENSE file on 2026-09-15.

### Drawing

| Library | Licence | Verdict |
|---|---|---|
| perfect-freehand | MIT | **Port.** Cloned. Exports are `getStroke`, `getStrokePoints`, `getStrokeOutlinePoints`. There is no `getStrokeOutline`. |
| **`@velipso/polybool`** | **0BSD** | **The pick if `boolean.ts` ever needs replacing.** TypeScript, zero attribution required, CCW exteriors and CW holes (matches riff's subpath model), and a `shape()` builder that speaks `moveTo` / `lineTo` / `bezierCurveTo` / `closePath`. Experimental cubic support. |
| `@flatten-js/core` | MIT | The alternative if circular arcs must survive a boolean. `BooleanOperations.unify/subtract/intersect`. Carries arcs, not cubics. |
| `w8r/martinez` | MIT | The liveliest Martinez implementation, now TypeScript. Note the method is `diff`, not `difference`. |
| paper.js | MIT (GitHub reports NOASSERTION; `LICENSE.txt` is plain MIT) | True cubic booleans, `src/path/PathItem.Boolean.js`. 180 KB of numerics: this is an adoption in a worker, not a port. Last resort. |
| polygon-clipping | MIT | **Avoid.** Abandoned since 2024 with open correctness bugs. |
| polybooljs | MIT | Superseded by `@velipso/polybool`. |
| simplify-js | BSD-2 | ~70 lines. Already reimplemented in `polyline.ts simplifyPoints`. No need. |
| `soswow/fit-curve` | MIT | Schneider's curve fitting from Graphics Gems, ~300 lines, finished. **Worth porting** for the trace pipeline: it turns a simplified polyline into cubics, which is the step between imagetracerjs and riff's `PathGeometry`. |
| bezier-js | MIT | Already covered by `geometry/bezier.ts`. Useful only if path offsetting or outlining is ever wanted (`offset`, `outline`, `arcs`). |
| `@thi.ng/geom-resample`, `geom-splines`, `geom-clip-poly` | Apache-2.0 | TypeScript, actively released. Keep the NOTICE header if any file is copied. |

### Tracing

| Library | Licence | Verdict |
|---|---|---|
| imagetracerjs | **Unlicense only** (public domain; the widely repeated "dual Unlicense/MIT" claim is wrong, there is no MIT text in the repo) | **Ship this first.** Already in `ref/`. The functions to port are `pathscan` (boundary walk), `pointinpoly` plus `boundingboxincludes` (hole nesting), `internodes`, and `tracepath` / `fitseq`. |
| vtracer and `visioncortex/visioncortex` | **MIT OR Apache-2.0** (dual; both LICENSE files present in the algorithm crate) | The upgrade. Already in `ref/`. The browser build is the `webapp/` crate (`wasm-pack build --target web`); the npm package is a Node build. Pass `hierarchical: 'cutout'` or you get no holes, because the default stacking strategy deliberately avoids them. |
| potrace (original, and every port: `node-potrace`, `kilobtye/potrace`, `iwsfg`, `oslllo`, `tatarize`, SVGcode) | **GPL-2.0-or-later**, some forks GPL-3.0 | **Do not link, do not port.** Peter Selinger dual-licenses a proprietary build, which is exactly why nobody has the right to relicense a port. No permissive Rust port exists either. |
| `esm-potrace-wasm` | **GPL-2.0** (verified: full GPL-2 text, npm declares GPL-2.0) | Same answer. A wasm wrapper does not launder a licence. |
| `marchingsquares` npm (`RaumZeit/MarchingSquares.js`) | **AGPL-3.0** | **Trap.** Looks like an innocuous contour helper. Do not copy and do not depend. Use `d3-contour` (ISC) or imagetracerjs `pathscan` instead. |
| `d3-contour` | ISC | Handles holes via `contains`. Grid-resolution output, so it is a fallback, not a first choice. |

### Geometry

| Library | Licence | Verdict |
|---|---|---|
| earcut | ISC | Cloned. **Fill triangulation only.** Ear clipping adds no interior vertices and produces slivers at thin spots, which is exactly wrong for skinning. |
| delaunator | ISC | Unconstrained Delaunay. Half of the recommended pair. |
| `kninnug/Constrainautor` | ISC | Constrains a Delaunator triangulation to given edges. TypeScript. The other half. |
| `jhasse/poly2tri` | BSD-3 | Constrained Delaunay in C++, maintained. The JS ports are not. |
| `mikolalysenko/cdt2d` | MIT | Constrained Delaunay in JS, stale since 2019. |
| `ivanfratric/polypartition` | MIT | Ear clipping plus convex partition, C++. |
| `artem-ogre/CDT` | **MPL-2.0** | **Avoid for a port.** File-level copyleft: a TypeScript translation would have to stay MPL and be published. |
| `libigl` bounded biharmonic weights (`igl/bbw.cpp`) | **MPL-2.0** per file (the repo's GPL-3.0 badge is for its CGAL modules) | The textbook automatic-weights algorithm, but the same file-level copyleft applies. Not worth it: see below. |

**The recommended triangulation, for the image-backed case only:** seed interior points
(a grid or Poisson disc), run **Delaunator plus Constrainautor** (both ISC) with the
outline and hole rings as constraint edges, then drop triangles whose centroid falls
outside the outline or inside a hole. That gives well shaped triangles with interior
vertices, which is what skinning needs and what earcut alone cannot give.

**On automatic weights:** there is no permissively licensed bounded-biharmonic-weights
implementation anywhere. The practical answer, and what the DragonBones and Spine
editors actually ship, is distance-falloff weights written from scratch. That is what
`autoWeights` in plan phase 11 does, and it is sufficient for a two bone limb.

### Runtime and export

| Library | Licence | Verdict |
|---|---|---|
| `@shopify/react-native-skia` | MIT | **The delivery target.** Everything the runtime contract needs is present; see the primitive list below. |
| lottie-web | MIT | Reference for what the Lottie schema can express. Also the player for a Lottie export preview. lottie-ios, lottie-android and lottie-react-native are Apache-2.0. |
| `lottie/lottie-spec` | Community Specification License 1.0 | The spec itself. Read it, do not vendor it. |
| `@lottiefiles/dotlottie-web` | MIT | The zip container, if `.lottie` is ever wanted. Its v2 state machine only selects and transitions between pre-baked clips; it cannot drive a bone. |
| Skottie (Skia's Lottie player) | BSD-3 (Skia) | Supports a subset of Lottie. Now shipped **first party and in-tree** inside react-native-skia, which makes `margelo/react-native-skottie` redundant. |
| Spine runtimes | Spine Runtimes License Agreement | **Not usable.** See above. |
| `pixi-spine` / `@esotericsoftware/spine-pixi` | Spine Runtimes License Agreement, inherited | **Not usable.** It wraps `spine-core`, so the same "every user needs a Spine Editor licence" term flows through. A permissive wrapper around a restrictive core does not change the core's terms. |
| Creature_WebGL | Apache-2.0 | Portable but dead since 2022. One 4,271 line file, `CreatureMeshBone.js`, with `MeshRenderRegion.poseFinalPts` as the skinning kernel. Rive and DragonBones are both better; keep this as a third opinion only. |

### react-native-skia primitives the runtime uses

Verified in source, npm 2.11.2, peers React Native 0.78 and above, React 19 and above,
Reanimated 4 and above.

| Need | Primitive | Notes |
|---|---|---|
| Draw a part's outline | `Skia.Path.MakeFromSVGString(d)` then `<Path>` or `canvas.drawPath` | The exported `paths` array feeds this directly. |
| Bone hierarchy | `<Group transform>` / `<Group matrix>` / `<Group origin>` | `origin` is the pivot. Nested groups are the skeleton. |
| Skinned mesh, image backed | `<Vertices vertices textures indices mode>` or `canvas.drawVertices(verts, mode, paint)`, `Skia.MakeVertices` | Put an `<ImageShader>` as a sibling in the same `<Group>` and pass `textures` as UVs. **Trap:** `blendMode` defaults to `dstOver` when `colors` is present and `srcOver` when it is absent. Omit `colors` for pure texturing. |
| One draw call for many rigid parts | `<Atlas image sprites transforms>` / `canvas.drawAtlas`, `Skia.RSXform` | **Trap:** `RSXform` is rotate, scale and translate only. No skew and no non-uniform scale, so riff's Slant and squash-and-stretch cannot go through Atlas. Use `Group matrix` or `Vertices` for those. |
| Custom shaders, if the halo ever needs one | `RuntimeEffect` (SkSL) | Not needed by the current plan. |
| Lottie playback, if a Lottie export is ever previewed in the app | `Skia.Skottie.Make(JSON.stringify(json))` then `<Skottie animation frame />` | First party and in-tree, with slot and property overrides. |

**The one that changes an architectural option:** react-native-skia runs on the web via
`canvaskit-wasm`, with a parallel web implementation under
`packages/skia/src/skia/web/`. That means the same rig runtime could render in the
browser editor and in the app, bit for bit. riff is Canvas2D today and the plan keeps
it that way, because Canvas2D has no textured-triangle primitive and therefore cannot
preview an image-backed skinned part. If phase 11's image-backed case ever becomes
important, switching the canvas to CanvasKit is the answer, not writing a Canvas2D
triangle rasteriser. Note it as a fork in the road; do not take it speculatively.

### Skottie's gaps, if a Lottie export is ever previewed through it

Read from Skia's source rather than docs, because skia.org publishes no gap list.

- **Layer types silently dropped** (`modules/skottie/src/Layer.cpp`, `gLayerBuildInfo`):
  placeholder video (7), image sequence (8), placeholder still (10), guide (11),
  adjustment layer (12), light (14). Camera (13) keeps its transform but has no content.
- **Expressions are ignored by default.** `Skottie.h` declares
  `setExpressionManager` with the comment that expressions are ignored if unspecified.
  The interface ships; no implementation does. Expressions are not in the Lottie spec at
  all; they are a lottie-web extension present only in the full build.
- **Effects are a 29 entry allowlist** (`effects/Effects.cpp`). No Turbulent Displace,
  Roughen Edges, Glow effect or Wave Warp.
- **Layer styles**: only ColorOverlay, Glow and Shadow.
- **3D auto-orient** is still a TODO (`Transform.cpp`). 2D auto-orient works.
- Correcting a widely repeated stale claim: Skottie **does** support track mattes (all
  four modes plus `tp`), merge paths, trim paths, repeater, offset paths, pucker and
  bloat, rounded corners, and text with full shaping and range selectors.

### Lip sync (rated Later)

| Library | Licence | Verdict |
|---|---|---|
| Rhubarb Lip Sync | MIT (`LICENSE.md`). Every bundled dependency audited and permissive: boost BSL-1.0, pocketsphinx and the cmusphinx model BSD, flite BSD-like, fmt BSD-2, gsl/tclap/utf8proc MIT, ogg/vorbis/webrtc BSD-3. **No GPL anywhere.** The output data is explicitly yours. | The quality option, but it is a C++ command line binary. Output is `{ metadata, mouthCues: [{ start, end, value }] }` with contiguous cues; visemes are Hanna-Barbera A to F plus optional G, H and X behind `--extendedShapes`. |
| `danieloquelis/rhubarb-lip-sync-wasm` | MIT | An Emscripten build with the model bundled. `Rhubarb.getLipSync(pcm16k, { dialogText })`. Beta, packaged for Node, needs a Worker and 16 kHz PCM. The browser path exists but is not comfortable yet. |
| `wass08/wawa-lipsync` | MIT | Pure JS real-time formant analysis over an `AnalyserNode`, Oculus/ARKit 15 viseme set, no recognition model. Much lower quality than Rhubarb but trivial to ship. If lip sync is ever wanted cheaply, start here. |

---

## Licence traps, in one list

Each of these looks safe and is not. Checked on 2026-09-15.

| Looks like | Actually |
|---|---|
| potrace, and every JS, wasm, Python and Go port of it | GPL-2.0-or-later, some forks GPL-3.0. No exceptions exist. |
| `marchingsquares` npm | AGPL-3.0 |
| `artem-ogre/CDT`, `libigl` bounded biharmonic weights | MPL-2.0, file-level copyleft |
| Spine runtimes, and `pixi-spine` which wraps them | Spine Runtimes License Agreement: the obligation attaches to **your users**, not just to you |
| skel2d, Cani2D, bonehead, icebones | No LICENSE file at all, so all rights reserved |
| coa_tools, SkelForm, Synfig, OpenToonz, glaxnimate, Krita, Blender | GPL |
| paper.js, Rhubarb (GitHub shows NOASSERTION for both) | Both are genuinely permissive: paper.js is verbatim MIT, Rhubarb is MIT |
| imagetracerjs "dual Unlicense/MIT" | Unlicense only, which is strictly better anyway |
| vtracer "MIT" | MIT **OR** Apache-2.0, dual, in both the tool and the `visioncortex` algorithm crate |

## Searches run, and the one conclusion that matters

For the record, so a later agent does not repeat them: "2d skeletal animation editor
web", "cutout animation editor javascript", "spine-like editor open source", "2d bone
animation typescript", "inochi2d", "dragonbones", "two bone ik typescript", "fabrik
javascript", "creature2d", "coa_tools", "puppet2d".

**There is no maintained, permissively licensed, browser-based 2D cutout rig *editor*.**
That is a finding, not a gap in the search. The landscape sorts cleanly into three
piles and none of them is what riff is:

| Pile | Examples | Why it is not riff |
|---|---|---|
| Permissively licensed **runtimes**, no editor | Rive runtime, DragonBones, Inochi2D, Creature | Excellent porting sources. That is the whole point. |
| Permissively licensed **editors**, desktop native | nijigenerate (D), inochi-creator (D) | Not a browser tool, and the paradigm is Live2D-style parameters rather than cutout bones. |
| Browser editors | skel2d (54 stars, no licence, dead 2019), icebones (0 stars, no licence), bonehead (2 stars, no licence), DragonBones DesignPanel (MIT but the 2013 Flash-era one, no mesh or weight tooling) | Either unlicensed or trivial. |

Everything well starred and browser adjacent is copyleft (SkelForm, Synfig, coa_tools).
Everything commercial is closed (Spine, Rive, Moho, Toon Boom, Character Animator,
Live2D, DragonBones Pro).

So riff is not duplicating something that already exists. It is assembling one from
runtime-quality parts, which is why every phase in `plan.md` names a specific algorithm
to port rather than a library to install. The complete permissive kit is small enough
to list in one paragraph: Rive's `weight.cpp` plus `cubic_weight.hpp` plus `skin.cpp`
for skinning, Rive's `ik_constraint.cpp solve2` or DragonBones's `Constraint.ts
_computeB` for two bone IK, DragonBones's `Bone.ts _updateGlobalTransformMatrix` for
the hierarchy, Inochi2D's `param/` tree for the turn slider and `simplephysics.d` for
the springs, perfect-freehand for the brush, imagetracerjs for the trace, and
DragonBones Tools' `dragonBonesFormat.ts` as a proven schema to adapt. A few hundred
lines each, all MIT or BSD.

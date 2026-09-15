import { describe, expect, test } from "bun:test";
import { type AgentTool, createAgentTools } from "./agent-tools";
import type { LayerId } from "./model/document";
import { EditorStore } from "./store";

interface Described {
  id: LayerId;
  name: string;
  depth: number;
  parentId: LayerId | null;
  joint: { x: number; y: number };
  transform: Record<string, number>;
  depthValue: number;
  overlap: number;
  variants: { name: string; active: boolean }[];
  visible: boolean;
  locked: boolean;
}

/** Every tool name the surface is required to carry. */
const REQUIRED = [
  "newDocument",
  "loadSample",
  "listLayers",
  "select",
  "drawStroke",
  "rect",
  "ellipse",
  "join",
  "union",
  "subtract",
  "intersect",
  "simplify",
  "attach",
  "setJoint",
  "setTransform",
  "setOverlap",
  "addVariant",
  "setVariant",
  "mirror",
  "group",
  "reorder",
  "setPlayhead",
  "key",
  "keyAll",
  "play",
  "pause",
  "exportJson",
  "importJson",
  "exportPlayerHtml",
  "undo",
  "redo",
  "state",
  "screenshotHints",
];

/** Names actually exercised, so the suite cannot quietly stop covering one. */
const exercised = new Set<string>();

function setup() {
  const store = new EditorStore();
  const tools = createAgentTools(store);
  const byName = new Map<string, AgentTool>(
    tools.map((tool) => [tool.name, tool]),
  );

  const call = <T>(name: string, input: Record<string, unknown> = {}): T => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`No tool called ${name}`);
    exercised.add(name);
    return tool.execute(input) as T;
  };

  const layers = () => call<Described[]>("listLayers");
  const named = (name: string): Described => {
    const found = layers().find((layer) => layer.name === name);
    if (!found) throw new Error(`No part called ${name}`);
    return found;
  };

  return { store, tools, call, layers, named };
}

/** A square drawn as four corners, so `closed` has to be honoured explicitly. */
const SQUARE = [
  [0, 0, 0.5],
  [80, 0, 0.5],
  [80, 80, 0.5],
  [0, 80, 0.5],
];

describe("the tool surface", () => {
  test("carries every required tool, each with a description and a schema", () => {
    const { tools } = setup();
    const names = tools.map((tool) => tool.name);
    for (const required of REQUIRED) expect(names).toContain(required);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(8);
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.execute).toBe("function");
    }
  });

  test("has no duplicate names", () => {
    const { tools } = setup();
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });
});

describe("documents", () => {
  test("starts empty and loads the sample", () => {
    const { call, layers } = setup();
    expect(call<{ layers: number }>("newDocument").layers).toBe(0);
    expect(layers()).toHaveLength(0);

    expect(call<{ layers: number }>("loadSample").layers).toBe(7);
    expect(layers().map((l) => l.name)).toEqual([
      "Torso",
      "Head",
      "Face",
      "Leg",
      "Upper arm",
      "Forearm",
      "Hand",
    ]);
  });

  test("listLayers reports the skeleton and the joint", () => {
    const { call, named } = setup();
    call("loadSample");
    const hand = named("Hand");
    const forearm = named("Forearm");
    expect(hand.parentId).toBe(forearm.id);
    expect(hand.depth).toBe(3);
    expect(Number.isFinite(hand.joint.x)).toBe(true);
    expect(hand.variants[0].active).toBe(true);
  });

  test("state reports what the editor is showing", () => {
    const { call } = setup();
    call("loadSample");
    call("setPlayhead", { frame: 12 });
    const state = call<{
      name: string;
      fps: number;
      frameCount: number;
      layerCount: number;
      artboard: { width: number; height: number };
      ui: { frame: number; tool: string; selection: string[] };
    }>("state");
    expect(state.name).toBe("Sample character");
    expect(state.fps).toBe(24);
    expect(state.frameCount).toBe(48);
    expect(state.layerCount).toBe(7);
    expect(state.artboard.width).toBeGreaterThan(0);
    expect(state.ui.frame).toBe(12);
  });
});

describe("selecting", () => {
  test("selects and clears", () => {
    const { call, named } = setup();
    call("loadSample");
    const head = named("Head");
    expect(
      call<{ selection: string[] }>("select", { ids: [head.id] }).selection,
    ).toEqual([head.id]);
    expect(call<{ ui: { selection: string[] } }>("state").ui.selection).toEqual(
      [head.id],
    );
    call("select", { ids: [] });
    expect(call<{ ui: { selection: string[] } }>("state").ui.selection).toEqual(
      [],
    );
  });

  test("refuses an id that does not exist", () => {
    const { call } = setup();
    call("loadSample");
    expect(() => call("select", { ids: ["nope"] })).toThrow(/no part/i);
  });
});

describe("drawing", () => {
  test("a stroke becomes a part and shows up in the list", () => {
    const { call, layers } = setup();
    call("newDocument");
    const before = layers().length;
    const { id } = call<{ id: LayerId }>("drawStroke", {
      points: SQUARE,
      closed: true,
      name: "Blob",
    });
    const after = layers();
    expect(after).toHaveLength(before + 1);
    expect(after.some((l) => l.id === id && l.name === "Blob")).toBe(true);
    expect(call<{ ui: { selection: string[] } }>("state").ui.selection).toEqual(
      [id],
    );
  });

  test("a rectangle and an oval become parts", () => {
    const { call, layers } = setup();
    call("newDocument");
    call("rect", { x: 0, y: 0, width: 50, height: 40, name: "Box" });
    call("ellipse", { cx: 60, cy: 20, rx: 30, ry: 20, name: "Egg" });
    expect(layers().map((l) => l.name)).toContain("Box");
    expect(layers().map((l) => l.name)).toContain("Egg");
  });

  test("an explicit colour is honoured, and null means an open line", () => {
    const { call, store } = setup();
    call("newDocument");
    const red = call<{ id: LayerId }>("rect", {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fill: "#ff0000",
    });
    const open = call<{ id: LayerId }>("drawStroke", {
      points: [
        [0, 0],
        [100, 100],
      ],
      fill: null,
    });
    const doc = store.getState().doc;
    expect(doc.layers[red.id].variants[0].fill).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 1,
    });
    expect(doc.layers[open.id].variants[0].fill).toBeNull();
  });

  test("a stroke of one point is refused", () => {
    const { call } = setup();
    call("newDocument");
    expect(() => call("drawStroke", { points: [[0, 0]] })).toThrow(
      /at least two points/i,
    );
  });
});

describe("shapes", () => {
  test("union leaves one part holding the combined outline", () => {
    const { call, layers } = setup();
    call("newDocument");
    const a = call<{ id: LayerId }>("rect", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      name: "A",
    });
    const b = call<{ id: LayerId }>("rect", {
      x: 50,
      y: 50,
      width: 100,
      height: 100,
      name: "B",
    });
    expect(layers()).toHaveLength(2);

    const result = call<{ id: LayerId }>("union", { ids: [a.id, b.id] });
    expect(result.id).toBe(a.id);
    const after = layers();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(a.id);
  });

  test("subtract and intersect each collapse two parts into one", () => {
    for (const op of ["subtract", "intersect"]) {
      const { call, layers } = setup();
      call("newDocument");
      const a = call<{ id: LayerId }>("rect", {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      });
      const b = call<{ id: LayerId }>("rect", {
        x: 40,
        y: 40,
        width: 100,
        height: 100,
      });
      call(op, { ids: [a.id, b.id] });
      expect(layers()).toHaveLength(1);
      expect(layers()[0].id).toBe(a.id);
    }
  });

  test("combining needs exactly two parts", () => {
    const { call } = setup();
    call("newDocument");
    const a = call<{ id: LayerId }>("rect", {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(() => call("union", { ids: [a.id] })).toThrow(/exactly two/i);
  });

  test("join folds several parts into the first one", () => {
    const { call, layers, store } = setup();
    call("newDocument");
    const a = call<{ id: LayerId }>("drawStroke", {
      points: [
        [0, 0],
        [80, 0],
      ],
      name: "Top",
    });
    const b = call<{ id: LayerId }>("drawStroke", {
      points: [
        [80, 0],
        [80, 80],
      ],
      name: "Side",
    });
    const c = call<{ id: LayerId }>("drawStroke", {
      points: [
        [80, 80],
        [0, 80],
      ],
      name: "Bottom",
    });
    expect(layers()).toHaveLength(3);

    call("join", { ids: [a.id, b.id, c.id] });
    const after = layers();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(a.id);

    const doc = store.getState().doc;
    const pathId = doc.layers[a.id].variants[0].pathIds[0];
    expect(doc.paths[pathId].subpathClosed[0]).toBe(1);
  });

  test("simplify drops points and keeps the part", () => {
    const { call, layers } = setup();
    call("newDocument");
    const points: number[][] = [];
    for (let i = 0; i <= 200; i++) points.push([i, 0]);
    const { id } = call<{ id: LayerId }>("drawStroke", { points });

    const result = call<{ pointsBefore: number; pointsAfter: number }>(
      "simplify",
      { id, tolerance: 1 },
    );
    expect(result.pointsAfter).toBeLessThan(result.pointsBefore);
    expect(result.pointsAfter).toBeGreaterThanOrEqual(2);
    expect(layers()).toHaveLength(1);
  });
});

describe("the skeleton", () => {
  test("attach changes the parent, and null detaches", () => {
    const { call, named } = setup();
    call("loadSample");
    const hand = named("Hand");
    const torso = named("Torso");

    const moved = call<Described>("attach", {
      childId: hand.id,
      parentId: torso.id,
    });
    expect(moved.parentId).toBe(torso.id);
    expect(named("Hand").parentId).toBe(torso.id);

    call("attach", { childId: hand.id, parentId: null });
    expect(named("Hand").parentId).toBeNull();
  });

  test("setJoint moves the joint", () => {
    const { call, named } = setup();
    call("loadSample");
    const head = named("Head");
    const before = head.joint;
    const after = call<Described>("setJoint", {
      id: head.id,
      x: before.x + 30,
      y: before.y + 15,
    });
    expect(after.joint.x).toBeCloseTo(before.x + 30, 6);
    expect(after.joint.y).toBeCloseTo(before.y + 15, 6);
    expect(named("Head").joint.x).toBeCloseTo(before.x + 30, 6);
  });

  test("setOverlap clamps to the range the renderer understands", () => {
    const { call, named } = setup();
    call("loadSample");
    const leg = named("Leg");
    expect(
      call<Described>("setOverlap", { id: leg.id, overlap: 9 }).overlap,
    ).toBe(3);
    expect(
      call<Described>("setOverlap", { id: leg.id, overlap: -4 }).overlap,
    ).toBe(0);
  });

  test("group attaches the selection to one new joint", () => {
    const { call, named, store } = setup();
    call("loadSample");
    const leg = named("Leg");
    const head = named("Head");
    const { id } = call<{ id: LayerId | null }>("group", {
      ids: [leg.id, head.id],
    });
    expect(id).not.toBeNull();
    if (!id) throw new Error("no group");
    const doc = store.getState().doc;
    expect(doc.layers[leg.id].parentLayerId).toBe(id);
    expect(doc.layers[head.id].parentLayerId).toBe(id);
  });

  test("mirror makes a flipped copy of the whole chain and selects it", () => {
    const { call, named, layers } = setup();
    call("loadSample");
    const arm = named("Upper arm");
    const before = layers().length;
    const { ids } = call<{ ids: LayerId[] }>("mirror", { id: arm.id });

    // The upper arm carries its forearm and hand: an arm mirrored without them
    // is not the other arm.
    expect(ids).toHaveLength(3);
    expect(layers()).toHaveLength(before + 3);
    const names = layers()
      .filter((layer) => ids.includes(layer.id))
      .map((layer) => layer.name);
    expect(names).toContain("Upper arm mirrored");
    expect(names).toContain("Forearm mirrored");
    expect(names).toContain("Hand mirrored");

    // The copied chain hangs off itself, not off the original.
    const copied = layers().filter((layer) => ids.includes(layer.id));
    const copiedArm = copied.find((l) => l.name === "Upper arm mirrored");
    const copiedForearm = copied.find((l) => l.name === "Forearm mirrored");
    const copiedHand = copied.find((l) => l.name === "Hand mirrored");
    expect(copiedForearm?.parentId).toBe(copiedArm?.id);
    expect(copiedHand?.parentId).toBe(copiedForearm?.id);

    expect(call<{ ui: { selection: string[] } }>("state").ui.selection).toEqual(
      ids,
    );
  });

  test("reorder moves a part through the draw order", () => {
    const { call, named } = setup();
    call("loadSample");
    const face = named("Face");
    const order = call<{ order: LayerId[] }>("reorder", {
      id: face.id,
      index: 0,
    }).order;
    expect(order[0]).toBe(face.id);
  });
});

describe("transforms and drawings", () => {
  test("setTransform writes a constant when nothing is animated", () => {
    const { call, named } = setup();
    call("loadSample");
    const leg = named("Leg");
    const after = call<Described>("setTransform", {
      id: leg.id,
      x: 12,
      rotation: 20,
      skewX: 8,
    });
    expect(after.transform.x).toBeCloseTo(12, 6);
    expect(after.transform.rotation).toBeCloseTo(20, 6);
    expect(after.transform.skewX).toBeCloseTo(8, 6);
  });

  test("setTransform keys at the playhead when the property is animated", () => {
    const { call, named, store } = setup();
    call("loadSample");
    const arm = named("Upper arm");
    // The sample already animates the upper arm's rotation.
    const before = Object.keys(store.getState().doc.tracks).length;
    call("setPlayhead", { frame: 6 });
    call("setTransform", { id: arm.id, rotation: -45 });
    expect(Object.keys(store.getState().doc.tracks)).toHaveLength(before);
    expect(named("Upper arm").transform.rotation).toBeCloseTo(-45, 6);
    call("setPlayhead", { frame: 0 });
    expect(named("Upper arm").transform.rotation).toBeCloseTo(0, 6);
  });

  test("setTransform needs at least one number", () => {
    const { call, named } = setup();
    call("loadSample");
    expect(() => call("setTransform", { id: named("Leg").id })).toThrow(
      /at least one number/i,
    );
  });

  test("addVariant and setVariant give a part a second drawing", () => {
    const { call, named } = setup();
    call("loadSample");
    const hand = named("Hand");
    const added = call<Described>("addVariant", {
      id: hand.id,
      name: "Fist",
    });
    expect(added.variants.map((v) => v.name)).toEqual(["Default", "Fist"]);

    const shown = call<Described>("setVariant", { id: hand.id, name: "Fist" });
    expect(shown.variants.find((v) => v.name === "Fist")?.active).toBe(true);
    expect(named("Hand").variants.find((v) => v.name === "Fist")?.active).toBe(
      true,
    );
  });

  test("addVariant can borrow the shape of another part", () => {
    const { call, named, store } = setup();
    call("loadSample");
    const hand = named("Hand");
    const head = named("Head");
    call("addVariant", { id: hand.id, name: "Big", fromIds: [head.id] });
    const doc = store.getState().doc;
    const big = doc.layers[hand.id].variants.find((v) => v.name === "Big");
    if (!big) throw new Error("no variant");
    const geometry = doc.paths[big.pathIds[0]];
    // The head is far larger than the hand, so borrowing it must change size.
    expect(geometry.bounds[2] - geometry.bounds[0]).toBeGreaterThan(100);
  });

  test("setVariant refuses a name the part does not have", () => {
    const { call, named } = setup();
    call("loadSample");
    expect(() =>
      call("setVariant", { id: named("Leg").id, name: "Nope" }),
    ).toThrow(/no drawing called/i);
  });
});

describe("time", () => {
  test("setPlayhead clamps to the document", () => {
    const { call } = setup();
    call("loadSample");
    expect(call<{ frame: number }>("setPlayhead", { frame: 9999 }).frame).toBe(
      47,
    );
    expect(call<{ frame: number }>("setPlayhead", { frame: -5 }).frame).toBe(0);
  });

  test("key remembers a part at the playhead", () => {
    const { call, named, store } = setup();
    call("loadSample");
    const leg = named("Leg");
    expect(leg.transform.rotation).toBe(0);

    call("setPlayhead", { frame: 10 });
    const result = call<{ keyed: LayerId[]; frame: number }>("key", {
      ids: [leg.id],
    });
    expect(result.keyed).toEqual([leg.id]);
    expect(result.frame).toBe(10);

    const doc = store.getState().doc;
    expect(doc.layers[leg.id].transform.rotation.kind).toBe("track");
  });

  test("key defaults to the selection and refuses an empty one", () => {
    const { call, named, store } = setup();
    call("loadSample");
    const leg = named("Leg");
    call("select", { ids: [leg.id] });
    call("key", {});
    expect(store.getState().doc.layers[leg.id].transform.x.kind).toBe("track");

    call("select", { ids: [] });
    expect(() => call("key", {})).toThrow(/select a part/i);
  });

  test("key refuses a property that is not animatable", () => {
    const { call, named } = setup();
    call("loadSample");
    expect(() =>
      call("key", { ids: [named("Leg").id], props: ["colour"] }),
    ).toThrow(/not something a part can animate/i);
  });

  test("keyAll keys every part at once", () => {
    const { call, store } = setup();
    call("loadSample");
    call("setPlayhead", { frame: 20 });
    const result = call<{ keyed: number; frame: number }>("keyAll", {});
    expect(result.keyed).toBe(7);
    expect(result.frame).toBe(20);
    // A part that already animates something is keyed on that; a part that has
    // never moved is seeded with a pose. Either way it now holds a key.
    for (const layer of Object.values(store.getState().doc.layers)) {
      const animated = [
        layer.transform.rotation,
        layer.transform.x,
        layer.transform.y,
        layer.variant,
      ].filter((prop) => prop.kind === "track");
      expect(animated.length).toBeGreaterThan(0);
    }
  });

  test("play and pause flip the transport", () => {
    const { call } = setup();
    call("loadSample");
    expect(call<{ playing: boolean }>("play", {}).playing).toBe(true);
    expect(call<{ ui: { playing: boolean } }>("state").ui.playing).toBe(true);
    expect(call<{ playing: boolean }>("pause", {}).playing).toBe(false);
    expect(call<{ ui: { playing: boolean } }>("state").ui.playing).toBe(false);
  });
});

describe("files", () => {
  test("a project round-trips through export and import", () => {
    const { call, layers } = setup();
    call("loadSample");
    const before = layers().map((l) => `${l.depth}:${l.name}`);
    const json = call<string>("exportJson", {});
    expect(typeof json).toBe("string");
    expect(JSON.parse(json).format).toBe("riff-rig");

    call("newDocument");
    expect(layers()).toHaveLength(0);

    expect(call<{ layers: number }>("importJson", { json }).layers).toBe(7);
    expect(layers().map((l) => `${l.depth}:${l.name}`)).toEqual(before);
  });

  test("import also reads a prototype file", () => {
    const { call, layers } = setup();
    const prototype = JSON.stringify({
      v: 3,
      parts: [
        {
          id: "body",
          name: "Body",
          pivot: [10, 10],
          variants: [
            { name: "default", kind: "path", d: "M0 0 L20 0 L20 20 Z", ink: 4 },
          ],
        },
      ],
      poses: {},
      anim: [],
    });
    expect(
      call<{ layers: number }>("importJson", { json: prototype }).layers,
    ).toBe(1);
    expect(layers()[0].name).toBe("Body");
  });

  test("import refuses something that is not a file", () => {
    const { call } = setup();
    expect(() => call("importJson", { json: "not json" })).toThrow(
      /not a rig file/i,
    );
  });

  test("the player is a single standalone page", () => {
    const { call } = setup();
    call("loadSample");
    const html = call<string>("exportPlayerHtml", {});
    expect(html).toContain("<canvas");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("window.rig");
    expect(html).not.toContain("<script src");
  });
});

describe("history", () => {
  test("undo puts back a part that was joined away, and redo takes it again", () => {
    const { call, layers } = setup();
    call("newDocument");
    const a = call<{ id: LayerId }>("drawStroke", {
      points: [
        [0, 0],
        [50, 0],
      ],
    });
    const b = call<{ id: LayerId }>("drawStroke", {
      points: [
        [50, 0],
        [50, 50],
      ],
    });
    expect(layers()).toHaveLength(2);

    call("join", { ids: [a.id, b.id] });
    expect(layers()).toHaveLength(1);

    call("undo", {});
    expect(layers()).toHaveLength(2);
    expect(layers().some((l) => l.id === b.id)).toBe(true);

    call("redo", {});
    expect(layers()).toHaveLength(1);
  });

  test("a failed tool leaves the history usable", () => {
    const { call, layers } = setup();
    call("loadSample");
    expect(() => call("simplify", { id: "missing" })).toThrow();
    // The transaction the failure opened must not swallow the next edit.
    const leg = layers().find((l) => l.name === "Leg");
    if (!leg) throw new Error("no leg");
    call("setTransform", { id: leg.id, x: 42 });
    call("undo", {});
    const after = layers().find((l) => l.name === "Leg");
    expect(after?.transform.x).toBe(0);
  });
});

describe("aiming a click", () => {
  test("screenshotHints reports a box per drawn part, in screen pixels", () => {
    const { call, store } = setup();
    call("loadSample");
    store.setUi({ viewport: { x: 100, y: 50, scale: 2 } });

    const hints = call<{
      layers: { id: LayerId; name: string; rect: Record<string, number> }[];
      artboard: Record<string, number>;
    }>("screenshotHints", {});

    expect(hints.layers.length).toBe(7);
    for (const layer of hints.layers) {
      expect(layer.name.length).toBeGreaterThan(0);
      for (const value of Object.values(layer.rect)) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(layer.rect.width).toBeGreaterThan(0);
    }

    const artboard = store.getState().doc.artboards[store.activeArtboardId];
    expect(hints.artboard.x).toBe(100);
    expect(hints.artboard.y).toBe(50);
    expect(hints.artboard.width).toBe(artboard.width * 2);
  });
});

describe("coverage", () => {
  test("every required tool was actually run", () => {
    expect([...REQUIRED].filter((name) => !exercised.has(name))).toEqual([]);
  });
});

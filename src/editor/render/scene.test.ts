import { describe, expect, test } from "bun:test";
import {
  constant,
  emptyDocument,
  type LayerId,
  newPart,
  newVariant,
  type RiffDocument,
} from "../model/document";
import { contoursToGeometry } from "../model/polyline";
import { addPart } from "../model/rig";
import { resolveScene } from "./scene";

function square(x: number, size: number) {
  return contoursToGeometry([
    { points: [x, 0, x + size, 0, x + size, size, x, size], closed: true },
  ]);
}

/** Three overlapping squares, listed back to front. */
function stack(): { doc: RiffDocument; ids: LayerId[] } {
  let doc = emptyDocument(200, 200, 24);
  const ids: LayerId[] = [];
  for (let i = 0; i < 3; i++) {
    const geometry = square(i * 20, 60);
    doc = { ...doc, paths: { ...doc.paths, [geometry.id]: geometry } };
    const part = newPart(doc.activeArtboardId, {
      name: `Part ${i}`,
      variants: [newVariant({ pathIds: [geometry.id] })],
    });
    doc = addPart(doc, part);
    ids.push(part.id);
  }
  return { doc, ids };
}

describe("draw order", () => {
  test("follows the artboard list when nothing has depth", () => {
    const { doc, ids } = stack();
    expect(resolveScene(doc, 0).items.map((i) => i.layerId)).toEqual(ids);
  });

  test("depth re-sorts the stack, and ties keep the list order", () => {
    const { doc, ids } = stack();
    const lifted: RiffDocument = {
      ...doc,
      layers: {
        ...doc.layers,
        [ids[0]]: { ...doc.layers[ids[0]], depth: constant(5) },
      },
    };
    expect(resolveScene(lifted, 0).items.map((i) => i.layerId)).toEqual([
      ids[1],
      ids[2],
      ids[0],
    ]);
  });

  test("a hidden part takes its children with it", () => {
    const { doc, ids } = stack();
    const hidden: RiffDocument = {
      ...doc,
      layers: {
        ...doc.layers,
        [ids[0]]: { ...doc.layers[ids[0]], visible: false },
        [ids[1]]: { ...doc.layers[ids[1]], parentLayerId: ids[0] },
      },
    };
    expect(resolveScene(hidden, 0).items.map((i) => i.layerId)).toEqual([
      ids[2],
    ]);
  });

  test("a part with no drawing is not in the list at all", () => {
    const { doc, ids } = stack();
    const emptied: RiffDocument = {
      ...doc,
      layers: {
        ...doc.layers,
        [ids[1]]: { ...doc.layers[ids[1]], variants: [] },
      },
    };
    expect(resolveScene(emptied, 0).items).toHaveLength(2);
  });
});

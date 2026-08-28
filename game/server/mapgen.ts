/**
 * Map generation.
 *
 * A hand-tuned generator rather than a file format: Phase A needs a playable
 * space, not an editor. Deterministic from a seed so a match can be reproduced
 * exactly, which matters once self-play starts comparing AI runs.
 */
import { Terrain, type MapData, type SupplyNode } from "../shared/types.js";

/** Small deterministic PRNG (mulberry32). Seeded runs must be reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateMap(width = 64, height = 64, seed = 1): MapData {
  const rand = rng(seed);
  const tiles = new Uint8Array(width * height);
  tiles.fill(Terrain.Ground);

  const set = (x: number, y: number, t: Terrain) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    tiles[y * width + x] = t;
  };

  // A few rough-ground patches to give movement some texture.
  for (let i = 0; i < 14; i++) {
    const cx = Math.floor(rand() * width);
    const cy = Math.floor(rand() * height);
    const r = 2 + Math.floor(rand() * 4);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.hypot(x - cx, y - cy) <= r) set(x, y, Terrain.Rough);
      }
    }
  }

  // Cliffs as obstacles to path around. Kept away from the map edges and the
  // centre band so the two start areas stay connected.
  for (let i = 0; i < 10; i++) {
    const cx = 8 + Math.floor(rand() * (width - 16));
    const cy = 8 + Math.floor(rand() * (height - 16));
    const len = 3 + Math.floor(rand() * 6);
    const horizontal = rand() < 0.5;
    for (let j = 0; j < len; j++) {
      set(horizontal ? cx + j : cx, horizontal ? cy : cy + j, Terrain.Cliff);
    }
  }

  // Keep every start corner clear so nobody spawns inside a rock.
  for (const [sx, sy] of [
    [4, 4],
    [width - 5, height - 5],
    [width - 5, 4],
    [4, height - 5],
  ] as const) {
    for (let y = sy - 3; y <= sy + 3; y++) {
      for (let x = sx - 3; x <= sx + 3; x++) set(x, y, Terrain.Ground);
    }
  }

  return { width, height, tiles };
}

/**
 * Supply deposits: one pair near each start so both players have a safe
 * opening income, plus contested piles in the middle worth fighting over.
 * That shape is what gives an RTS map its early game and its mid game.
 */
export function generateSupplyNodes(map: MapData): SupplyNode[] {
  const nodes: SupplyNode[] = [];
  let id = 1;
  const add = (x: number, y: number, amount: number) => nodes.push({ id: id++, x, y, amount });

  const w = map.width;
  const h = map.height;

  // Safe income beside each base.
  add(9.5, 4.5, 6000);
  add(4.5, 9.5, 6000);
  add(w - 9.5, h - 4.5, 6000);
  add(w - 4.5, h - 9.5, 6000);

  // Contested centre.
  add(w / 2, h / 2, 10000);
  add(w / 2 - 6, h / 2 + 6, 8000);
  add(w / 2 + 6, h / 2 - 6, 8000);

  return nodes;
}

/**
 * Canonical start positions, matching the cleared corners above.
 *
 * Four of them, and the server refuses players beyond this count: with fewer
 * starts than players, a late joiner spawns on top of an existing base, their
 * command centre fails to place, and their entire tech tree stays silently
 * locked.
 */
export function startPositions(map: MapData): Array<{ x: number; y: number }> {
  return [
    { x: 4.5, y: 4.5 },
    { x: map.width - 4.5, y: map.height - 4.5 },
    { x: map.width - 4.5, y: 4.5 },
    { x: 4.5, y: map.height - 4.5 },
  ];
}

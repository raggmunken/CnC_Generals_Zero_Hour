/**
 * Map generation.
 *
 * A generator rather than a file format: what a match needs is a fair playable
 * space, not an editor. Deterministic from a seed so a match can be reproduced
 * exactly, which matters once self-play starts comparing AI runs.
 */
import { mapPreset } from "../shared/content.js";
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

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Start positions evenly spaced around a circle.
 *
 * Hardcoded corners do not generalise: with fewer starts than players, a late
 * joiner spawns on top of an existing base, their command centre fails to
 * place, and their whole tech tree stays silently locked. Even angles are
 * symmetric by construction for any player count.
 */
export function startPositions(size: number, players: number): Vec2[] {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.36;
  const out: Vec2[] = [];
  for (let i = 0; i < players; i++) {
    // Start at the top and go clockwise, so a duel is top-versus-bottom.
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / players;
    out.push({
      x: Math.round(cx + Math.cos(angle) * radius) + 0.5,
      y: Math.round(cy + Math.sin(angle) * radius) + 0.5,
    });
  }
  return out;
}

/** Clear a square of ground so nothing spawns inside a rock. */
function clearArea(tiles: Uint8Array, size: number, cx: number, cy: number, r: number): void {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      tiles[y * size + x] = Terrain.Ground;
    }
  }
}

/**
 * Build a map sized for the given player count, along with its start
 * positions. The two are returned together because clearing the start areas
 * depends on knowing where they are.
 */
export function generateMap(players = 2, seed = 1): { map: MapData; starts: Vec2[] } {
  const preset = mapPreset(players);
  const size = preset.size;
  const rand = rng(seed);
  const tiles = new Uint8Array(size * size);
  tiles.fill(Terrain.Ground);

  const set = (x: number, y: number, t: Terrain) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    tiles[y * size + x] = t;
  };

  // Rough-ground patches, to give movement some texture. Count scales with
  // area so a larger map is not proportionally emptier.
  const patches = Math.round((size * size) / 300);
  for (let i = 0; i < patches; i++) {
    const cx = Math.floor(rand() * size);
    const cy = Math.floor(rand() * size);
    const r = 2 + Math.floor(rand() * 4);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.hypot(x - cx, y - cy) <= r) set(x, y, Terrain.Rough);
      }
    }
  }

  // Cliffs as obstacles to path around, kept off the map edges.
  const cliffs = Math.round((size * size) / 420);
  for (let i = 0; i < cliffs; i++) {
    const cx = 8 + Math.floor(rand() * (size - 16));
    const cy = 8 + Math.floor(rand() * (size - 16));
    const len = 3 + Math.floor(rand() * 6);
    const horizontal = rand() < 0.5;
    for (let j = 0; j < len; j++) {
      set(horizontal ? cx + j : cx, horizontal ? cy : cy + j, Terrain.Cliff);
    }
  }

  const starts = startPositions(size, preset.players);
  for (const s of starts) clearArea(tiles, size, s.x, s.y, 5);

  return { map: { width: size, height: size, tiles }, starts };
}

/**
 * Supply deposits: two beside each start so every player has a safe opening
 * income, plus a contested centre cluster worth fighting over. That shape is
 * what gives a map an early game and a mid game.
 */
export function generateSupplyNodes(map: MapData, starts: Vec2[]): SupplyNode[] {
  const nodes: SupplyNode[] = [];
  let id = 1;
  const add = (x: number, y: number, amount: number) =>
    nodes.push({ id: id++, x, y, amount });

  const cx = map.width / 2;
  const cy = map.height / 2;

  for (const s of starts) {
    // Offset the safe piles perpendicular to the line toward the centre, so
    // they sit beside the base rather than in front of or behind it.
    const dx = cx - s.x;
    const dy = cy - s.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len;
    const py = dx / len;
    add(s.x + px * 6, s.y + py * 6, 6000);
    add(s.x - px * 6, s.y - py * 6, 6000);
  }

  // Contested centre, scaled so more players means more to fight over.
  add(cx, cy, 10000);
  const ring = Math.max(2, starts.length);
  for (let i = 0; i < ring; i++) {
    const angle = (2 * Math.PI * i) / ring + Math.PI / ring;
    add(cx + Math.cos(angle) * map.width * 0.12, cy + Math.sin(angle) * map.height * 0.12, 8000);
  }

  return nodes;
}

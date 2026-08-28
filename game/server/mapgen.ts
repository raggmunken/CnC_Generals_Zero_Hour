/**
 * Map generation.
 *
 * A generator rather than a file format: what a match needs is a fair playable
 * space, not an editor. Deterministic from a seed so a match can be reproduced
 * exactly, which matters once self-play starts comparing AI runs.
 */
import { mapPreset } from "../shared/content.js";
import { isPassable, Terrain, type MapData, type SupplyNode } from "../shared/types.js";

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

  const blob = (cx: number, cy: number, r: number, t: Terrain) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        // Ragged edge: a perfect circle reads as artificial immediately.
        if (Math.hypot(x - cx, y - cy) <= r * (0.75 + rand() * 0.35)) set(x, y, t);
      }
    }
  };

  // Rough ground, for texture and to slow a push through it. Counts scale with
  // area so a larger map is not proportionally emptier.
  for (let i = 0; i < Math.round((size * size) / 300); i++) {
    blob(rand() * size, rand() * size, 2 + rand() * 4, Terrain.Rough);
  }

  // Ocean along one or two edges: a hard back wall that shapes where fighting
  // can happen without eating the middle of the map.
  const oceanEdges = rand() < 0.45 ? 2 : 1;
  const edges = [0, 1, 2, 3].sort(() => rand() - 0.5).slice(0, oceanEdges);
  for (const edge of edges) {
    const depth = Math.round(size * (0.05 + rand() * 0.05));
    for (let d = 0; d < depth; d++) {
      // Wobble the shoreline so it is not a ruled line.
      const wob = Math.round(Math.sin(d * 0.7 + rand()) * 1.5);
      for (let k = 0; k < size; k++) {
        const t = d + wob;
        if (edge === 0) set(k, t, Terrain.Water);
        else if (edge === 1) set(k, size - 1 - t, Terrain.Water);
        else if (edge === 2) set(t, k, Terrain.Water);
        else set(size - 1 - t, k, Terrain.Water);
      }
    }
  }

  // A river across the map, with fords punched through it. A river without
  // crossings is a wall, and a wall down the middle is an unplayable map --
  // the fords are what make it a chokepoint instead.
  if (rand() < 0.75) {
    const vertical = rand() < 0.5;
    let drift = size / 2 + (rand() - 0.5) * size * 0.2;
    const width = 2 + Math.floor(rand() * 2);
    const fordAt = [0.3, 0.68].map((f) => Math.round(size * f + (rand() - 0.5) * size * 0.1));
    const fordHalf = 4;

    for (let k = 0; k < size; k++) {
      drift += (rand() - 0.5) * 1.2;
      drift = Math.max(size * 0.2, Math.min(size * 0.8, drift));
      if (fordAt.some((f) => Math.abs(k - f) <= fordHalf)) continue;
      for (let w = -width; w <= width; w++) {
        const c = Math.round(drift) + w;
        if (vertical) set(c, k, Terrain.Water);
        else set(k, c, Terrain.Water);
      }
    }
  }

  // Mountains: big impassable masses to path around, kept off the edges.
  for (let i = 0; i < Math.round((size * size) / 900); i++) {
    blob(8 + rand() * (size - 16), 8 + rand() * (size - 16), 3 + rand() * 4, Terrain.Mountain);
  }

  // Tree clusters: smaller, more numerous, and they break line of sight.
  for (let i = 0; i < Math.round((size * size) / 260); i++) {
    blob(4 + rand() * (size - 8), 4 + rand() * (size - 8), 1.5 + rand() * 2.5, Terrain.Trees);
  }

  const starts = startPositions(size, preset.players);
  for (const s of starts) clearArea(tiles, size, s.x, s.y, 6);

  // Generated obstacles can trivially wall a start off from the rest of the
  // map. A map where you cannot reach the enemy is not a hard map, it is a
  // broken one, so connectivity is repaired rather than left to chance.
  connectStarts(tiles, size, starts);

  return { map: { width: size, height: size, tiles }, starts };
}

/** Tiles reachable on foot from a seed point. */
function reachableFrom(tiles: Uint8Array, size: number, sx: number, sy: number): Uint8Array {
  const seen = new Uint8Array(size * size);
  const start = Math.floor(sy) * size + Math.floor(sx);
  if (!isPassable(tiles[start] as Terrain)) return seen;

  const queue = [start];
  seen[start] = 1;
  while (queue.length > 0) {
    const at = queue.pop()!;
    const x = at % size;
    const y = (at / size) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const ni = ny * size + nx;
      if (seen[ni] || !isPassable(tiles[ni] as Terrain)) continue;
      seen[ni] = 1;
      queue.push(ni);
    }
  }
  return seen;
}

/**
 * Guarantee every start can reach every other.
 *
 * Carves a corridor from any start cut off from the first one. Straight-line
 * carving is crude, but a crude corridor beats a map that cannot be played,
 * and the surrounding terrain still shapes the approach.
 */
function connectStarts(tiles: Uint8Array, size: number, starts: Vec2[]): void {
  if (starts.length === 0) return;
  const first = starts[0]!;

  for (let i = 1; i < starts.length; i++) {
    const s = starts[i]!;
    const seen = reachableFrom(tiles, size, first.x, first.y);
    if (seen[Math.floor(s.y) * size + Math.floor(s.x)]) continue;

    // Carve a two-wide corridor toward the first start.
    let x = s.x;
    let y = s.y;
    const steps = Math.ceil(Math.hypot(first.x - s.x, first.y - s.y));
    const dx = (first.x - s.x) / steps;
    const dy = (first.y - s.y) / steps;
    for (let step = 0; step <= steps; step++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const tx = Math.round(x) + ox;
          const ty = Math.round(y) + oy;
          if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
          const idx = ty * size + tx;
          if (!isPassable(tiles[idx] as Terrain)) tiles[idx] = Terrain.Ground;
        }
      }
      x += dx;
      y += dy;
    }
  }
}

/**
 * Supply deposits: two beside each start so every player has a safe opening
 * income, plus a contested centre cluster worth fighting over. That shape is
 * what gives a map an early game and a mid game.
 */
export function generateSupplyNodes(map: MapData, starts: Vec2[]): SupplyNode[] {
  const nodes: SupplyNode[] = [];
  let id = 1;
  const add = (x: number, y: number, amount: number) => {
    // Clamp inside the map, then clear the ground around it. A pile placed in
    // a river or inside a mountain is income nobody can ever collect.
    const cx = Math.max(2, Math.min(map.width - 3, x));
    const cy = Math.max(2, Math.min(map.height - 3, y));
    clearArea(map.tiles, map.width, cx, cy, 2);
    nodes.push({ id: id++, x: cx, y: cy, amount });
  };

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

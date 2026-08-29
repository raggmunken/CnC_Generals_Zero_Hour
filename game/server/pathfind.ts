/**
 * Grid A* over the tile map.
 *
 * Direct steering was adequate on an open field and stopped being adequate the
 * moment mountains and forests arrived: a unit sent around the far side of a
 * large mass presses into it and stalls forever. This produces a route around.
 *
 * Pure over a blocked-grid so it can be tested without a Sim.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** Minimal binary heap. A sorted array turns A* into O(n^2) on open maps. */
class MinHeap {
  private items: Array<{ node: number; f: number }> = [];

  get size(): number {
    return this.items.length;
  }

  push(node: number, f: number): void {
    this.items.push({ node, f });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent]!.f <= this.items[i]!.f) break;
      [this.items[parent], this.items[i]] = [this.items[i]!, this.items[parent]!];
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.items.length && this.items[l]!.f < this.items[smallest]!.f) smallest = l;
        if (r < this.items.length && this.items[r]!.f < this.items[smallest]!.f) smallest = r;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i]!, this.items[smallest]!];
        i = smallest;
      }
    }
    return top.node;
  }
}

const SQRT2 = Math.SQRT2;

/** Octile distance: the exact cost of moving on an 8-connected grid. */
function heuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
}

/**
 * Route between two tiles, or null if there is no way through.
 *
 * `blocked` is 1 where a unit cannot stand. `maxNodes` bounds the search so a
 * request into a sealed pocket cannot stall the tick.
 */
export function findPath(
  blocked: Uint8Array,
  width: number,
  height: number,
  from: Vec2,
  to: Vec2,
  maxNodes = 20000,
): Vec2[] | null {
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  let tx = Math.floor(to.x);
  let ty = Math.floor(to.y);

  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  if (tx < 0 || ty < 0 || tx >= width || ty >= height) return null;

  // Ordering a unit into a rock is a normal thing for a player to do. Rather
  // than refusing, walk as close as possible: find the nearest open tile.
  if (blocked[ty * width + tx]) {
    const near = nearestOpen(blocked, width, height, tx, ty, 12);
    if (!near) return null;
    tx = near.x;
    ty = near.y;
  }

  const start = sy * width + sx;
  const goal = ty * width + tx;
  if (start === goal) return [];

  // If the start tile is blocked (unit inside a building that finished on it),
  // let it move to the nearest open tile first.
  if (blocked[start]) {
    const near = nearestOpen(blocked, width, height, sx, sy, 12);
    if (!near) return null;
    const openStart = near.y * width + near.x;
    if (openStart === goal) return [{ x: near.x + 0.5, y: near.y + 0.5 }];
    const sub = findPath(blocked, width, height,
      { x: near.x + 0.5, y: near.y + 0.5 }, { x: tx + 0.5, y: ty + 0.5 }, maxNodes);
    if (!sub) return null;
    return [{ x: near.x + 0.5, y: near.y + 0.5 }, ...sub];
  }

  const gScore = new Float32Array(width * height).fill(Infinity);
  const cameFrom = new Int32Array(width * height).fill(-1);
  const closed = new Uint8Array(width * height);
  const open = new MinHeap();

  gScore[start] = 0;
  open.push(start, heuristic(sx, sy, tx, ty));

  let expanded = 0;
  while (open.size > 0) {
    const current = open.pop();
    if (closed[current]) continue;
    closed[current] = 1;

    if (current === goal) {
      // Reconstruct path.
      const out: Vec2[] = [];
      let cur = current;
      while (cur !== -1) {
        out.push({ x: (cur % width) + 0.5, y: ((cur / width) | 0) + 0.5 });
        cur = cameFrom[cur]!;
      }
      out.reverse();
      out.shift(); // drop the tile the unit is already standing on
      return out;
    }

    if (++expanded > maxNodes) break;

    const cx = current % width;
    const cy = (current / width) | 0;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

        const ni = ny * width + nx;
        if (blocked[ni] || closed[ni]) continue;

        // No cutting corners: a diagonal is only legal if both orthogonal
        // neighbours are open, or units clip through the corners of buildings.
        if (dx !== 0 && dy !== 0) {
          if (blocked[cy * width + nx] || blocked[ny * width + cx]) continue;
        }

        const step = dx !== 0 && dy !== 0 ? SQRT2 : 1;
        const tentative = gScore[current]! + step;
        if (tentative >= gScore[ni]!) continue;

        cameFrom[ni] = current;
        gScore[ni] = tentative;
        open.push(ni, tentative + heuristic(nx, ny, tx, ty));
      }
    }
  }

  return null;
}

/** Nearest open tile within a radius, for destinations inside obstacles. */
export function nearestOpen(
  blocked: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  maxR: number,
): Vec2 | null {
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (!blocked[ny * width + nx]) return { x: nx, y: ny };
      }
    }
  }
  return null;
}

/**
 * Find the nearest reachable tile to a destination.
 *
 * When A* fails (no path exists), this does a BFS from the start to find all
 * reachable tiles, then returns the one closest (by Euclidean distance) to
 * the destination. This lets the unit walk as far as it can instead of
 * grinding against a wall.
 */
export function nearestReachable(
  blocked: Uint8Array,
  width: number,
  height: number,
  from: Vec2,
  to: Vec2,
  maxR: number = 64,
): Vec2 | null {
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  const tx = Math.floor(to.x);
  const ty = Math.floor(to.y);

  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  if (tx < 0 || ty < 0 || tx >= width || ty >= height) return null;

  const start = sy * width + sx;
  if (blocked[start]) return null;

  // BFS from start, tracking the closest reachable tile to the destination.
  const visited = new Uint8Array(width * height);
  const queue: number[] = [start];
  visited[start] = 1;

  let best: Vec2 | null = null;
  let bestDist = Infinity;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const cx = current % width;
    const cy = (current / width) | 0;

    // Track closest reachable tile to destination.
    const dist = Math.hypot(cx - tx, cy - ty);
    if (dist < bestDist) {
      bestDist = dist;
      best = { x: cx + 0.5, y: cy + 0.5 };
    }

    // Stop if we've searched far enough.
    if (bestDist <= 1) break;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (visited[ni] || blocked[ni]) continue;
        // No cutting corners on diagonals.
        if (dx !== 0 && dy !== 0) {
          if (blocked[cy * width + nx] || blocked[ny * width + cx]) continue;
        }
        visited[ni] = 1;
        queue.push(ni);
      }
    }
  }

  return best;
}

/** Is the straight line between two points clear? Used to shorten paths. */
export function lineIsClear(
  blocked: Uint8Array,
  width: number,
  height: number,
  a: Vec2,
  b: Vec2,
): boolean {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2);
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const x = Math.floor(a.x + (b.x - a.x) * t);
    const y = Math.floor(a.y + (b.y - a.y) * t);
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    if (blocked[y * width + x]) return false;
  }
  return true;
}

/**
 * Drop waypoints that can be skipped in a straight line.
 *
 * Raw grid A* zigzags along tile boundaries, which looks like a unit that
 * cannot decide where it is going. Removing redundant corners is what makes
 * the movement read as deliberate.
 */
export function smoothPath(
  blocked: Uint8Array,
  width: number,
  height: number,
  from: Vec2,
  path: Vec2[],
): Vec2[] {
  if (path.length <= 1) return path;

  const out: Vec2[] = [];
  let anchor = from;
  let i = 0;

  while (i < path.length) {
    // Walk forward while the anchor still has a clear line to the candidate.
    let furthest = i;
    for (let j = path.length - 1; j >= i; j--) {
      if (lineIsClear(blocked, width, height, anchor, path[j]!)) {
        furthest = j;
        break;
      }
    }
    out.push(path[furthest]!);
    anchor = path[furthest]!;
    i = furthest + 1;
  }

  return out;
}

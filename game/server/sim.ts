/**
 * The authoritative simulation.
 *
 * Deliberately free of I/O: no sockets, no timers, no logging. step() advances
 * the world by one fixed step and nothing else. That keeps it trivially
 * testable, and lets self-play run thousands of games by calling step() in a
 * loop with no clients attached.
 */
import { unitDef } from "../shared/content.js";
import {
  isPassable,
  Terrain,
  terrainCost,
  type MapData,
  type PlayerState,
  type Unit,
} from "../shared/types.js";

/** Fixed simulation step. 15Hz is plenty for an RTS and cheap to broadcast. */
export const TICK_RATE = 15;
export const DT = 1 / TICK_RATE;

/** How close counts as arrived, in world units. */
const ARRIVE_EPSILON = 0.08;

export class Sim {
  readonly map: MapData;
  readonly players: PlayerState[] = [];
  readonly units = new Map<number, Unit>();
  tick = 0;

  private nextUnitId = 1;

  constructor(map: MapData) {
    this.map = map;
  }

  addPlayer(p: PlayerState): void {
    this.players.push(p);
  }

  spawnUnit(owner: number, type: string, x: number, y: number): Unit {
    const def = unitDef(type);
    const unit: Unit = {
      id: this.nextUnitId++,
      owner,
      type,
      x,
      y,
      hp: def.maxHp,
      targetX: null,
      targetY: null,
    };
    this.units.set(unit.id, unit);
    return unit;
  }

  /** Terrain at a world position. Out of bounds reads as cliff (impassable). */
  terrainAt(x: number, y: number): Terrain {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) {
      return Terrain.Cliff;
    }
    return this.map.tiles[ty * this.map.width + tx] as Terrain;
  }

  /**
   * Order units to a destination.
   *
   * Ownership is checked here rather than at the transport layer, so a
   * malformed or hostile client cannot move somebody else's army.
   */
  issueMove(playerId: number, unitIds: number[], x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    for (const id of unitIds) {
      const u = this.units.get(id);
      if (!u || u.owner !== playerId) continue;
      u.targetX = x;
      u.targetY = y;
    }
  }

  /** Advance the world one fixed step. */
  step(): void {
    this.tick++;
    for (const u of this.units.values()) this.moveUnit(u);
  }

  /**
   * Steer one unit toward its target.
   *
   * Phase A uses direct steering with a terrain check rather than pathfinding:
   * enough to prove the stack, and the axis-separated retry below keeps a unit
   * sliding along an obstacle instead of sticking to it, which is what makes
   * simple steering tolerable until A* lands in Phase B.
   */
  private moveUnit(u: Unit): void {
    if (u.targetX === null || u.targetY === null) return;

    const dx = u.targetX - u.x;
    const dy = u.targetY - u.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= ARRIVE_EPSILON) {
      u.x = u.targetX;
      u.y = u.targetY;
      u.targetX = null;
      u.targetY = null;
      return;
    }

    const speed = unitDef(u.type).speed / terrainCost(this.terrainAt(u.x, u.y));
    const travel = Math.min(speed * DT, dist);
    const nx = u.x + (dx / dist) * travel;
    const ny = u.y + (dy / dist) * travel;

    if (isPassable(this.terrainAt(nx, ny))) {
      u.x = nx;
      u.y = ny;
      return;
    }

    // Blocked head-on: try each axis alone so the unit slides along the
    // obstacle rather than stopping dead against it.
    if (isPassable(this.terrainAt(nx, u.y))) {
      u.x = nx;
      return;
    }
    if (isPassable(this.terrainAt(u.x, ny))) {
      u.y = ny;
      return;
    }

    // Genuinely stuck -- drop the order so the unit does not vibrate forever.
    u.targetX = null;
    u.targetY = null;
  }

  snapshotUnits(): Unit[] {
    return [...this.units.values()];
  }
}

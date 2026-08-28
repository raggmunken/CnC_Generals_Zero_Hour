/**
 * The authoritative simulation.
 *
 * Deliberately free of I/O: no sockets, no timers, no logging. step() advances
 * the world by one fixed step and nothing else. That keeps it trivially
 * testable, and lets self-play run thousands of games by calling step() in a
 * loop with no clients attached.
 */
import {
  BUILDINGS,
  buildingDef,
  LOW_POWER_SPEED,
  STARTING_CREDITS,
  unitDef,
} from "../shared/content.js";
import {
  isPassable,
  Terrain,
  terrainCost,
  type Building,
  type Economy,
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
  readonly buildings = new Map<number, Building>();
  readonly economies = new Map<number, Economy>();
  tick = 0;

  private nextUnitId = 1;
  private nextBuildingId = 1;

  constructor(map: MapData) {
    this.map = map;
  }

  addPlayer(p: PlayerState): void {
    this.players.push(p);
    this.economies.set(p.id, {
      credits: STARTING_CREDITS,
      powerProduced: 0,
      powerConsumed: 0,
    });
  }

  economy(playerId: number): Economy {
    let e = this.economies.get(playerId);
    if (!e) {
      e = { credits: 0, powerProduced: 0, powerConsumed: 0 };
      this.economies.set(playerId, e);
    }
    return e;
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

  /** Which completed building types a player owns. Drives the tech tree. */
  private completedTypes(playerId: number): Set<string> {
    const out = new Set<string>();
    for (const b of this.buildings.values()) {
      if (b.owner === playerId && b.buildRemaining === 0) out.add(b.type);
    }
    return out;
  }

  /** Are this building type's prerequisites met? */
  canBuild(playerId: number, type: string): boolean {
    const def = buildingDef(type);
    const have = this.completedTypes(playerId);
    return def.requires.every((r) => have.has(r));
  }

  /** Is the footprint clear of terrain obstacles and other buildings? */
  isAreaFree(x: number, y: number, size: number): boolean {
    for (let ty = y; ty < y + size; ty++) {
      for (let tx = x; tx < x + size; tx++) {
        if (!isPassable(this.terrainAt(tx + 0.5, ty + 0.5))) return false;
      }
    }
    for (const b of this.buildings.values()) {
      const bs = buildingDef(b.type).size;
      if (x < b.x + bs && x + size > b.x && y < b.y + bs && y + size > b.y) return false;
    }
    return true;
  }

  /**
   * Place a building. Returns null with no side effects if anything is wrong,
   * so a client cannot half-commit a purchase by sending a bad request.
   */
  placeBuilding(playerId: number, type: string, x: number, y: number): Building | null {
    if (!(type in BUILDINGS)) return null;
    const def = buildingDef(type);
    const tx = Math.floor(x);
    const ty = Math.floor(y);

    if (!this.canBuild(playerId, type)) return null;
    if (!this.isAreaFree(tx, ty, def.size)) return null;

    const eco = this.economy(playerId);
    if (eco.credits < def.cost) return null;
    eco.credits -= def.cost;

    const ticks = Math.max(1, Math.round(def.buildTime * TICK_RATE));
    const b: Building = {
      id: this.nextBuildingId++,
      owner: playerId,
      type,
      x: tx,
      y: ty,
      hp: def.maxHp,
      buildRemaining: ticks,
      buildTotal: ticks,
      queue: [],
    };
    this.buildings.set(b.id, b);
    return b;
  }

  /** Queue a unit at one of our operational buildings. */
  queueUnit(playerId: number, buildingId: number, unitType: string): boolean {
    const b = this.buildings.get(buildingId);
    if (!b || b.owner !== playerId || b.buildRemaining > 0) return false;

    const bdef = buildingDef(b.type);
    if (!bdef.produces.includes(unitType)) return false;

    const udef = unitDef(unitType);
    const eco = this.economy(playerId);
    if (eco.credits < udef.cost) return false;

    eco.credits -= udef.cost;
    const ticks = Math.max(1, Math.round(udef.buildTime * TICK_RATE));
    b.queue.push({ unitType, remaining: ticks, total: ticks });
    return true;
  }

  /** Recompute power for every player from their completed buildings. */
  private recomputePower(): void {
    for (const e of this.economies.values()) {
      e.powerProduced = 0;
      e.powerConsumed = 0;
    }
    for (const b of this.buildings.values()) {
      if (b.buildRemaining > 0) continue;
      const e = this.economy(b.owner);
      const p = buildingDef(b.type).power;
      if (p >= 0) e.powerProduced += p;
      else e.powerConsumed += -p;
    }
  }

  /**
   * Production rate for a player.
   *
   * A brownout halves output rather than stopping it. Generals stops dead,
   * which punishes without teaching; halving makes the mistake obvious and
   * still recoverable.
   */
  private buildSpeed(playerId: number): number {
    const e = this.economy(playerId);
    return e.powerConsumed > e.powerProduced ? LOW_POWER_SPEED : 1;
  }

  /** Find a free spot next to a building to place a freshly built unit. */
  private spawnPointFor(b: Building): { x: number; y: number } {
    const size = buildingDef(b.type).size;
    const cx = b.x + size / 2;
    const cy = b.y + size / 2;
    for (let ring = 1; ring <= 4; ring++) {
      for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
        const px = cx + dx * (size / 2 + ring);
        const py = cy + dy * (size / 2 + ring);
        if (isPassable(this.terrainAt(px, py))) return { x: px, y: py };
      }
    }
    return { x: cx, y: cy + size };
  }

  /** Advance the world one fixed step. */
  step(): void {
    this.tick++;
    this.recomputePower();

    for (const b of this.buildings.values()) {
      const speed = this.buildSpeed(b.owner);

      if (b.buildRemaining > 0) {
        b.buildRemaining = Math.max(0, b.buildRemaining - speed);
        continue; // A building under construction produces nothing.
      }

      const head = b.queue[0];
      if (!head) continue;
      head.remaining -= speed;
      if (head.remaining <= 0) {
        b.queue.shift();
        const at = this.spawnPointFor(b);
        this.spawnUnit(b.owner, head.unitType, at.x, at.y);
      }
    }

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

  snapshotBuildings(): Building[] {
    return [...this.buildings.values()];
  }
}

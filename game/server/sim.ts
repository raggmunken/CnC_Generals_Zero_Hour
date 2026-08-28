/**
 * The authoritative simulation.
 *
 * Deliberately free of I/O: no sockets, no timers, no logging. step() advances
 * the world by one fixed step and nothing else. That keeps it trivially
 * testable, and lets self-play run thousands of games by calling step() in a
 * loop with no clients attached.
 */
import { acquireTarget, canHarm, damageFor, rangeTo, type Combatant } from "./combat.js";
import { findPath, smoothPath } from "./pathfind.js";
import {
  BUILDINGS,
  buildingDef,
  HARVEST_CAPACITY,
  HARVEST_RATE,
  HARVEST_REACH,
  LOW_POWER_SPEED,
  STARTING_CREDITS,
  UNLOAD_RATE,
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
  type Order,
  type SupplyNode,
  type Tracer,
  type Unit,
  type WeaponDef,
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
  readonly supplyNodes = new Map<number, SupplyNode>();
  /** Shots fired this tick, for the client to draw. Cleared every step. */
  readonly tracers: Tracer[] = [];
  /** Players with nothing left. */
  readonly eliminated = new Set<number>();
  tick = 0;

  private nextUnitId = 1;
  private nextBuildingId = 1;

  /** 1 where nothing can stand: impassable terrain or a building footprint. */
  private blocked: Uint8Array;
  /**
   * The same grid inflated by one tile, for bodies wider than a tile.
   *
   * A* reasons about tile centres and would otherwise treat every unit as a
   * point, routing a wide unit through a gap its body cannot fit. A unit of
   * radius r centred on a tile centre overhangs into the orthogonal
   * neighbours whenever r > 0.5, so those tiles are unusable to it. This is
   * what "footprint" has to mean for pathing as well as for collision.
   */
  private blockedWide: Uint8Array;
  /** Set when buildings change, so the grids are rebuilt at most once a tick. */
  private blockedDirty = true;

  constructor(map: MapData) {
    this.map = map;
    this.blocked = new Uint8Array(map.width * map.height);
    this.blockedWide = new Uint8Array(map.width * map.height);
    this.rebuildBlocked();
  }

  /**
   * Recompute the pathfinding grid.
   *
   * Cached rather than tested per query: buildings change rarely and paths are
   * requested constantly, so the cost belongs on the write side.
   */
  private rebuildBlocked(): void {
    const { width, height, tiles } = this.map;
    for (let i = 0; i < tiles.length; i++) {
      this.blocked[i] = isPassable(tiles[i] as Terrain) ? 0 : 1;
    }
    for (const b of this.buildings.values()) {
      const size = buildingDef(b.type).size;
      for (let y = b.y; y < b.y + size; y++) {
        for (let x = b.x; x < b.x + size; x++) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          this.blocked[y * width + x] = 1;
        }
      }
    }
    // Inflate by one tile orthogonally. Diagonals are not needed: the widest
    // unit has radius 0.6, which overhangs an edge but never a corner.
    const { width: w, height: h } = this.map;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        this.blockedWide[i] =
          this.blocked[i] ||
          (x > 0 && this.blocked[i - 1]) ||
          (x < w - 1 && this.blocked[i + 1]) ||
          (y > 0 && this.blocked[i - w]) ||
          (y < h - 1 && this.blocked[i + w])
            ? 1
            : 0;
      }
    }

    this.blockedDirty = false;
  }

  /** The grid a body of this radius may path on. */
  private gridFor(radius: number): Uint8Array {
    return radius > 0.5 ? this.blockedWide : this.blocked;
  }

  /**
   * Send a unit somewhere, routing around obstacles.
   *
   * The single entry point for "go here", so every caller gets pathfinding
   * rather than only the ones that remembered to ask. Re-pathing is skipped
   * when the goal has barely moved, which is what stops a unit chasing a
   * moving target from recomputing a full route every tick.
   */
  private setDestination(u: Unit, x: number, y: number): void {
    u.targetX = x;
    u.targetY = y;

    const sameGoal =
      u.pathGoalX !== undefined &&
      Math.hypot(u.pathGoalX - x, (u.pathGoalY ?? 0) - y) < 1.0;
    if (sameGoal && u.path && u.path.length > 0) return;

    if (this.blockedDirty) this.rebuildBlocked();

    const grid = this.gridFor(unitDef(u.type).radius);
    const raw = findPath(grid, this.map.width, this.map.height, u, { x, y });
    if (raw === null) {
      // Nowhere to go: keep the destination so the unit still nudges toward it
      // via direct steering, rather than freezing with no explanation.
      u.path = undefined;
    } else {
      const smoothed = smoothPath(grid, this.map.width, this.map.height, u, raw);
      // The final waypoint is the tile centre; use the true destination so
      // units stop where they were told, not where the grid rounded to.
      if (smoothed.length > 0) smoothed[smoothed.length - 1] = { x, y };
      u.path = smoothed;
    }
    u.pathGoalX = x;
    u.pathGoalY = y;
    u.stuckFor = 0;
  }

  private clearPath(u: Unit): void {
    u.path = undefined;
    u.pathGoalX = undefined;
    u.pathGoalY = undefined;
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

  setSupplyNodes(nodes: SupplyNode[]): void {
    this.supplyNodes.clear();
    for (const n of nodes) this.supplyNodes.set(n.id, n);
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
    // Harvesters go to work on their own. Requiring the player to babysit
    // every one of them is busywork, not strategy.
    if (type === "harvester") {
      unit.carrying = 0;
      unit.harvest = "seeking";
      unit.auto = true;
    }
    this.units.set(unit.id, unit);
    return unit;
  }

  /** Terrain at a world position. Out of bounds reads as cliff (impassable). */
  terrainAt(x: number, y: number): Terrain {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) {
      return Terrain.Mountain;
    }
    return this.map.tiles[ty * this.map.width + tx] as Terrain;
  }

  /**
   * Is this spot blocked for a body of the given radius?
   *
   * Terrain and buildings are hard obstacles: a unit cannot walk through a
   * structure. Other units are handled separately by separation, because hard
   * unit-vs-unit blocking without a real pathfinder deadlocks groups the
   * moment two of them want the same doorway.
   */
  isBlockedFor(x: number, y: number, radius: number): boolean {
    if (!isPassable(this.terrainAt(x, y))) return true;

    for (const b of this.buildings.values()) {
      const size = buildingDef(b.type).size;
      // Closest point on the building's footprint to this position.
      const nx = Math.max(b.x, Math.min(x, b.x + size));
      const ny = Math.max(b.y, Math.min(y, b.y + size));
      if (Math.hypot(x - nx, y - ny) < radius) return true;
    }
    return false;
  }

  /**
   * Push overlapping units apart.
   *
   * Runs after movement, so units resolve into legal positions rather than
   * being blocked from moving at all. Each pair splits the overlap evenly,
   * weighted by nothing -- a tank and a rifleman separate equally, which is
   * wrong physically and right for playability, because heavy units otherwise
   * bulldoze their own infantry off cliffs.
   */
  private separateUnits(): void {
    const arr = [...this.units.values()];

    for (let i = 0; i < arr.length; i++) {
      const a = arr[i]!;
      const ra = unitDef(a.type).radius;

      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j]!;
        const rb = unitDef(b.type).radius;
        const min = ra + rb;

        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);

        if (d >= min) continue;

        if (d < 1e-6) {
          // Exactly coincident: nudge along a deterministic axis derived from
          // the ids, so a replay separates them the same way every time.
          dx = (a.id % 2 === 0) ? 1 : -1;
          dy = (a.id % 3 === 0) ? 1 : -1;
          d = Math.hypot(dx, dy);
        }

        const push = (min - d) / 2;
        const nx = (dx / d) * push;
        const ny = (dy / d) * push;

        if (!this.isBlockedFor(a.x - nx, a.y - ny, ra)) {
          a.x -= nx;
          a.y -= ny;
        }
        if (!this.isBlockedFor(b.x + nx, b.y + ny, rb)) {
          b.x += nx;
          b.y += ny;
        }
      }
    }
  }

  /**
   * Order units to a destination.
   *
   * Ownership is checked here rather than at the transport layer, so a
   * malformed or hostile client cannot move somebody else's army.
   */
  issueMove(playerId: number, unitIds: number[], x: number, y: number): void {
    this.issueOrder(playerId, unitIds, { kind: "move", x, y });
  }

  /** Give an order to units we own. Rejects anything malformed outright. */
  issueOrder(playerId: number, unitIds: number[], order: Order): void {
    if (order.kind !== "attack" && (!Number.isFinite(order.x) || !Number.isFinite(order.y))) {
      return;
    }

    for (const id of unitIds) {
      const u = this.units.get(id);
      if (!u || u.owner !== playerId) continue;
      u.order = order;
      if (order.kind === "attack") {
        u.targetX = null;
        u.targetY = null;
        this.clearPath(u);
      } else {
        this.setDestination(u, order.x, order.y);
      }
      // A direct order takes a harvester off automatic, so it stays where it
      // was sent instead of immediately wandering back to the nearest pile.
      u.auto = false;
    }
  }

  /** Set where a building sends what it produces. */
  setRally(playerId: number, buildingId: number, x: number, y: number): void {
    const b = this.buildings.get(buildingId);
    if (!b || b.owner !== playerId) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    b.rallyX = x;
    b.rallyY = y;
  }

  /** Two players are enemies unless they share a team number. */
  isEnemy(a: number, b: number): boolean {
    if (a === b) return false;
    const ta = this.players.find((p) => p.id === a)?.team;
    const tb = this.players.find((p) => p.id === b)?.team;
    if (ta === undefined || tb === undefined) return true;
    return ta !== tb;
  }

  /** Everything shootable, flattened for the combat helpers. */
  private *combatants(): Generator<Combatant> {
    for (const u of this.units.values()) {
      const def = unitDef(u.type);
      yield {
        id: u.id, kind: "unit", owner: u.owner,
        x: u.x, y: u.y, armour: def.armour, hp: u.hp, radius: def.radius,
      };
    }
    for (const b of this.buildings.values()) {
      const def = buildingDef(b.type);
      yield {
        id: b.id, kind: "building", owner: b.owner,
        x: b.x + def.size / 2, y: b.y + def.size / 2,
        armour: def.armour, hp: b.hp, radius: def.size / 2,
      };
    }
  }

  private applyDamage(target: Combatant, amount: number): void {
    if (target.kind === "unit") {
      const u = this.units.get(target.id);
      if (u) u.hp -= amount;
    } else {
      const b = this.buildings.get(target.id);
      if (b) b.hp -= amount;
    }
  }

  private findCombatant(id: number, kind: "unit" | "building"): Combatant | null {
    for (const c of this.combatants()) {
      if (c.id === id && c.kind === kind) return c;
    }
    return null;
  }

  /**
   * One combat pass, run before movement so a unit that is already in range
   * stops this tick rather than overshooting and oscillating.
   */
  private runCombat(): void {
    const all = [...this.combatants()];
    const isEnemy = (a: number, b: number) => this.isEnemy(a, b);

    for (const u of this.units.values()) {
      const def = unitDef(u.type);
      if (u.cooldown && u.cooldown > 0) u.cooldown--;
      if (!def.weapon) continue;

      const weapon = def.weapon;
      let target: Combatant | null = null;

      if (u.order?.kind === "attack") {
        target = this.findCombatant(u.order.targetId, u.order.targetKind);
        if (!target || target.hp <= 0 || !canHarm(weapon, target.armour)) {
          // The target died or was never valid. Clearing the order matters:
          // left in place it pins the unit chasing a corpse forever.
          u.order = undefined;
          target = null;
        } else if (rangeTo(u, target) > weapon.range) {
          // Close the distance rather than firing into nothing.
          this.setDestination(u, target.x, target.y);
          continue;
        } else {
          u.targetX = null;
          u.targetY = null;
        }
      } else {
        // Idle, moving or attack-moving: engage whatever is already in reach.
        // Units do not chase off their own initiative -- an army that wanders
        // after every scout is worse than useless.
        target = acquireTarget({ ...u, weapon }, all, isEnemy, weapon.range);
        if (target && u.order?.kind === "attackMove") {
          // Attack-move stops to fight, then resumes when nothing is left.
          u.targetX = null;
          u.targetY = null;
        }
      }

      if (!target) {
        // Attack-move with nothing in range: carry on to the destination.
        if (u.order?.kind === "attackMove") {
          this.setDestination(u, u.order.x, u.order.y);
        }
        continue;
      }

      this.fire(u.x, u.y, weapon, target, u);
    }

    for (const b of this.buildings.values()) {
      const def = buildingDef(b.type);
      if (b.cooldown && b.cooldown > 0) b.cooldown--;
      if (!def.weapon || b.buildRemaining > 0) continue;

      const cx = b.x + def.size / 2;
      const cy = b.y + def.size / 2;
      const target = acquireTarget(
        { x: cx, y: cy, owner: b.owner, weapon: def.weapon },
        all,
        isEnemy,
        def.weapon.range,
      );
      if (target) this.fire(cx, cy, def.weapon, target, b);
    }
  }

  /** Apply a shot if the shooter is off cooldown, and record a tracer. */
  private fire(
    x: number,
    y: number,
    weapon: WeaponDef,
    target: Combatant,
    shooter: { cooldown?: number },
  ): void {
    if (shooter.cooldown && shooter.cooldown > 0) return;
    this.applyDamage(target, damageFor(weapon, target.armour));
    shooter.cooldown = Math.max(1, Math.round(weapon.reload * TICK_RATE));
    this.tracers.push({ x0: x, y0: y, x1: target.x, y1: target.y });
  }

  /** Remove anything reduced to zero, and clear orders that pointed at it. */
  private removeDead(): void {
    const deadUnits: number[] = [];
    const deadBuildings: number[] = [];

    for (const [id, u] of this.units) if (u.hp <= 0) deadUnits.push(id);
    for (const [id, b] of this.buildings) if (b.hp <= 0) deadBuildings.push(id);
    if (deadUnits.length === 0 && deadBuildings.length === 0) return;

    for (const id of deadUnits) this.units.delete(id);
    for (const id of deadBuildings) this.buildings.delete(id);
    if (deadBuildings.length > 0) this.markBlockedDirty();

    const deadU = new Set(deadUnits);
    const deadB = new Set(deadBuildings);
    for (const u of this.units.values()) {
      if (u.order?.kind !== "attack") continue;
      const gone = u.order.targetKind === "unit" ? deadU.has(u.order.targetId) : deadB.has(u.order.targetId);
      if (gone) {
        u.order = undefined;
        u.targetX = null;
        u.targetY = null;
      }
    }
  }

  /** A player with nothing left on the field is out. */
  private updateElimination(): void {
    for (const p of this.players) {
      if (this.eliminated.has(p.id)) continue;
      let alive = false;
      for (const u of this.units.values()) if (u.owner === p.id) { alive = true; break; }
      if (!alive) {
        for (const b of this.buildings.values()) if (b.owner === p.id) { alive = true; break; }
      }
      if (!alive) this.eliminated.add(p.id);
    }
  }

  /** Teams still in the match. One left means the game is decided. */
  livingTeams(): Set<number> {
    const teams = new Set<number>();
    for (const p of this.players) {
      if (!this.eliminated.has(p.id)) teams.add(p.team);
    }
    return teams;
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
    this.markBlockedDirty();
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
  private markBlockedDirty(): void {
    this.blockedDirty = true;
  }

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

  /**
   * Find a free spot next to a building for a freshly produced unit.
   *
   * Must test buildings and not just terrain: a unit placed inside a footprint
   * is stuck permanently, because every direction out of it is blocked.
   */
  private spawnPointFor(b: Building, radius: number): { x: number; y: number } {
    const size = buildingDef(b.type).size;
    const cx = b.x + size / 2;
    const cy = b.y + size / 2;
    for (let ring = 1; ring <= 6; ring++) {
      for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
        const px = cx + dx * (size / 2 + ring);
        const py = cy + dy * (size / 2 + ring);
        if (!this.isBlockedFor(px, py, radius)) return { x: px, y: py };
      }
    }
    return { x: cx, y: cy + size + 1 };
  }

  /** Advance the world one fixed step. */
  step(): void {
    this.tick++;
    this.tracers.length = 0;
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
        const at = this.spawnPointFor(b, unitDef(head.unitType).radius);
        const unit = this.spawnUnit(b.owner, head.unitType, at.x, at.y);
        // Send it to the rally point so production does not pile up on the
        // factory door.
        if (b.rallyX !== undefined && b.rallyY !== undefined) {
          this.issueOrder(b.owner, [unit.id], { kind: "move", x: b.rallyX, y: b.rallyY });
        }
      }
    }

    this.runCombat();
    this.removeDead();

    for (const u of this.units.values()) {
      if (u.auto && u.harvest) this.runHarvester(u);
      this.moveUnit(u);
    }

    this.separateUnits();
    this.updateElimination();
  }

  /** Nearest supply node with anything left in it. */
  private nearestNode(x: number, y: number): SupplyNode | null {
    let best: SupplyNode | null = null;
    let bestD = Infinity;
    for (const n of this.supplyNodes.values()) {
      if (n.amount <= 0) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  /** Nearest completed supply centre belonging to this player. */
  private nearestDropOff(owner: number, x: number, y: number): Building | null {
    let best: Building | null = null;
    let bestD = Infinity;
    for (const b of this.buildings.values()) {
      if (b.owner !== owner || b.type !== "supply_center" || b.buildRemaining > 0) continue;
      const size = buildingDef(b.type).size;
      const d = Math.hypot(b.x + size / 2 - x, b.y + size / 2 - y);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /**
   * Drive one harvester through gather -> return -> unload.
   *
   * Runs before movement each tick, so the state it sets is acted on in the
   * same step rather than a tick late.
   */
  private runHarvester(u: Unit): void {
    const carrying = u.carrying ?? 0;

    switch (u.harvest) {
      case "seeking": {
        const node = this.nodeFor(u);
        if (!node) { u.targetX = null; u.targetY = null; return; }
        u.nodeId = node.id;
        if (Math.hypot(node.x - u.x, node.y - u.y) <= HARVEST_REACH) {
          u.harvest = "gathering";
          u.targetX = null;
          u.targetY = null;
        } else {
          this.setDestination(u, node.x, node.y);
        }
        return;
      }

      case "gathering": {
        const node = u.nodeId === undefined ? null : this.supplyNodes.get(u.nodeId) ?? null;
        if (!node || node.amount <= 0) {
          u.harvest = carrying > 0 ? "returning" : "seeking";
          u.nodeId = undefined;
          return;
        }
        const take = Math.min(HARVEST_RATE * DT, HARVEST_CAPACITY - carrying, node.amount);
        node.amount -= take;
        u.carrying = carrying + take;
        if ((u.carrying ?? 0) >= HARVEST_CAPACITY) u.harvest = "returning";
        return;
      }

      case "returning": {
        const drop = this.nearestDropOff(u.owner, u.x, u.y);
        if (!drop) return; // No supply centre yet: wait rather than dump cargo.
        const size = buildingDef(drop.type).size;
        const dx = drop.x + size / 2;
        const dy = drop.y + size / 2;
        if (Math.hypot(dx - u.x, dy - u.y) <= HARVEST_REACH + size / 2) {
          u.harvest = "unloading";
          u.targetX = null;
          u.targetY = null;
        } else {
          this.setDestination(u, dx, dy);
        }
        return;
      }

      case "unloading": {
        const give = Math.min(UNLOAD_RATE * DT, carrying);
        u.carrying = carrying - give;
        this.economy(u.owner).credits += Math.round(give);
        if ((u.carrying ?? 0) <= 0.001) {
          u.carrying = 0;
          u.harvest = "seeking";
        }
        return;
      }
    }
  }

  /** The node a harvester should work: its current one, else the nearest. */
  private nodeFor(u: Unit): SupplyNode | null {
    if (u.nodeId !== undefined) {
      const n = this.supplyNodes.get(u.nodeId);
      if (n && n.amount > 0) return n;
    }
    return this.nearestNode(u.x, u.y);
  }

  /**
   * Move one unit one step along its route.
   *
   * Follows pathfinder waypoints when it has them and falls back to steering
   * straight at the destination when it does not -- an unreachable goal should
   * still make the unit walk as close as it can rather than freeze.
   */
  private moveUnit(u: Unit): void {
    if (u.targetX === null || u.targetY === null) return;

    // Waypoints are consumed as they are reached; the last one is the goal.
    let wx = u.targetX;
    let wy = u.targetY;
    if (u.path && u.path.length > 0) {
      const wp = u.path[0]!;
      wx = wp.x;
      wy = wp.y;
    }

    const dx = wx - u.x;
    const dy = wy - u.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= ARRIVE_EPSILON) {
      if (u.path && u.path.length > 0) {
        u.path.shift();
        if (u.path.length > 0) return; // straight on to the next waypoint
      }
      u.x = u.targetX;
      u.y = u.targetY;
      u.targetX = null;
      u.targetY = null;
      this.clearPath(u);
      return;
    }

    const def = unitDef(u.type);
    const speed = def.speed / terrainCost(this.terrainAt(u.x, u.y));
    const travel = Math.min(speed * DT, dist);
    const nx = u.x + (dx / dist) * travel;
    const ny = u.y + (dy / dist) * travel;
    const r = def.radius;

    const beforeX = u.x;
    const beforeY = u.y;

    // If the unit is already inside an obstacle -- a building finished on top
    // of it, or a bad spawn -- let it move regardless, or it is stuck forever.
    if (this.isBlockedFor(u.x, u.y, r)) {
      u.x = nx;
      u.y = ny;
      return;
    }

    if (!this.isBlockedFor(nx, ny, r)) {
      u.x = nx;
      u.y = ny;
    } else if (!this.isBlockedFor(nx, u.y, r)) {
      // Blocked head-on: try each axis alone so the unit slides along the
      // obstacle rather than stopping dead against it.
      u.x = nx;
    } else if (!this.isBlockedFor(u.x, ny, r)) {
      u.y = ny;
    }

    // Progress check. A unit pressed against geometry its path did not
    // anticipate -- another unit parked in a gap, a building raised across the
    // route -- recovers by asking for a new route rather than grinding.
    const moved = Math.hypot(u.x - beforeX, u.y - beforeY);
    if (moved < travel * 0.25) {
      u.stuckFor = (u.stuckFor ?? 0) + 1;
      if (u.stuckFor > TICK_RATE) {
        const gx = u.targetX;
        const gy = u.targetY;
        this.clearPath(u);
        if (gx !== null && gy !== null) this.setDestination(u, gx, gy);
        u.stuckFor = 0;
      }
    } else {
      u.stuckFor = 0;
    }
  }

  snapshotUnits(): Unit[] {
    return [...this.units.values()];
  }

  snapshotBuildings(): Building[] {
    return [...this.buildings.values()];
  }

  snapshotSupply(): SupplyNode[] {
    return [...this.supplyNodes.values()];
  }
}

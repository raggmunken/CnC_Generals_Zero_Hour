/** Core simulation types, shared between server and client. */

/** Faction identity. Generals' three, kept as roles rather than exact rosters. */
export type FactionId = "usa" | "china" | "gla";

/**
 * Terrain kinds.
 *
 * Each exists to do a distinct job to the map: rough ground slows a push,
 * trees and mountains wall it off, water splits the map into fronts. Anything
 * that does not change how a fight moves does not need to be here.
 */
export const enum Terrain {
  Ground = 0,
  /** Passable, slower. Scrub and broken ground. */
  Rough = 1,
  /** Rivers and ocean. Impassable to ground units. */
  Water = 2,
  /** Impassable rock. Also blocks sight. */
  Mountain = 3,
  /** Forest. Impassable, and blocks sight. */
  Trees = 4,
}

/** Whether a tile can be walked on at all. */
export function isPassable(t: Terrain): boolean {
  return t === Terrain.Ground || t === Terrain.Rough;
}

/** Movement cost multiplier for a tile. Rough ground slows you down. */
export function terrainCost(t: Terrain): number {
  return t === Terrain.Rough ? 1.6 : 1;
}

/**
 * Does this tile stop you seeing past it?
 *
 * Water is passable to sight even though it is not to feet, which is what
 * makes a river a front line rather than a wall.
 */
export function blocksVision(t: Terrain): boolean {
  return t === Terrain.Mountain || t === Terrain.Trees;
}

export interface MapData {
  width: number;
  height: number;
  /** Row-major, length width*height. */
  tiles: Uint8Array;
}

/** What a weapon deals. Paired with ArmourType through the damage matrix. */
export type DamageType = "gun" | "cannon" | "rocket" | "flak" | "explosive";

/** What a target is made of. */
export type ArmourType = "infantry" | "light" | "heavy" | "structure" | "air";

export interface WeaponDef {
  damage: number;
  damageType: DamageType;
  /** Maximum engagement distance, world units. */
  range: number;
  /** Seconds between shots. */
  reload: number;
  /**
   * Area damage around the impact point.
   *
   * Absent means a single-target weapon. Splash is what makes massed infantry
   * a liability and gives artillery a reason to exist beyond raw damage.
   */
  splash?: {
    /** World units from the impact at which damage reaches `minFraction`. */
    radius: number;
    /** Share of full damage still dealt at the very edge. */
    minFraction: number;
  };
}

/**
 * What a unit is currently trying to do.
 *
 * Kept separate from targetX/targetY, which stay as the movement output that
 * moveUnit() consumes. The order resolves into that output each tick, so the
 * steering and terrain-sliding code is untouched by combat.
 */
export type Order =
  | { kind: "move"; x: number; y: number }
  | { kind: "attackMove"; x: number; y: number }
  | { kind: "attack"; targetId: number; targetKind: "unit" | "building" };

export interface UnitTypeDef {
  id: string;
  name: string;
  /** World units per second. */
  speed: number;
  maxHp: number;
  /** Collision/selection radius in world units. */
  radius: number;
  cost: number;
  /** Seconds to produce at full power. */
  buildTime: number;
  /** Building type that trains this unit. */
  producedBy: string;
  /** One-line description for the build menu. */
  role: string;
  armour: ArmourType;
  /** How far this unit can see, and so auto-acquire from. */
  vision: number;
  /** Absent means the unit cannot fight (harvesters, dozers). */
  weapon?: WeaponDef;
}

export interface BuildingTypeDef {
  id: string;
  name: string;
  cost: number;
  /** Seconds to construct at full power. */
  buildTime: number;
  maxHp: number;
  /** Footprint in tiles, square. */
  size: number;
  /** Positive supplies power, negative consumes it. */
  power: number;
  /** Building type ids that must already exist before this can be built. */
  requires: string[];
  /** Unit type ids this building can train. */
  produces: string[];
  description: string;
  armour: ArmourType;
  vision: number;
  /** Present on defensive structures only. */
  weapon?: WeaponDef;
}

/** One item being produced at a building. */
export interface ProductionItem {
  unitType: string;
  /** Ticks of work remaining. */
  remaining: number;
  /** Ticks the item needs in total, for progress display. */
  total: number;
}

export interface Building {
  id: number;
  owner: number;
  type: string;
  /** Top-left tile of the footprint. */
  x: number;
  y: number;
  hp: number;
  /** Ticks left until construction completes; 0 means operational. */
  buildRemaining: number;
  buildTotal: number;
  queue: ProductionItem[];
  /** Where produced units are sent. Absent means they stand at the exit. */
  rallyX?: number;
  rallyY?: number;
  /** Ticks until this building's weapon may fire again. */
  cooldown?: number;
}

/** A shot fired this tick, for the client to draw. Not simulation state. */
export interface Tracer {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Per-player economy, sent to its owner each snapshot. */
export interface Economy {
  credits: number;
  powerProduced: number;
  powerConsumed: number;
}

/** What a harvester is currently doing. */
export type HarvestState = "seeking" | "gathering" | "returning" | "unloading";

export interface Unit {
  id: number;
  owner: number;
  type: string;
  x: number;
  y: number;
  hp: number;
  /** Current move destination, or null when idle. */
  targetX: number | null;
  targetY: number | null;
  /** Supplies aboard, harvesters only. */
  carrying?: number;
  /** Harvester job state. Absent on everything else. */
  harvest?: HarvestState;
  /** Supply node being worked, harvesters only. */
  nodeId?: number;
  /** Current intent. Absent means idle. */
  order?: Order;
  /** Ticks until this unit may fire again. */
  cooldown?: number;
  /** Remaining waypoints from the pathfinder. */
  path?: Array<{ x: number; y: number }>;
  /** Destination the current path was computed for. */
  pathGoalX?: number;
  pathGoalY?: number;
  /** Ticks spent making no progress, used to trigger a repath. */
  stuckFor?: number;
  /**
   * True while the unit is under automatic control.
   *
   * A direct move order clears it, so telling a harvester to go somewhere
   * actually keeps it there instead of it immediately wandering back to work.
   */
  auto?: boolean;
}

/** A supply deposit on the map. */
export interface SupplyNode {
  id: number;
  x: number;
  y: number;
  /** Remaining supplies. Depletes as harvesters work it. */
  amount: number;
}

export interface PlayerState {
  id: number;
  name: string;
  faction: FactionId;
  /** Team number: units on the same team are allies. 0 = red, 1 = blue. */
  team: number;
}

/** Core simulation types, shared between server and client. */

/** Faction identity. Generals' three, kept as roles rather than exact rosters. */
export type FactionId = "usa" | "china" | "gla";

/** Terrain kinds. Kept deliberately small -- more is not more fun. */
export const enum Terrain {
  Ground = 0,
  Rough = 1,
  Water = 2,
  Cliff = 3,
}

/** Whether a tile can be walked on at all. */
export function isPassable(t: Terrain): boolean {
  return t === Terrain.Ground || t === Terrain.Rough;
}

/** Movement cost multiplier for a tile. Rough ground slows you down. */
export function terrainCost(t: Terrain): number {
  return t === Terrain.Rough ? 1.6 : 1;
}

export interface MapData {
  width: number;
  height: number;
  /** Row-major, length width*height. */
  tiles: Uint8Array;
}

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

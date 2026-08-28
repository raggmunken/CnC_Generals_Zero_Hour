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
}

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
}

export interface PlayerState {
  id: number;
  name: string;
  faction: FactionId;
  /** Team number: units on the same team are allies. 0 = red, 1 = blue. */
  team: number;
}

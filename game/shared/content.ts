/**
 * Game content: what exists, what it costs, what it needs, what it makes, and
 * what it does to what.
 *
 * Shaped like Generals -- a command centre that unlocks everything, power as a
 * real constraint, a barracks/war-factory split, and supply as the economy --
 * but the numbers are ours and tuned for play rather than authenticity.
 *
 * Everything balance-related lives in this one file on purpose: tuning should
 * be a data edit, never a code edit.
 */
import type {
  ArmourType,
  BuildingTypeDef,
  DamageType,
  UnitTypeDef,
} from "./types.js";

/**
 * The damage matrix: what each damage type does to each armour class.
 *
 * This is the core of the game's rock-paper-scissors, and everything else in
 * combat is arithmetic on top of it. A 0 means genuinely cannot hit -- target
 * acquisition uses the same table to skip targets a weapon could never hurt,
 * so a tank never wastes time chasing an aircraft.
 */
export const DAMAGE_MATRIX: Record<DamageType, Record<ArmourType, number>> = {
  //          infantry  light  heavy  structure  air
  gun:       { infantry: 1.00, light: 0.50, heavy: 0.25, structure: 0.25, air: 0.30 },
  cannon:    { infantry: 0.50, light: 1.00, heavy: 1.00, structure: 0.80, air: 0.00 },
  rocket:    { infantry: 0.40, light: 1.25, heavy: 1.50, structure: 1.00, air: 0.50 },
  flak:      { infantry: 0.60, light: 0.50, heavy: 0.20, structure: 0.20, air: 1.50 },
  explosive: { infantry: 1.25, light: 0.80, heavy: 0.60, structure: 1.50, air: 0.00 },
};

export const BUILDINGS: Record<string, BuildingTypeDef> = {
  command_center: {
    id: "command_center",
    name: "Command Center",
    cost: 2000,
    buildTime: 20,
    maxHp: 3000,
    size: 3,
    power: 0,
    requires: [],
    produces: ["dozer"],
    description: "Builds dozers. Losing every one of these loses you the game.",
    armour: "structure",
    vision: 8,
  },
  power_plant: {
    id: "power_plant",
    name: "Power Plant",
    cost: 800,
    buildTime: 10,
    maxHp: 800,
    size: 2,
    power: 10,
    requires: ["command_center"],
    produces: [],
    description: "Supplies power. Everything else draws from it.",
    armour: "structure",
    vision: 6,
  },
  supply_center: {
    id: "supply_center",
    name: "Supply Center",
    cost: 1500,
    buildTime: 15,
    maxHp: 1500,
    size: 3,
    power: -2,
    requires: ["command_center"],
    produces: ["harvester"],
    description: "Harvesters return supplies here. Build this first or starve.",
    armour: "structure",
    vision: 7,
  },
  barracks: {
    id: "barracks",
    name: "Barracks",
    cost: 700,
    buildTime: 10,
    maxHp: 1000,
    size: 2,
    power: -2,
    requires: ["command_center"],
    produces: ["infantry", "rocket"],
    description: "Trains infantry.",
    armour: "structure",
    vision: 7,
  },
  war_factory: {
    id: "war_factory",
    name: "War Factory",
    cost: 2000,
    buildTime: 20,
    maxHp: 1800,
    size: 3,
    power: -5,
    requires: ["barracks"],
    produces: ["tank", "aa_vehicle", "artillery", "chopper"],
    description: "Builds vehicles. Needs a barracks first.",
    armour: "structure",
    vision: 7,
  },
  gun_turret: {
    id: "gun_turret",
    name: "Gun Nest",
    cost: 600,
    buildTime: 6,
    maxHp: 900,
    size: 1,
    power: -2,
    requires: ["barracks"],
    produces: [],
    description: "Shreds infantry, near-useless against armour.",
    armour: "structure",
    vision: 10,
    // Fast, splashy, low per-shot: it is the answer to a crowd.
    weapon: {
      damage: 18, damageType: "gun", range: 7, reload: 0.5,
      splash: { radius: 1.2, minFraction: 0.4 },
    },
  },
  cannon_turret: {
    id: "cannon_turret",
    name: "Cannon Tower",
    cost: 1000,
    buildTime: 9,
    maxHp: 1400,
    size: 1,
    power: -4,
    requires: ["war_factory"],
    produces: [],
    description: "Stops armour cold. Wasted on infantry.",
    armour: "structure",
    vision: 12,
    weapon: { damage: 90, damageType: "cannon", range: 10, reload: 2.6 },
  },
  aa_turret: {
    id: "aa_turret",
    name: "AA Battery",
    cost: 800,
    buildTime: 7,
    maxHp: 800,
    size: 1,
    power: -3,
    requires: ["barracks"],
    produces: [],
    description: "Anti-air only. Cannot defend itself on the ground.",
    armour: "structure",
    vision: 13,
    weapon: { damage: 55, damageType: "flak", range: 11, reload: 1.0 },
  },
};

export const UNITS: Record<string, UnitTypeDef> = {
  dozer: {
    id: "dozer", name: "Dozer", cost: 500, buildTime: 8,
    speed: 3.4, maxHp: 300, radius: 0.5, producedBy: "command_center",
    role: "Constructs buildings. Unarmed.",
    armour: "light", vision: 6,
  },
  harvester: {
    id: "harvester", name: "Harvester", cost: 700, buildTime: 10,
    speed: 4.0, maxHp: 400, radius: 0.55, producedBy: "supply_center",
    role: "Gathers supplies. Unarmed.",
    armour: "light", vision: 6,
  },
  infantry: {
    id: "infantry", name: "Rifle Infantry", cost: 200, buildTime: 5,
    speed: 3.2, maxHp: 100, radius: 0.32, producedBy: "barracks",
    role: "Cheap anti-infantry. Useless against armour.",
    armour: "infantry", vision: 7,
    weapon: { damage: 12, damageType: "gun", range: 5, reload: 1.0 },
  },
  rocket: {
    id: "rocket", name: "Rocket Infantry", cost: 350, buildTime: 7,
    speed: 2.8, maxHp: 90, radius: 0.32, producedBy: "barracks",
    role: "Anti-vehicle. Shreds tanks, poor against infantry.",
    armour: "infantry", vision: 7,
    weapon: { damage: 40, damageType: "rocket", range: 6.5, reload: 2.2 },
  },
  tank: {
    id: "tank", name: "Battle Tank", cost: 800, buildTime: 12,
    speed: 4.2, maxHp: 500, radius: 0.6, producedBy: "war_factory",
    role: "Main battle vehicle. Crushes infantry, fears rockets.",
    armour: "heavy", vision: 8,
    weapon: { damage: 55, damageType: "cannon", range: 7, reload: 2.0 },
  },
  aa_vehicle: {
    id: "aa_vehicle", name: "AA Vehicle", cost: 700, buildTime: 10,
    speed: 4.6, maxHp: 300, radius: 0.55, producedBy: "war_factory",
    role: "Dedicated anti-air. Weak on the ground.",
    armour: "light", vision: 9,
    weapon: { damage: 30, damageType: "flak", range: 7.5, reload: 1.2 },
  },
  artillery: {
    id: "artillery", name: "Artillery", cost: 1100, buildTime: 16,
    speed: 2.6, maxHp: 220, radius: 0.55, producedBy: "war_factory",
    role: "Long-range splash. Devastating on crowds and bases, helpless up close.",
    armour: "light", vision: 10,
    // Outranges everything, hits an area, and dies instantly if reached.
    weapon: {
      damage: 70, damageType: "explosive", range: 13, reload: 4.0,
      splash: { radius: 2.4, minFraction: 0.35 },
    },
  },
  chopper: {
    id: "chopper", name: "Attack Chopper", cost: 1200, buildTime: 18,
    speed: 5.5, maxHp: 350, radius: 0.55, producedBy: "war_factory",
    role: "Fast gunship. Flies over anything, strafes ground and air. Only flak answers it.",
    armour: "air", vision: 9,
    // Rockets keep it honest against armour and other aircraft; the matrix
    // makes cannons and artillery pointless against it, which is the point of
    // air: it forces the opponent to build flak.
    weapon: { damage: 34, damageType: "rocket", range: 7, reload: 1.6 },
  },
};

export function unitDef(type: string): UnitTypeDef {
  const d = UNITS[type];
  if (!d) throw new Error(`unknown unit type: ${type}`);
  return d;
}

export function buildingDef(type: string): BuildingTypeDef {
  const d = BUILDINGS[type];
  if (!d) throw new Error(`unknown building type: ${type}`);
  return d;
}

/** Damage multiplier for a pairing. */
export function damageMultiplier(dmg: DamageType, armour: ArmourType): number {
  return DAMAGE_MATRIX[dmg][armour];
}

/**
 * Map presets, keyed by player count.
 *
 * Size scales with players so the distance between neighbouring bases -- and
 * therefore rush timing -- stays roughly constant as the lobby grows.
 */
export interface MapPreset {
  players: number;
  size: number;
  name: string;
}

export const MAP_PRESETS: Record<number, MapPreset> = {
  2: { players: 2, size: 64, name: "Duel" },
  3: { players: 3, size: 80, name: "Three-Way" },
  4: { players: 4, size: 96, name: "Crossroads" },
  5: { players: 5, size: 104, name: "Five Points" },
  6: { players: 6, size: 112, name: "Six Corners" },
};

export function mapPreset(players: number): MapPreset {
  return MAP_PRESETS[players] ?? MAP_PRESETS[2]!;
}

/** How much a harvester carries per trip. */
export const HARVEST_CAPACITY = 300;
/** Supplies gathered per second while parked on a node. */
export const HARVEST_RATE = 120;
/** Supplies unloaded per second at a supply centre. */
export const UNLOAD_RATE = 300;
/** How close a harvester must be to a node or centre to work it. */
export const HARVEST_REACH = 1.4;

/** Starting credits. Enough for a supply centre and a little slack. */
export const STARTING_CREDITS = 5000;

/**
 * Production speed when demand exceeds supply.
 *
 * Generals brownouts stop production dead, which feels punishing without
 * teaching anything. Halving it makes the mistake legible and recoverable.
 */
export const LOW_POWER_SPEED = 0.5;

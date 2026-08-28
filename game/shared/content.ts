/**
 * Game content: what exists, what it costs, what it needs, what it makes.
 *
 * Shaped like Generals -- a command centre that unlocks everything, power as a
 * real constraint, a barracks/war-factory split, and supply as the economy --
 * but the numbers are ours and tuned for play rather than authenticity.
 *
 * Everything the tech tree needs lives in this one file on purpose: balance
 * changes should be a data edit, never a code edit.
 */
import type { BuildingTypeDef, UnitTypeDef } from "./types.js";

/** Seconds of build time are converted to ticks by the sim. */
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
    produces: ["tank", "aa_vehicle"],
    description: "Builds vehicles. Needs a barracks first.",
  },
  turret: {
    id: "turret",
    name: "Defense Turret",
    cost: 900,
    buildTime: 8,
    maxHp: 1200,
    size: 1,
    power: -3,
    requires: ["barracks"],
    produces: [],
    description: "Static defense. Cheap insurance against an early rush.",
  },
};

export const UNITS: Record<string, UnitTypeDef> = {
  dozer: {
    id: "dozer", name: "Dozer", cost: 500, buildTime: 8,
    speed: 3.4, maxHp: 300, radius: 0.5, producedBy: "command_center",
    role: "Constructs buildings.",
  },
  harvester: {
    id: "harvester", name: "Harvester", cost: 700, buildTime: 10,
    speed: 4.0, maxHp: 400, radius: 0.55, producedBy: "supply_center",
    role: "Gathers supplies.",
  },
  infantry: {
    id: "infantry", name: "Rifle Infantry", cost: 200, buildTime: 5,
    speed: 3.2, maxHp: 100, radius: 0.32, producedBy: "barracks",
    role: "Cheap anti-infantry.",
  },
  rocket: {
    id: "rocket", name: "Rocket Infantry", cost: 350, buildTime: 7,
    speed: 2.8, maxHp: 90, radius: 0.32, producedBy: "barracks",
    role: "Anti-vehicle and anti-air.",
  },
  tank: {
    id: "tank", name: "Battle Tank", cost: 800, buildTime: 12,
    speed: 4.2, maxHp: 500, radius: 0.6, producedBy: "war_factory",
    role: "Main battle vehicle.",
  },
  aa_vehicle: {
    id: "aa_vehicle", name: "AA Vehicle", cost: 700, buildTime: 10,
    speed: 4.6, maxHp: 300, radius: 0.55, producedBy: "war_factory",
    role: "Dedicated anti-air.",
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

/** Starting credits. Enough for a supply centre and a little slack. */
export const STARTING_CREDITS = 5000;

/**
 * Production speed when demand exceeds supply.
 *
 * Generals brownouts stop production dead, which feels punishing without
 * teaching anything. Halving it makes the mistake legible and recoverable.
 */
export const LOW_POWER_SPEED = 0.5;

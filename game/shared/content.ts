/** Unit definitions. Our own numbers, tuned for play rather than authenticity. */
import type { UnitTypeDef } from "./types.js";

export const UNIT_TYPES: Record<string, UnitTypeDef> = {
  infantry: { id: "infantry", name: "Rifle Infantry", speed: 3.2, maxHp: 100, radius: 0.35, cost: 200 },
  rocket: { id: "rocket", name: "Rocket Infantry", speed: 2.8, maxHp: 90, radius: 0.35, cost: 300 },
  tank: { id: "tank", name: "Battle Tank", speed: 4.5, maxHp: 400, radius: 0.6, cost: 800 },
  harvester: { id: "harvester", name: "Harvester", speed: 4.0, maxHp: 300, radius: 0.6, cost: 700 },
};

export function unitDef(type: string): UnitTypeDef {
  const d = UNIT_TYPES[type];
  if (!d) throw new Error(`unknown unit type: ${type}`);
  return d;
}

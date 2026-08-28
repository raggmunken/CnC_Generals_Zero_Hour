/**
 * Damage resolution and target acquisition.
 *
 * Kept free of Sim so the maths can be tested directly: these are pure
 * functions over plain data, which is where combat bugs are cheapest to catch.
 */
import { damageMultiplier } from "../shared/content.js";
import type { ArmourType, WeaponDef } from "../shared/types.js";

/** Anything that can be shot at, unit or building, flattened to what matters. */
export interface Combatant {
  id: number;
  kind: "unit" | "building";
  owner: number;
  /** Centre point, world units. */
  x: number;
  y: number;
  armour: ArmourType;
  hp: number;
  /** Effective radius, so range is measured surface-to-surface for buildings. */
  radius: number;
}

/** Damage one shot deals to this armour class, after the matrix. */
export function damageFor(weapon: WeaponDef, armour: ArmourType): number {
  return weapon.damage * damageMultiplier(weapon.damageType, armour);
}

/**
 * Can this weapon hurt this armour at all?
 *
 * A zero in the matrix means genuinely cannot hit -- a tank cannon against an
 * aircraft. Acquisition uses this so a unit never wastes time closing on a
 * target it could never damage.
 */
export function canHarm(weapon: WeaponDef, armour: ArmourType): boolean {
  return damageMultiplier(weapon.damageType, armour) > 0;
}

/** Distance from an attacker to a target's surface, not its centre. */
export function rangeTo(
  from: { x: number; y: number },
  target: Combatant,
): number {
  return Math.max(0, Math.hypot(target.x - from.x, target.y - from.y) - target.radius);
}

/**
 * Pick the best target within reach.
 *
 * Nearest-first. Deliberately not cleverer than that: focus-fire and threat
 * weighting are the AI's job in a later phase, and baking them in here would
 * make every unit behave identically regardless of who is commanding it.
 */
export function acquireTarget(
  attacker: { x: number; y: number; owner: number; weapon: WeaponDef },
  candidates: Iterable<Combatant>,
  isEnemy: (a: number, b: number) => boolean,
  maxRange: number,
): Combatant | null {
  let best: Combatant | null = null;
  let bestDist = Infinity;

  for (const c of candidates) {
    if (c.hp <= 0) continue;
    if (!isEnemy(attacker.owner, c.owner)) continue;
    if (!canHarm(attacker.weapon, c.armour)) continue;

    const d = rangeTo(attacker, c);
    if (d > maxRange) continue;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }

  return best;
}

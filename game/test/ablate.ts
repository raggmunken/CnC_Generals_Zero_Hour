/**
 * One-parameter-at-a-time sweeps.
 *
 * Three tuning knobs were changed together and the result got worse, which
 * means nothing could be attributed. Varying one at a time against a fixed
 * baseline is the only way to learn which knob actually does anything.
 */
import { AIPlayer, TUNING, type Tuning } from "../server/ai.js";
import { generateMap, generateSupplyNodes } from "../server/mapgen.js";
import { Sim, TICK_RATE } from "../server/sim.js";
import { buildingDef, unitDef } from "../shared/content.js";
import { wilson } from "./selfplay.js";

function fieldValue(sim: Sim, playerId: number): number {
  let v = 0;
  for (const u of sim.units.values()) if (u.owner === playerId) v += unitDef(u.type).cost;
  for (const b of sim.buildings.values()) if (b.owner === playerId) v += buildingDef(b.type).cost;
  return v;
}

function match(a: Tuning, b: Tuning, seed: number, maxSeconds = 480): number | null {
  const { map, starts } = generateMap(2, seed);
  const sim = new Sim(map);
  sim.setSupplyNodes(generateSupplyNodes(map, starts));
  const bots: AIPlayer[] = [];
  for (const [i, tuning] of [a, b].entries()) {
    sim.addPlayer({ id: i, name: `AI${i}`, faction: "usa", team: i });
    const s = starts[i]!;
    const cc = sim.placeBuilding(i, "command_center", Math.floor(s.x) - 1, Math.floor(s.y) - 1);
    if (cc) cc.buildRemaining = 0;
    sim.spawnUnit(i, "dozer", s.x + 2.5, s.y + 2.5);
    sim.spawnUnit(i, "infantry", s.x + 3, s.y + 4);
    bots.push(new AIPlayer(sim, i, tuning));
  }
  for (let t = 0; t < maxSeconds * TICK_RATE; t++) {
    for (const bot of bots) bot.update();
    sim.step();
    if (sim.eliminated.size > 0) {
      const alive = [0, 1].filter((id) => !sim.eliminated.has(id));
      return alive.length === 1 ? alive[0]! : null;
    }
  }
  const va = fieldValue(sim, 0);
  const vb = fieldValue(sim, 1);
  const margin = Math.abs(va - vb) / Math.max(1, Math.max(va, vb));
  return margin < 0.15 ? null : va > vb ? 0 : 1;
}

/** Paired games so map bias cancels exactly. */
function duel(a: Tuning, b: Tuning, pairs: number): { w: number; l: number; d: number } {
  let w = 0, l = 0, d = 0;
  for (let i = 0; i < pairs; i++) {
    for (const swap of [false, true]) {
      const r = match(swap ? b : a, swap ? a : b, 2000 + i);
      if (r === null) d++;
      else if ((swap ? 1 : 0) === r) w++;
      else l++;
    }
  }
  return { w, l, d };
}

const BASE: Tuning = { ...TUNING.normal };
const pairs = Number(process.env.PAIRS ?? 12);

function sweep(label: string, key: keyof Tuning, values: number[]): void {
  console.log(`\n${label} (baseline ${key}=${BASE[key]}, ${pairs * 2} games each)`);
  for (const v of values) {
    if (v === BASE[key]) continue;
    const variant: Tuning = { ...BASE, [key]: v };
    const { w, l, d } = duel(variant, BASE, pairs);
    const decided = w + l;
    const [lo, hi] = wilson(w, decided);
    const verdict = lo > 0.5 ? "BETTER" : hi < 0.5 ? "worse" : "--";
    console.log(
      `  ${key}=${String(v).padEnd(6)} ${w}-${l} (draws ${d})  ` +
        `${decided === 0 ? 0 : Math.round((100 * w) / decided)}% ` +
        `[${Math.round(lo * 100)}%, ${Math.round(hi * 100)}%]  ${verdict}`,
    );
  }
}

console.log("ablation against the normal baseline; BETTER means the interval clears 50%");
sweep("attack threshold", "attackThreshold", [1200, 1800, 2400, 3600, 4800]);
sweep("harvesters", "harvesterTarget", [1, 2, 4, 6]);
sweep("think interval", "thinkInterval", [0.5, 0.8, 3.0, 5.0]);

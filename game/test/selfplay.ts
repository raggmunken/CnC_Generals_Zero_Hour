/**
 * Headless AI evaluation.
 *
 * The whole point of keeping the simulation free of I/O: matches run in a
 * loop, at whatever speed the CPU allows, with no browser and no sockets.
 *
 * Reports Wilson score intervals rather than bare win rates. A 7-3 record over
 * ten games is not evidence of anything, and a harness that presents it as
 * though it were will send you tuning against noise.
 */
import { AIPlayer, type Difficulty } from "../server/ai.js";
import { generateMap, generateSupplyNodes } from "../server/mapgen.js";
import { Sim, TICK_RATE } from "../server/sim.js";
import { buildingDef, unitDef } from "../shared/content.js";

export interface MatchResult {
  /** Winning player id, or null for a draw. */
  winner: number | null;
  seconds: number;
  reason: "eliminated" | "timeout";
}

/** Total value a player has on the field, used to settle timeouts. */
function fieldValue(sim: Sim, playerId: number): number {
  let v = 0;
  for (const u of sim.units.values()) if (u.owner === playerId) v += unitDef(u.type).cost;
  for (const b of sim.buildings.values()) if (b.owner === playerId) v += buildingDef(b.type).cost;
  return v;
}

export function runMatch(
  a: Difficulty,
  b: Difficulty,
  seed: number,
  maxSeconds = 480,
): MatchResult {
  const { map, starts } = generateMap(2, seed);
  const sim = new Sim(map);
  sim.setSupplyNodes(generateSupplyNodes(map, starts));

  const bots: AIPlayer[] = [];
  for (const [i, difficulty] of [a, b].entries()) {
    sim.addPlayer({ id: i, name: `AI${i}`, faction: "usa", team: i });
    const s = starts[i]!;
    const cc = sim.placeBuilding(i, "command_center", Math.floor(s.x) - 1, Math.floor(s.y) - 1);
    if (cc) cc.buildRemaining = 0;
    sim.spawnUnit(i, "dozer", s.x + 2.5, s.y + 2.5);
    sim.spawnUnit(i, "infantry", s.x + 3, s.y + 4);
    bots.push(new AIPlayer(sim, i, difficulty));
  }

  const maxTicks = maxSeconds * TICK_RATE;
  for (let t = 0; t < maxTicks; t++) {
    for (const bot of bots) bot.update();
    sim.step();

    if (sim.eliminated.size > 0) {
      const alive = [0, 1].filter((id) => !sim.eliminated.has(id));
      return {
        winner: alive.length === 1 ? alive[0]! : null,
        seconds: t / TICK_RATE,
        reason: "eliminated",
      };
    }
  }

  // Nobody died: award it to whoever built the stronger position, which is a
  // far better signal than calling every long game a draw.
  const va = fieldValue(sim, 0);
  const vb = fieldValue(sim, 1);
  const margin = Math.abs(va - vb) / Math.max(1, Math.max(va, vb));
  return {
    winner: margin < 0.15 ? null : va > vb ? 0 : 1,
    seconds: maxSeconds,
    reason: "timeout",
  };
}

/** Wilson score interval for a binomial proportion. */
export function wilson(wins: number, total: number, z = 1.96): [number, number] {
  if (total === 0) return [0, 0];
  const p = wins / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return [(centre - margin) / denom, (centre + margin) / denom];
}

/**
 * Play a matchup both ways round.
 *
 * Sides are swapped every other game because start positions are not identical
 * -- without swapping you measure the map, not the AI.
 */
export function series(a: Difficulty, b: Difficulty, games: number): {
  aWins: number; bWins: number; draws: number; avgSeconds: number;
} {
  let aWins = 0;
  let bWins = 0;
  let draws = 0;
  let seconds = 0;

  for (let i = 0; i < games; i++) {
    const swap = i % 2 === 1;
    const r = runMatch(swap ? b : a, swap ? a : b, 1000 + i);
    seconds += r.seconds;
    if (r.winner === null) draws++;
    else {
      const aWon = swap ? r.winner === 1 : r.winner === 0;
      if (aWon) aWins++;
      else bWins++;
    }
  }

  return { aWins, bWins, draws, avgSeconds: seconds / games };
}

function report(label: string, a: Difficulty, b: Difficulty, games: number): void {
  const t0 = Date.now();
  const { aWins, bWins, draws, avgSeconds } = series(a, b, games);
  const decided = aWins + bWins;
  const [lo, hi] = wilson(aWins, decided);
  const pct = decided === 0 ? 0 : (100 * aWins) / decided;

  console.log(
    `${label.padEnd(22)} ${a} ${aWins} - ${bWins} ${b}` +
      `  draws=${draws}  ${pct.toFixed(0)}% [${(lo * 100).toFixed(0)}%, ${(hi * 100).toFixed(0)}%]` +
      `  avg ${avgSeconds.toFixed(0)}s game  (${((Date.now() - t0) / 1000).toFixed(1)}s real)`,
  );
}

const games = Number(process.env.GAMES ?? 10);
console.log(`self-play: ${games} games per matchup\n`);
report("mirror (normal)", "normal", "normal", games);
report("hard vs easy", "hard", "easy", games);
report("hard vs normal", "hard", "normal", games);

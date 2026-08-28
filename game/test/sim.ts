/**
 * Headless simulation tests.
 *
 * The sim does no I/O, so the economy can be tested directly by stepping it in
 * a loop -- no browser, no sockets, no timing. This is the same property that
 * makes self-play possible later.
 */
import { HARVEST_CAPACITY, STARTING_CREDITS } from "../shared/content.js";
import { generateMap } from "../server/mapgen.js";
import { Sim, TICK_RATE } from "../server/sim.js";
import { Terrain } from "../shared/types.js";

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

/** A flat map with no obstacles, so tests measure economy and not pathing. */
function flatSim(): Sim {
  const map = generateMap(48, 48, 7);
  map.tiles.fill(Terrain.Ground);
  const sim = new Sim(map);
  sim.addPlayer({ id: 0, name: "P1", faction: "usa", team: 0 });
  return sim;
}

function run(sim: Sim, seconds: number): void {
  for (let i = 0; i < seconds * TICK_RATE; i++) sim.step();
}

// -- tech tree --------------------------------------------------------------
{
  const sim = flatSim();
  check("war factory blocked without barracks", !sim.canBuild(0, "war_factory"));

  const cc = sim.placeBuilding(0, "command_center", 5, 5)!;
  cc.buildRemaining = 0;
  const bar = sim.placeBuilding(0, "barracks", 10, 5)!;
  bar.buildRemaining = 0;
  check("war factory unlocked by barracks", sim.canBuild(0, "war_factory"));

  check("cannot build on an occupied footprint", sim.placeBuilding(0, "power_plant", 5, 5) === null);
}

// -- economy: the harvester loop -------------------------------------------
{
  const sim = flatSim();
  sim.setSupplyNodes([{ id: 1, x: 20, y: 12, amount: 5000 }]);

  const cc = sim.placeBuilding(0, "command_center", 10, 10)!;
  cc.buildRemaining = 0;
  const sc = sim.placeBuilding(0, "supply_center", 14, 10)!;
  sc.buildRemaining = 0;

  const spent = STARTING_CREDITS - sim.economy(0).credits;
  check("building costs were charged", spent === 2000 + 1500, `spent=${spent}`);

  const before = sim.economy(0).credits;
  sim.spawnUnit(0, "harvester", 15, 12);

  // Long enough for at least one full round trip.
  run(sim, 40);

  const after = sim.economy(0).credits;
  check("harvester generated income", after > before, `$${before} -> $${after}`);

  const node = sim.supplyNodes.get(1)!;
  check("supply node was depleted", node.amount < 5000, `${node.amount} left`);

  const delivered = after - before;
  check(
    "delivered at least one full load",
    delivered >= HARVEST_CAPACITY,
    `delivered=${delivered}, capacity=${HARVEST_CAPACITY}`,
  );
}

// -- a direct order takes a harvester off automatic -------------------------
{
  const sim = flatSim();
  sim.setSupplyNodes([{ id: 1, x: 30, y: 30, amount: 5000 }]);
  const h = sim.spawnUnit(0, "harvester", 5, 5);
  sim.issueMove(0, [h.id], 8, 5);
  run(sim, 3);
  check("manual order overrides harvesting", h.auto === false, `auto=${h.auto}`);
  check("harvester obeyed the move order", Math.abs(h.x - 8) < 0.5, `x=${h.x.toFixed(2)}`);
}

// -- power -----------------------------------------------------------------
{
  const sim = flatSim();
  const cc = sim.placeBuilding(0, "command_center", 5, 5)!;
  cc.buildRemaining = 0;
  const bar = sim.placeBuilding(0, "barracks", 10, 5)!;
  bar.buildRemaining = 0;
  sim.step();
  const e = sim.economy(0);
  check("consumption is tracked", e.powerConsumed === 2, `consumed=${e.powerConsumed}`);

  const pp = sim.placeBuilding(0, "power_plant", 14, 5)!;
  pp.buildRemaining = 0;
  sim.step();
  check("power plant supplies power", sim.economy(0).powerProduced === 10, `produced=${sim.economy(0).powerProduced}`);
}

console.log(`\nRESULT: ${failures.length === 0 ? "ALL PASS" : `FAILURES: ${failures.join(", ")}`}`);
process.exit(failures.length === 0 ? 0 : 1);

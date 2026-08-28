/**
 * Headless simulation tests.
 *
 * The sim does no I/O, so the economy can be tested directly by stepping it in
 * a loop -- no browser, no sockets, no timing. This is the same property that
 * makes self-play possible later.
 */
import { HARVEST_CAPACITY, STARTING_CREDITS, UNITS } from "../shared/content.js";
import { canHarm, damageFor } from "../server/combat.js";
import { generateMap, generateSupplyNodes } from "../server/mapgen.js";
import { Sim, TICK_RATE } from "../server/sim.js";
import { isPassable, Terrain } from "../shared/types.js";

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

/** A flat map with no obstacles, so tests measure mechanics and not pathing. */
function flatSim(players = 1): Sim {
  const size = 64;
  const map = { width: size, height: size, tiles: new Uint8Array(size * size) };
  map.tiles.fill(Terrain.Ground);
  const sim = new Sim(map);
  for (let i = 0; i < players; i++) {
    sim.addPlayer({ id: i, name: `P${i + 1}`, faction: "usa", team: i });
  }
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
  sim.spawnUnit(0, "harvester", 18.5, 12); // clear of the supply centre footprint

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

// -- damage matrix ---------------------------------------------------------
{
  const rifle = UNITS.infantry!.weapon!;
  const rpg = UNITS.rocket!.weapon!;
  const cannon = UNITS.tank!.weapon!;

  check(
    "rockets out-damage rifles against heavy armour",
    damageFor(rpg, "heavy") > damageFor(rifle, "heavy"),
    `rocket=${damageFor(rpg, "heavy")} rifle=${damageFor(rifle, "heavy")}`,
  );
  check(
    "rifles out-damage rockets against infantry",
    damageFor(rifle, "infantry") > damageFor(rpg, "infantry") / 3,
    `rifle=${damageFor(rifle, "infantry")} rocket=${damageFor(rpg, "infantry")}`,
  );
  check("cannons cannot touch aircraft", !canHarm(cannon, "air"));
  check("flak can", canHarm(UNITS.aa_vehicle!.weapon!, "air"));
}

// -- counters actually play out --------------------------------------------
// A table can be correct while the game still feels flat. This measures the
// thing that matters: equal money, wildly different outcome.
{
  function ticksToKillTank(squadType: string, count: number): number {
    const sim = flatSim(2);
    const tank = sim.spawnUnit(1, "tank", 20, 20);
    for (let i = 0; i < count; i++) sim.spawnUnit(0, squadType, 17 + i * 0.7, 20);
    for (let t = 0; t < 60 * TICK_RATE; t++) {
      sim.step();
      if (!sim.units.has(tank.id)) return t;
    }
    return Infinity;
  }

  // $1400 each: seven rifles or four rocket teams.
  const byRifle = ticksToKillTank("infantry", 7);
  const byRocket = ticksToKillTank("rocket", 4);

  check("rifles eventually kill a tank", Number.isFinite(byRifle), `${byRifle} ticks`);
  check("rockets kill a tank", Number.isFinite(byRocket), `${byRocket} ticks`);
  check(
    "equal money, rockets kill a tank far faster",
    byRocket * 2 < byRifle,
    `rocket=${byRocket} ticks vs rifle=${byRifle} ticks`,
  );
}

// -- range -----------------------------------------------------------------
{
  const sim = flatSim(2);
  const target = sim.spawnUnit(1, "infantry", 40, 20);
  sim.spawnUnit(0, "infantry", 20, 20); // well beyond a rifle's 5 units
  const hp0 = target.hp;
  for (let i = 0; i < 30; i++) sim.step();
  check("out of range means no damage", target.hp === hp0, `hp=${target.hp}`);

  const sim2 = flatSim(2);
  const near = sim2.spawnUnit(1, "infantry", 23, 20);
  sim2.spawnUnit(0, "infantry", 20, 20);
  for (let i = 0; i < 30; i++) sim2.step();
  check("in range means damage", near.hp < 100, `hp=${near.hp}`);
}

// -- death and order cleanup ----------------------------------------------
{
  const sim = flatSim(2);
  const victim = sim.spawnUnit(1, "infantry", 22, 20);
  const shooter = sim.spawnUnit(0, "tank", 20, 20);
  sim.issueOrder(0, [shooter.id], { kind: "attack", targetId: victim.id, targetKind: "unit" });

  let died = -1;
  for (let t = 0; t < 30 * TICK_RATE; t++) {
    sim.step();
    if (!sim.units.has(victim.id)) { died = t; break; }
  }
  check("a unit reduced to zero is removed", died >= 0, `after ${died} ticks`);
  check("orders aimed at the dead are cleared", shooter.order === undefined, `order=${JSON.stringify(shooter.order)}`);
}

// -- attack-move -----------------------------------------------------------
{
  const sim = flatSim(2);
  const enemy = sim.spawnUnit(1, "infantry", 30, 20);
  const soldier = sim.spawnUnit(0, "tank", 20, 20);
  sim.issueOrder(0, [soldier.id], { kind: "attackMove", x: 45, y: 20 });

  let killed = false;
  for (let t = 0; t < 40 * TICK_RATE; t++) {
    sim.step();
    if (!sim.units.has(enemy.id)) { killed = true; break; }
  }
  check("attack-move engages what it meets", killed);

  // ...and then carries on to where it was sent.
  for (let t = 0; t < 40 * TICK_RATE; t++) sim.step();
  check("attack-move resumes after the fight", soldier.x > 40, `x=${soldier.x.toFixed(1)}`);
}

// -- elimination -----------------------------------------------------------
{
  const sim = flatSim(2);
  const lone = sim.spawnUnit(1, "infantry", 22, 20);
  sim.spawnUnit(0, "tank", 20, 20);
  for (let t = 0; t < 30 * TICK_RATE && !sim.eliminated.has(1); t++) sim.step();
  check("losing everything eliminates a player", sim.eliminated.has(1));
  check("the survivor is not eliminated", !sim.eliminated.has(0));
  check("one team left standing", sim.livingTeams().size === 1, `teams=${[...sim.livingTeams()]}`);
  void lone;
}

// -- collision -------------------------------------------------------------
{
  const sim = flatSim(1);
  // Two tanks ordered onto the exact same spot must not end up inside one
  // another; separation should push them at least their combined radii apart.
  const a = sim.spawnUnit(0, "tank", 20, 20);
  const b = sim.spawnUnit(0, "tank", 20.05, 20.05);
  sim.issueMove(0, [a.id, b.id], 20, 20);
  for (let i = 0; i < 60; i++) sim.step();

  const gap = Math.hypot(a.x - b.x, a.y - b.y);
  const need = UNITS.tank!.radius * 2;
  check("units cannot occupy the same spot", gap >= need * 0.95, `gap=${gap.toFixed(2)} need=${need}`);
}

{
  const sim = flatSim(1);
  // A building in the way must actually stop a unit, not be walked through.
  // A command centre: 3x3 and the one structure with no prerequisites.
  const wall = sim.placeBuilding(0, "command_center", 24, 18)!;
  wall.buildRemaining = 0;
  const u = sim.spawnUnit(0, "infantry", 20, 19.5);
  sim.issueMove(0, [u.id], 34, 19.5);
  for (let i = 0; i < 20 * TICK_RATE; i++) sim.step();

  check(
    "a unit cannot walk through a building",
    u.x < 24,
    `x=${u.x.toFixed(2)} (building spans 24..27)`,
  );
}

// -- map presets -----------------------------------------------------------
{
  for (const players of [2, 3, 4, 5, 6]) {
    const { map, starts } = generateMap(players, 3);
    const okCount = starts.length === players;

    let minGap = Infinity;
    for (let i = 0; i < starts.length; i++) {
      for (let j = i + 1; j < starts.length; j++) {
        minGap = Math.min(minGap, Math.hypot(starts[i]!.x - starts[j]!.x, starts[i]!.y - starts[j]!.y));
      }
    }

    const sim = new Sim(map);
    const allClear = starts.every((s) => !sim.isBlockedFor(s.x, s.y, 1.5));

    const nodes = generateSupplyNodes(map, starts);
    const everyStartHasSupply = starts.every((s) =>
      nodes.some((n) => Math.hypot(n.x - s.x, n.y - s.y) < 12),
    );

    check(
      `${players}p map: starts, spacing, ground and supply`,
      okCount && minGap > map.width * 0.3 && allClear && everyStartHasSupply,
      `size=${map.width} starts=${starts.length} minGap=${minGap.toFixed(1)} clear=${allClear} supply=${everyStartHasSupply}`,
    );

    // Connectivity is the property that decides whether a generated map is
    // playable at all: rivers, mountains and forests can trivially wall a
    // start off, and a map you cannot cross is broken rather than hard.
    const seen = reachable(map, starts[0]!);
    const idx = (v: { x: number; y: number }) =>
      Math.floor(v.y) * map.width + Math.floor(v.x);
    const startsConnected = starts.every((st) => seen[idx(st)] === 1);
    const nodesReachable = nodes.filter((n) => seen[idx(n)] === 1).length;

    check(
      `${players}p map: every start is reachable from every other`,
      startsConnected,
      `connected=${starts.filter((st) => seen[idx(st)] === 1).length}/${starts.length}`,
    );
    check(
      `${players}p map: most supply is reachable`,
      nodesReachable >= nodes.length - 1,
      `${nodesReachable}/${nodes.length} piles reachable`,
    );

    // The features must actually appear, or the generator silently produces
    // the same flat field it did before.
    const kinds = new Set(map.tiles);
    check(
      `${players}p map: has water, mountains and forest`,
      kinds.has(Terrain.Water) && kinds.has(Terrain.Mountain) && kinds.has(Terrain.Trees),
      `kinds=${[...kinds].sort().join(",")}`,
    );
  }
}

/** Flood fill of walkable tiles from a point, for connectivity checks. */
function reachable(map: { width: number; height: number; tiles: Uint8Array }, from: { x: number; y: number }): Uint8Array {
  const seen = new Uint8Array(map.tiles.length);
  const start = Math.floor(from.y) * map.width + Math.floor(from.x);
  if (!isPassable(map.tiles[start] as Terrain)) return seen;
  const q = [start];
  seen[start] = 1;
  while (q.length > 0) {
    const at = q.pop()!;
    const x = at % map.width;
    const y = (at / map.width) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      const ni = ny * map.width + nx;
      if (seen[ni] || !isPassable(map.tiles[ni] as Terrain)) continue;
      seen[ni] = 1;
      q.push(ni);
    }
  }
  return seen;
}

console.log(`\nRESULT: ${failures.length === 0 ? "ALL PASS" : `FAILURES: ${failures.join(", ")}`}`);
process.exit(failures.length === 0 ? 0 : 1);

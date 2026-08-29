/**
 * Diagnostic tests: "does the mechanic actually do what it should?"
 *
 * The regular test suite verifies that mechanics exist — power is tracked,
 * buildings can be placed, the AI builds something. These tests verify the
 * *consequence*: that low power slows production, that turrets go offline,
 * that the AI sustains its economy over a long game, that units escape
 * building traps, and that unit stat relationships match C&C design intent.
 *
 * The principle: test the effect, not the accounting. If a test only checks
 * that a variable was set, it proves the code runs, not that the game works.
 *
 * Run: node ./node_modules/tsx/dist/cli.mjs test/diagnostic.ts
 */
import { AIPlayer } from "../server/ai.js";
import { generateMap, generateSupplyNodes } from "../server/mapgen.js";
import { Sim, TICK_RATE } from "../server/sim.js";
import {
  BUILDINGS,
  buildingDef,
  LOW_POWER_SPEED,
  STARTING_CREDITS,
  UNITS,
  unitDef,
} from "../shared/content.js";
import { Terrain, type Unit } from "../shared/types.js";

let pass = 0;
const failed: string[] = [];

function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}${detail ? `  (${detail})` : ""}`);
  } else {
    failed.push(label);
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}
function section(name: string): void {
  console.log(`\n${name}`);
}

function flatSim(players = 2): Sim {
  const size = 64;
  const map = { width: size, height: size, tiles: new Uint8Array(size * size) };
  map.tiles.fill(Terrain.Ground);
  const sim = new Sim(map);
  for (let i = 0; i < players; i++)
    sim.addPlayer({ id: i, name: `P${i}`, faction: "usa", team: i });
  return sim;
}

function run(sim: Sim, seconds: number, bots: AIPlayer[] = []): void {
  for (let i = 0; i < seconds * TICK_RATE; i++) {
    for (const b of bots) b.update();
    sim.step();
  }
}

function base(sim: Sim, owner: number, x: number, y: number) {
  const cc = sim.placeBuilding(owner, "command_center", x, y)!;
  cc.buildRemaining = 0;
  return cc;
}

// ===========================================================================
// 1. LOW POWER: does brownout actually slow production?
//    The old test checked "powerConsumed > 0" — accounting, not consequence.
//    This test measures build time with and without power.
// ===========================================================================
section("Low power slows production");
{
  const sim = flatSim();
  base(sim, 0, 10, 10);
  sim.economy(0).credits = 99999;

  // Set up a barracks with no power: command center (0 power) + barracks (-2).
  // No power plant, so powerConsumed > powerProduced.
  const bar = sim.placeBuilding(0, "barracks", 14, 10)!;
  bar.buildRemaining = 0;
  sim.step();

  ok("brownout is detected", sim.isLowPower(0), `power: ${sim.economy(0).powerProduced}/${sim.economy(0).powerConsumed}`);

  // Queue an infantry and measure how long it takes.
  sim.queueUnit(0, bar.id, "infantry");
  const ticksNoPower = measureProductionTime(sim, bar.id);

  // Now add a power plant and measure again.
  const pp = sim.placeBuilding(0, "power_plant", 18, 10)!;
  pp.buildRemaining = 0;
  sim.step();
  ok("power restored", !sim.isLowPower(0));

  sim.queueUnit(0, bar.id, "infantry");
  const ticksFullPower = measureProductionTime(sim, bar.id);

  // Low power should be noticeably slower.
  ok(
    "low power production is slower than full power",
    ticksNoPower > ticksFullPower * 1.3,
    `brownout=${ticksNoPower}t vs full=${ticksFullPower}t (expected >${Math.ceil(ticksFullPower * 1.3)}t)`,
  );
}

// ===========================================================================
// 2. LOW POWER: do turrets go offline during brownout?
//    The old test checked "power is produced" — not that turrets stop firing.
// ===========================================================================
section("Low power disables turrets");
{
  const sim = flatSim(2);
  base(sim, 1, 30, 30);
  sim.economy(1).credits = 99999;

  // Power plant + barracks + turret: fully powered.
  const pp = sim.placeBuilding(1, "power_plant", 30, 26)!;
  pp.buildRemaining = 0;
  const tbar = sim.placeBuilding(1, "barracks", 34, 30)!;
  tbar.buildRemaining = 0;
  const turret = sim.placeBuilding(1, "gun_turret", 26, 30)!;
  turret.buildRemaining = 0;
  sim.step();

  // Turret should kill an infantry that wanders into range.
  const attacker1 = sim.spawnUnit(0, "infantry", 22, 30);
  run(sim, 25);
  ok("turret fires with power", !sim.units.has(attacker1.id), "infantry killed");

  // Now sell the power plant to trigger brownout.
  sim.sellBuilding(1, pp.id);
  // Wait for sell to complete.
  for (let i = 0; i < 20 * TICK_RATE; i++) sim.step();
  ok("brownout after selling power", sim.isLowPower(1));

  // A new infantry should survive — turret is offline.
  const attacker2 = sim.spawnUnit(0, "infantry", 22, 30);
  run(sim, 25);
  ok(
    "turret is offline during brownout",
    sim.units.has(attacker2.id),
    `infantry hp=${attacker2.hp}/${unitDef("infantry").maxHp}`,
  );
}

// ===========================================================================
// 3. AI SUSTAINED ECONOMY: does the AI grow its economy over time, not just
//    build a fixed opening then stall?
//    The old test checked "AI expands base (≥4 buildings)" at one point in
//    time. This test measures economic growth rate at multiple intervals.
// ===========================================================================
section("AI sustains economy over a long game");
{
  const { map, starts } = generateMap(2, 42);
  const sim = new Sim(map);
  sim.setSupplyNodes(generateSupplyNodes(map, starts));
  sim.addPlayer({ id: 0, name: "AI", faction: "usa", team: 0 });
  sim.addPlayer({ id: 1, name: "Idle", faction: "usa", team: 1 });
  for (const i of [0, 1]) {
    const s = starts[i]!;
    base(sim, i, Math.floor(s.x) - 1, Math.floor(s.y) - 1);
    sim.spawnUnit(i, "dozer", s.x + 2.5, s.y + 2.5);
  }
  const bot = new AIPlayer(sim, 0, "normal");

  // Snapshot at 2 minutes, 5 minutes, and 10 minutes.
  const snapshots: Array<{ time: string; harvesters: number; supplyCenters: number; credits: number }> = [];

  run(sim, 120, [bot]);
  snapshots.push({
    time: "2min",
    harvesters: [...sim.units.values()].filter((u) => u.owner === 0 && u.type === "harvester").length,
    supplyCenters: [...sim.buildings.values()].filter((b) => b.owner === 0 && b.type === "supply_center").length,
    credits: sim.economy(0).credits,
  });

  run(sim, 180, [bot]);
  snapshots.push({
    time: "5min",
    harvesters: [...sim.units.values()].filter((u) => u.owner === 0 && u.type === "harvester").length,
    supplyCenters: [...sim.buildings.values()].filter((b) => b.owner === 0 && b.type === "supply_center").length,
    credits: sim.economy(0).credits,
  });

  run(sim, 300, [bot]);
  snapshots.push({
    time: "10min",
    harvesters: [...sim.units.values()].filter((u) => u.owner === 0 && u.type === "harvester").length,
    supplyCenters: [...sim.buildings.values()].filter((b) => b.owner === 0 && b.type === "supply_center").length,
    credits: sim.economy(0).credits,
  });

  console.log(`        ${snapshots.map((s) => `${s.time}: ${s.harvesters}h, ${s.supplyCenters}sc, $${s.credits}`).join(" | ")}`);

  ok(
    "AI builds more than 1 supply center over a long game",
    snapshots[2]!.supplyCenters >= 2,
    `${snapshots[2]!.supplyCenters} at 10min`,
  );
  ok(
    "AI harvester count grows over time",
    snapshots[2]!.harvesters > snapshots[0]!.harvesters,
    `${snapshots[0]!.harvesters} -> ${snapshots[2]!.harvesters}`,
  );
  ok(
    "AI economy does not stagnate (credits at 10min > 0 or harvesters ≥ 5)",
    snapshots[2]!.credits > 0 || snapshots[2]!.harvesters >= 5,
    `$${snapshots[2]!.credits}, ${snapshots[2]!.harvesters} harvesters`,
  );
}

// ===========================================================================
// 4. AI RECOVERY: does the AI rebuild its army after a failed attack?
//    The old test only checked "AI attacks and can win unopposed" — a single
//    wave. This test kills the AI's army mid-game and checks it rebuilds.
// ===========================================================================
section("AI rebuilds army after losses");
{
  const { map, starts } = generateMap(2, 42);
  const sim = new Sim(map);
  sim.setSupplyNodes(generateSupplyNodes(map, starts));
  sim.addPlayer({ id: 0, name: "AI", faction: "usa", team: 0 });
  sim.addPlayer({ id: 1, name: "Idle", faction: "usa", team: 1 });
  for (const i of [0, 1]) {
    const s = starts[i]!;
    base(sim, i, Math.floor(s.x) - 1, Math.floor(s.y) - 1);
    sim.spawnUnit(i, "dozer", s.x + 2.5, s.y + 2.5);
  }
  const bot = new AIPlayer(sim, 0, "normal");

  // Let the AI build up for 5 minutes.
  run(sim, 300, [bot]);

  const armyBefore = [...sim.units.values()].filter(
    (u) => u.owner === 0 && unitDef(u.type).weapon,
  ).length;

  // Kill all the AI's combat units.
  for (const u of [...sim.units.values()]) {
    if (u.owner === 0 && unitDef(u.type).weapon) sim.units.delete(u.id);
  }

  // Let the AI recover.
  run(sim, 300, [bot]);

  const armyAfter = [...sim.units.values()].filter(
    (u) => u.owner === 0 && unitDef(u.type).weapon,
  ).length;

  ok(
    "AI rebuilds army after total loss",
    armyAfter > 0,
    `${armyBefore} -> 0 -> ${armyAfter}`,
  );
  ok(
    "AI rebuilds at least 20% of its previous army size",
    armyAfter >= Math.max(2, Math.floor(armyBefore * 0.2)),
    `${armyAfter} rebuilt (was ${armyBefore})`,
  );
}

// ===========================================================================
// 5. PATHFINDING: units escape dense building layouts.
//    The old test used a single 3x3 building. This test creates a U-shaped
//    building trap and verifies the unit escapes.
// ===========================================================================
section("Units escape building traps");
{
  const sim = flatSim(1);

  // Create a U-shaped trap: buildings on three sides, narrow opening.
  // Place buildings to form a pocket with a 1-tile gap.
  const buildings = [
    ["command_center", 20, 20], // 3x3: tiles 20-22, 20-22
    ["barracks", 20, 24],       // 2x2: tiles 20-21, 24-25
    ["barracks", 24, 20],       // 2x2: tiles 24-25, 20-21
  ] as const;

  for (const [type, x, y] of buildings) {
    const b = sim.placeBuilding(0, type, x, y)!;
    b.buildRemaining = 0;
  }

  // Place a unit inside the pocket (tile 23, 22 — surrounded by buildings).
  const u = sim.spawnUnit(0, "infantry", 23.5, 22.5);

  // Order it to move far away.
  sim.issueMove(0, [u.id], 40, 40);

  // Give it plenty of time to escape (or get stuck forever).
  let escaped = false;
  for (let i = 0; i < 60 * TICK_RATE; i++) {
    sim.step();
    if (Math.hypot(u.x - 40, u.y - 40) < 3) {
      escaped = true;
      break;
    }
  }

  ok(
    "unit escapes U-shaped building trap",
    escaped,
    escaped ? `reached ${u.x.toFixed(1)},${u.y.toFixed(1)}` : `stuck at ${u.x.toFixed(1)},${u.y.toFixed(1)}`,
  );
}

// ===========================================================================
// 6. PATHFINDING: units don't get permanently stuck between two buildings.
//    Two buildings with a 1-tile gap between them — a unit ordered through
//    the gap must get through or around.
// ===========================================================================
section("Units navigate narrow gaps between buildings");
{
  const sim = flatSim(1);

  // Two 3x3 buildings with a 1-tile gap between them.
  const b1 = sim.placeBuilding(0, "command_center", 20, 20)!;
  b1.buildRemaining = 0;
  const b2 = sim.placeBuilding(0, "supply_center", 24, 20)!;
  b2.buildRemaining = 0;

  // Unit on one side, ordered to the other side through the gap at x=23.
  const u = sim.spawnUnit(0, "infantry", 22, 25);
  sim.issueMove(0, [u.id], 22, 15);

  let arrived = false;
  for (let i = 0; i < 60 * TICK_RATE; i++) {
    sim.step();
    if (u.y < 18) {
      arrived = true;
      break;
    }
  }

  ok(
    "unit navigates through narrow gap",
    arrived,
    arrived ? `at ${u.x.toFixed(1)},${u.y.toFixed(1)}` : `stuck at ${u.x.toFixed(1)},${u.y.toFixed(1)}`,
  );
}

// ===========================================================================
// 7. C&C FEEL: unit stat relationships match design intent.
//    Artillery should outrange everything. Tanks should survive rifle fire.
//    Choppers should outrange ground AA without flak. These are the
//    rock-paper-scissors relationships that make the game feel like C&C.
// ===========================================================================
section("C&C feel: unit stat relationships");
{
  const ranges = new Map<string, number>();
  for (const [name, def] of Object.entries(UNITS)) {
    if (def.weapon) ranges.set(name, def.weapon.range);
  }

  // Artillery outranges everything else.
  const artilleryRange = ranges.get("artillery")!;
  const maxOtherRange = Math.max(...[...ranges.entries()]
    .filter(([name]) => name !== "artillery")
    .map(([, r]) => r));
  ok(
    "artillery outranges all other units",
    artilleryRange > maxOtherRange,
    `artillery=${artilleryRange} vs next=${maxOtherRange}`,
  );

  // Tanks survive a reasonable amount of rifle fire (not instantly killed).
  const rifleDmg = UNITS.infantry!.weapon!.damage;
  const rifleReload = UNITS.infantry!.weapon!.reload;
  const tankHp = UNITS.tank!.maxHp;
  const rifleDps = rifleDmg / rifleReload;
  const timeToKillTank = tankHp / rifleDps;
  ok(
    "tanks are not instantly killed by rifles",
    timeToKillTank > 10,
    `${timeToKillTank.toFixed(1)}s for one rifle to kill one tank`,
  );

  // Choppers outrange cannon turrets (so they can siege without flak answer).
  const chopperRange = UNITS.chopper!.weapon!.range;
  const cannonTurretRange = BUILDINGS.cannon_turret!.weapon!.range;
  ok(
    "choppers outrange cannon turrets",
    chopperRange >= cannonTurretRange,
    `chopper=${chopperRange} vs cannon_turret=${cannonTurretRange}`,
  );

  // Rocket infantry counters tanks: rocket DPS vs heavy > rifle DPS vs heavy.
  const rocketDpsVsHeavy = UNITS.rocket!.weapon!.damage / UNITS.rocket!.weapon!.reload * 1.5; // rocket vs heavy multiplier
  const rifleDpsVsHeavy = UNITS.infantry!.weapon!.damage / UNITS.infantry!.weapon!.reload * 0.25; // gun vs heavy multiplier
  ok(
    "rocket infantry counters tanks (DPS vs heavy)",
    rocketDpsVsHeavy > rifleDpsVsHeavy * 3,
    `rocket=${rocketDpsVsHeavy.toFixed(1)} vs rifle=${rifleDpsVsHeavy.toFixed(1)}`,
  );

  // Starting credits allow a supply center + power plant opening.
  ok(
    "starting credits allow supply center + power plant opening",
    STARTING_CREDITS >= BUILDINGS.supply_center!.cost + BUILDINGS.power_plant!.cost,
    `$${STARTING_CREDITS} vs $${BUILDINGS.supply_center!.cost + BUILDINGS.power_plant!.cost}`,
  );
}

// ===========================================================================
// 8. C&C FEEL: combat is decisive — units die in reasonable timeframes.
//    If combat is too slow, battles feel like a slog. If too fast, units
//    feel disposable. C&C battles are typically 5-30 seconds for squad fights.
// ===========================================================================
section("C&C feel: combat pacing");
{
  function timeToKill(attackerType: string, defenderType: string, count: number): number {
    const sim = flatSim(2);
    const defender = sim.spawnUnit(1, defenderType, 30, 20);
    for (let i = 0; i < count; i++)
      sim.spawnUnit(0, attackerType, 25 + i * 0.8, 20);
    for (let t = 0; t < 120 * TICK_RATE; t++) {
      sim.step();
      if (!sim.units.has(defender.id)) return t / TICK_RATE;
    }
    return Infinity;
  }

  // 3 tanks vs 1 tank should be decisive (under 30s).
  const tankFight = timeToKill("tank", "tank", 3);
  ok(
    "tank vs tank combat is decisive (3v1 under 30s)",
    tankFight < 30,
    `${tankFight.toFixed(1)}s`,
  );

  // 1 artillery vs 4 infantry should kill the cluster quickly (splash).
  const artilleryVsInf = timeToKill("artillery", "infantry", 1);
  ok(
    "artillery kills infantry in reasonable time",
    artilleryVsInf < 20,
    `${artilleryVsInf.toFixed(1)}s`,
  );
}

// ===========================================================================
// 9. REGRESSION GUARD: LOW_POWER_SPEED is not 1.0 (which would mean brownout
//    has no effect). This is the simplest possible check that caught the
//    original "low power doesn't affect anything" bug.
// ===========================================================================
section("Regression guards");
{
  ok(
    "LOW_POWER_SPEED is not 1.0 (brownout has an effect)",
    LOW_POWER_SPEED < 1.0,
    `value=${LOW_POWER_SPEED}`,
  );
  ok(
    "LOW_POWER_SPEED is meaningfully slow (< 0.6)",
    LOW_POWER_SPEED < 0.6,
    `value=${LOW_POWER_SPEED}`,
  );
}

// ===========================================================================
// Helpers
// ===========================================================================
function measureProductionTime(sim: Sim, buildingId: number): number {
  const building = sim.buildings.get(buildingId);
  if (!building || building.queue.length === 0) return -1;
  const startTick = sim.tick;
  const targetUnit = building.queue[0]!.unitType;
  for (let t = 0; t < 120 * TICK_RATE; t++) {
    sim.step();
    // Check if the queued unit has been produced.
    const produced = [...sim.units.values()].some(
      (u) => u.type === targetUnit && Math.hypot(u.x - building.x, u.y - building.y) < 5,
    );
    if (produced) return sim.tick - startTick;
  }
  return -1;
}

// ===========================================================================
console.log(
  `\n${pass} passed, ${failed.length} failed` +
    (failed.length ? `\nFAILED: ${failed.join(", ")}` : ""),
);
process.exit(failed.length === 0 ? 0 : 1);

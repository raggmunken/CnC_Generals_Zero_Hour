/**
 * The computer opponent.
 *
 * Built around the thing the original Generals AI does not have. Reading EA's
 * source earlier, `AIPlayer::selectTeamToBuild()` gathers every buildable team,
 * keeps those at the highest script-authored priority, and then picks one with
 * `GameLogicRandomValue()`. Nothing in `AIPlayer` stores what the opponent has.
 * It is not a weak strategist; it has no strategist, and its difficulty levels
 * are resource multipliers rather than better play.
 *
 * So this one keeps a model of the enemy from the outset, only knows what it
 * has actually seen, and picks production to counter it. Difficulty changes how
 * fast and how boldly it thinks -- never how much money it is handed.
 */
import { BUILDINGS, UNITS, buildingDef, unitDef } from "../shared/content.js";
import type { Sim } from "./sim.js";
import { TICK_RATE } from "./sim.js";
import type { Building, Unit } from "../shared/types.js";

export type Difficulty = "easy" | "normal" | "hard";

export interface Tuning {
  /** Seconds between strategic decisions. */
  thinkInterval: number;
  /** Army value required before committing to an attack. */
  attackThreshold: number;
  /** Harvesters it will keep working. */
  harvesterTarget: number;
  /**
   * How many barracks and war factories it will run.
   *
   * The one lever that is monotonic in strength by construction: more
   * production is straightforwardly more army per minute. The other knobs were
   * measured and did not produce a clean ordering -- attack threshold showed no
   * effect at all across 1200-4800, and think interval was noise once order
   * churn was fixed.
   */
  maxProduction: number;
}

/**
 * Difficulty as competence, not recklessness.
 *
 * The first cut made harder AIs attack at a *lower* army value, on the
 * assumption that aggression reads as difficulty. Self-play said otherwise:
 * hard went 18-21 against easy while beating normal 30-9, because easy's
 * higher threshold made it mass a real army while hard trickled units in and
 * lost them piecemeal. Committing a bigger army is simply stronger, so the
 * threshold now rises with difficulty and the gradient comes from economy and
 * reaction speed instead.
 *
 * None of these touch income. Handing the AI money is what the original game
 * did, and it produces an opponent that is annoying rather than better.
 */
export const TUNING: Record<Difficulty, Tuning> = {
  easy: { thinkInterval: 3.0, attackThreshold: 1800, harvesterTarget: 2, maxProduction: 2 },
  normal: { thinkInterval: 2.0, attackThreshold: 1800, harvesterTarget: 3, maxProduction: 3 },
  hard: { thinkInterval: 1.2, attackThreshold: 1800, harvesterTarget: 3, maxProduction: 3 },
};

// MEASURED STATUS, so the next person does not repeat the search:
//   - attackThreshold has no measurable effect anywhere in 1200..4800.
//   - maxProduction above 2 makes the AI *weaker*: income, not factory count,
//     is the bottleneck, so extra buildings drain money that should be army.
//   - thinkInterval differences were noise once order churn and commit
//     oscillation were fixed.
// The tiers are therefore only weakly differentiated, and honestly labelled as
// such. Making them properly monotonic needs a better AI, not better constants.

/** Broad force categories, mirroring the armour classes we counter. */
interface Sighting {
  infantry: number;
  vehicle: number;
  air: number;
  structure: number;
}

/**
 * A decaying, vision-limited picture of the enemy.
 *
 * Observations fold in with max(remembered, observed) rather than summing:
 * seeing the same ten tanks on two consecutive passes does not mean twenty.
 * Max means a fresh sighting supersedes stale memory while memory survives
 * losing sight of them.
 */
class EnemyModel {
  private seen: Sighting = { infantry: 0, vehicle: 0, air: 0, structure: 0 };
  private baseX: number | null = null;
  private baseY: number | null = null;
  private everSaw = false;

  /** Half-life of a memory, in seconds. */
  private static readonly HALF_LIFE = 45;

  decay(dt: number): void {
    const f = Math.pow(0.5, dt / EnemyModel.HALF_LIFE);
    this.seen.infantry *= f;
    this.seen.vehicle *= f;
    this.seen.air *= f;
    this.seen.structure *= f;
  }

  /** Record what our own units and buildings can currently see. */
  observe(sim: Sim, playerId: number): void {
    // Same definition of sight the snapshot filter uses, so the AI can never
    // know something a human player in its position would not.
    const eyes = sim.visionSources(playerId);
    if (eyes.length === 0) return;

    const fresh: Sighting = { infantry: 0, vehicle: 0, air: 0, structure: 0 };
    let sumX = 0;
    let sumY = 0;
    let structures = 0;

    const visible = (x: number, y: number) =>
      eyes.some((e) => Math.hypot(e.x - x, e.y - y) <= e.vision);

    for (const u of sim.units.values()) {
      if (!sim.isEnemy(playerId, u.owner)) continue;
      if (!visible(u.x, u.y)) continue;
      const def = unitDef(u.type);
      if (def.armour === "infantry") fresh.infantry++;
      else if (def.armour === "air") fresh.air++;
      else fresh.vehicle++;
      this.everSaw = true;
    }

    for (const b of sim.buildings.values()) {
      if (!sim.isEnemy(playerId, b.owner)) continue;
      const d = buildingDef(b.type);
      const bx = b.x + d.size / 2;
      const by = b.y + d.size / 2;
      if (!visible(bx, by)) continue;
      fresh.structure++;
      sumX += bx;
      sumY += by;
      structures++;
      this.everSaw = true;
    }

    this.seen.infantry = Math.max(this.seen.infantry, fresh.infantry);
    this.seen.vehicle = Math.max(this.seen.vehicle, fresh.vehicle);
    this.seen.air = Math.max(this.seen.air, fresh.air);
    this.seen.structure = Math.max(this.seen.structure, fresh.structure);

    if (structures > 0) {
      // Enemy buildings do not walk away, so their centroid is a durable
      // anchor for "where does this player live".
      this.baseX = sumX / structures;
      this.baseY = sumY / structures;
    }
  }

  get mobile(): number {
    return this.seen.infantry + this.seen.vehicle + this.seen.air;
  }

  /** Nothing seen: we are blind and should get eyes on the map. */
  isBlind(): boolean {
    return !this.everSaw || this.mobile + this.seen.structure < 0.5;
  }

  vehicleFraction(): number {
    return this.mobile <= 0 ? 0 : this.seen.vehicle / this.mobile;
  }

  needsAntiAir(): boolean {
    return this.seen.air >= 1;
  }

  knownBase(): { x: number; y: number } | null {
    return this.baseX === null || this.baseY === null ? null : { x: this.baseX, y: this.baseY };
  }
}

/** Deterministic PRNG (mulberry32), so matches are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class AIPlayer {
  private readonly model = new EnemyModel();
  /**
   * Seeded rather than Math.random: without this a match cannot be replayed,
   * and a mirror self-play match cannot settle to an exact 50%, which is the
   * check that tells you the harness itself is sound.
   */
  private readonly rand: () => number;
  private nextThink = 0;
  private readonly tuning: Tuning;
  /** Units held back from attacking until the army is worth committing. */
  private massing = new Set<number>();
  /** Where the army was last sent, so identical orders are not re-issued. */
  private lastAttackX?: number;
  private lastAttackY?: number;
  /** True while the army is committed to an attack. Hysteresis, see below. */
  private committed = false;
  /** How many attack waves have been launched. Resets economy priority after losses. */
  private attackWaves = 0;
  /** Timestamp of last attack commitment, to detect stale committed state. */
  private lastCommitTick = 0;

  constructor(
    private readonly sim: Sim,
    readonly playerId: number,
    /** A named difficulty, or an explicit tuning for parameter sweeps. */
    difficulty: Difficulty | Tuning = "normal",
  ) {
    this.tuning = typeof difficulty === "string" ? TUNING[difficulty] : difficulty;
    this.rand = rng(0x9e3779b9 ^ (playerId * 2654435761));
  }

  /**
   * What this AI currently believes about the enemy.
   *
   * Exposed so the fog claim can be tested rather than asserted: an AI that
   * "respects vision" needs to be demonstrably blind to things it has not
   * seen, and this is also the first thing worth printing when its decisions
   * look wrong.
   */
  intel(): { blind: boolean; knownBase: { x: number; y: number } | null; mobile: number } {
    return {
      blind: this.model.isBlind(),
      knownBase: this.model.knownBase(),
      mobile: this.model.mobile,
    };
  }

  /** Called every tick; does real work only on its own slower cadence. */
  update(): void {
    if (this.sim.tick < this.nextThink) return;
    const dt = this.tuning.thinkInterval;
    this.nextThink = this.sim.tick + Math.round(dt * TICK_RATE);

    this.model.decay(dt);
    this.model.observe(this.sim, this.playerId);

    // If the army has been wiped, prioritise rebuilding it over expanding
    // the base. buildBase() spends income on structures, which starves
    // trainUnits() of the money needed to replace lost combat units.
    const combatCount = this.myUnits().filter((u) => unitDef(u.type).weapon !== undefined).length;
    if (combatCount > 0 || this.attackWaves === 0) {
      this.buildBase();
    }
    this.trainUnits();
    this.commandArmy();
  }

  private mine<T extends { owner: number }>(items: Iterable<T>): T[] {
    return [...items].filter((i) => i.owner === this.playerId);
  }

  /** Completed buildings only -- these are the ones that can produce. */
  private myBuildings(type?: string): Building[] {
    return this.mine(this.sim.buildings.values()).filter(
      (b) => (type === undefined || b.type === type) && b.buildRemaining === 0,
    );
  }

  /**
   * Buildings including those still going up.
   *
   * Build-order decisions must use this. Counting only finished buildings
   * means the AI cannot see what it has already paid for, so it buys a second
   * supply centre while the first is under construction, spends itself to
   * nothing, and can never afford the harvester that would have paid for it.
   */
  private countBuildings(type: string): number {
    return this.mine(this.sim.buildings.values()).filter((b) => b.type === type).length;
  }

  private myUnits(type?: string): Unit[] {
    return this.mine(this.sim.units.values()).filter((u) => type === undefined || u.type === type);
  }

  private homePosition(): { x: number; y: number } {
    const cc = this.myBuildings("command_center")[0] ?? this.mine(this.sim.buildings.values())[0];
    if (cc) {
      const size = buildingDef(cc.type).size;
      return { x: cc.x + size / 2, y: cc.y + size / 2 };
    }
    const u = this.myUnits()[0];
    return u ? { x: u.x, y: u.y } : { x: this.sim.map.width / 2, y: this.sim.map.height / 2 };
  }

  /**
   * Find somewhere legal to put a building, spiralling out from home.
   *
   * Deliberately leaves a gap around the base centre so the AI does not wall
   * its own production in -- a base that cannot get its units out is worse
   * than a sprawling one.
   */
  private findPlot(size: number): { x: number; y: number } | null {
    const home = this.homePosition();
    for (let r = 5; r < 24; r += 3) {
      for (let a = 0; a < 16; a++) {
        const angle = (Math.PI * 2 * a) / 16;
        const x = Math.round(home.x + Math.cos(angle) * r);
        const y = Math.round(home.y + Math.sin(angle) * r);
        if (!this.sim.isAreaFree(x, y, size)) continue;
        // Ensure a 2-tile gap between this building and any existing one,
        // so harvesters (radius > 0.5, using the inflated blockedWide grid)
        // can always path between buildings. Without this, the AI walls in
        // its own supply centers and harvesters get permanently trapped.
        if (this.hasClearance(x, y, size, 2)) return { x, y };
      }
    }
    // Fallback: relax the clearance requirement if no spacious plot exists.
    for (let r = 5; r < 24; r += 3) {
      for (let a = 0; a < 16; a++) {
        const angle = (Math.PI * 2 * a) / 16;
        const x = Math.round(home.x + Math.cos(angle) * r);
        const y = Math.round(home.y + Math.sin(angle) * r);
        if (this.sim.isAreaFree(x, y, size)) return { x, y };
      }
    }
    return null;
  }

  /** Check that no existing building is within `gap` tiles of the proposed footprint. */
  private hasClearance(x: number, y: number, size: number, gap: number): boolean {
    for (const b of this.mine(this.sim.buildings.values())) {
      const bs = buildingDef(b.type).size;
      // Check if the expanded footprints overlap.
      if (x < b.x + bs + gap && x + size + gap > b.x &&
          y < b.y + bs + gap && y + size + gap > b.y) return false;
    }
    return true;
  }

  private tryBuild(type: string, reserve = 0): boolean {
    if (!this.sim.canBuild(this.playerId, type)) return false;
    const def = BUILDINGS[type]!;
    if (this.sim.economy(this.playerId).credits < def.cost + reserve) return false;
    const plot = this.findPlot(def.size);
    if (!plot) return false;
    return this.sim.placeBuilding(this.playerId, type, plot.x, plot.y) !== null;
  }

  /**
   * Base build order.
   *
   * Economy before army, power before the thing that needs it. Ordered rather
   * than scored because an opening is a sequence, and a scoring function that
   * reproduces a good opening is a scoring function with the opening hidden
   * inside it.
   */
  private buildBase(): void {
    const eco = this.sim.economy(this.playerId);
    const has = (t: string) => this.countBuildings(t);

    // One thing under construction at a time: queueing several at once is how
    // an opening spends itself into a position it cannot recover from.
    const underway = this.mine(this.sim.buildings.values()).some((b) => b.buildRemaining > 0);
    if (underway) return;

    // Income first: everything else is gated on it.
    if (has("supply_center") === 0) {
      this.tryBuild("supply_center");
      return;
    }

    // Sustained economy: build additional supply centers so harvesters have
    // drop-off points and income scales into late game. One center stalls
    // after the nearby pile depletes and the long walk kills throughput.
    // Prioritize this early: a second supply center costs 1500 and pays for
    // itself in roughly 30 seconds of two-harvester throughput.
    const supplyCenters = has("supply_center");
    const harvesters = this.myUnits("harvester").length;
    if (supplyCenters < 3 && eco.credits > 1500 && harvesters >= 2) {
      if (this.tryBuild("supply_center")) return;
    }

    // Scale harvester target with supply centers: each center supports 2-3
    // harvesters, so more centers means more income means more army.
    const scaledHarvesterTarget = this.tuning.harvesterTarget + (supplyCenters - 1) * 3;
    const needsHarvesters = harvesters < scaledHarvesterTarget;
    const reserve = needsHarvesters ? UNITS.harvester!.cost : 0;
    if (eco.credits < reserve) return;

    // Keep ahead of the power curve rather than reacting to a brownout.
    if (eco.powerProduced - eco.powerConsumed < 5) {
      if (this.tryBuild("power_plant")) return;
    }

    if (has("barracks") === 0) {
      this.tryBuild("barracks");
      return;
    }

    if (has("war_factory") === 0) {
      this.tryBuild("war_factory");
      return;
    }

    // Expand production up to the difficulty's cap, once there is money spare
    // to keep the extra buildings busy.
    const production = has("barracks") + has("war_factory");
    const productionCap = this.tuning.maxProduction + 2;
    if (production < productionCap) {
      if (eco.credits > 2000 && has("barracks") <= has("war_factory")) {
        if (this.tryBuild("barracks")) return;
      }
      if (eco.credits > 3000) {
        if (this.tryBuild("war_factory")) return;
      }
    }
    // Defend against what has actually been seen, rather than building a
    // generic turret: this is the same counter-composition logic the
    // production queue uses, applied to static defence.
    const defences = has("gun_turret") + has("cannon_turret") + has("aa_turret");
    if (eco.credits > 2500 && defences < 3) {
      if (this.model.needsAntiAir() && has("aa_turret") < 1) {
        if (this.tryBuild("aa_turret")) return;
      }
      const pick = this.model.vehicleFraction() > 0.4 ? "cannon_turret" : "gun_turret";
      this.tryBuild(pick);
    }
  }

  /** Queue units, countering what we have actually seen. */
  private trainUnits(): void {
    const eco = this.sim.economy(this.playerId);

    // Harvesters pay for everything else, so they come first.
    // Scale target with supply centers for sustained income growth.
    const supplyCenters = this.myBuildings("supply_center");
    const harvesterTarget = this.tuning.harvesterTarget + Math.max(0, supplyCenters.length - 1) * 3;
    const harvesters = this.myUnits("harvester").length;
    if (harvesters < harvesterTarget) {
      // Queue at the supply center with the shortest queue.
      const idle = supplyCenters.filter((s) => s.queue.length === 0);
      const target = idle[0] ?? supplyCenters[0];
      if (target && eco.credits >= UNITS.harvester!.cost) {
        this.sim.queueUnit(this.playerId, target.id, "harvester");
        return;
      }
    }

    const wantAir = this.model.needsAntiAir();
    const armoured = this.model.vehicleFraction() > 0.4;

    for (const factory of this.myBuildings("war_factory")) {
      if (factory.queue.length >= 2) continue;
      // Answer air the moment it is seen; otherwise tanks are the backbone,
      // with choppers kept at a quarter of the vehicle fleet -- air mobility
      // is too strong to leave on the table, and it forces the opponent's
      // flak to be in two places at once.
      const vehicles = this.myUnits().filter((u) =>
        ["tank", "aa_vehicle", "artillery", "chopper"].includes(u.type)
      );
      const choppers = vehicles.filter((u) => u.type === "chopper").length;
      const pick = wantAir ? "aa_vehicle" : choppers * 4 <= vehicles.length ? "chopper" : "tank";
      if (eco.credits >= UNITS[pick]!.cost) {
        this.sim.queueUnit(this.playerId, factory.id, pick);
      }
    }

    for (const barracks of this.myBuildings("barracks")) {
      if (barracks.queue.length >= 2) continue;
      // Rockets against armour, rifles against infantry, and rifles while
      // blind because they are the cheapest way to get eyes on the map.
      const pick = armoured ? "rocket" : "infantry";
      if (eco.credits >= UNITS[pick]!.cost) {
        this.sim.queueUnit(this.playerId, barracks.id, pick);
      }
    }
  }

  /** Value of a unit, used to decide when the army is worth committing. */
  private armyValue(units: Unit[]): number {
    return units.reduce((sum, u) => sum + unitDef(u.type).cost, 0);
  }

  /**
   * Gather, then commit.
   *
   * Trickling units into the enemy as they are produced is the classic way for
   * a bot to lose while appearing busy, so the army waits at home until it is
   * worth something, then goes in together.
   */
  private commandArmy(): void {
    const combat = this.myUnits().filter((u) => unitDef(u.type).weapon !== undefined);
    if (combat.length === 0) {
      // Army wiped out: reset committed so rebuilt units mass at home
      // instead of trickling into the enemy one at a time.
      if (this.committed) {
        this.committed = false;
        this.attackWaves++;
        this.massing.clear();
      }
      return;
    }

    const home = this.homePosition();
    const target = this.model.knownBase() ?? this.scoutTarget();

    const value = this.armyValue(combat);

    // Hysteresis on the commit decision.
    //
    // Without it the army oscillates: it crosses the threshold and attacks,
    // takes losses, drops back under, is recalled home, rebuilds, attacks
    // again. Every crossing re-orders everything, and an AI that thinks more
    // often oscillates more often -- which is why self-play had easy (3.0s
    // think) beating hard (0.8s think) 103-52. Once committed, stay committed
    // until the army is genuinely spent.
    if (this.committed && value < this.tuning.attackThreshold * 0.35) {
      this.committed = false;
      this.attackWaves++;
      this.massing.clear();
    } else if (!this.committed && value >= this.tuning.attackThreshold) {
      this.committed = true;
      this.lastCommitTick = this.sim.tick;
    }

    if (!this.committed) {
      // Still massing: hold near home, and send one cheap unit to scout so the
      // model does not stay blind while the army builds.
      for (const u of combat) {
        if (this.massing.has(u.id)) continue;
        this.massing.add(u.id);
        this.sim.issueOrder(this.playerId, [u.id], {
          kind: "move",
          x: home.x + (this.rand() - 0.5) * 6,
          y: home.y + (this.rand() - 0.5) * 6,
        });
      }

      // Scout to find the enemy base.
      if (this.model.isBlind() && target) {
        const scout = combat.find((u) => u.type === "infantry");
        if (scout) {
          this.sim.issueOrder(this.playerId, [scout.id], {
            kind: "attackMove",
            x: target.x,
            y: target.y,
          });
        }
      }
      return;
    }

    if (!target) return;
    this.massing.clear();

    // Only order units that actually need a new order.
    //
    // Re-issuing attack-move to the whole army every think looks harmless and
    // is not: each order recomputes a path and restarts the route, so a faster
    // thinking AI churns its own army in place and never arrives. Ablation
    // caught this backwards -- a 3.0s think interval beat 1.5s at 75%, which
    // only makes sense if thinking is doing damage.
    const moved =
      this.lastAttackX === undefined ||
      Math.hypot(this.lastAttackX - target.x, (this.lastAttackY ?? 0) - target.y) > 4;

    const needsOrder = combat.filter(
      (u) => moved || u.order === undefined || u.order.kind !== "attackMove",
    );
    if (needsOrder.length === 0) return;

    this.lastAttackX = target.x;
    this.lastAttackY = target.y;
    this.sim.issueOrder(
      this.playerId,
      needsOrder.map((u) => u.id),
      { kind: "attackMove", x: target.x, y: target.y },
    );
  }

  /** Somewhere worth looking when we have never seen the enemy. */
  private scoutTarget(): { x: number; y: number } | null {
    const home = this.homePosition();
    // The opposite side of the map is where an opponent almost always is.
    return {
      x: this.sim.map.width - home.x,
      y: this.sim.map.height - home.y,
    };
  }
}

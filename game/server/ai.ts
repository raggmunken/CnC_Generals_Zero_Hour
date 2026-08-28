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

interface Tuning {
  /** Seconds between strategic decisions. */
  thinkInterval: number;
  /** Army value required before committing to an attack. */
  attackThreshold: number;
  /** Harvesters it will keep working. */
  harvesterTarget: number;
}

const TUNING: Record<Difficulty, Tuning> = {
  easy: { thinkInterval: 3.0, attackThreshold: 3000, harvesterTarget: 2 },
  normal: { thinkInterval: 1.5, attackThreshold: 2200, harvesterTarget: 3 },
  hard: { thinkInterval: 0.8, attackThreshold: 1600, harvesterTarget: 4 },
};

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
    const eyes: Array<{ x: number; y: number; vision: number }> = [];
    for (const u of sim.units.values()) {
      if (u.owner === playerId) eyes.push({ x: u.x, y: u.y, vision: unitDef(u.type).vision });
    }
    for (const b of sim.buildings.values()) {
      if (b.owner !== playerId) continue;
      const d = buildingDef(b.type);
      eyes.push({ x: b.x + d.size / 2, y: b.y + d.size / 2, vision: d.vision });
    }
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

export class AIPlayer {
  private readonly model = new EnemyModel();
  private nextThink = 0;
  private readonly tuning: Tuning;
  /** Units held back from attacking until the army is worth committing. */
  private massing = new Set<number>();

  constructor(
    private readonly sim: Sim,
    readonly playerId: number,
    readonly difficulty: Difficulty = "normal",
  ) {
    this.tuning = TUNING[difficulty];
  }

  /** Called every tick; does real work only on its own slower cadence. */
  update(): void {
    if (this.sim.tick < this.nextThink) return;
    const dt = this.tuning.thinkInterval;
    this.nextThink = this.sim.tick + Math.round(dt * TICK_RATE);

    this.model.decay(dt);
    this.model.observe(this.sim, this.playerId);

    this.buildBase();
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
    for (let r = 4; r < 22; r += 2) {
      for (let a = 0; a < 16; a++) {
        const angle = (Math.PI * 2 * a) / 16;
        const x = Math.round(home.x + Math.cos(angle) * r);
        const y = Math.round(home.y + Math.sin(angle) * r);
        // isAreaFree already rejects impassable terrain and overlaps.
        if (this.sim.isAreaFree(x, y, size)) return { x, y };
      }
    }
    return null;
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

    // Do not spend the harvester money on structures: income first, or the
    // base is a monument rather than an economy.
    const needsHarvesters = this.myUnits("harvester").length < this.tuning.harvesterTarget;
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

    // Expand production once there is money spare to keep it busy.
    if (eco.credits > 3500 && has("barracks") < 2) {
      if (this.tryBuild("barracks")) return;
    }
    if (eco.credits > 5000 && has("war_factory") < 2) {
      if (this.tryBuild("war_factory")) return;
    }
    if (eco.credits > 2500 && has("turret") < 2) {
      this.tryBuild("turret");
    }
  }

  /** Queue units, countering what we have actually seen. */
  private trainUnits(): void {
    const eco = this.sim.economy(this.playerId);

    // Harvesters pay for everything else, so they come first.
    const supply = this.myBuildings("supply_center")[0];
    if (supply && this.myUnits("harvester").length < this.tuning.harvesterTarget) {
      if (eco.credits >= UNITS.harvester!.cost && supply.queue.length === 0) {
        this.sim.queueUnit(this.playerId, supply.id, "harvester");
        return;
      }
    }

    const wantAir = this.model.needsAntiAir();
    const armoured = this.model.vehicleFraction() > 0.4;

    for (const factory of this.myBuildings("war_factory")) {
      if (factory.queue.length >= 2) continue;
      // Answer air the moment it is seen; otherwise tanks are the backbone.
      const pick = wantAir ? "aa_vehicle" : "tank";
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
    if (combat.length === 0) return;

    const home = this.homePosition();
    const target = this.model.knownBase() ?? this.scoutTarget();

    const value = this.armyValue(combat);
    if (value < this.tuning.attackThreshold) {
      // Still massing: hold near home, and send one cheap unit to scout so the
      // model does not stay blind while the army builds.
      for (const u of combat) {
        if (this.massing.has(u.id)) continue;
        this.massing.add(u.id);
        this.sim.issueOrder(this.playerId, [u.id], {
          kind: "move",
          x: home.x + (Math.random() - 0.5) * 6,
          y: home.y + (Math.random() - 0.5) * 6,
        });
      }

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
    this.sim.issueOrder(
      this.playerId,
      combat.map((u) => u.id),
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

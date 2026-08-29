/**
 * Wire protocol. Client sends commands, server sends snapshots.
 *
 * The client is a renderer and an input device; it never simulates. That keeps
 * there being exactly one authority and removes any prediction/reconciliation
 * layer to keep in sync.
 */
import type { Building, Economy, Order, PlayerState, SupplyNode, Tracer, Unit } from "./types.js";

/** Server -> client, once on connect. */
export interface WelcomeMsg {
  t: "welcome";
  playerId: number;
  tickRate: number;
  map: { width: number; height: number; tiles: number[] };
  players: PlayerState[];
  /** The settings this match was started with, so the lobby can show them. */
  config: { players: number; bots: number; difficulty: string; seed: number };
}

/** Server -> client, every tick. */
export interface SnapshotMsg {
  t: "snap";
  tick: number;
  units: Unit[];
  buildings: Building[];
  supply: SupplyNode[];
  /** Shots fired this tick, purely for rendering. */
  tracers: Tracer[];
  /** Player ids with nothing left on the field. */
  eliminated: number[];
  /**
   * Where this player can currently see from.
   *
   * Sent rather than a fog bitmap: a 112x112 grid at 15Hz is far more
   * bandwidth than a handful of circles, and the client can rasterise it.
   */
  vision: Array<{ x: number; y: number; vision: number }>;
  /** The receiving player's own economy only. */
  economy: Economy;
}

/** Client -> server: move the given units to a point. */
export interface MoveCmd {
  t: "move";
  unitIds: number[];
  x: number;
  y: number;
}

/** Client -> server: place a building at a tile. */
export interface BuildCmd {
  t: "build";
  buildingType: string;
  x: number;
  y: number;
}

/** Client -> server: queue a unit at one of our buildings. */
export interface TrainCmd {
  t: "train";
  buildingId: number;
  unitType: string;
}

/** Client -> server: a full order (attack-move, attack a target). */
export interface OrderCmd {
  t: "order";
  unitIds: number[];
  order: Order;
  /** Shift-queue: run after the unit's current order instead of replacing it. */
  append?: boolean;
}

/** Client -> server: set a building's rally point. */
export interface RallyCmd {
  t: "rally";
  buildingId: number;
  x: number;
  y: number;
}

/** Client -> server: sell a building for a partial refund. */
export interface SellCmd {
  t: "sell";
  buildingId: number;
}

/** Client -> server: throw away this match and start a new one. */
export interface NewMatchCmd {
  t: "newMatch";
  players: number;
  bots: number;
  difficulty: "easy" | "normal" | "hard";
  seed: number;
}

export type ServerMsg = WelcomeMsg | SnapshotMsg;
export type ClientMsg = MoveCmd | BuildCmd | TrainCmd | OrderCmd | RallyCmd | SellCmd | NewMatchCmd;

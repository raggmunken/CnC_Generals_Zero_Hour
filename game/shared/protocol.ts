/**
 * Wire protocol. Client sends commands, server sends snapshots.
 *
 * The client is a renderer and an input device; it never simulates. That keeps
 * there being exactly one authority and removes any prediction/reconciliation
 * layer to keep in sync.
 */
import type { Building, Economy, PlayerState, SupplyNode, Unit } from "./types.js";

/** Server -> client, once on connect. */
export interface WelcomeMsg {
  t: "welcome";
  playerId: number;
  tickRate: number;
  map: { width: number; height: number; tiles: number[] };
  players: PlayerState[];
}

/** Server -> client, every tick. */
export interface SnapshotMsg {
  t: "snap";
  tick: number;
  units: Unit[];
  buildings: Building[];
  supply: SupplyNode[];
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

export type ServerMsg = WelcomeMsg | SnapshotMsg;
export type ClientMsg = MoveCmd | BuildCmd | TrainCmd;

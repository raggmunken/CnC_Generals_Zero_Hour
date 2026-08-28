/**
 * Wire protocol. Client sends commands, server sends snapshots.
 *
 * The client is a renderer and an input device; it never simulates. That keeps
 * there being exactly one authority and removes any prediction/reconciliation
 * layer to keep in sync.
 */
import type { PlayerState, Unit } from "./types.js";

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
}

/** Client -> server: move the given units to a point. */
export interface MoveCmd {
  t: "move";
  unitIds: number[];
  x: number;
  y: number;
}

export type ServerMsg = WelcomeMsg | SnapshotMsg;
export type ClientMsg = MoveCmd;

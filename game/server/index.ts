/**
 * Game server: HTTP for the built client, WebSocket for play.
 *
 * One match at a time, but restartable: the lobby replaces it wholesale rather
 * than mutating it, so a new game cannot inherit half the old one.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

import { AIPlayer, type Difficulty } from "./ai.js";
import { generateMap, generateSupplyNodes } from "./mapgen.js";
import { Sim, TICK_RATE } from "./sim.js";
import { buildingDef, mapPreset } from "../shared/content.js";
import type { ClientMsg, ServerMsg } from "../shared/protocol.js";
import type { Building, FactionId, Unit } from "../shared/types.js";

const PORT = Number(process.env.PORT ?? 8090);
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const FACTIONS: FactionId[] = ["usa", "china", "gla"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export interface MatchConfig {
  players: number;
  bots: number;
  difficulty: Difficulty;
  seed: number;
}

/** Everything belonging to one match, so a restart can replace it wholesale. */
interface Match {
  sim: Sim;
  starts: Array<{ x: number; y: number }>;
  bots: AIPlayer[];
  botIds: Set<number>;
  preset: ReturnType<typeof mapPreset>;
  config: MatchConfig;
}

/** Sockets by player id, so a disconnect frees its slot. */
const clients = new Map<number, WebSocket>();

/**
 * Last-known enemy buildings per player.
 *
 * Buildings do not walk away, so a scouted base stays on your map after you
 * lose sight of it. Units get no such memory: an army you cannot see is gone.
 */
const remembered = new Map<number, Map<number, Building>>();

let match: Match;

function defaultConfig(): MatchConfig {
  const players = Number(process.env.PLAYERS ?? 2);
  return {
    players,
    bots: Number(process.env.BOTS ?? players - 1),
    difficulty: (process.env.DIFFICULTY ?? "normal") as Difficulty,
    seed: Number(process.env.SEED ?? 1),
  };
}

/** Give a player their opening base: a command centre, a dozer, an escort. */
function spawnStartingBase(sim: Sim, playerId: number, start: { x: number; y: number }): void {
  const cc = sim.placeBuilding(playerId, "command_center", Math.floor(start.x) - 1, Math.floor(start.y) - 1);
  if (cc) {
    cc.buildRemaining = 0; // the starting base is not under construction
  } else {
    console.warn(`player ${playerId}: command centre could not be placed at its start`);
  }
  sim.spawnUnit(playerId, "dozer", start.x + 2.5, start.y + 2.5);
  for (let i = 0; i < 2; i++) {
    sim.spawnUnit(playerId, "infantry", start.x + 3 + i * 0.9, start.y + 4);
  }
}

function startMatch(cfg: MatchConfig): Match {
  const players = Math.max(2, Math.min(6, Math.floor(cfg.players)));
  const preset = mapPreset(players);
  const { map, starts } = generateMap(preset.players, Math.floor(cfg.seed) || 1);
  const sim = new Sim(map);
  sim.setSupplyNodes(generateSupplyNodes(map, starts));

  const bots: AIPlayer[] = [];
  const botCount = Math.max(0, Math.min(preset.players - 1, Math.floor(cfg.bots)));
  for (let i = 0; i < botCount; i++) {
    // Bots take the highest slots so humans keep the low ones as they join.
    const id = preset.players - 1 - i;
    sim.addPlayer({ id, name: `Bot ${i + 1}`, faction: FACTIONS[id % FACTIONS.length]!, team: id });
    spawnStartingBase(sim, id, starts[id]!);
    bots.push(new AIPlayer(sim, id, cfg.difficulty));
  }

  remembered.clear();
  const normalised: MatchConfig = { ...cfg, players, bots: botCount };
  console.log(
    `match: "${preset.name}" ${map.width}x${map.height}, ${players} players, ` +
      `${botCount} bot${botCount === 1 ? "" : "s"} on ${cfg.difficulty}, seed ${normalised.seed}`,
  );
  return { sim, starts, bots, botIds: new Set(bots.map((b) => b.playerId)), preset, config: normalised };
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** Everything a client needs to render a freshly started match. */
function welcomeFor(playerId: number): ServerMsg {
  return {
    t: "welcome",
    playerId,
    tickRate: TICK_RATE,
    map: {
      width: match.sim.map.width,
      height: match.sim.map.height,
      tiles: [...match.sim.map.tiles],
    },
    players: match.sim.players,
    config: match.config,
  };
}

/** Filter a snapshot down to what this player is allowed to know. */
function viewFor(playerId: number, units: Unit[], buildings: Building[]) {
  const eyes = match.sim.visionSources(playerId);
  const sees = (x: number, y: number) => eyes.some((e) => Math.hypot(e.x - x, e.y - y) <= e.vision);

  let memory = remembered.get(playerId);
  if (!memory) {
    memory = new Map();
    remembered.set(playerId, memory);
  }

  const visibleUnits = units.filter((u) => u.owner === playerId || sees(u.x, u.y));

  const visibleBuildings: Building[] = [];
  const seenNow = new Set<number>();
  for (const b of buildings) {
    const d = buildingDef(b.type);
    if (b.owner === playerId || sees(b.x + d.size / 2, b.y + d.size / 2)) {
      visibleBuildings.push(b);
      seenNow.add(b.id);
      memory.set(b.id, { ...b });
    }
  }

  // Remembered buildings we can no longer see. One we watch being destroyed is
  // forgotten; one destroyed out of sight stays as a stale memory, which is
  // correct -- the player has not learned otherwise.
  for (const [id, b] of memory) {
    if (seenNow.has(id)) continue;
    const d = buildingDef(b.type);
    if (sees(b.x + d.size / 2, b.y + d.size / 2)) {
      memory.delete(id);
      continue;
    }
    visibleBuildings.push(b);
  }

  return { units: visibleUnits, buildings: visibleBuildings };
}

// -- transport --------------------------------------------------------------

const httpServer = createServer(async (req, res) => {
  const rawPath = (req.url ?? "/").split("?")[0] ?? "/";

  // Answer favicon explicitly: browsers always ask, and a 404 puts a red error
  // in every player's console for no reason.
  if (rawPath === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }

  // Static file serving, normalised so a crafted path cannot escape dist/.
  const rel = normalize(rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, ""));
  if (rel.startsWith("..")) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(join(DIST, rel));
    res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws) => {
  // Refuse rather than overlap: a player without a start position spawns on
  // top of someone else's base and silently gets no command centre.
  let playerId = 0;
  while (clients.has(playerId) || match.botIds.has(playerId)) playerId++;
  if (playerId >= match.starts.length) {
    ws.close(1013, "match full");
    return;
  }

  match.sim.addPlayer({
    id: playerId,
    name: `Player ${playerId + 1}`,
    faction: FACTIONS[playerId % FACTIONS.length]!,
    team: playerId,
  });
  spawnStartingBase(match.sim, playerId, match.starts[playerId]!);

  clients.set(playerId, ws);
  console.log(`player ${playerId} joined; ${clients.size} connected`);
  send(ws, welcomeFor(playerId));

  ws.on("message", (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data)) as ClientMsg;
    } catch {
      return; // Ignore malformed frames rather than killing the match.
    }

    const sim = match.sim;
    if (msg.t === "move" && Array.isArray(msg.unitIds)) {
      sim.issueMove(playerId, msg.unitIds, msg.x, msg.y);
    } else if (msg.t === "build" && typeof msg.buildingType === "string") {
      sim.placeBuilding(playerId, msg.buildingType, msg.x, msg.y);
    } else if (msg.t === "train" && typeof msg.buildingId === "number") {
      sim.queueUnit(playerId, msg.buildingId, msg.unitType);
    } else if (msg.t === "order" && Array.isArray(msg.unitIds)) {
      sim.issueOrder(playerId, msg.unitIds, msg.order, msg.append === true);
    } else if (msg.t === "rally" && typeof msg.buildingId === "number") {
      sim.setRally(playerId, msg.buildingId, msg.x, msg.y);
    } else if (msg.t === "newMatch") {
      // Any player may restart. This is a game for you and people you invited,
      // not a public service, so host privileges would be ceremony.
      restart({
        players: msg.players,
        bots: msg.bots,
        difficulty: msg.difficulty,
        seed: msg.seed,
      });
    }
  });

  ws.on("close", () => {
    // Look the socket up rather than trusting the id captured at connect: a
    // lobby restart re-seats everyone, so this socket may now hold a different
    // slot, and deleting the old id would free somebody else's.
    for (const [id, sock] of clients) {
      if (sock === ws) {
        clients.delete(id);
        console.log(`player ${id} left; ${clients.size} connected`);
        return;
      }
    }
  });
});

/** Replace the match and re-seat everyone currently connected. */
function restart(cfg: MatchConfig): void {
  match = startMatch(cfg);

  // Re-seat connected clients into the new match, dropping any who no longer
  // fit -- a 6-player lobby restarted as a duel has nowhere to put player 5.
  const seated = [...clients.entries()];
  clients.clear();
  for (const [, ws] of seated) {
    let id = 0;
    while (clients.has(id) || match.botIds.has(id)) id++;
    if (id >= match.starts.length) {
      ws.close(1013, "match full");
      continue;
    }
    match.sim.addPlayer({
      id,
      name: `Player ${id + 1}`,
      faction: FACTIONS[id % FACTIONS.length]!,
      team: id,
    });
    spawnStartingBase(match.sim, id, match.starts[id]!);
    clients.set(id, ws);
    send(ws, welcomeFor(id));
  }
}

match = startMatch(defaultConfig());

setInterval(() => {
  for (const bot of match.bots) bot.update();
  match.sim.step();

  const units = match.sim.snapshotUnits();
  const buildings = match.sim.snapshotBuildings();
  const supply = match.sim.snapshotSupply();
  const tracers = [...match.sim.tracers];

  for (const [id, ws] of clients) {
    // Filtered server-side rather than hidden by the renderer: a modified
    // client must not be able to see through the fog.
    const view = viewFor(id, units, buildings);
    send(ws, {
      t: "snap",
      tick: match.sim.tick,
      units: view.units,
      buildings: view.buildings,
      supply,
      tracers,
      economy: match.sim.economy(id),
      eliminated: [...match.sim.eliminated],
      vision: match.sim.visionSources(id),
    });
  }
}, 1000 / TICK_RATE);

httpServer.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT} (tick ${TICK_RATE}Hz)`);
});

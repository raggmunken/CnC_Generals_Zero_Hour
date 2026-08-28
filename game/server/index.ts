/**
 * Game server: HTTP for the built client, WebSocket for play.
 *
 * One match per process for now. Lobby and multiple concurrent matches are
 * Phase E; keeping it to one keeps the transport honest and small.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

import { generateMap, generateSupplyNodes } from "./mapgen.js";
import { buildingDef, mapPreset } from "../shared/content.js";
import { AIPlayer, type Difficulty } from "./ai.js";
import { Sim, TICK_RATE } from "./sim.js";
import type { ClientMsg, ServerMsg } from "../shared/protocol.js";
import type { Building, FactionId, Unit } from "../shared/types.js";

const PORT = Number(process.env.PORT ?? 8090);
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const PLAYERS = Number(process.env.PLAYERS ?? 2);
const preset = mapPreset(PLAYERS);
const { map, starts } = generateMap(preset.players, Number(process.env.SEED ?? 1));
const sim = new Sim(map);
sim.setSupplyNodes(generateSupplyNodes(map, starts));

/** Computer opponents, ticked with the simulation. */
const bots: AIPlayer[] = [];

/** Sockets by player id, so a disconnect frees its slot. */
const clients = new Map<number, WebSocket>();
let nextPlayerId = 0;

const FACTIONS: FactionId[] = ["usa", "china", "gla"];

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** Kept for lobby-wide messages; snapshots are per-player, see the tick loop. */
function broadcast(msg: ServerMsg): void {
  const raw = JSON.stringify(msg);
  for (const ws of clients.values()) {
    if (ws.readyState === ws.OPEN) ws.send(raw);
  }
}

const httpServer = createServer(async (req, res) => {
  // Static file serving, normalised so a crafted path cannot escape dist/.
  const rawPath = (req.url ?? "/").split("?")[0] ?? "/";

  // Answer favicon explicitly: browsers always ask, and a 404 puts a red error
  // in every player's console for no reason.
  if (rawPath === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }

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

/** Give a player their opening base: a command centre, a dozer, an escort. */
function spawnStartingBase(playerId: number, start: { x: number; y: number }): void {
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

/**
 * Fill the remaining slots with bots.
 *
 * Done up front rather than on demand so a single human always has an
 * opponent: without this, solo play is a base builder with nobody to fight.
 */
const BOTS = Math.max(0, Math.min(preset.players - 1, Number(process.env.BOTS ?? preset.players - 1)));
const BOT_DIFFICULTY = (process.env.DIFFICULTY ?? "normal") as Difficulty;

for (let i = 0; i < BOTS; i++) {
  const id = preset.players - 1 - i;
  const start = starts[id]!;
  sim.addPlayer({ id, name: `Bot ${i + 1}`, faction: "china", team: id });
  spawnStartingBase(id, start);
  bots.push(new AIPlayer(sim, id, BOT_DIFFICULTY));
}
const botIds = new Set(bots.map((b) => b.playerId));

wss.on("connection", (ws) => {
  // Refuse rather than overlap: a player without a start position spawns on
  // top of someone else's base and silently gets no command centre.
  if (clients.size + botIds.size >= starts.length) {
    ws.close(1013, "match full");
    return;
  }

  // Reuse the lowest free human slot; bot slots are taken.
  let playerId = 0;
  while (clients.has(playerId) || botIds.has(playerId)) playerId++;
  if (playerId >= starts.length) {
    ws.close(1013, "match full");
    return;
  }
  nextPlayerId = Math.max(nextPlayerId, playerId + 1);
  const start = starts[playerId % starts.length]!;
  const faction = FACTIONS[playerId % FACTIONS.length]!;

  sim.addPlayer({
    id: playerId,
    name: `Player ${playerId + 1}`,
    faction,
    team: playerId % 2,
  });

  // Start as Generals does: a command centre already standing, a dozer to
  // expand with, and a token escort. Everything else is earned.
  spawnStartingBase(playerId, start);

  clients.set(playerId, ws);
  console.log(`player ${playerId} joined (${faction}); ${clients.size} connected`);

  send(ws, {
    t: "welcome",
    playerId,
    tickRate: TICK_RATE,
    map: { width: map.width, height: map.height, tiles: [...map.tiles] },
    players: sim.players,
  });

  ws.on("message", (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data)) as ClientMsg;
    } catch {
      return; // Ignore malformed frames rather than killing the match.
    }
    if (msg.t === "move" && Array.isArray(msg.unitIds)) {
      sim.issueMove(playerId, msg.unitIds, msg.x, msg.y);
    } else if (msg.t === "build" && typeof msg.buildingType === "string") {
      sim.placeBuilding(playerId, msg.buildingType, msg.x, msg.y);
    } else if (msg.t === "train" && typeof msg.buildingId === "number") {
      sim.queueUnit(playerId, msg.buildingId, msg.unitType);
    } else if (msg.t === "order" && Array.isArray(msg.unitIds)) {
      sim.issueOrder(playerId, msg.unitIds, msg.order);
    } else if (msg.t === "rally" && typeof msg.buildingId === "number") {
      sim.setRally(playerId, msg.buildingId, msg.x, msg.y);
    }
  });

  ws.on("close", () => {
    clients.delete(playerId);
    console.log(`player ${playerId} left; ${clients.size} connected`);
  });
});

/**
 * Last-known enemy buildings per player.
 *
 * Buildings do not walk away, so a player keeps seeing one where they last saw
 * it even after losing sight -- which is how every RTS handles a scouted base.
 * Units get no such memory: an army you cannot see is genuinely gone.
 */
const remembered = new Map<number, Map<number, Building>>();

/** Filter a snapshot down to what this player is allowed to know. */
function viewFor(playerId: number, units: Unit[], buildings: Building[]) {
  const eyes = sim.visionSources(playerId);
  const sees = (x: number, y: number) =>
    eyes.some((e) => Math.hypot(e.x - x, e.y - y) <= e.vision);

  let memory = remembered.get(playerId);
  if (!memory) {
    memory = new Map();
    remembered.set(playerId, memory);
  }

  const visibleUnits = units.filter((u) => u.owner === playerId || sees(u.x, u.y));

  const visibleBuildings: Building[] = [];
  const stillStanding = new Set<number>();
  for (const b of buildings) {
    stillStanding.add(b.id);
    const d = buildingDef(b.type);
    if (b.owner === playerId || sees(b.x + d.size / 2, b.y + d.size / 2)) {
      visibleBuildings.push(b);
      memory.set(b.id, { ...b });
    }
  }

  // Add remembered buildings we can no longer see. Ones we can see being
  // destroyed are forgotten; ones destroyed out of sight stay on the map as a
  // stale memory, which is correct -- the player has not learned otherwise.
  for (const [id, b] of memory) {
    if (stillStanding.has(id) && visibleBuildings.some((v) => v.id === id)) continue;
    const d = buildingDef(b.type);
    if (sees(b.x + d.size / 2, b.y + d.size / 2)) {
      memory.delete(id); // watched it go
      continue;
    }
    if (!visibleBuildings.some((v) => v.id === id)) visibleBuildings.push(b);
  }

  return { units: visibleUnits, buildings: visibleBuildings };
}

setInterval(() => {
  for (const bot of bots) bot.update();
  sim.step();

  // Snapshots are per-player: units and buildings are public, but a player
  // only ever sees their own credits and power.
  const units = sim.snapshotUnits();
  const buildings = sim.snapshotBuildings();
  const supply = sim.snapshotSupply();
  const tracers = [...sim.tracers];
  for (const [id, ws] of clients) {
    // Filtered server-side rather than hidden by the renderer: a modified
    // client must not be able to see through the fog.
    const view = viewFor(id, units, buildings);
    send(ws, {
      t: "snap", tick: sim.tick,
      units: view.units, buildings: view.buildings,
      supply, tracers,
      economy: sim.economy(id),
      eliminated: [...sim.eliminated],
      vision: sim.visionSources(id),
    });
  }
}, 1000 / TICK_RATE);

httpServer.listen(PORT, () => {
  console.log(
    `server listening on http://localhost:${PORT} (tick ${TICK_RATE}Hz, ` +
      `map "${preset.name}" ${map.width}x${map.height} for ${preset.players} players, ` +
      `${BOTS} bot${BOTS === 1 ? "" : "s"} on ${BOT_DIFFICULTY})`,
  );
});

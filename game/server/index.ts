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

import { generateMap, startPositions } from "./mapgen.js";
import { Sim, TICK_RATE } from "./sim.js";
import type { ClientMsg, ServerMsg } from "../shared/protocol.js";
import type { FactionId } from "../shared/types.js";

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

const map = generateMap();
const sim = new Sim(map);
const starts = startPositions(map);

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

wss.on("connection", (ws) => {
  const playerId = nextPlayerId++;
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
  const cc = sim.placeBuilding(playerId, "command_center", Math.floor(start.x) - 1, Math.floor(start.y) - 1);
  if (cc) cc.buildRemaining = 0; // the starting base is not under construction
  sim.spawnUnit(playerId, "dozer", start.x + 2.5, start.y + 2.5);
  for (let i = 0; i < 2; i++) {
    sim.spawnUnit(playerId, "infantry", start.x + 3 + i * 0.9, start.y + 4);
  }

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
    }
  });

  ws.on("close", () => {
    clients.delete(playerId);
    console.log(`player ${playerId} left; ${clients.size} connected`);
  });
});

setInterval(() => {
  sim.step();

  // Snapshots are per-player: units and buildings are public, but a player
  // only ever sees their own credits and power.
  const units = sim.snapshotUnits();
  const buildings = sim.snapshotBuildings();
  for (const [id, ws] of clients) {
    send(ws, { t: "snap", tick: sim.tick, units, buildings, economy: sim.economy(id) });
  }
}, 1000 / TICK_RATE);

httpServer.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT} (tick ${TICK_RATE}Hz)`);
});

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

  // A small starting force so there is something to command immediately.
  for (let i = 0; i < 3; i++) {
    sim.spawnUnit(playerId, "infantry", start.x + i * 0.9, start.y);
  }
  sim.spawnUnit(playerId, "tank", start.x, start.y + 1.6);

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
    }
  });

  ws.on("close", () => {
    clients.delete(playerId);
    console.log(`player ${playerId} left; ${clients.size} connected`);
  });
});

setInterval(() => {
  sim.step();
  broadcast({ t: "snap", tick: sim.tick, units: sim.snapshotUnits() });
}, 1000 / TICK_RATE);

httpServer.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT} (tick ${TICK_RATE}Hz)`);
});

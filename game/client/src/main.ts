/**
 * Client entry point: connect, render, take input.
 *
 * The client never simulates. It renders the last two server snapshots with
 * interpolation between them, which is what makes a 15Hz sim look smooth.
 */
import { BUILDINGS, buildingDef, unitDef, UNITS } from "../../shared/content.js";
import type { ServerMsg } from "../../shared/protocol.js";
import type { Building, Economy, SupplyNode, Tracer, Unit } from "../../shared/types.js";
import { Net } from "./net.js";
import { Renderer } from "./render.js";
import { AudioEngine } from "./audio.js";
import type { DamageType } from "../../shared/types.js";

const CAMERA_SPEED = 18; // world units per second
const EDGE_SCROLL_PX = 24;
/** How far past the map edge the camera may scroll, in world units. */
const EDGE_MARGIN = 2;

const hud = document.getElementById("hud")!;
const panelItems = document.getElementById("panel-items")!;
const minimap = document.getElementById("minimap") as HTMLCanvasElement;
const lobby = document.getElementById("lobby")!;
const lobbyPlayers = document.getElementById("lobby-players") as HTMLSelectElement;
const lobbyBots = document.getElementById("lobby-bots") as HTMLSelectElement;
const lobbyDifficulty = document.getElementById("lobby-difficulty") as HTMLSelectElement;
const lobbySeed = document.getElementById("lobby-seed") as HTMLInputElement;
const minimapCtx = minimap.getContext("2d")!;
const endscreen = document.getElementById("endscreen")!;
const endTitle = document.getElementById("end-title")!;
const endDetail = document.getElementById("end-detail")!;
const panelTitle = document.getElementById("panel-title")!;
const hintEl = document.getElementById("hint")!;
const HINT_TEXT = hintEl.textContent ?? "";
let hintTimer = 0;
/** Briefly replace the hint bar with feedback, then restore it. */
function flashHint(text: string): void {
  hintEl.textContent = text;
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => (hintEl.textContent = HINT_TEXT), 1200);
}
const renderer = new Renderer();
await renderer.init();
// Optional: the game plays with primitive shapes if the sheet is absent.
await renderer.loadAtlas();

const net = new Net();
const audio = new AudioEngine();
// Browsers block audio until a user gesture; the first input unlocks it.
addEventListener("pointerdown", () => audio.unlock(), { capture: true });
addEventListener("keydown", () => audio.unlock(), { capture: true });

/** Weapon damage type -> firing sound. Flak is a lighter, faster rifle. */
const WEAPON_SFX: Record<DamageType, { name: "rifle" | "cannon" | "rocket"; rate: number }> = {
  gun: { name: "rifle", rate: 1 },
  flak: { name: "rifle", rate: 1.35 },
  cannon: { name: "cannon", rate: 1 },
  rocket: { name: "rocket", rate: 1 },
  explosive: { name: "cannon", rate: 0.8 },
};

/** Centre of the viewport in world units, for positional volume. */
function viewCentre(): { x: number; y: number } {
  return renderer.screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
}

let playerId = -1;
let status = "connecting";
let mapW = 0;
let mapH = 0;

/** The two most recent snapshots; we render between them. */
let prevUnits = new Map<number, Unit>();
let currUnits = new Map<number, Unit>();
let prevAt = 0;
let currAt = 0;

let buildings: Building[] = [];
let supply: SupplyNode[] = [];
/** Peak seen per node, so the shrinking pile has something to scale against. */
const supplyMax = new Map<number, number>();
let economy: Economy = { credits: 0, powerProduced: 0, powerConsumed: 0 };

/** Building type queued for placement, or null when not placing. */
let placing: string | null = null;
/** True while the next click issues an attack-move rather than a move. */
let attackMoveArmed = false;
let eliminated: number[] = [];
/** Every player in the match, from the welcome message; drives the end screen. */
let matchPlayers: Array<{ id: number; team: number }> = [];
/** Match outcome already announced, so the overlay shows once per match. */
let endState: "victory" | "defeat" | null = null;

/**
 * Fog state.
 *
 * `explored` is cumulative and never cleared -- once you have seen ground you
 * remember its shape. `visible` is recomputed from the vision circles the
 * server sends each snapshot.
 */
let explored = new Uint8Array(0);
let visible = new Uint8Array(0);
let fogDirty = true;

/**
 * Tracers with the wall-clock time they arrived.
 *
 * The sim reports a shot for one 15Hz tick, which is too brief to see. Holding
 * them client-side for a moment and fading them out turns a blink into a
 * readable muzzle flash without putting render concerns in the simulation.
 */
const liveTracers: Array<Tracer & { at: number }> = [];
const TRACER_MS = 160;
/** Our building whose production menu is open, or null. */
let selectedBuilding: number | null = null;

const selected = new Set<number>();
const keys = new Set<string>();
/** Ctrl+1..9 stores a selection, 1..9 recalls it. */
const controlGroups = new Map<string, number[]>();
/** Last group recall, so a double-tap can centre the camera on the group. */
let lastGroupRecall: { slot: string; at: number } = { slot: "", at: 0 };
/** Terrain drawn once into an offscreen canvas; only fog and units redraw. */
let minimapTerrain: HTMLCanvasElement | null = null;
let pointer = { x: 0, y: 0, inside: false };
let centred = false;
let dragStart: { x: number; y: number } | null = null;
let dragNow: { x: number; y: number } | null = null;

net.onStatus = (s) => { status = s; };
net.onMessage = (msg: ServerMsg) => {
  if (msg.t === "welcome") {
    playerId = msg.playerId;
    mapW = msg.map.width;
    mapH = msg.map.height;

    // A welcome can arrive mid-session when someone restarts the match, so
    // everything carried over from the previous game has to be dropped.
    selected.clear();
    controlGroups.clear();
    selectedBuilding = null;
    placing = null;
    buildings = [];
    supply = [];
    matchPlayers = msg.players.map((p) => ({ id: p.id, team: p.team }));
    endState = null;
    endscreen.hidden = true;
    currUnits = new Map();
    prevUnits = new Map();
    centred = false;
    syncLobby(msg.config);
    renderer.buildTerrain(mapW, mapH, msg.map.tiles);
    explored = new Uint8Array(mapW * mapH);
    visible = new Uint8Array(mapW * mapH);
    buildMinimapTerrain(msg.map.tiles);
    // Camera is centred once our units actually arrive -- see below. Welcome
    // lands before the first snapshot, so there is nothing to centre on yet.
  } else if (msg.t === "snap") {
    const now = performance.now();
    updateFog(msg.vision);

    // Deaths are derived, not sent: something on a tile we can see that stops
    // existing blew up. Fog hides enemy movement, so a unit that walks out of
    // sight vanishes identically to one that died -- only exploding the ones
    // we can actually see keeps "left view" and "destroyed" distinct.
    const tileVisible = (x: number, y: number): boolean => {
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      return tx >= 0 && ty >= 0 && tx < mapW && ty < mapH && visible[ty * mapW + tx] === 1;
    };
    for (const [id, u] of prevUnits) {
      if (currUnits.has(id)) continue;
      if (u.owner === playerId || tileVisible(u.x, u.y)) {
        renderer.spawnEffect("explosion", u.x, u.y, Math.max(0.6, unitDef(u.type).radius));
        const vc = viewCentre();
        audio.playAt("explosion", u.x, u.y, vc.x, vc.y);
      }
    }
    for (const b of buildings) {
      const nb = msg.buildings.find((c) => c.id === b.id);
      if (!nb) {
        const size = buildingDef(b.type).size;
        const cx = b.x + size / 2;
        const cy = b.y + size / 2;
        if (b.owner === playerId || tileVisible(cx, cy)) {
          renderer.spawnEffect("bigExplosion", cx, cy, size / 2);
          const vc = viewCentre();
          audio.playAt("bigexplosion", cx, cy, vc.x, vc.y);
        }
      } else if (b.buildRemaining > 0 && nb.buildRemaining === 0 && nb.owner === playerId) {
        // "Construction complete" is a notification, not a positional sound --
        // you want to hear it wherever the camera is.
        audio.play("build", 0.8);
      }
    }

    prevUnits = currUnits;
    prevAt = currAt;
    currUnits = new Map(msg.units.map((u) => [u.id, u]));
    currAt = now;
    buildings = msg.buildings;
    supply = msg.supply;
    eliminated = msg.eliminated;
    updateEndscreen();

    // Expose this client's view for tests and debugging. Safe to publish: the
    // server has already filtered it to what this player may know, so there is
    // nothing here a modified client could not read anyway.
    (window as unknown as { __rts?: unknown }).__rts = {
      playerId,
      units: msg.units,
      buildings: msg.buildings,
      economy: msg.economy,
      tick: msg.tick,
    };
    for (const t of msg.tracers) {
      liveTracers.push({ ...t, at: now });
      const sfx = WEAPON_SFX[t.weapon];
      if (sfx) {
        const vc = viewCentre();
        audio.playAt(sfx.name, t.x0, t.y0, vc.x, vc.y, 0.7, sfx.rate);
      }
    }
    for (const n of supply) {
      supplyMax.set(n.id, Math.max(supplyMax.get(n.id) ?? 0, n.amount));
    }
    // The only income source is a harvester unload, so a credits increase is
    // exactly one delivery.
    if (msg.economy.credits > economy.credits && economy.credits > 0) {
      audio.play("harvest", 0.35, 1.1);
    }
    economy = msg.economy;
    if (!centred) centreOnOwnUnits();
    drawMinimap();
    if (selectedBuilding !== null && !buildings.some((b) => b.id === selectedBuilding)) {
      selectedBuilding = null;
    }
    renderPanel();
    // Drop selections for units that no longer exist.
    for (const id of [...selected]) if (!currUnits.has(id)) selected.delete(id);
  }
};
net.connect();

/**
 * Put the camera on our own force the first time we see it.
 *
 * Cannot be done on welcome: that message arrives before the first snapshot,
 * so there are no units to centre on yet and the camera would sit on the map
 * centre while the player's base is in a corner, off screen.
 */
/**
 * Rasterise the vision circles the server sent into the fog grids.
 *
 * Done from circles rather than a transmitted bitmap: a 112x112 grid every
 * tick is far more bandwidth than a handful of positions, and the client has
 * to walk the tiles to draw them anyway.
 */
function updateFog(sources: Array<{ x: number; y: number; vision: number }>): void {
  if (explored.length === 0) return;
  visible.fill(0);

  for (const s of sources) {
    const r = Math.ceil(s.vision);
    const minX = Math.max(0, Math.floor(s.x - r));
    const maxX = Math.min(mapW - 1, Math.ceil(s.x + r));
    const minY = Math.max(0, Math.floor(s.y - r));
    const maxY = Math.min(mapH - 1, Math.ceil(s.y + r));
    const r2 = s.vision * s.vision;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x + 0.5 - s.x;
        const dy = y + 0.5 - s.y;
        if (dx * dx + dy * dy > r2) continue;
        const i = y * mapW + x;
        visible[i] = 1;
        explored[i] = 1;
      }
    }
  }
  fogDirty = true;
}

/** Paint the static terrain layer of the minimap once. */
function buildMinimapTerrain(tiles: number[]): void {
  const c = document.createElement("canvas");
  c.width = mapW;
  c.height = mapH;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(mapW, mapH);
  const palette: Record<number, [number, number, number]> = {
    0: [63, 81, 51], 1: [89, 80, 47], 2: [36, 80, 107], 3: [74, 70, 66], 4: [43, 61, 34],
  };
  for (let i = 0; i < mapW * mapH; i++) {
    const [r, g, b] = palette[tiles[i] ?? 0] ?? [0, 0, 0];
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = g;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  minimapTerrain = c;
}

/**
 * Redraw the minimap.
 *
 * Called on snapshots rather than every frame: it is a whole-map redraw and
 * nothing on it changes faster than the simulation does.
 */
function drawMinimap(): void {
  if (!minimapTerrain || mapW === 0) return;
  const W = minimap.width;
  const H = minimap.height;
  minimapCtx.clearRect(0, 0, W, H);

  minimapCtx.imageSmoothingEnabled = false;
  minimapCtx.drawImage(minimapTerrain, 0, 0, W, H);

  // Fog, at tile resolution.
  const sx = W / mapW;
  const sy = H / mapH;
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const i = y * mapW + x;
      if (visible[i]) continue;
      minimapCtx.fillStyle = explored[i] ? "rgba(5,7,10,0.45)" : "rgb(5,7,10)";
      minimapCtx.fillRect(x * sx, y * sy, Math.ceil(sx), Math.ceil(sy));
    }
  }

  for (const b of buildings) {
    const size = buildingDef(b.type).size;
    minimapCtx.fillStyle = b.owner === playerId ? "#7ad07a" : "#d2564b";
    minimapCtx.fillRect(b.x * sx, b.y * sy, Math.max(2, size * sx), Math.max(2, size * sy));
  }
  for (const u of currUnits.values()) {
    minimapCtx.fillStyle = u.owner === playerId ? "#bff0bf" : "#ff8a7a";
    minimapCtx.fillRect(u.x * sx - 1, u.y * sy - 1, 2.5, 2.5);
  }

  // Viewport rectangle, so the minimap says where you are looking.
  const viewW = (window.innerWidth / renderer.tilePx) * sx;
  const viewH = (window.innerHeight / renderer.tilePx) * sy;
  minimapCtx.strokeStyle = "rgba(255,255,255,0.75)";
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(renderer.camX * sx, renderer.camY * sy, viewW, viewH);
}

minimap.addEventListener("pointerdown", (e) => {
  const r = minimap.getBoundingClientRect();
  const wx = ((e.clientX - r.left) / r.width) * mapW;
  const wy = ((e.clientY - r.top) / r.height) * mapH;
  // Centre the view on the clicked point rather than putting it top-left.
  renderer.camX = wx - window.innerWidth / renderer.tilePx / 2;
  renderer.camY = wy - window.innerHeight / renderer.tilePx / 2;
  clampCamera();
  e.preventDefault();
});

/**
 * Populate the lobby from the running match.
 *
 * Bots are capped at players-1: offering a bot count the server will silently
 * clamp is worse than not offering it, because the player cannot tell whether
 * their choice took effect.
 */
function syncLobby(cfg: { players: number; bots: number; difficulty: string; seed: number }): void {
  lobbyPlayers.replaceChildren();
  for (let n = 2; n <= 6; n++) {
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = `${n} players`;
    if (n === cfg.players) o.selected = true;
    lobbyPlayers.append(o);
  }
  refreshBotOptions(cfg.players, cfg.bots);
  lobbyDifficulty.value = cfg.difficulty;
  lobbySeed.value = String(cfg.seed);
}

function refreshBotOptions(players: number, selectedBots: number): void {
  lobbyBots.replaceChildren();
  for (let n = 0; n <= players - 1; n++) {
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = n === 0 ? "none" : `${n} bot${n === 1 ? "" : "s"}`;
    if (n === selectedBots) o.selected = true;
    lobbyBots.append(o);
  }
}

lobbyPlayers.addEventListener("change", () => {
  refreshBotOptions(Number(lobbyPlayers.value), Number(lobbyBots.value));
});

document.getElementById("lobby-open")!.addEventListener("click", () => { lobby.hidden = false; });
document.getElementById("end-again")!.addEventListener("click", () => {
  endscreen.hidden = true;
  lobby.hidden = false;
});
document.getElementById("end-watch")!.addEventListener("click", () => {
  endscreen.hidden = true;
});

/**
 * Announce the match result.
 *
 * The server only reports who is eliminated; whether that means victory or
 * defeat depends on teams, which only the welcome message knows. Defeat is
 * announced the moment we are out; victory when nobody on another team is
 * left. A match with nobody else in it (yet) is not won by default.
 */
function updateEndscreen(): void {
  if (endState !== null) return;
  const me = matchPlayers.find((p) => p.id === playerId);
  if (!me) return;
  if (eliminated.includes(playerId)) {
    endState = "defeat";
  } else {
    const foesLeft = matchPlayers.filter((p) => p.team !== me.team && !eliminated.includes(p.id));
    if (matchPlayers.length < 2 || foesLeft.length > 0) return;
    endState = "victory";
  }
  endTitle.textContent = endState === "victory" ? "VICTORY" : "DEFEAT";
  endTitle.style.color = endState === "victory" ? "#9fe870" : "#e05a4a";
  endDetail.textContent = endState === "victory"
    ? "Every opposing force has been destroyed."
    : "Your forces have been destroyed. The battle goes on without you.";
  endscreen.hidden = false;
}

document.getElementById("lobby-cancel")!.addEventListener("click", () => { lobby.hidden = true; });
document.getElementById("lobby-start")!.addEventListener("click", () => {
  net.send({
    t: "newMatch",
    players: Number(lobbyPlayers.value),
    bots: Number(lobbyBots.value),
    difficulty: lobbyDifficulty.value as "easy" | "normal" | "hard",
    seed: Math.max(1, Number(lobbySeed.value) || 1),
  });
  lobby.hidden = true;
});

function centreOnOwnUnits(): void {
  const mine = [...currUnits.values()].filter((u) => u.owner === playerId);
  if (mine.length === 0) return;
  const cx = mine.reduce((a, u) => a + u.x, 0) / mine.length;
  const cy = mine.reduce((a, u) => a + u.y, 0) / mine.length;
  renderer.camX = cx - window.innerWidth / renderer.tilePx / 2;
  renderer.camY = cy - window.innerHeight / renderer.tilePx / 2;
  clampCamera();
  centred = true;
}

// -- input ------------------------------------------------------------------

addEventListener("keydown", (e) => {
  keys.add(e.code);

  // Control groups. Ctrl+N assigns the current selection, N recalls it --
  // the muscle memory every RTS player already has.
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) {
    const slot = digit[1]!;
    if (e.ctrlKey || e.metaKey) {
      if (selected.size > 0) controlGroups.set(slot, [...selected]);
      e.preventDefault();
    } else {
      const group = controlGroups.get(slot);
      if (group) {
        selected.clear();
        // Skip anything that has since died, rather than selecting ghosts.
        for (const id of group) if (currUnits.has(id)) selected.add(id);
        selectedBuilding = null;
        renderPanel();

        // Double-tap jumps the camera to the group -- the other half of the
        // control-group idiom, and the fast way back to a fight.
        const nowMs = performance.now();
        if (lastGroupRecall.slot === slot && nowMs - lastGroupRecall.at < 450 && selected.size > 0) {
          let cx = 0;
          let cy = 0;
          for (const id of selected) {
            const u = currUnits.get(id)!;
            cx += u.x;
            cy += u.y;
          }
          renderer.camX = cx / selected.size - window.innerWidth / renderer.tilePx / 2;
          renderer.camY = cy / selected.size - window.innerHeight / renderer.tilePx / 2;
          clampCamera();
        }
        lastGroupRecall = { slot, at: nowMs };
      }
    }
    return;
  }
  // Hold-to-arm rather than a toggle: A then click is the RTS idiom, and a
  // sticky attack-move mode gets people killed by accident.
  // Ctrl+A takes the whole army. Plain A stays attack-move: an RTS player
  // reaches for A far more often to attack-move than to select everything.
  if (e.code === "KeyA" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    selected.clear();
    for (const u of currUnits.values()) if (u.owner === playerId) selected.add(u.id);
    selectedBuilding = null;
    renderPanel();
    return;
  }
  if (e.code === "KeyE" && !e.repeat) {
    // Combat units only -- the army without the dozers and harvesters, which
    // is what "select everything" almost always means in practice.
    selected.clear();
    for (const u of currUnits.values()) {
      if (u.owner === playerId && unitDef(u.type).weapon) selected.add(u.id);
    }
    selectedBuilding = null;
    renderPanel();
    return;
  }
  if (e.code === "KeyS" && !e.repeat && selected.size > 0) {
    // Stop: halt, hold fire only in the sense of not chasing. Clears queues.
    net.send({ t: "order", unitIds: [...selected], order: { kind: "stop" } });
    return;
  }
  if (e.code === "KeyM" && !e.repeat) {
    const muted = audio.toggleMute();
    flashHint(muted ? "sound off" : "sound on");
    return;
  }
  if (e.code === "KeyA" && !e.repeat && selected.size > 0) attackMoveArmed = true;
  if (e.code === "Escape" && !lobby.hidden) {
    lobby.hidden = true;
    return;
  }
  if (e.code === "Escape") {
    attackMoveArmed = false;
    // Escape backs out of the most specific mode first, rather than clearing
    // everything at once -- otherwise cancelling a placement also drops the
    // army you had selected.
    if (placing) placing = null;
    else if (selectedBuilding !== null) selectedBuilding = null;
    else selected.clear();
    renderPanel();
  }
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => keys.clear());

const canvas = renderer.app.canvas;
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointermove", (e) => {
  pointer = { x: e.clientX, y: e.clientY, inside: true };
  if (dragStart) dragNow = { x: e.clientX, y: e.clientY };

  // Context cursor: with an armed selection, hovering an enemy means attack.
  // Reading hit targets per mousemove is a handful of distance checks against
  // the visible unit list, far cheaper than a misread order.
  let cursor = "default";
  if (placing) {
    cursor = "copy";
  } else if (selected.size > 0) {
    const u = unitAtScreen(e.clientX, e.clientY);
    const b = u ? null : buildingAtScreen(e.clientX, e.clientY);
    if ((u && u.owner !== playerId) || (b && b.owner !== playerId)) cursor = "crosshair";
  }
  canvas.style.cursor = cursor;
});
canvas.addEventListener("pointerleave", () => { pointer.inside = false; });

canvas.addEventListener("pointerdown", (e) => {
  if (e.button === 0) {
    if (placing) {
      const w = renderer.screenToWorld(e.clientX, e.clientY);
      const size = buildingDef(placing).size;
      net.send({
        t: "build",
        buildingType: placing,
        x: Math.floor(w.x - size / 2),
        y: Math.floor(w.y - size / 2),
      });
      // Shift keeps the tool active for laying down several in a row.
      if (!e.shiftKey) placing = null;
      renderPanel();
      return;
    }
    dragStart = { x: e.clientX, y: e.clientY };
    dragNow = { x: e.clientX, y: e.clientY };
  } else if (e.button === 2) {
    if (placing) {
      placing = null;
      renderPanel();
      return;
    }

    // Right-click with a building selected sets its rally point.
    if (selectedBuilding !== null) {
      const w = renderer.screenToWorld(e.clientX, e.clientY);
      net.send({ t: "rally", buildingId: selectedBuilding, x: w.x, y: w.y });
      return;
    }

    // Right-click an enemy attacks it; right-click ground moves or attack-moves.
    // Shift queues the order behind what the units are already doing.
    const enemyUnit = unitAtScreen(e.clientX, e.clientY);
    const enemyBuilding = buildingAtScreen(e.clientX, e.clientY);
    const wClick = renderer.screenToWorld(e.clientX, e.clientY);
    if (enemyUnit && enemyUnit.owner !== playerId && selected.size > 0) {
      net.send({
        t: "order", unitIds: [...selected],
        order: { kind: "attack", targetId: enemyUnit.id, targetKind: "unit" },
        append: e.shiftKey,
      });
      renderer.spawnEffect("attack", wClick.x, wClick.y);
    } else if (enemyBuilding && enemyBuilding.owner !== playerId && selected.size > 0) {
      net.send({
        t: "order", unitIds: [...selected],
        order: { kind: "attack", targetId: enemyBuilding.id, targetKind: "building" },
        append: e.shiftKey,
      });
      renderer.spawnEffect("attack", wClick.x, wClick.y);
    } else {
      issueMoveAt(e.clientX, e.clientY, e.shiftKey);
    }
    attackMoveArmed = false;
  }
});

canvas.addEventListener("dblclick", (e) => {
  const hit = unitAtScreen(e.clientX, e.clientY);
  if (!hit || hit.owner !== playerId) return;
  selectSameType(hit.type, e.ctrlKey || e.metaKey);
  renderPanel();
});

canvas.addEventListener("pointerup", (e) => {
  if (e.button !== 0 || !dragStart) return;
  const moved = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);

  if (moved < 4) {
    // A click, not a drag: select the unit under the cursor, or move if we
    // already have a selection and clicked empty ground.
    const hit = unitAtScreen(e.clientX, e.clientY);
    const hitBuilding = buildingAtScreen(e.clientX, e.clientY);
    if (hit) {
      if (hit.owner !== playerId) {
        // Clicking an enemy with nothing selected is a look, not an order.
        if (!e.shiftKey) selected.clear();
      } else if (!e.shiftKey) {
        selected.clear();
        selected.add(hit.id);
      } else if (selected.has(hit.id)) {
        // Shift on something already picked removes it. Additive-only shift
        // means a misclick can only be undone by starting the selection again.
        selected.delete(hit.id);
      } else {
        selected.add(hit.id);
      }
      selectedBuilding = null;
      renderPanel();
    } else if (hitBuilding && hitBuilding.owner === playerId) {
      selectedBuilding = hitBuilding.id;
      selected.clear();
      renderPanel();
    } else if (selected.size > 0) {
      issueMoveAt(e.clientX, e.clientY, e.shiftKey);
    } else {
      selected.clear();
    }
  } else {
    if (!e.shiftKey) selected.clear();
    boxSelect(dragStart, { x: e.clientX, y: e.clientY });
  }

  dragStart = null;
  dragNow = null;
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const before = renderer.screenToWorld(e.clientX, e.clientY);
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  renderer.zoom = Math.min(2.5, Math.max(0.4, renderer.zoom * factor));
  // Keep the world point under the cursor pinned while zooming.
  const after = renderer.screenToWorld(e.clientX, e.clientY);
  renderer.camX += before.x - after.x;
  renderer.camY += before.y - after.y;
  // Zoom changes the view size, so the previous clamp no longer holds. Without
  // this, zooming out walks the camera off the map and leaves it there.
  clampCamera();
}, { passive: false });

function unitAtScreen(sx: number, sy: number): Unit | null {
  const w = renderer.screenToWorld(sx, sy);
  let best: Unit | null = null;
  let bestDist = Infinity;
  for (const u of currUnits.values()) {
    const r = unitDef(u.type).radius;
    const d = Math.hypot(u.x - w.x, u.y - w.y);
    if (d <= r * 1.6 && d < bestDist) {
      best = u;
      bestDist = d;
    }
  }
  return best;
}

function buildingAtScreen(sx: number, sy: number): Building | null {
  const w = renderer.screenToWorld(sx, sy);
  for (const b of buildings) {
    const size = buildingDef(b.type).size;
    if (w.x >= b.x && w.x < b.x + size && w.y >= b.y && w.y < b.y + size) return b;
  }
  return null;
}

/** Last rendered panel signature, so we only rebuild when something changed. */
let panelSig = "";

/**
 * Rebuild the right-hand panel.
 *
 * Shows the production menu of a selected building, otherwise the build list.
 * Unavailable entries stay visible but disabled with the reason -- hiding them
 * makes the tech tree impossible to learn.
 *
 * Snapshots arrive 15 times a second, but the panel almost never changes
 * between them. Rebuilding it every tick detaches every button mid-click,
 * which loses real clicks and flickers hover state, so the DOM is only
 * replaced when the rendered content would actually differ. Production
 * progress is quantised into the signature rather than excluded, so a running
 * queue updates without churning the panel every frame.
 */
function renderPanel(): void {
  const sig = panelSignature();
  if (sig === panelSig) return;
  panelSig = sig;

  panelItems.replaceChildren();

  const completed = new Set(
    buildings.filter((b) => b.owner === playerId && b.buildRemaining === 0).map((b) => b.type),
  );

  const sel = selectedBuilding === null ? null : buildings.find((b) => b.id === selectedBuilding);

  if (sel) {
    const def = buildingDef(sel.type);
    panelTitle.textContent = def.name.toUpperCase();

    if (def.produces.length === 0) {
      const p = document.createElement("div");
      p.className = "item";
      p.style.cursor = "default";
      p.textContent = def.description;
      panelItems.append(p);
    }

    for (const unitId of def.produces) {
      const u = UNITS[unitId]!;
      const afford = economy.credits >= u.cost;
      panelItems.append(
        makeItem(u.name, u.cost, afford ? u.role : "not enough credits", !afford, false, () => {
          net.send({ t: "train", buildingId: sel.id, unitType: unitId });
        }),
      );
    }

    if (sel.queue.length > 0) {
      const q = document.createElement("div");
      q.className = "item";
      q.style.cursor = "default";
      const head = sel.queue[0]!;
      const pct = Math.round((1 - head.remaining / head.total) * 100);
      q.textContent = `${UNITS[head.unitType]?.name ?? head.unitType} ${pct}%` +
        (sel.queue.length > 1 ? `  (+${sel.queue.length - 1})` : "");
      panelItems.append(q);
    }

    panelItems.append(makeBack());
    return;
  }

  panelTitle.textContent = "BUILD";
  for (const id of Object.keys(BUILDINGS)) {
    const def = BUILDINGS[id]!;
    const missing = def.requires.filter((r) => !completed.has(r));
    const afford = economy.credits >= def.cost;
    const disabled = missing.length > 0 || !afford;

    const why = missing.length > 0
      ? `needs ${missing.map((m) => BUILDINGS[m]?.name ?? m).join(", ")}`
      : !afford
        ? "not enough credits"
        : `${def.power >= 0 ? "+" : ""}${def.power} power · ${def.description}`;

    panelItems.append(
      makeItem(def.name, def.cost, why, disabled, placing === id, () => {
        placing = placing === id ? null : id;
        renderPanel();
      }),
    );
  }
}

/** Everything that affects what the panel looks like, as a comparable string. */
function panelSignature(): string {
  const completed = buildings
    .filter((b) => b.owner === playerId && b.buildRemaining === 0)
    .map((b) => b.type)
    .sort()
    .join(",");

  const sel = selectedBuilding === null ? null : buildings.find((b) => b.id === selectedBuilding);

  // Affordability is what flips buttons between enabled and disabled, so it is
  // the credit-derived part that matters -- not the exact balance, which would
  // otherwise force a rebuild on every harvester delivery.
  const affordable = [
    ...Object.keys(BUILDINGS).map((id) => (economy.credits >= BUILDINGS[id]!.cost ? "1" : "0")),
    ...Object.keys(UNITS).map((id) => (economy.credits >= UNITS[id]!.cost ? "1" : "0")),
  ].join("");

  const head = sel?.queue[0];
  const queue = head
    ? `${head.unitType}:${Math.round((1 - head.remaining / head.total) * 20)}:${sel!.queue.length}`
    : "";

  return [placing ?? "", selectedBuilding ?? "", completed, affordable, queue].join("|");
}

function makeItem(
  name: string,
  cost: number,
  why: string,
  disabled: boolean,
  active: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = "item" + (active ? " active" : "");
  el.disabled = disabled;
  const cs = document.createElement("span");
  cs.className = "cost";
  cs.textContent = `$${cost}`;
  el.append(name, cs);
  const w = document.createElement("span");
  w.className = "why";
  w.textContent = why;
  el.append(w);
  el.addEventListener("click", () => {
    audio.play("click", 0.6);
    onClick();
  });
  return el;
}

function makeBack(): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = "item";
  el.textContent = "\u2190 back";
  el.addEventListener("click", () => { selectedBuilding = null; renderPanel(); });
  return el;
}

function boxSelect(a: { x: number; y: number }, b: { x: number; y: number }): void {
  const p0 = renderer.screenToWorld(Math.min(a.x, b.x), Math.min(a.y, b.y));
  const p1 = renderer.screenToWorld(Math.max(a.x, b.x), Math.max(a.y, b.y));
  for (const u of currUnits.values()) {
    if (u.owner !== playerId) continue;
    // Overlap, not centre-inside: a box drawn around a visible unit should
    // take it, and at low zoom the difference is several pixels of slack.
    const r = unitDef(u.type).radius;
    if (u.x + r >= p0.x && u.x - r <= p1.x && u.y + r >= p0.y && u.y - r <= p1.y) {
      selected.add(u.id);
    }
  }
}

/**
 * Every unit of one type, the way a double-click does it everywhere else.
 *
 * On screen by default rather than map-wide: grabbing the tanks in front of you
 * is the common case, and quietly adding a tank from the far side of the map to
 * an attack is how armies wander off. Ctrl widens it to everything you own.
 */
function selectSameType(type: string, everywhere: boolean): void {
  const view = {
    x0: renderer.camX, y0: renderer.camY,
    x1: renderer.camX + innerWidth / renderer.tilePx,
    y1: renderer.camY + innerHeight / renderer.tilePx,
  };
  selected.clear();
  for (const u of currUnits.values()) {
    if (u.owner !== playerId || u.type !== type) continue;
    if (!everywhere && (u.x < view.x0 || u.x > view.x1 || u.y < view.y0 || u.y > view.y1)) continue;
    selected.add(u.id);
  }
  selectedBuilding = null;
}

function issueMoveAt(sx: number, sy: number, append = false): void {
  if (selected.size === 0) return;
  const w = renderer.screenToWorld(sx, sy);
  if (attackMoveArmed) {
    net.send({ t: "order", unitIds: [...selected], order: { kind: "attackMove", x: w.x, y: w.y }, append });
    attackMoveArmed = false;
    renderer.spawnEffect("attack", w.x, w.y);
  } else if (append) {
    // MoveCmd has no queue flag, so a shift-move goes as a full order.
    net.send({ t: "order", unitIds: [...selected], order: { kind: "move", x: w.x, y: w.y }, append: true });
    renderer.spawnEffect("ping", w.x, w.y);
  } else {
    net.send({ t: "move", unitIds: [...selected], x: w.x, y: w.y });
    renderer.spawnEffect("ping", w.x, w.y);
  }
}

// -- frame loop -------------------------------------------------------------

let lastFrame = performance.now();

renderer.app.ticker.add(() => {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  updateCamera(dt);
  renderer.applyCamera();

  // Interpolate between the last two snapshots. Clamped to 1 so a late packet
  // stops units rather than flinging them past their destination.
  const span = currAt - prevAt;
  const alpha = span > 0 ? Math.min((now - currAt) / span, 1) : 1;

  const drawList = [];
  for (const u of currUnits.values()) {
    const p = prevUnits.get(u.id);
    const def = unitDef(u.type);
    drawList.push({
      id: u.id,
      owner: u.owner,
      x: p ? p.x + (u.x - p.x) * alpha : u.x,
      y: p ? p.y + (u.y - p.y) * alpha : u.y,
      radius: def.radius,
      type: u.type,
      hpFrac: u.hp / def.maxHp,
    });
  }
  renderer.drawSupply(
    supply.map((n) => ({
      id: n.id, x: n.x, y: n.y, amount: n.amount, max: supplyMax.get(n.id) ?? n.amount,
    })),
  );

  renderer.drawBuildings(
    buildings.map((b) => ({
      id: b.id,
      type: b.type,
      owner: b.owner,
      x: b.x,
      y: b.y,
      size: buildingDef(b.type).size,
      progress: b.buildTotal === 0 ? 1 : 1 - b.buildRemaining / b.buildTotal,
      selected: b.id === selectedBuilding,
      hpFrac: b.hp / buildingDef(b.type).maxHp,
    })),
  );

  if (placing && pointer.inside) {
    const w = renderer.screenToWorld(pointer.x, pointer.y);
    const size = buildingDef(placing).size;
    const gx = Math.floor(w.x - size / 2);
    const gy = Math.floor(w.y - size / 2);
    renderer.drawPlacementGhost({ x: gx, y: gy, size, ok: economy.credits >= buildingDef(placing).cost });
  }

  // Reach of everything selected, from the same defs the server fires with, so
  // the ring is the real engagement distance and not a drawing of one.
  const rings: Array<{ x: number; y: number; r: number; strong: boolean }> = [];
  for (const u of drawList) {
    if (!selected.has(u.id)) continue;
    const range = unitDef(u.type).weapon?.range;
    if (range) rings.push({ x: u.x, y: u.y, r: range, strong: selected.size <= 3 });
  }
  if (selectedBuilding !== null) {
    const b = buildings.find((x) => x.id === selectedBuilding);
    const range = b ? buildingDef(b.type).weapon?.range : undefined;
    if (b && range) {
      const size = buildingDef(b.type).size;
      rings.push({ x: b.x + size / 2, y: b.y + size / 2, r: range, strong: true });
    }
  }
  renderer.drawRanges(rings);
  renderer.drawUnits(drawList, selected);
  // Per-frame view state for tests: selection and range rings are drawn, not
  // stored, so without this there is nothing to assert against but pixels.
  // Separate from __rts on purpose -- that object is replaced wholesale by
  // every snapshot, so fields written here would be raced away 15 times a
  // second and read back as undefined.
  (window as unknown as { __rtsView?: unknown }).__rtsView = {
    selected: selected.size,
    selectedIds: [...selected],
    rangeRings: rings.length,
    selectedBuilding,
    effects: renderer.effectCount,
    endState,
    audioLoaded: audio.loadedCount,
  };

  // Age out tracers, then draw what is left with a linear fade.
  while (liveTracers.length > 0 && now - liveTracers[0]!.at > TRACER_MS) liveTracers.shift();
  renderer.drawTracers(
    liveTracers.map((t) => ({ ...t, alpha: 1 - (now - t.at) / TRACER_MS })),
  );

  const rallyOf = selectedBuilding === null ? null : buildings.find((b) => b.id === selectedBuilding);
  if (rallyOf && rallyOf.rallyX !== undefined && rallyOf.rallyY !== undefined) {
    const size = buildingDef(rallyOf.type).size;
    renderer.drawRally(
      { x: rallyOf.x + size / 2, y: rallyOf.y + size / 2 },
      { x: rallyOf.rallyX, y: rallyOf.rallyY },
    );
  }

  if (fogDirty && explored.length > 0) {
    renderer.drawFog(mapW, mapH, explored, visible);
    fogDirty = false;
  }

  renderer.drawSelectionBox(
    dragStart && dragNow
      ? { x0: dragStart.x, y0: dragStart.y, x1: dragNow.x, y1: dragNow.y }
      : null,
  );

  // Selection breakdown, so a mixed army reads as more than a bare count.
  let selSummary = "";
  if (selected.size > 0) {
    const counts = new Map<string, number>();
    for (const id of selected) {
      const u = currUnits.get(id);
      if (!u) continue;
      const name = unitDef(u.type).name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    selSummary = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => (n > 1 ? `${name} x${n}` : name))
      .join(", ");
  }

  const lowPower = economy.powerConsumed > economy.powerProduced;
  hud.textContent =
    `${status}  ·  player ${playerId < 0 ? "?" : playerId + 1}  ·  ` +
    `$${economy.credits}  ·  power ${economy.powerProduced - economy.powerConsumed}` +
    `${lowPower ? " LOW" : ""}  ·  units ${currUnits.size}  ·  selected ${selected.size}` +
    `${attackMoveArmed ? "  ·  ATTACK-MOVE" : ""}` +
    `${endState === "defeat" ? "  ·  DEFEATED" : ""}` +
    (selSummary ? `\n${selSummary}` : "");
});

function updateCamera(dt: number): void {
  let dx = 0;
  let dy = 0;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) dx -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) dx += 1;
  if (keys.has("KeyW") || keys.has("ArrowUp")) dy -= 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) dy += 1;

  // Edge scrolling, but never while dragging a selection box -- otherwise the
  // map runs away the moment the box touches the screen edge.
  if (pointer.inside && !dragStart) {
    if (pointer.x < EDGE_SCROLL_PX) dx -= 1;
    if (pointer.x > window.innerWidth - EDGE_SCROLL_PX) dx += 1;
    if (pointer.y < EDGE_SCROLL_PX) dy -= 1;
    if (pointer.y > window.innerHeight - EDGE_SCROLL_PX) dy += 1;
  }

  if (dx === 0 && dy === 0) return;
  const len = Math.hypot(dx, dy) || 1;
  renderer.camX += (dx / len) * CAMERA_SPEED * dt;
  renderer.camY += (dy / len) * CAMERA_SPEED * dt;
  clampCamera();
}

/**
 * Keep the view on the map.
 *
 * Allowing half a screen past the edge means a base in a corner is rendered
 * against a wall of void, which reads as a broken camera. A couple of tiles of
 * margin is enough to reach units at the very edge without that.
 */
function clampCamera(): void {
  if (mapW === 0 || mapH === 0) return;
  const viewW = window.innerWidth / renderer.tilePx;
  const viewH = window.innerHeight / renderer.tilePx;

  // If the map is narrower than the view, centre it rather than clamping.
  renderer.camX =
    viewW >= mapW
      ? (mapW - viewW) / 2
      : Math.max(-EDGE_MARGIN, Math.min(mapW - viewW + EDGE_MARGIN, renderer.camX));
  renderer.camY =
    viewH >= mapH
      ? (mapH - viewH) / 2
      : Math.max(-EDGE_MARGIN, Math.min(mapH - viewH + EDGE_MARGIN, renderer.camY));
}

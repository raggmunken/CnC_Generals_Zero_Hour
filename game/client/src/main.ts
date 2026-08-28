/**
 * Client entry point: connect, render, take input.
 *
 * The client never simulates. It renders the last two server snapshots with
 * interpolation between them, which is what makes a 15Hz sim look smooth.
 */
import { BUILDINGS, buildingDef, unitDef, UNITS } from "../../shared/content.js";
import type { ServerMsg } from "../../shared/protocol.js";
import type { Building, Economy, Unit } from "../../shared/types.js";
import { Net } from "./net.js";
import { Renderer } from "./render.js";

const CAMERA_SPEED = 18; // world units per second
const EDGE_SCROLL_PX = 24;
/** How far past the map edge the camera may scroll, in world units. */
const EDGE_MARGIN = 2;

const hud = document.getElementById("hud")!;
const panelItems = document.getElementById("panel-items")!;
const panelTitle = document.getElementById("panel-title")!;
const renderer = new Renderer();
await renderer.init();

const net = new Net();

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
let economy: Economy = { credits: 0, powerProduced: 0, powerConsumed: 0 };

/** Building type queued for placement, or null when not placing. */
let placing: string | null = null;
/** Our building whose production menu is open, or null. */
let selectedBuilding: number | null = null;

const selected = new Set<number>();
const keys = new Set<string>();
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
    renderer.buildTerrain(mapW, mapH, msg.map.tiles);
    // Camera is centred once our units actually arrive -- see below. Welcome
    // lands before the first snapshot, so there is nothing to centre on yet.
  } else if (msg.t === "snap") {
    prevUnits = currUnits;
    prevAt = currAt;
    currUnits = new Map(msg.units.map((u) => [u.id, u]));
    currAt = performance.now();
    buildings = msg.buildings;
    economy = msg.economy;
    if (!centred) centreOnOwnUnits();
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
  if (e.code === "Escape") {
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
    issueMoveAt(e.clientX, e.clientY);
  }
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
      if (!e.shiftKey) selected.clear();
      if (hit.owner === playerId) selected.add(hit.id);
      selectedBuilding = null;
      renderPanel();
    } else if (hitBuilding && hitBuilding.owner === playerId) {
      selectedBuilding = hitBuilding.id;
      selected.clear();
      renderPanel();
    } else if (selected.size > 0) {
      issueMoveAt(e.clientX, e.clientY);
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
  el.addEventListener("click", onClick);
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
    if (u.x >= p0.x && u.x <= p1.x && u.y >= p0.y && u.y <= p1.y) selected.add(u.id);
  }
}

function issueMoveAt(sx: number, sy: number): void {
  if (selected.size === 0) return;
  const w = renderer.screenToWorld(sx, sy);
  net.send({ t: "move", unitIds: [...selected], x: w.x, y: w.y });
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
    });
  }
  renderer.drawBuildings(
    buildings.map((b) => ({
      owner: b.owner,
      x: b.x,
      y: b.y,
      size: buildingDef(b.type).size,
      progress: b.buildTotal === 0 ? 1 : 1 - b.buildRemaining / b.buildTotal,
      selected: b.id === selectedBuilding,
    })),
  );

  if (placing && pointer.inside) {
    const w = renderer.screenToWorld(pointer.x, pointer.y);
    const size = buildingDef(placing).size;
    const gx = Math.floor(w.x - size / 2);
    const gy = Math.floor(w.y - size / 2);
    renderer.drawPlacementGhost({ x: gx, y: gy, size, ok: economy.credits >= buildingDef(placing).cost });
  }

  renderer.drawUnits(drawList, selected);

  renderer.drawSelectionBox(
    dragStart && dragNow
      ? { x0: dragStart.x, y0: dragStart.y, x1: dragNow.x, y1: dragNow.y }
      : null,
  );

  const lowPower = economy.powerConsumed > economy.powerProduced;
  hud.textContent =
    `${status}  ·  player ${playerId < 0 ? "?" : playerId + 1}  ·  ` +
    `$${economy.credits}  ·  power ${economy.powerProduced - economy.powerConsumed}` +
    `${lowPower ? " LOW" : ""}  ·  units ${currUnits.size}  ·  selected ${selected.size}`;
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

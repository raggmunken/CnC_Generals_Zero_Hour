/**
 * Sprite atlas generator.
 *
 * Emits a single labelled PNG containing every drawable element in the game --
 * terrain, buildings, units and overlays -- plus an atlas.json describing the
 * grid. Redraw any cell and the game picks it up; the manifest is the contract
 * between the art and the renderer, so nothing needs recompiling to reskin.
 *
 * Cells are uniform even though footprints are not: an artist wants a
 * consistent canvas, and the renderer scales each sprite to its real footprint
 * from the size recorded in the manifest.
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { BUILDINGS, UNITS } from "../shared/content.js";
import { FACTIONS, SPRITES } from "./sprites.js";

const CELL = 128;
const PAD = 10;
const LABEL_H = 26;
const COLS = 8;

interface Cell {
  key: string;
  label: string;
  sub: string;
  svg: string;
  /** Footprint in world tiles, so the renderer knows the real scale. */
  tiles: number;
  group: string;
}

/** Terrain swatches, matching the renderer's palette exactly. */
const TERRAIN: Array<[string, string, number]> = [
  ["ground", "#3f5133", 1],
  ["rough", "#59502f", 1],
  ["water", "#24506b", 1],
  ["mountain", "#4a4642", 1],
  ["trees", "#2b3d22", 1],
];

function swatch(color: string, motif = ""): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
    <rect width="64" height="64" fill="${color}"/>${motif}</svg>`;
}

const cells: Cell[] = [];

for (const [name, color, tiles] of TERRAIN) {
  // A faint grid hint so an artist can see the tile boundary they must fill.
  const motif = `<path d="M0 0 H64 M0 0 V64" stroke="rgba(255,255,255,.10)" stroke-width="2" fill="none"/>`;
  cells.push({ key: `terrain.${name}`, label: name, sub: "terrain · tiles seamlessly",
    svg: swatch(color, motif), tiles, group: "Terrain" });
}

for (const b of Object.values(BUILDINGS)) {
  cells.push({
    key: `building.${b.id}`,
    label: b.name,
    sub: `${b.size}x${b.size} tiles · $${b.cost}`,
    svg: SPRITES.building(FACTIONS.red!),
    tiles: b.size,
    group: "Buildings",
  });
}

for (const u of Object.values(UNITS)) {
  // Reuse the closest existing procedural shape as a starting point.
  const draw =
    u.id === "infantry" || u.id === "rocket" ? SPRITES.infantry
      : u.id === "harvester" || u.id === "dozer" ? SPRITES.harvester
      : SPRITES.tank;
  cells.push({
    key: `unit.${u.id}`,
    label: u.name,
    sub: `r=${u.radius} · $${u.cost}`,
    svg: draw(FACTIONS.red!),
    tiles: Math.max(1, Math.round(u.radius * 2)),
    group: "Units",
  });
}

cells.push({
  key: "overlay.supply",
  label: "Supply Pile",
  sub: "shrinks as it depletes",
  svg: swatch("#00000000", `<circle cx="32" cy="32" r="22" fill="#c9a227" stroke="#7d6416" stroke-width="3"/>`),
  tiles: 2,
  group: "Overlays",
});
cells.push({
  key: "overlay.selection",
  label: "Selection Ring",
  sub: "drawn under the unit",
  svg: swatch("#00000000", `<circle cx="32" cy="32" r="26" fill="none" stroke="#ffffff" stroke-width="4"/>`),
  tiles: 1,
  group: "Overlays",
});
cells.push({
  key: "overlay.rally",
  label: "Rally Marker",
  sub: "production destination",
  svg: swatch("#00000000", `<circle cx="32" cy="32" r="18" fill="none" stroke="#9fe870" stroke-width="4"/><path d="M32 8 V56" stroke="#9fe870" stroke-width="3"/>`),
  tiles: 1,
  group: "Overlays",
});

// -- lay out ---------------------------------------------------------------

const groups = [...new Set(cells.map((c) => c.group))];
type Placed = Cell & { x: number; y: number };
const placed: Placed[] = [];

let y = PAD + 34;
const headers: Array<{ name: string; y: number }> = [];

for (const group of groups) {
  headers.push({ name: group, y });
  y += 24;
  const members = cells.filter((c) => c.group === group);
  members.forEach((c, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    placed.push({ ...c, x: PAD + col * (CELL + PAD), y: y + row * (CELL + LABEL_H + PAD) });
  });
  y += Math.ceil(members.length / COLS) * (CELL + LABEL_H + PAD) + 16;
}

const WIDTH = PAD * 2 + COLS * (CELL + PAD);
const HEIGHT = y + PAD;

const html = `<!doctype html><meta charset="utf-8"><body>
<style>
  body { margin:0; width:${WIDTH}px; height:${HEIGHT}px; background:#171b14;
         font:12px ui-monospace,SFMono-Regular,Menlo,monospace; color:#cfe0c3; position:relative; }
  .title { position:absolute; left:${PAD}px; top:8px; font-size:15px; letter-spacing:1px; color:#9fe870; }
  .hdr { position:absolute; font-size:13px; letter-spacing:2px; color:#8fa382; }
  .cell { position:absolute; width:${CELL}px; }
  .box { width:${CELL}px; height:${CELL}px; background:#0f120d;
         border:1px dashed #3c4a33; box-sizing:border-box; display:flex;
         align-items:center; justify-content:center; }
  .box img { width:${CELL - 16}px; height:${CELL - 16}px; }
  .lbl { height:${LABEL_H}px; padding-top:4px; line-height:1.2; }
  .lbl b { display:block; font-weight:600; color:#e6f0de; }
  .lbl span { opacity:.6; font-size:11px; }
</style>
<div class="title">GAME ATLAS — redraw any cell, keep the grid</div>
${headers.map((h) => `<div class="hdr" style="left:${PAD}px; top:${h.y}px">${h.name.toUpperCase()}</div>`).join("")}
${placed.map((c) => `
  <div class="cell" style="left:${c.x}px; top:${c.y}px">
    <div class="box"><img src="data:image/svg+xml;base64,${Buffer.from(c.svg).toString("base64")}"></div>
    <div class="lbl"><b>${c.label}</b><span>${c.sub}</span></div>
  </div>`).join("")}
</body>`;

writeFileSync("/tmp/atlas.html", html);

const manifest = {
  cell: CELL,
  note: "Each cell is a square canvas. `tiles` is the element's real footprint in world tiles; the renderer scales the cell to that.",
  sprites: Object.fromEntries(
    placed.map((c) => [c.key, { x: c.x, y: c.y, w: CELL, h: CELL, tiles: c.tiles, label: c.label }]),
  ),
};
writeFileSync("assets/atlas.json", JSON.stringify(manifest, null, 2));

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
await page.goto("file:///tmp/atlas.html");
await page.waitForTimeout(400);
await page.screenshot({ path: "assets/atlas.png", fullPage: true });
await browser.close();

console.log(`atlas: ${placed.length} cells, ${WIDTH}x${HEIGHT} (@2x) -> assets/atlas.png + assets/atlas.json`);

/**
 * Label whatever sheet is currently installed.
 *
 * Distinct from atlas.ts, which draws the primitive placeholder art: this one
 * reads client/public/sprites.png and atlas.json and produces the reference an
 * artist -- or an image model -- gets handed. Point it at real art and the
 * guide describes the real art, which is the only way the brief in
 * assets/ART_PROMPT.md stays true as the sheet is replaced.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("client/public/atlas.json", "utf8")) as {
  cell: number;
  sheet: string;
  sprites: Record<string, { x: number; y: number; w: number; h: number; tiles: number; label: string }>;
};
const png = readFileSync(`client/public/${manifest.sheet}`).toString("base64");

const CELL = 168;
const LABEL = 44;
const COLS = 8;
const entries = Object.entries(manifest.sprites);
const rows = Math.ceil(entries.length / COLS);

const cells = entries.map(([key, c], i) => {
  const cx = (i % COLS) * CELL;
  const cy = Math.floor(i / COLS) * (CELL + LABEL);
  // background-size scales the whole sheet so the wanted cell lands in the box.
  const k = (CELL - 8) / c.w;
  return `<div class="cell" style="left:${cx}px;top:${cy}px">
    <div class="art" style="background-size:${k * 1024}px ${k * 384}px, 22px 22px;
      background-position:${-c.x * k}px ${-c.y * k}px, 0 0"></div>
    <div class="cap"><b>${key}</b><span>${c.label} &middot; ${c.tiles}&times;${c.tiles} tiles</span></div>
  </div>`;
}).join("");

const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin:0; background:#15181a; font:12px ui-monospace,Menlo,monospace; color:#cfd6cc; }
  .wrap { position:relative; width:${COLS * CELL}px; height:${rows * (CELL + LABEL)}px; }
  .cell { position:absolute; width:${CELL}px; height:${CELL + LABEL}px; }
  .art { width:${CELL - 8}px; height:${CELL - 8}px; margin:4px;
    background-image:
      url(data:image/png;base64,${png}),
      conic-gradient(#2b3134 0 25%, #1e2325 0 50%, #2b3134 0 75%, #1e2325 0);
    background-repeat:no-repeat,repeat;
    background-position:0 0,0 0; }
  .cap { padding:0 6px; line-height:1.3; font-size:10.5px; word-break:break-word; }
  .cap b { color:#e6ecdf; font-weight:600; display:block; }
  .cap span { color:#8d968a; }
</style><div class="wrap">${cells}</div>`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({
  viewport: { width: COLS * CELL, height: rows * (CELL + LABEL) },
  deviceScaleFactor: 2,
});
await page.setContent(html);
await page.waitForTimeout(300);
await page.screenshot({ path: "assets/atlas-guide.png", fullPage: true });
await browser.close();
console.log(`guide: ${entries.length} cells from ${manifest.sheet} -> assets/atlas-guide.png`);

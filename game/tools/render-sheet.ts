/**
 * Render the sprites to a PNG contact sheet so they can actually be looked at.
 *
 * Generating art blind is the whole reason authored SVG comes out wrong. This
 * closes the loop: draw, render, look, fix.
 */
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { FACTIONS, SPRITES } from "./sprites.js";

const names = Object.keys(SPRITES) as Array<keyof typeof SPRITES>;
const cells: string[] = [];

for (const faction of ["red", "blue"] as const) {
  for (const name of names) {
    const src = SPRITES[name](FACTIONS[faction]!);
    const b64 = Buffer.from(src).toString("base64");
    cells.push(`
      <figure>
        <div class="row">
          <img class="big" src="data:image/svg+xml;base64,${b64}">
          <img class="mid" src="data:image/svg+xml;base64,${b64}">
          <img class="small" src="data:image/svg+xml;base64,${b64}">
        </div>
        <figcaption>${faction} ${name}</figcaption>
      </figure>`);
  }
}

const html = `<!doctype html><meta charset="utf-8"><body>
<style>
  body { margin:0; padding:24px; background:#3f5133; font:12px ui-monospace,monospace; color:#dfe8d6; }
  .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:20px; }
  figure { margin:0; text-align:center; background:#36452c; padding:12px; border-radius:6px; }
  .row { display:flex; align-items:flex-end; justify-content:center; gap:12px; height:104px; }
  .big { width:96px; height:96px; } .mid { width:48px; height:48px; } .small { width:24px; height:24px; }
  img { image-rendering:auto; }
  figcaption { margin-top:8px; opacity:.8; }
</style>
<div class="grid">${cells.join("")}</div>
</body>`;

writeFileSync("/tmp/sheet.html", html);

const b = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const p = await b.newPage({ viewport: { width: 1000, height: 560 }, deviceScaleFactor: 2 });
await p.goto("file:///tmp/sheet.html");
await p.waitForTimeout(400);
await p.screenshot({ path: "/tmp/sprites.png", fullPage: true });
await b.close();
console.log("rendered /tmp/sprites.png");

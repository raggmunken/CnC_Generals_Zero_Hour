/**
 * Automated playtest: drives the real client in a real browser the way a
 * player actually would -- box-select, move orders, camera pan, zoom,
 * building placement, production queueing, control groups, minimap click --
 * and captures a screenshot after each step.
 *
 * This exists to *see* the game rather than reason about its source: art and
 * feel bugs do not show up by reading render.ts, they show up on screen.
 * Needs the server up (`npm run server`); writes numbered PNGs plus a JSON
 * summary of console errors and HUD state to OUT_DIR.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findChromium } from "../test/browser.js";

const URL = process.env.GAME_URL ?? "http://127.0.0.1:8090/";
const OUT_DIR = process.env.PLAYTEST_OUT ?? path.join(process.env.TEMP ?? "/tmp", "rts-playtest");
mkdirSync(OUT_DIR, { recursive: true });

let shot = 0;
async function snap(page: import("playwright").Page, label: string): Promise<void> {
  shot += 1;
  const file = path.join(OUT_DIR, `${String(shot).padStart(2, "0")}-${label}.png`);
  await page.screenshot({ path: file });
  console.log(`  shot  ${label} -> ${file}`);
}

const consoleErrors: string[] = [];
const log: Array<{ step: string; hud: string }> = [];

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

async function hud(): Promise<string> {
  return ((await page.locator("#hud").textContent()) ?? "").replace(/\s+/g, " ").trim();
}
async function record(step: string): Promise<void> {
  const h = await hud();
  log.push({ step, hud: h });
  console.log(`  ${step.padEnd(28)} ${h}`);
}

console.log(`connecting to ${URL}`);
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await record("connected");
await snap(page, "initial");

// Let the economy run a little so there is a base worth looking at.
await page.waitForTimeout(15000);
await record("after 15s economy");
await snap(page, "economy-15s");

// -- box select every owned unit --------------------------------------------
await page.mouse.move(20, 40);
await page.mouse.down();
await page.mouse.move(1400, 860, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(300);
await record("box-select all");
await snap(page, "box-select");

// -- move order --------------------------------------------------------------
await page.mouse.move(700, 450);
await page.mouse.down({ button: "right" });
await page.mouse.up({ button: "right" });
await page.waitForTimeout(600);
await record("move order issued");
await snap(page, "move-order");

// -- camera pan via WASD -------------------------------------------------
await page.keyboard.down("KeyD");
await page.waitForTimeout(700);
await page.keyboard.up("KeyD");
await record("panned camera (D)");
await snap(page, "camera-pan");

// -- zoom in / out -------------------------------------------------------
await page.mouse.move(720, 450);
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(30); }
await record("zoomed in");
await snap(page, "zoom-in");
for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(30); }
await record("zoomed out");
await snap(page, "zoom-out");
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(30); } // back to a normal zoom

// -- jump to dozer, open build panel, place a building ------------------
await page.keyboard.press("KeyB");
await page.waitForTimeout(300);
await record("jumped to dozer");
await snap(page, "dozer-selected");

// Click the first enabled build item in the panel (skip disabled ones).
const buildItem = page.locator("#panel-items .item:not([disabled])").first();
const buildCount = await page.locator("#panel-items .item").count();
console.log(`  build panel has ${buildCount} entries`);
if (await buildItem.count() > 0) {
  await buildItem.click();
  await page.waitForTimeout(200);
  await record("armed placement");
  await snap(page, "placement-armed");

  await page.mouse.move(900, 500);
  await page.waitForTimeout(150);
  await snap(page, "placement-ghost");
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(600);
  await record("building placed");
  await snap(page, "building-placed");
}

// -- select a production building and queue a unit -----------------------
// Command centre sits at the base; click near the camera-centred start.
const commandCenterHit = await page.evaluate(() => {
  const w = (window as unknown as {
    __rts?: { buildings?: Array<{ id: number; type: string; x: number; y: number; owner: number }>; playerId?: number };
  }).__rts;
  const cc = w?.buildings?.find((b) => b.type === "command_center" && b.owner === w.playerId);
  return cc ? { x: cc.x, y: cc.y } : null;
});
if (commandCenterHit) {
  const screen = await page.evaluate((wpt) => {
    const r = (window as unknown as { renderer?: unknown }).renderer;
    return r ? undefined : wpt; // renderer isn't exposed globally; fall back below
  }, commandCenterHit);
  void screen;
}
// Simplest reliable path: click screen-centre after camera re-centres on B,
// since KeyB just centred the view on our dozer, which starts near our base.
await page.mouse.move(720, 450);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(200);
await record("clicked near base");
await snap(page, "clicked-near-base");

// -- control groups --------------------------------------------------------
await page.mouse.move(20, 40);
await page.mouse.down();
await page.mouse.move(1400, 860, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
await page.keyboard.down("Control");
await page.keyboard.press("Digit1");
await page.keyboard.up("Control");
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const clearedHud = await hud();
await page.keyboard.press("Digit1");
await page.waitForTimeout(300);
const recalledHud = await hud();
log.push({ step: "control-group cleared", hud: clearedHud });
log.push({ step: "control-group recalled", hud: recalledHud });
console.log(`  control-group cleared        ${clearedHud}`);
console.log(`  control-group recalled       ${recalledHud}`);
await snap(page, "control-group-recall");

// -- minimap click -----------------------------------------------------------
const minimapBox = await page.locator("#minimap").boundingBox();
if (minimapBox) {
  await page.mouse.click(minimapBox.x + minimapBox.width * 0.8, minimapBox.y + minimapBox.height * 0.2);
  await page.waitForTimeout(300);
  await record("minimap click");
  await snap(page, "minimap-click");
}

// -- attack-move ------------------------------------------------------------
await page.mouse.move(20, 40);
await page.mouse.down();
await page.mouse.move(1400, 860, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(150);
await page.keyboard.press("KeyA");
await page.mouse.move(1100, 300);
await page.mouse.down({ button: "right" });
await page.mouse.up({ button: "right" });
await page.waitForTimeout(400);
await record("attack-move issued");
await snap(page, "attack-move");

// Let combat / economy run a while longer, then a final overview shot.
await page.waitForTimeout(20000);
await record("after 20s more");
await snap(page, "final-overview");

writeFileSync(path.join(OUT_DIR, "log.json"), JSON.stringify({ log, consoleErrors }, null, 2));
console.log(`\nconsole errors: ${consoleErrors.length}`);
for (const e of consoleErrors.slice(0, 20)) console.log(`  ERR  ${e}`);

await browser.close();
console.log(`\nwrote ${shot} screenshots + log.json to ${OUT_DIR}`);

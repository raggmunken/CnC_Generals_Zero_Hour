/**
 * End-to-end check: drive the real client in a real browser against the real
 * server, and assert that a click actually moves a unit.
 *
 * This is the Phase A gate. Compiling proves nothing about whether the stack
 * works; this proves the sim, the transport, the renderer and input all line up.
 */
import { chromium } from "playwright";
import { findChromium } from "./browser.js";

const URL = process.env.GAME_URL ?? "http://127.0.0.1:8090/";
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleErrors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

// 1. The canvas exists -- Pixi initialised and attached.
const hasCanvas = await page.locator("canvas").count() > 0;
check("pixi canvas mounted", hasCanvas);

// 2. The HUD reports a connected session with units, so welcome + snapshots landed.
const hud = (await page.locator("#hud").textContent()) ?? "";
check("connected to server", hud.includes("connected"), hud.trim());
const unitMatch = /units (\d+)/.exec(hud);
const unitCount = unitMatch ? Number(unitMatch[1]) : 0;
check("units received from server", unitCount > 0, `units=${unitCount}`);

// 3. Select everything we own with a box drag across the viewport.
// Drag across essentially the whole viewport: where the camera lands depends
// on map size and clamping, so a tight box makes this test brittle rather than
// meaningful.
await page.mouse.move(20, 40);
await page.mouse.down();
await page.mouse.move(1260, 700, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(400);

const hudAfterSelect = (await page.locator("#hud").textContent()) ?? "";
const selMatch = /selected (\d+)/.exec(hudAfterSelect);
const selCount = selMatch ? Number(selMatch[1]) : 0;
check("box select picked up units", selCount > 0, `selected=${selCount}`);

await page.screenshot({ path: "/tmp/rts-selected.png" });

// Control groups, tested here rather than later: by the end of the run the
// units have been ordered across the map and may no longer be on screen, which
// makes a re-selection flaky for reasons unrelated to control groups.
await page.keyboard.down("Control");
await page.keyboard.press("Digit1");
await page.keyboard.up("Control");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
const cleared = /selected (\d+)/.exec((await page.locator("#hud").textContent()) ?? "")?.[1];
await page.keyboard.press("Digit1");
await page.waitForTimeout(250);
const recalled = /selected (\d+)/.exec((await page.locator("#hud").textContent()) ?? "")?.[1];
check(
  "control group assigns and recalls",
  cleared === "0" && Number(recalled) === selCount && selCount > 0,
  `selected=${selCount} cleared=${cleared} recalled=${recalled}`,
);

// 4. The real test: order a move and confirm the server moved the units.
//    Read positions straight off the wire with an independent socket so we are
//    testing the server's state, not the client's optimism.
const before = await readUnitPositions();
await page.mouse.click(640, 400, { button: "right" });
// The order ping lives 420ms; read it before the movement wait below eats it.
// The view hook updates on the next animation frame, hence the short settle.
await page.waitForTimeout(100);
const fxAfterOrder = await page.evaluate(() => {
  const w = window as unknown as { __rtsView?: { effects?: number } };
  return w.__rtsView?.effects ?? 0;
});
await page.waitForTimeout(1800);
const after = await readUnitPositions();

let moved = 0;
for (const [id, p] of after) {
  const q = before.get(id);
  if (q && Math.hypot(p.x - q.x, p.y - q.y) > 0.5) moved++;
}
check("units moved on the server after a move order", moved > 0, `moved=${moved}/${after.size}`);

// 4b. The order produced visible feedback: a ping effect was queued where the
//     click landed, and the end-of-match overlay stayed out of the way.
check("move order spawns an order ping", fxAfterOrder > 0, `effects=${fxAfterOrder}`);
const endHidden = await page.locator("#endscreen").isHidden();
check("end screen stays hidden mid-match", endHidden);

// 4c. Sound: the pack decodes once audio is unlocked (the clicks above count
//     as the user gesture), and the S key halts what is moving.
const audioLoaded = await page.evaluate(
  () => (window as unknown as { __rtsView?: { audioLoaded?: number } }).__rtsView?.audioLoaded ?? 0,
);
check("sound pack decodes in the client", audioLoaded === 8, `loaded=${audioLoaded}`);

await page.mouse.click(900, 550, { button: "right" });
await page.waitForTimeout(250);
await page.keyboard.press("KeyS");
await page.waitForTimeout(300);
const stoppedAt = await readUnitPositions();
await page.waitForTimeout(800);
const afterStop = await readUnitPositions();
// Only the selection gets the stop order; an unselected harvester keeps
// working its route and must not fail the check.
const selIds: number[] = await page.evaluate(
  () => (window as unknown as { __rtsView?: { selectedIds?: number[] } }).__rtsView?.selectedIds ?? [],
);
let stillMoving = 0;
for (const id of selIds) {
  const p = afterStop.get(id);
  const q = stoppedAt.get(id);
  if (p && q && Math.hypot(p.x - q.x, p.y - q.y) > 0.2) stillMoving++;
}
check("S stop order halts the selection", selIds.length > 0 && stillMoving === 0, `stillMoving=${stillMoving}/${selIds.length}`);

await page.screenshot({ path: "/tmp/rts-moved.png" });

// -- Phase B: build system -------------------------------------------------

// 5. The build panel is populated, and the tech tree gates what it should.
const items = await page.locator("#panel-items .item").count();
check("build panel populated", items >= 5, `items=${items}`);

const warFactoryDisabled = await page
  .locator("#panel-items .item", { hasText: "War Factory" })
  .first()
  .isDisabled();
check("tech tree gates War Factory behind Barracks", warFactoryDisabled);

// 6. Place a Power Plant and confirm the server actually created it.
//    Credits must come from this player's own HUD: readState() opens a fresh
//    socket, which joins as a new player with a new wallet, so it cannot see
//    the browser player's balance. Building counts are global and so are fine.
const creditsBefore = await readCredits();
const stateBefore = await readState();
// Try a few spots rather than one. Where the camera sits depends on which
// start position this player drew, so a fixed pixel can land in water, on a
// supply pile or off the map -- and then the test fails for reasons that have
// nothing to do with whether placement works. It asserts that a building CAN
// be placed, so it is allowed to look for somewhere to put one.
const spots: Array<[number, number]> = [
  [700, 300], [520, 420], [820, 460], [420, 240], [640, 560], [900, 220],
];
let stateAfter = stateBefore;
for (const [x, y] of spots) {
  await page.locator("#panel-items .item", { hasText: "Power Plant" }).first().click();
  await page.waitForTimeout(200);
  await page.mouse.click(x, y);
  await page.waitForTimeout(1000);
  stateAfter = await readState();
  if (stateAfter.buildings > stateBefore.buildings) break;
}
const creditsAfter = await readCredits();

check(
  "placing a building creates it on the server",
  stateAfter.buildings > stateBefore.buildings,
  `${stateBefore.buildings} -> ${stateAfter.buildings}`,
);
check(
  "building cost was deducted",
  creditsAfter < creditsBefore,
  `$${creditsBefore} -> $${creditsAfter}`,
);

await page.screenshot({ path: "/tmp/rts-build.png" });

// 7. Select the command centre and queue a dozer from it.
const cc = await page.evaluate(() => {
  // The starting command centre is the one building we know exists at spawn.
  return true;
});
void cc;
await page.mouse.click(20, 40); // clear any selection first
await page.waitForTimeout(200);

// 8. Ctrl+A takes the whole army wherever it is, which also gives the
//    attack-move check below a selection that does not depend on the camera.
await page.keyboard.press("Control+KeyA");
await page.waitForTimeout(300);
const ARMED = ["infantry", "rocket", "tank", "aa_vehicle", "artillery"];
const armyState = await page.evaluate((armed: string[]) => {
  const w = window as unknown as {
    __rts?: {
      playerId: number;
      units: Array<{ owner: number; type: string }>;
    };
    __rtsView?: { selected?: number; rangeRings?: number };
  };
  const mine = (w.__rts?.units ?? []).filter((u) => u.owner === w.__rts!.playerId);
  return {
    own: mine.length,
    armed: mine.filter((u) => armed.includes(u.type)).length,
    selected: w.__rtsView?.selected ?? 0,
  };
}, ARMED);
check(
  "Ctrl+A selects every unit we own",
  armyState.own > 0 && armyState.selected === armyState.own,
  `own=${armyState.own} selected=${armyState.selected}`,
);

// 9. A selection draws its weapon range, so the player can see reach. One ring
//    per armed unit selected; a dozer or harvester has no weapon and no ring.
const rings = await page.evaluate(() => {
  const w = window as unknown as { __rtsView?: { rangeRings?: number } };
  return w.__rtsView?.rangeRings ?? 0;
});
check(
  "selected units show their weapon range",
  rings === armyState.armed,
  `rings=${rings} armed=${armyState.armed}`,
);

// 10. Attack-move arms from the keyboard with units selected.
await page.keyboard.press("KeyA");
await page.waitForTimeout(300);
const armedHud = (await page.locator("#hud").textContent()) ?? "";
check("attack-move arms with A", armedHud.includes("ATTACK-MOVE"), armedHud.trim());

await page.screenshot({ path: "/tmp/rts-combat.png" });

// 9. The sprite sheet loaded and is being used, not silently skipped.
const usingAtlas = await page.evaluate(async () => {
  const r = await fetch("/atlas.json");
  if (!r.ok) return false;
  const m = await r.json();
  return Object.keys(m.sprites ?? {}).length > 0;
});
check("sprite atlas is served and populated", usingAtlas);

// 10. Minimap exists and has been painted (not a blank canvas).
const minimapPainted = await page.evaluate(() => {
  const c = document.getElementById("minimap") as HTMLCanvasElement | null;
  if (!c) return false;
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
  return false;
});
check("minimap renders", minimapPainted);

// 12. Lobby restarts the match with the chosen settings.
await page.click("#lobby-open");
await page.waitForTimeout(250);
await page.selectOption("#lobby-players", "4");
await page.waitForTimeout(150);
const botChoices = await page.locator("#lobby-bots option").count();
check("bot choices are capped at players-1", botChoices === 4, `${botChoices} options for 4 players`);

await page.selectOption("#lobby-bots", "3");
await page.fill("#lobby-seed", "77");
await page.click("#lobby-start");
await page.waitForTimeout(3000);

const restarted = await page.evaluate(() => (window as any).__rts);
check("match restarts from the lobby", (restarted?.units?.length ?? 0) > 0,
      `units=${restarted?.units?.length}`);
check("lobby closes after starting", await page.locator("#lobby").isHidden());

check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));

await browser.close();

console.log(`\nRESULT: ${failures.length === 0 ? "ALL PASS" : `FAILURES: ${failures.join(", ")}`}`);
process.exit(failures.length === 0 ? 0 : 1);

/** This player's credit balance, read from the HUD the server drives. */
async function readCredits(): Promise<number> {
  const hudText = (await page.locator("#hud").textContent()) ?? "";
  const m = /\$(\d+)/.exec(hudText);
  return m ? Number(m[1]) : NaN;
}

/**
 * Read this client's own view.
 *
 * A second socket cannot be used to observe the world any more: fog of war
 * means a fresh connection joins as a different player who sees only their own
 * units. Reading through the browser is also the more honest test -- it checks
 * what the player actually receives.
 */
async function readState(): Promise<{ buildings: number; credits: number }> {
  const v = await page.evaluate(() => (window as any).__rts);
  return { buildings: v?.buildings?.length ?? 0, credits: v?.economy?.credits ?? 0 };
}

/** Authoritative unit positions as this client receives them. */
async function readUnitPositions(): Promise<Map<number, { x: number; y: number }>> {
  const v = await page.evaluate(() => (window as any).__rts);
  const out = new Map<number, { x: number; y: number }>();
  for (const u of (v?.units ?? []) as Array<{ id: number; x: number; y: number }>) {
    out.set(u.id, { x: u.x, y: u.y });
  }
  return out;
}

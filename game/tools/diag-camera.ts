/**
 * Focused repro: place a second command centre and dump camera/zoom state
 * before and after, to pin down the black-screen bug seen during playtest.
 */
import { chromium } from "playwright";
import { findChromium } from "../test/browser.js";

const URL = process.env.GAME_URL ?? "http://127.0.0.1:8090/";
const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => console.log(`  console.${m.type()}  ${m.text()}`));
page.on("pageerror", (e) => console.log(`  pageerror  ${e}`));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

async function camState(label: string) {
  const s = await page.evaluate(() => {
    const w = window as unknown as { __rtsView?: unknown };
    // renderer isn't global, so read camera through the canvas transform instead.
    const canvas = document.querySelector("canvas");
    return { view: w.__rtsView, canvasSize: canvas ? `${canvas.width}x${canvas.height}` : null };
  });
  console.log(`  ${label}`, JSON.stringify(s));
}

await page.keyboard.press("KeyB"); // select nearest dozer, centre camera
await page.waitForTimeout(300);
await camState("after KeyB");
await page.screenshot({ path: `${process.env.TEMP}\\diag-01-before.png` });

const buildItem = page.locator("#panel-items .item:not([disabled])").first();
const label = await buildItem.locator(".name").textContent();
console.log(`  arming placement for: ${label}`);
await buildItem.click();
await page.waitForTimeout(200);

await page.mouse.move(900, 500);
await page.waitForTimeout(150);
await page.screenshot({ path: `${process.env.TEMP}\\diag-02-ghost.png` });

await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(200);
await camState("immediately after placement");
await page.screenshot({ path: `${process.env.TEMP}\\diag-03-just-placed.png` });

await page.waitForTimeout(600);
await camState("600ms after placement");
await page.screenshot({ path: `${process.env.TEMP}\\diag-04-600ms-later.png` });

await page.waitForTimeout(2000);
await camState("2.6s after placement");
await page.screenshot({ path: `${process.env.TEMP}\\diag-05-2600ms-later.png` });

await browser.close();
console.log("done");

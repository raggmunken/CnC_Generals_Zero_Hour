/**
 * Take a look at the running game.
 *
 * Art has to be judged on screen, at the size and against the terrain it will
 * actually sit on -- a contact sheet flatters everything. Needs the server up
 * (`npm run server`); writes a zoomed-in and a zoomed-out frame.
 */
import { chromium } from "playwright";
import { findChromium } from "../test/browser.js";

const URL = process.env.GAME_URL ?? "http://127.0.0.1:8090/";
const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

for (let i = 0; i < 22; i++) {
  await page.mouse.move(640, 360);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(60);
}
await page.waitForTimeout(20000);      // let the economy put some buildings up
await page.screenshot({ path: "/tmp/art-close.png" });
for (let i = 0; i < 14; i++) {
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(60);
}
await page.screenshot({ path: "/tmp/art-wide.png" });
await browser.close();
console.log("wrote /tmp/art-close.png and /tmp/art-wide.png");

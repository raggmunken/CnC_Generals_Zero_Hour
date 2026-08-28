import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on("pageerror", (e) => console.log("[pageerror]", e.message));
await p.goto(process.env.GAME_URL!, { waitUntil: "networkidle" });
await p.waitForTimeout(3000);
for (let i = 0; i < 8; i++) { await p.mouse.wheel(0, 120); await p.waitForTimeout(60); }
await p.waitForTimeout(1500);
await p.screenshot({ path: "/tmp/rts-fog.png" });
console.log("hud:", (await p.locator("#hud").textContent())?.trim());
// How many units does this client actually receive? Fog should hide the bot's.
const seen = await p.evaluate(() => (document.getElementById("hud")?.textContent ?? ""));
console.log("client sees:", /units (\d+)/.exec(seen)?.[1]);
await b.close();

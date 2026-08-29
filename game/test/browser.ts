/**
 * Locate a Chromium executable for the browser-driven checks.
 *
 * The path used to be hardcoded to one machine's Playwright cache layout, and
 * both the revision directory (chromium-1194) and the platform subdirectory
 * (chrome-linux vs chrome-linux64) change with Playwright releases. Honour an
 * explicit override first, then scan the usual cache roots for whatever is
 * actually installed.
 */
import { existsSync, readdirSync } from "node:fs";

export function findChromium(): string {
  const candidates: string[] = [];
  if (process.env.PW_CHROMIUM) candidates.push(process.env.PW_CHROMIUM);

  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", `${process.env.HOME}/.cache/ms-playwright`]
    .filter((r): r is string => typeof r === "string" && existsSync(r));
  for (const root of roots) {
    for (const dir of readdirSync(root).filter((d) => /^chromium[-_]/u.test(d)).sort().reverse()) {
      candidates.push(
        `${root}/${dir}/chrome-linux/chrome`,
        `${root}/${dir}/chrome-linux64/chrome`,
      );
    }
  }

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `no chromium found; set PW_CHROMIUM to a chrome executable (looked in: ${candidates.join(", ") || "nothing"})`,
  );
}

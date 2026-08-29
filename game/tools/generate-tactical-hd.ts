/**
 * Tactical HD Texture & Sprite Generator
 *
 * Procedurally generates high-resolution, pixel-perfect Tactical HD sprites and
 * seamless tileable terrain textures for the game atlas.
 *
 * Emits:
 *   - client/public/sprites.png (1024x384 high-density atlas)
 *   - client/public/atlas.json (atlas manifest)
 *   - dist/sprites.png and dist/atlas.json (for production builds)
 */

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CELL_SIZE = 128;
const COLS = 8;
const ROWS = 3;
const ATLAS_W = COLS * CELL_SIZE; // 1024
const ATLAS_H = ROWS * CELL_SIZE; // 384

// --- Math & Procedural Helpers ----------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(min: number, max: number, v: number): number {
  const t = clamp((v - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}

// 2D Hash
function hash2(x: number, y: number, seed = 1337): number {
  let n = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453123;
  return n - Math.floor(n);
}

// 2D Value Noise with cosine interpolation
function valueNoise(x: number, y: number, seed = 1337): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  const wx = (1 - Math.cos(fx * Math.PI)) * 0.5;
  const wy = (1 - Math.cos(fy * Math.PI)) * 0.5;

  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);

  return lerp(lerp(a, b, wx), lerp(c, d, wx), wy);
}

// Seamless Tileable 2D Noise
function periodicNoise(x: number, y: number, w: number, h: number, seed = 1337): number {
  const nx = (x % w + w) % w;
  const ny = (y % h + h) % h;
  const u = nx / w;
  const v = ny / h;

  // 4D Torus embedding for 100% seamless wrap
  const r = 1.0 / (2 * Math.PI);
  const dx = Math.cos(u * 2 * Math.PI) * r;
  const dy = Math.sin(u * 2 * Math.PI) * r;
  const dz = Math.cos(v * 2 * Math.PI) * r;
  const dw = Math.sin(v * 2 * Math.PI) * r;

  let n = hash2(dx * 17.1 + dz * 31.7, dy * 19.3 + dw * 23.9, seed);
  return n;
}

// Multi-octave seamless fractal noise
function fbmSeamless(x: number, y: number, size: number, octaves = 4, seed = 1337): number {
  let total = 0;
  let amp = 0.5;
  let freq = 1;
  let max = 0;

  for (let i = 0; i < octaves; i++) {
    // Sample 4 offsets for periodic blending
    const u = (x * freq) % size;
    const v = (y * freq) % size;
    const w = size;

    const n1 = valueNoise(u, v, seed + i * 17);
    const n2 = valueNoise((u + w) % w, v, seed + i * 17);
    const n3 = valueNoise(u, (v + w) % w, seed + i * 17);
    const n4 = valueNoise((u + w) % w, (v + w) % w, seed + i * 17);

    const tx = u / size;
    const ty = v / size;
    const n = lerp(lerp(n1, n2, tx), lerp(n3, n4, tx), ty);

    total += n * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }

  return total / max;
}

// --- Software Canvas for 128x128 Cells ---------------------------------------

class PixelCanvas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;

  constructor(width = CELL_SIZE, height = CELL_SIZE) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  get(x: number, y: number): [number, number, number, number] {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return [0, 0, 0, 0];
    const i = (y * this.width + x) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!, this.data[i + 3]!];
  }

  set(x: number, y: number, r: number, g: number, b: number, a = 255): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }

  blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height || a <= 0) return;
    const i = (y * this.width + x) * 4;
    const alpha = a / 255;
    const dstA = this.data[i + 3]! / 255;
    const outA = alpha + dstA * (1 - alpha);

    if (outA > 0) {
      this.data[i] = Math.round((r * alpha + this.data[i]! * dstA * (1 - alpha)) / outA);
      this.data[i + 1] = Math.round((g * alpha + this.data[i + 1]! * dstA * (1 - alpha)) / outA);
      this.data[i + 2] = Math.round((b * alpha + this.data[i + 2]! * dstA * (1 - alpha)) / outA);
      this.data[i + 3] = Math.round(outA * 255);
    }
  }

  fill(r: number, g: number, b: number, a = 255): void {
    for (let i = 0; i < this.width * this.height * 4; i += 4) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = a;
    }
  }

  fillCircle(cx: number, cy: number, radius: number, r: number, g: number, b: number, a = 255): void {
    const r2 = radius * radius;
    const minX = Math.max(0, Math.floor(cx - radius - 1));
    const maxX = Math.min(this.width - 1, Math.ceil(cx + radius + 1));
    const minY = Math.max(0, Math.floor(cy - radius - 1));
    const maxY = Math.min(this.height - 1, Math.ceil(cy + radius + 1));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d <= r2) {
          const aa = radius > 1 ? clamp(radius - Math.sqrt(d) + 0.5, 0, 1) : 1;
          this.blend(x, y, r, g, b, Math.round(a * aa));
        }
      }
    }
  }

  strokeCircle(cx: number, cy: number, radius: number, width: number, r: number, g: number, b: number, a = 255): void {
    const minX = Math.max(0, Math.floor(cx - radius - width - 1));
    const maxX = Math.min(this.width - 1, Math.ceil(cx + radius + width + 1));
    const minY = Math.max(0, Math.floor(cy - radius - width - 1));
    const maxY = Math.min(this.height - 1, Math.ceil(cy + radius + width + 1));
    const rInner = radius - width / 2;
    const rOuter = radius + width / 2;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dist = Math.hypot(x - cx, y - cy);
        if (dist >= rInner && dist <= rOuter) {
          const edgeDist = Math.min(dist - rInner, rOuter - dist);
          const aa = clamp(edgeDist + 0.5, 0, 1);
          this.blend(x, y, r, g, b, Math.round(a * aa));
        }
      }
    }
  }

  fillRect(rx: number, ry: number, rw: number, rh: number, r: number, g: number, b: number, a = 255): void {
    const minX = Math.max(0, Math.floor(rx));
    const maxX = Math.min(this.width - 1, Math.floor(rx + rw));
    const minY = Math.max(0, Math.floor(ry));
    const maxY = Math.min(this.height - 1, Math.floor(ry + rh));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        this.blend(x, y, r, g, b, a);
      }
    }
  }

  strokeRect(rx: number, ry: number, rw: number, rh: number, strokeWidth: number, r: number, g: number, b: number, a = 255): void {
    this.fillRect(rx, ry, rw, strokeWidth, r, g, b, a);
    this.fillRect(rx, ry + rh - strokeWidth, rw, strokeWidth, r, g, b, a);
    this.fillRect(rx, ry, strokeWidth, rh, r, g, b, a);
    this.fillRect(rx + rw - strokeWidth, ry, strokeWidth, rh, r, g, b, a);
  }

  fillRoundRect(rx: number, ry: number, rw: number, rh: number, rad: number, r: number, g: number, b: number, a = 255): void {
    const minX = Math.max(0, Math.floor(rx));
    const maxX = Math.min(this.width - 1, Math.ceil(rx + rw));
    const minY = Math.max(0, Math.floor(ry));
    const maxY = Math.min(this.height - 1, Math.ceil(ry + rh));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = Math.max(0, Math.max(rx + rad - x, x - (rx + rw - rad)));
        const dy = Math.max(0, Math.max(ry + rad - y, y - (ry + rh - rad)));
        const dist = Math.hypot(dx, dy);
        if (dist <= rad) {
          const aa = clamp(rad - dist + 0.5, 0, 1);
          this.blend(x, y, r, g, b, Math.round(a * aa));
        }
      }
    }
  }

  strokeRoundRect(rx: number, ry: number, rw: number, rh: number, rad: number, strokeWidth: number, r: number, g: number, b: number, a = 255): void {
    const minX = Math.max(0, Math.floor(rx - strokeWidth));
    const maxX = Math.min(this.width - 1, Math.ceil(rx + rw + strokeWidth));
    const minY = Math.max(0, Math.floor(ry - strokeWidth));
    const maxY = Math.min(this.height - 1, Math.ceil(ry + rh + strokeWidth));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = Math.max(0, Math.max(rx + rad - x, x - (rx + rw - rad)));
        const dy = Math.max(0, Math.max(ry + rad - y, y - (ry + rh - rad)));
        const dist = Math.hypot(dx, dy);
        if (dist <= rad + strokeWidth / 2 && dist >= rad - strokeWidth / 2) {
          const aa = clamp(strokeWidth / 2 - Math.abs(dist - rad) + 0.5, 0, 1);
          this.blend(x, y, r, g, b, Math.round(a * aa));
        }
      }
    }
  }

  drawLine(x0: number, y0: number, x1: number, y1: number, width: number, r: number, g: number, b: number, a = 255): void {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    if (dist === 0) return;
    const steps = Math.ceil(dist * 2);
    const radius = width / 2;

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = lerp(x0, x1, t);
      const y = lerp(y0, y1, t);
      this.fillCircle(x, y, radius, r, g, b, a);
    }
  }

  // Draw metallic bevel/highlight on a box (light from top-left)
  bevelRect(rx: number, ry: number, rw: number, rh: number, highlight = 230, shadow = 40): void {
    // Top & Left highlight
    this.drawLine(rx, ry, rx + rw, ry, 1.5, highlight, highlight, highlight, 180);
    this.drawLine(rx, ry, rx, ry + rh, 1.5, highlight, highlight, highlight, 180);
    // Bottom & Right shadow
    this.drawLine(rx, ry + rh, rx + rw, ry + rh, 1.5, shadow, shadow, shadow, 180);
    this.drawLine(rx + rw, ry, rx + rw, ry + rh, 1.5, shadow, shadow, shadow, 180);
  }

  // Draw hazard stripes (yellow/black or grey/black)
  hazardStripes(rx: number, ry: number, rw: number, rh: number, stripeW = 6, c1 = [220, 180, 20], c2 = [25, 25, 25]): void {
    const minX = Math.max(0, Math.floor(rx));
    const maxX = Math.min(this.width - 1, Math.floor(rx + rw));
    const minY = Math.max(0, Math.floor(ry));
    const maxY = Math.min(this.height - 1, Math.floor(ry + rh));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const d = (x + y) % (stripeW * 2);
        const [r, g, b] = d < stripeW ? c1 : c2;
        this.blend(x, y, r!, g!, b!, 255);
      }
    }
  }
}

// --- High Definition Texture Synthesizers ------------------------------------

/**
 * 1. Terrain: Ground (Military Turf / Tactical Soil)
 * Seamless 128x128 with fine grass clumps, soil speckles, and muted tactical olive tones
 */
function renderTerrainGround(): PixelCanvas {
  const c = new PixelCanvas(CELL_SIZE, CELL_SIZE);
  const baseR = 63, baseG = 81, baseB = 51; // #3f5133

  for (let y = 0; y < CELL_SIZE; y++) {
    for (let x = 0; x < CELL_SIZE; x++) {
      const n1 = fbmSeamless(x, y, CELL_SIZE, 4, 101);
      const n2 = fbmSeamless(x * 2.5, y * 2.5, CELL_SIZE, 3, 202);
      const micro = hash2(x, y, 303);

      const tone = (n1 - 0.5) * 28 + (n2 - 0.5) * 16 + (micro - 0.5) * 10;
      const r = clamp(Math.round(baseR + tone * 0.9), 35, 105);
      const g = clamp(Math.round(baseG + tone * 1.1), 50, 130);
      const b = clamp(Math.round(baseB + tone * 0.7), 30, 85);

      c.set(x, y, r, g, b, 255);
    }
  }

  // Add subtle tactical dirt patches and grass blade highlights
  for (let i = 0; i < 40; i++) {
    const px = Math.floor(hash2(i, 1) * CELL_SIZE);
    const py = Math.floor(hash2(i, 2) * CELL_SIZE);
    const rad = 2 + hash2(i, 3) * 4;
    c.fillCircle(px, py, rad, 95, 115, 65, 45);
  }

  return c;
}

/**
 * 2. Terrain: Rough (Broken Arid Ground / Stony Scrubland)
 */
function renderTerrainRough(): PixelCanvas {
  const c = new PixelCanvas(CELL_SIZE, CELL_SIZE);
  const baseR = 89, baseG = 80, baseB = 47; // #59502f

  for (let y = 0; y < CELL_SIZE; y++) {
    for (let x = 0; x < CELL_SIZE; x++) {
      const n1 = fbmSeamless(x, y, CELL_SIZE, 5, 404);
      const crags = fbmSeamless(x * 4, y * 4, CELL_SIZE, 3, 505);
      const grain = hash2(x, y, 606);

      const tone = (n1 - 0.5) * 36 + (crags - 0.5) * 22 + (grain - 0.5) * 14;
      const r = clamp(Math.round(baseR + tone * 1.1), 50, 140);
      const g = clamp(Math.round(baseG + tone * 1.0), 45, 125);
      const b = clamp(Math.round(baseB + tone * 0.7), 25, 80);

      c.set(x, y, r, g, b, 255);
    }
  }

  // Loose stones and gravel
  for (let i = 0; i < 60; i++) {
    const sx = Math.floor(hash2(i, 11) * CELL_SIZE);
    const sy = Math.floor(hash2(i, 12) * CELL_SIZE);
    const sr = 1 + hash2(i, 13) * 2.2;
    c.fillCircle(sx + 1, sy + 1, sr, 30, 25, 15, 120); // shadow
    c.fillCircle(sx, sy, sr, 145, 135, 95, 190);       // stone highlight
  }

  return c;
}

/**
 * 3. Terrain: Water (Deep Tactical Caustic Water)
 */
function renderTerrainWater(): PixelCanvas {
  const c = new PixelCanvas(CELL_SIZE, CELL_SIZE);
  const baseR = 36, baseG = 80, baseB = 107; // #24506b

  for (let y = 0; y < CELL_SIZE; y++) {
    for (let x = 0; x < CELL_SIZE; x++) {
      const caust1 = Math.sin(fbmSeamless(x, y, CELL_SIZE, 3, 707) * Math.PI * 4);
      const caust2 = Math.cos(fbmSeamless(x * 1.5, y * 1.5, CELL_SIZE, 3, 808) * Math.PI * 3);
      const wave = (caust1 + caust2) * 0.5;

      const depth = fbmSeamless(x * 0.5, y * 0.5, CELL_SIZE, 2, 909);
      const r = clamp(Math.round(baseR + depth * 15 + wave * 22), 20, 80);
      const g = clamp(Math.round(baseG + depth * 25 + wave * 35), 45, 145);
      const b = clamp(Math.round(baseB + depth * 35 + wave * 45), 75, 185);

      c.set(x, y, r, g, b, 255);
    }
  }

  return c;
}

/**
 * 4. Terrain: Mountain (Chiseled Granite Rock & Scree)
 */
function renderTerrainMountain(): PixelCanvas {
  const c = new PixelCanvas(CELL_SIZE, CELL_SIZE);
  const baseR = 74, baseG = 70, baseB = 66; // #4a4642

  for (let y = 0; y < CELL_SIZE; y++) {
    for (let x = 0; x < CELL_SIZE; x++) {
      const rock1 = fbmSeamless(x, y, CELL_SIZE, 5, 1010);
      const ridge = Math.abs(fbmSeamless(x * 2, y * 2, CELL_SIZE, 4, 1111) - 0.5) * 2;
      const grain = hash2(x, y, 1212);

      const tone = (rock1 - 0.5) * 50 + (ridge - 0.5) * 35 + (grain - 0.5) * 16;
      const r = clamp(Math.round(baseR + tone), 40, 150);
      const g = clamp(Math.round(baseG + tone * 0.95), 38, 140);
      const b = clamp(Math.round(baseB + tone * 0.9), 35, 135);

      c.set(x, y, r, g, b, 255);
    }
  }

  // Cliff strata ridges
  for (let y = 0; y < CELL_SIZE; y += 14) {
    for (let x = 0; x < CELL_SIZE; x++) {
      const off = Math.sin((x / CELL_SIZE) * Math.PI * 6) * 3;
      const py = (Math.round(y + off) % CELL_SIZE + CELL_SIZE) % CELL_SIZE;
      c.blend(x, py, 170, 165, 155, 60); // light edge
      c.blend(x, (py + 1) % CELL_SIZE, 30, 28, 26, 90); // dark shadow
    }
  }

  return c;
}

/**
 * 5. Terrain: Trees (Dense Forest Canopy with Rounded Crowns)
 */
function renderTerrainTrees(): PixelCanvas {
  const c = new PixelCanvas(CELL_SIZE, CELL_SIZE);
  // Under-layer: deep shaded ground
  c.fill(25, 38, 20, 255);

  // Clusters of tree canopies
  const numTrees = 70;
  for (let i = 0; i < numTrees; i++) {
    const tx = Math.floor(hash2(i, 21) * CELL_SIZE);
    const ty = Math.floor(hash2(i, 22) * CELL_SIZE);
    const trad = 8 + hash2(i, 23) * 9;
    const toneVar = hash2(i, 24) * 30 - 15;

    // Drop shadow
    c.fillCircle(tx + 3, ty + 4, trad, 10, 15, 8, 140);

    // Tree crown base
    const cr = clamp(Math.round(40 + toneVar * 0.8), 25, 75);
    const cg = clamp(Math.round(62 + toneVar), 40, 110);
    const cb = clamp(Math.round(32 + toneVar * 0.6), 20, 60);
    c.fillCircle(tx, ty, trad, cr, cg, cb, 255);

    // Top-left sunlit foliage highlight
    c.fillCircle(tx - trad * 0.3, ty - trad * 0.3, trad * 0.65, cr + 35, cg + 45, cb + 25, 200);
    c.fillCircle(tx - trad * 0.4, ty - trad * 0.4, trad * 0.35, cr + 60, cg + 75, cb + 40, 170);
  }

  return c;
}

// --- High Definition Building Synthesizers ----------------------------------

/**
 * Building: Command Center (3x3 footprint)
 * Reinforced command bunker, satellite array, comms antenna, landing pad
 */
function renderCommandCenter(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Main reinforced outer hull
  c.fillRoundRect(cx - 52, cy - 52, 104, 104, 8, 60, 62, 65, 255);
  c.bevelRect(cx - 52, cy - 52, 104, 104, 140, 25);
  c.strokeRoundRect(cx - 52, cy - 52, 104, 104, 8, 2, 35, 36, 38, 255);

  // Roof plate
  c.fillRoundRect(cx - 42, cy - 42, 84, 84, 5, 110, 112, 115, 255);
  c.bevelRect(cx - 42, cy - 42, 84, 84, 190, 50);

  // Landing Helipad / Central Pad
  c.fillCircle(cx, cy, 26, 80, 82, 85, 255);
  c.strokeCircle(cx, cy, 24, 2.5, 230, 200, 40, 230); // Yellow circle
  // "H" marking
  c.fillRect(cx - 12, cy - 12, 4, 24, 230, 230, 230, 240);
  c.fillRect(cx + 8, cy - 12, 4, 24, 230, 230, 230, 240);
  c.fillRect(cx - 12, cy - 2, 24, 4, 230, 230, 230, 240);

  // Satellite dish (top-left)
  c.fillCircle(cx - 26, cy - 26, 11, 45, 48, 52, 255);
  c.fillCircle(cx - 27, cy - 27, 9, 180, 185, 190, 255);
  c.drawLine(cx - 27, cy - 27, cx - 23, cy - 23, 2, 230, 235, 240, 255);

  // Comms Antenna (top-right)
  c.fillCircle(cx + 26, cy - 26, 6, 50, 52, 55, 255);
  c.fillCircle(cx + 26, cy - 26, 3, 220, 60, 60, 255); // Red blinking beacon

  // HVAC / Generator vents (bottom)
  c.fillRect(cx - 34, cy + 24, 20, 12, 40, 42, 45, 255);
  c.hazardStripes(cx + 14, cy + 24, 20, 12, 4, [210, 180, 30], [30, 30, 30]);

  return c;
}

/**
 * Building: Power Plant (2x2 footprint)
 * High voltage reactor coils, cooling grilles, glowing energy conduit
 */
function renderPowerPlant(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Base structure
  c.fillRoundRect(cx - 46, cy - 46, 92, 92, 6, 65, 68, 72, 255);
  c.bevelRect(cx - 46, cy - 46, 92, 92, 150, 30);

  // Dual Generator Turbines
  c.fillCircle(cx - 20, cy - 12, 18, 45, 48, 52, 255);
  c.fillCircle(cx - 20, cy - 12, 14, 110, 115, 120, 255);
  c.strokeCircle(cx - 20, cy - 12, 10, 2, 60, 180, 240, 240); // Blue reactor glow

  c.fillCircle(cx + 20, cy - 12, 18, 45, 48, 52, 255);
  c.fillCircle(cx + 20, cy - 12, 14, 110, 115, 120, 255);
  c.strokeCircle(cx + 20, cy - 12, 10, 2, 60, 180, 240, 240);

  // Cooling grilles & heat dissipation fins
  c.fillRect(cx - 36, cy + 18, 72, 20, 40, 42, 45, 255);
  for (let x = cx - 32; x <= cx + 32; x += 6) {
    c.drawLine(x, cy + 20, x, cy + 36, 2, 200, 150, 60, 220); // Amber heat fins
  }

  return c;
}

/**
 * Building: Supply Center (3x3 footprint)
 * Loading bay with ramp, overhead crane gantry, container stacks
 */
function renderSupplyCenter(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Main warehouse
  c.fillRoundRect(cx - 50, cy - 50, 100, 100, 6, 75, 78, 82, 255);
  c.bevelRect(cx - 50, cy - 50, 100, 100, 160, 35);

  // Loading Dock Bay (front / bottom)
  c.fillRect(cx - 36, cy + 12, 72, 32, 40, 42, 45, 255);
  c.hazardStripes(cx - 36, cy + 38, 72, 6, 5, [220, 190, 30], [30, 30, 30]);

  // Overhead crane rail
  c.drawLine(cx - 40, cy - 10, cx + 40, cy - 10, 5, 180, 150, 30, 255); // Yellow crane rail
  c.fillCircle(cx, cy - 10, 7, 50, 52, 55, 255);

  // Stacked Cargo Crates on Roof
  const crates = [
    { x: cx - 38, y: cy - 40, w: 16, h: 14, col: [140, 110, 60] },
    { x: cx - 20, y: cy - 42, w: 14, h: 16, col: [120, 90, 50] },
    { x: cx + 18, y: cy - 38, w: 20, h: 16, col: [150, 120, 70] },
  ];
  for (const cr of crates) {
    c.fillRect(cr.x, cr.y, cr.w, cr.h, cr.col[0]!, cr.col[1]!, cr.col[2]!, 255);
    c.strokeRect(cr.x, cr.y, cr.w, cr.h, 1, 40, 30, 15, 255);
  }

  return c;
}

/**
 * Building: Barracks (2x2 footprint)
 * Tactical garrison bunker, blast entrance, radar dome
 */
function renderBarracks(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Bunker structure
  c.fillRoundRect(cx - 44, cy - 44, 88, 88, 6, 70, 74, 78, 255);
  c.bevelRect(cx - 44, cy - 44, 88, 88, 155, 35);

  // Reinforced rooftop garrison deck
  c.fillRoundRect(cx - 34, cy - 34, 68, 48, 4, 115, 118, 122, 255);
  c.bevelRect(cx - 34, cy - 34, 68, 48, 185, 55);

  // Parade/Entry ramp (bottom)
  c.fillRect(cx - 18, cy + 20, 36, 20, 45, 48, 50, 255);
  c.strokeRect(cx - 18, cy + 20, 36, 20, 2, 190, 160, 40, 255);

  // Radar dome
  c.fillCircle(cx - 18, cy - 14, 9, 210, 215, 220, 255);
  c.fillCircle(cx - 20, cy - 16, 4, 250, 250, 255, 255);

  // Faction emblem plate
  c.fillRect(cx + 10, cy - 20, 14, 14, 45, 50, 55, 255);
  c.strokeRect(cx + 10, cy - 20, 14, 14, 1.5, 200, 200, 200, 255);

  return c;
}

/**
 * Building: War Factory (3x3 footprint)
 * Heavy industrial assembly plant, gantry crane, blast bay doors
 */
function renderWarFactory(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Main factory hall
  c.fillRoundRect(cx - 52, cy - 52, 104, 104, 7, 68, 72, 75, 255);
  c.bevelRect(cx - 52, cy - 52, 104, 104, 150, 30);

  // Vehicle Rollout Bay (large lower section)
  c.fillRect(cx - 38, cy + 2, 76, 44, 38, 40, 42, 255);
  // Hydraulic door tracks
  c.drawLine(cx - 36, cy + 4, cx - 36, cy + 44, 3, 140, 145, 150, 255);
  c.drawLine(cx + 36, cy + 4, cx + 36, cy + 44, 3, 140, 145, 150, 255);
  // Warning stripes
  c.hazardStripes(cx - 36, cy + 40, 72, 5, 5, [230, 195, 30], [30, 30, 30]);

  // Dual Heavy Exhaust Smokestacks (top)
  c.fillCircle(cx - 30, cy - 34, 10, 45, 48, 50, 255);
  c.fillCircle(cx - 30, cy - 34, 7, 20, 22, 24, 255);

  c.fillCircle(cx + 30, cy - 34, 10, 45, 48, 50, 255);
  c.fillCircle(cx + 30, cy - 34, 7, 20, 22, 24, 255);

  // Heavy gantry crossbar
  c.fillRect(cx - 40, cy - 22, 80, 12, 110, 115, 118, 255);
  c.bevelRect(cx - 40, cy - 22, 80, 12, 180, 50);

  return c;
}

/**
 * Building: Gun Nest (1x1 footprint)
 * Rotary dual autocannon bunker
 */
function renderGunTurret(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Sandbag & concrete reinforced ring
  c.fillCircle(cx, cy, 32, 75, 78, 80, 255);
  c.strokeCircle(cx, cy, 30, 4, 120, 105, 70, 255); // Sandbags

  // Armored rotating turret dome
  c.fillCircle(cx, cy, 20, 115, 118, 122, 255);
  c.bevelRect(cx - 16, cy - 16, 32, 32, 185, 45);

  // Dual Machine Gun Barrels (pointing DOWN +Y)
  c.fillRect(cx - 6, cy + 10, 3.5, 24, 30, 32, 35, 255);
  c.fillRect(cx + 2.5, cy + 10, 3.5, 24, 30, 32, 35, 255);
  // Muzzle Flash Dampeners
  c.fillRect(cx - 7, cy + 30, 5.5, 5, 60, 62, 65, 255);
  c.fillRect(cx + 1.5, cy + 30, 5.5, 5, 60, 62, 65, 255);

  return c;
}

/**
 * Building: Cannon Tower (1x1 footprint)
 * 155mm Heavy Fortress Cannon
 */
function renderCannonTurret(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Concrete pedestal
  c.fillRoundRect(cx - 32, cy - 32, 64, 64, 8, 65, 68, 72, 255);
  c.bevelRect(cx - 32, cy - 32, 64, 64, 140, 25);

  // Armored Turret Mantlet
  c.fillCircle(cx, cy, 22, 120, 124, 128, 255);
  c.fillRoundRect(cx - 16, cy - 18, 32, 36, 5, 140, 144, 148, 255);
  c.bevelRect(cx - 16, cy - 18, 32, 36, 210, 55);

  // Heavy 155mm Cannon Barrel (pointing DOWN +Y)
  c.fillRect(cx - 5, cy + 12, 10, 36, 45, 48, 50, 255);
  c.bevelRect(cx - 5, cy + 12, 10, 36, 120, 25);
  // Heavy Double-Baffle Muzzle Brake
  c.fillRect(cx - 8, cy + 42, 16, 8, 60, 62, 65, 255);

  // Optical rangefinder sights
  c.fillCircle(cx - 10, cy - 8, 4, 40, 140, 220, 255); // Cyan lens

  return c;
}

/**
 * Building: AA Battery (1x1 footprint)
 * Quad-barrel flak battery & tracking radar dish
 */
function renderAATurret(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Base platform
  c.fillCircle(cx, cy, 32, 70, 74, 78, 255);
  c.bevelRect(cx - 28, cy - 28, 56, 56, 150, 30);

  // Central Turret
  c.fillCircle(cx, cy, 18, 120, 125, 130, 255);

  // Quad Flak Barrels (angled downward +Y)
  const barrelXs = [-9, -4, 2, 7];
  for (const bx of barrelXs) {
    c.fillRect(cx + bx, cy + 6, 2.5, 30, 35, 38, 40, 255);
    c.fillRect(cx + bx - 1, cy + 32, 4.5, 4, 70, 72, 75, 255); // Conical muzzle
  }

  // Active Phased-Array Radar Dish
  c.fillRect(cx - 12, cy - 18, 24, 7, 180, 185, 190, 255);
  c.drawLine(cx, cy - 18, cx, cy - 10, 2, 50, 52, 55, 255);

  return c;
}

// --- High Definition Unit Synthesizers --------------------------------------

/**
 * Unit: Dozer
 * Construction vehicle with front dozer blade, hydraulic rams, armored cab
 */
function renderDozer(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Left & Right Track Treads
  c.fillRoundRect(cx - 22, cy - 24, 10, 48, 3, 40, 42, 45, 255);
  c.fillRoundRect(cx + 12, cy - 24, 10, 48, 3, 40, 42, 45, 255);

  // Main Chassis (Yellow/Industrial Camo)
  c.fillRoundRect(cx - 15, cy - 20, 30, 36, 4, 190, 175, 50, 255);
  c.bevelRect(cx - 15, cy - 20, 30, 36, 240, 90);

  // Armored Driver Cab & Glass
  c.fillRoundRect(cx - 10, cy - 14, 20, 18, 3, 70, 72, 75, 255);
  c.fillRect(cx - 8, cy - 12, 16, 12, 100, 180, 220, 240); // Blue glass

  // Hydraulic Ram Arms
  c.drawLine(cx - 16, cy + 6, cx - 18, cy + 24, 3.5, 160, 165, 170, 255);
  c.drawLine(cx + 16, cy + 6, cx + 18, cy + 24, 3.5, 160, 165, 170, 255);

  // Heavy Front Dozer Blade (pointing DOWN +Y)
  c.fillRoundRect(cx - 26, cy + 22, 52, 10, 3, 80, 82, 85, 255);
  c.bevelRect(cx - 26, cy + 22, 52, 10, 180, 35);
  c.hazardStripes(cx - 24, cy + 24, 48, 6, 4, [220, 190, 30], [30, 30, 30]);

  return c;
}

/**
 * Unit: Harvester
 * Mining harvester with front rotary scoop, hopper, heavy armored chassis
 */
function renderHarvester(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Heavy 8-wheel / Track modules
  c.fillRoundRect(cx - 25, cy - 26, 11, 52, 4, 35, 38, 40, 255);
  c.fillRoundRect(cx + 14, cy - 26, 11, 52, 4, 35, 38, 40, 255);

  // Main Armored Hull
  c.fillRoundRect(cx - 18, cy - 24, 36, 46, 5, 130, 134, 138, 255);
  c.bevelRect(cx - 18, cy - 24, 36, 46, 200, 60);

  // Ore Storage Hopper (Back)
  c.fillRoundRect(cx - 14, cy - 20, 28, 24, 3, 55, 58, 62, 255);
  // Golden Ore nuggets visible in hopper
  c.fillCircle(cx - 6, cy - 10, 4, 230, 190, 40, 240);
  c.fillCircle(cx + 5, cy - 8, 5, 240, 205, 50, 240);
  c.fillCircle(cx - 1, cy - 14, 3.5, 220, 175, 35, 240);

  // Front Collection Scoop & Rotary Cutter Drum (pointing DOWN +Y)
  c.fillRoundRect(cx - 22, cy + 20, 44, 14, 3, 70, 72, 75, 255);
  c.bevelRect(cx - 22, cy + 20, 44, 14, 160, 30);
  // Cutter teeth
  for (let x = cx - 18; x <= cx + 18; x += 6) {
    c.drawLine(x, cy + 22, x, cy + 32, 2, 210, 215, 220, 255);
  }

  // Operator cab
  c.fillRect(cx - 10, cy + 6, 20, 10, 90, 170, 210, 240);

  return c;
}

/**
 * Unit: Rifle Infantry
 * Tactical infantry operative with helmet, plate vest, assault rifle
 */
function renderInfantry(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Drop shadow
  c.fillCircle(cx + 2, cy + 2, 16, 10, 12, 15, 100);

  // Tactical shoulders & body armor
  c.fillRoundRect(cx - 16, cy - 10, 32, 20, 6, 85, 90, 95, 255);
  c.bevelRect(cx - 16, cy - 10, 32, 20, 150, 40);

  // Combat Helmet (PASGT style)
  c.fillCircle(cx, cy - 2, 11, 130, 135, 140, 255);
  c.bevelRect(cx - 9, cy - 11, 18, 18, 195, 65);

  // Assault Rifle (pointing DOWN +Y)
  c.fillRect(cx + 6, cy - 4, 5, 28, 30, 32, 35, 255); // Receiver & barrel
  c.fillRect(cx + 7, cy + 18, 3, 10, 20, 22, 25, 255); // Extended barrel & flash hider
  c.fillRect(cx + 5, cy + 2, 7, 3, 50, 180, 220, 240); // Optical scope lens

  // Tactical backpack
  c.fillRoundRect(cx - 10, cy - 18, 20, 9, 3, 60, 65, 70, 255);

  return c;
}

/**
 * Unit: Rocket Infantry
 * Heavy weapons specialist with shoulder missile launcher
 */
function renderRocketInfantry(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Drop shadow
  c.fillCircle(cx + 2, cy + 2, 18, 10, 12, 15, 100);

  // Tactical armor & shoulders
  c.fillRoundRect(cx - 18, cy - 10, 36, 20, 6, 80, 85, 90, 255);

  // Combat Helmet
  c.fillCircle(cx - 2, cy - 2, 10, 125, 130, 135, 255);

  // Shoulder Missile Launcher Tube (pointing DOWN +Y)
  c.fillRoundRect(cx + 6, cy - 18, 9, 44, 2, 45, 48, 52, 255);
  c.bevelRect(cx + 6, cy - 18, 9, 44, 140, 25);
  // Muzzle opening with warhead tip
  c.fillCircle(cx + 10.5, cy + 26, 4, 210, 140, 40, 255); // Copper warhead
  // Targeting optics
  c.fillRect(cx + 2, cy - 2, 5, 8, 220, 50, 50, 240); // Red laser optic

  return c;
}

/**
 * Unit: Battle Tank
 * Main Battle Tank: composite armored hull, sloped turret, 120mm smoothbore cannon
 */
function renderTank(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Left & Right Caterpillar Track Treads
  c.fillRoundRect(cx - 24, cy - 26, 11, 52, 4, 38, 40, 42, 255);
  c.fillRoundRect(cx + 13, cy - 26, 11, 52, 4, 38, 40, 42, 255);
  // Track tread segments
  for (let y = cy - 22; y <= cy + 22; y += 6) {
    c.drawLine(cx - 24, y, cx - 13, y, 1.5, 65, 68, 70, 255);
    c.drawLine(cx + 13, y, cx + 24, y, 1.5, 65, 68, 70, 255);
  }

  // Sloped Composite Armored Chassis
  c.fillRoundRect(cx - 16, cy - 22, 32, 44, 4, 115, 118, 122, 255);
  c.bevelRect(cx - 16, cy - 22, 32, 44, 185, 50);

  // Rotating Turret
  c.fillRoundRect(cx - 13, cy - 12, 26, 26, 5, 140, 144, 148, 255);
  c.bevelRect(cx - 13, cy - 12, 26, 26, 220, 65);

  // Commander Hatch & Thermal Optic
  c.fillCircle(cx + 5, cy - 4, 4, 60, 62, 65, 255);
  c.fillRect(cx - 9, cy - 8, 5, 5, 40, 180, 230, 240); // Cyan optic

  // 120mm Smoothbore Cannon Barrel (pointing DOWN +Y)
  c.fillRect(cx - 3, cy + 12, 6, 32, 45, 48, 50, 255);
  c.bevelRect(cx - 3, cy + 12, 6, 32, 130, 25);
  // Fume Extractor / Barrel Shroud
  c.fillRect(cx - 4.5, cy + 26, 9, 8, 75, 78, 80, 255);
  // Muzzle Tip
  c.fillRect(cx - 4, cy + 42, 8, 4, 60, 62, 65, 255);

  return c;
}

/**
 * Unit: AA Vehicle
 * 8x8 Armored combat chassis with twin flak autocannons and radar
 */
function renderAAVehicle(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // 8 Heavy Wheels
  const wheelYs = [-20, -7, 6, 19];
  for (const wy of wheelYs) {
    c.fillRoundRect(cx - 24, cy + wy - 4, 7, 9, 2, 30, 32, 35, 255);
    c.fillRoundRect(cx + 17, cy + wy - 4, 7, 9, 2, 30, 32, 35, 255);
  }

  // Armored 8x8 Chassis
  c.fillRoundRect(cx - 18, cy - 24, 36, 48, 5, 110, 115, 118, 255);
  c.bevelRect(cx - 18, cy - 24, 36, 48, 180, 45);

  // AA Turret
  c.fillCircle(cx, cy, 14, 135, 140, 145, 255);

  // Twin Flak Autocannons (pointing DOWN +Y)
  c.fillRect(cx - 7, cy + 8, 3.5, 30, 40, 42, 45, 255);
  c.fillRect(cx + 3.5, cy + 8, 3.5, 30, 40, 42, 45, 255);
  // Conical Muzzle Flash Suppressors
  c.fillRect(cx - 8.5, cy + 34, 6.5, 5, 70, 72, 75, 255);
  c.fillRect(cx + 2, cy + 34, 6.5, 5, 70, 72, 75, 255);

  // Radar Dish (top)
  c.fillRect(cx - 10, cy - 16, 20, 5, 190, 195, 200, 255);

  return c;
}

/**
 * Unit: Artillery
 * Long-range self-propelled howitzer with super-long cannon
 */
function renderArtillery(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Track Treads
  c.fillRoundRect(cx - 22, cy - 24, 10, 48, 3, 38, 40, 42, 255);
  c.fillRoundRect(cx + 12, cy - 24, 10, 48, 3, 40, 42, 45, 255);

  // Heavy Chassis
  c.fillRoundRect(cx - 15, cy - 20, 30, 40, 4, 105, 110, 114, 255);
  c.bevelRect(cx - 15, cy - 20, 30, 40, 175, 45);

  // Rear Recoil Stabilizer Spades
  c.fillRoundRect(cx - 18, cy - 26, 8, 10, 2, 60, 62, 65, 255);
  c.fillRoundRect(cx + 10, cy - 26, 8, 10, 2, 60, 62, 65, 255);

  // Armored Howitzer Turret
  c.fillRoundRect(cx - 12, cy - 14, 24, 22, 4, 130, 135, 140, 255);

  // Super-Long Heavy Artillery Barrel (pointing DOWN +Y)
  c.fillRect(cx - 4, cy + 6, 8, 44, 45, 48, 50, 255);
  c.bevelRect(cx - 4, cy + 6, 8, 44, 135, 25);
  // Double-Baffle Heavy Muzzle Brake
  c.fillRect(cx - 7, cy + 48, 14, 7, 70, 72, 75, 255);

  return c;
}

/**
 * Unit: Attack Chopper
 * Twin-rotor stealth gunship, cockpit glass, weapon pylons, Hellfire missiles
 */
function renderChopper(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Fuselage (Stealth Angular Shape)
  c.fillRoundRect(cx - 10, cy - 28, 20, 48, 4, 115, 120, 125, 255);
  c.bevelRect(cx - 10, cy - 28, 20, 48, 190, 50);

  // Tail Boom (top / rear)
  c.fillRect(cx - 3, cy - 44, 6, 20, 85, 90, 95, 255);
  // Tail Rotor
  c.fillRect(cx + 3, cy - 46, 3, 16, 40, 42, 45, 255);

  // Cockpit Glass Canopy (pointing DOWN +Y)
  c.fillRoundRect(cx - 7, cy + 6, 14, 18, 4, 60, 170, 220, 240); // Glossy cyan glass
  c.bevelRect(cx - 7, cy + 6, 14, 18, 220, 80);

  // Stub Weapon Wings
  c.fillRect(cx - 24, cy - 4, 48, 8, 90, 95, 100, 255);

  // Rocket Pods & Hellfire Missiles on wingtips
  c.fillRoundRect(cx - 26, cy - 8, 7, 16, 2, 45, 48, 52, 255);
  c.fillRoundRect(cx + 19, cy - 8, 7, 16, 2, 45, 48, 52, 255);
  // Red missile caps
  c.fillCircle(cx - 22.5, cy + 8, 2.5, 220, 40, 40, 255);
  c.fillCircle(cx + 22.5, cy + 8, 2.5, 220, 40, 40, 255);

  // Chin-mounted 30mm rotary cannon
  c.fillRect(cx - 2, cy + 24, 4, 14, 30, 32, 35, 255);

  // Main Rotor Hub & Blade Blur
  c.fillCircle(cx, cy - 6, 6, 40, 42, 45, 255);
  // Translucent rotor disc blur
  c.strokeCircle(cx, cy - 6, 36, 4, 200, 205, 210, 70);

  return c;
}

// --- High Definition Overlays -----------------------------------------------

/**
 * Overlay: Supply Pile (Glowing gold crystal cluster)
 */
function renderOverlaySupply(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Ambient gold glow
  c.fillCircle(cx, cy, 38, 240, 190, 40, 50);

  // Crystal facets
  const crystals = [
    { x: cx, y: cy + 4, r: 18, col: [245, 205, 40] },
    { x: cx - 14, y: cy - 6, r: 14, col: [230, 185, 30] },
    { x: cx + 13, y: cy - 4, r: 15, col: [250, 215, 50] },
    { x: cx - 4, y: cy - 16, r: 12, col: [220, 175, 25] },
  ];

  for (const cr of crystals) {
    c.fillCircle(cr.x, cr.y, cr.r, cr.col[0]!, cr.col[1]!, cr.col[2]!, 255);
    c.strokeCircle(cr.x, cr.y, cr.r - 1, 1.5, 140, 100, 15, 255);
    // Specular shine
    c.fillCircle(cr.x - cr.r * 0.35, cr.y - cr.r * 0.35, cr.r * 0.35, 255, 255, 220, 240);
  }

  return c;
}

/**
 * Overlay: Selection Ring (Sci-Fi Military Tactical Reticle)
 */
function renderOverlaySelection(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  // Thin outer circle
  c.strokeCircle(cx, cy, 48, 2, 255, 255, 255, 220);

  // 4 Tactical corner brackets
  const r = 48;
  const tick = 12;
  // Top
  c.drawLine(cx, cy - r, cx, cy - r + tick, 3, 255, 255, 255, 255);
  // Bottom
  c.drawLine(cx, cy + r, cx, cy + r - tick, 3, 255, 255, 255, 255);
  // Left
  c.drawLine(cx - r, cy, cx - r + tick, cy, 3, 255, 255, 255, 255);
  // Right
  c.drawLine(cx + r, cy, cx + r - tick, cy, 3, 255, 255, 255, 255);

  return c;
}

/**
 * Overlay: Rally Point
 */
function renderOverlayRally(): PixelCanvas {
  const c = new PixelCanvas();
  const cx = 64, cy = 64;

  c.strokeCircle(cx, cy, 28, 3, 140, 230, 80, 255);
  c.strokeCircle(cx, cy, 16, 2, 140, 230, 80, 220);
  c.fillCircle(cx, cy, 5, 160, 255, 100, 255);

  return c;
}

// --- Atlas Assembly & PNG Encoder -------------------------------------------

function crc32(buf: Buffer): number {
  let table = (crc32 as unknown as { table: Uint32Array }).table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
    (crc32 as unknown as { table: Uint32Array }).table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = data.length;
  const buf = Buffer.alloc(8 + len + 4);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4, 4, "ascii");
  data.copy(buf, 8);
  const crcBuf = Buffer.alloc(4 + len);
  buf.copy(crcBuf, 0, 4, 8 + len);
  buf.writeUInt32BE(crc32(crcBuf), 8 + len);
  return buf;
}

function encodePNG(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // Filter None
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Main Build Script ------------------------------------------------------

interface SpriteDef {
  key: string;
  row: number;
  col: number;
  tiles: number;
  label: string;
  render: () => PixelCanvas;
}

const ATLAS_GRID: SpriteDef[] = [
  // Row 0: Terrains + Core Buildings
  { key: "terrain.ground", row: 0, col: 0, tiles: 1, label: "ground", render: renderTerrainGround },
  { key: "terrain.rough", row: 0, col: 1, tiles: 1, label: "rough", render: renderTerrainRough },
  { key: "terrain.water", row: 0, col: 2, tiles: 1, label: "water", render: renderTerrainWater },
  { key: "terrain.mountain", row: 0, col: 3, tiles: 1, label: "mountain", render: renderTerrainMountain },
  { key: "terrain.trees", row: 0, col: 4, tiles: 1, label: "trees", render: renderTerrainTrees },
  { key: "building.command_center", row: 0, col: 5, tiles: 3, label: "Command Center", render: renderCommandCenter },
  { key: "building.power_plant", row: 0, col: 6, tiles: 2, label: "Power Plant", render: renderPowerPlant },
  { key: "building.supply_center", row: 0, col: 7, tiles: 3, label: "Supply Center", render: renderSupplyCenter },

  // Row 1: Production Buildings & Turrets
  { key: "building.barracks", row: 1, col: 0, tiles: 2, label: "Barracks", render: renderBarracks },
  { key: "building.war_factory", row: 1, col: 1, tiles: 3, label: "War Factory", render: renderWarFactory },
  { key: "building.gun_turret", row: 1, col: 2, tiles: 1, label: "Gun Nest", render: renderGunTurret },
  { key: "building.cannon_turret", row: 1, col: 3, tiles: 1, label: "Cannon Tower", render: renderCannonTurret },
  { key: "building.aa_turret", row: 1, col: 4, tiles: 1, label: "AA Battery", render: renderAATurret },
  { key: "unit.dozer", row: 1, col: 5, tiles: 1, label: "Dozer", render: renderDozer },
  { key: "unit.harvester", row: 1, col: 6, tiles: 1, label: "Harvester", render: renderHarvester },
  { key: "unit.infantry", row: 1, col: 7, tiles: 1, label: "Rifle Infantry", render: renderInfantry },

  // Row 2: Combat Units & Overlays
  { key: "unit.rocket", row: 2, col: 0, tiles: 1, label: "Rocket Infantry", render: renderRocketInfantry },
  { key: "unit.tank", row: 2, col: 1, tiles: 1, label: "Battle Tank", render: renderTank },
  { key: "unit.aa_vehicle", row: 2, col: 2, tiles: 1, label: "AA Vehicle", render: renderAAVehicle },
  { key: "unit.artillery", row: 2, col: 3, tiles: 1, label: "Artillery", render: renderArtillery },
  { key: "unit.chopper", row: 2, col: 4, tiles: 1, label: "Attack Chopper", render: renderChopper },
  { key: "overlay.supply", row: 2, col: 5, tiles: 2, label: "Supply Pile", render: renderOverlaySupply },
  { key: "overlay.selection", row: 2, col: 6, tiles: 1, label: "Selection Ring", render: renderOverlaySelection },
  { key: "overlay.rally", row: 2, col: 7, tiles: 1, label: "Rally Point", render: renderOverlayRally },
];

export function buildTacticalHDAtlas(): void {
  console.log("Generating Tactical HD Sprite Atlas...");

  const atlasData = Buffer.alloc(ATLAS_W * ATLAS_H * 4, 0);
  const manifestSprites: Record<string, { x: number; y: number; w: number; h: number; tiles: number; label: string }> = {};

  for (const item of ATLAS_GRID) {
    const canvas = item.render();
    const cellX = item.col * CELL_SIZE;
    const cellY = item.row * CELL_SIZE;

    manifestSprites[item.key] = {
      x: cellX,
      y: cellY,
      w: CELL_SIZE,
      h: CELL_SIZE,
      tiles: item.tiles,
      label: item.label,
    };

    // Blit cell canvas into atlas
    for (let y = 0; y < CELL_SIZE; y++) {
      for (let x = 0; x < CELL_SIZE; x++) {
        const srcIdx = (y * CELL_SIZE + x) * 4;
        const dstIdx = ((cellY + y) * ATLAS_W + (cellX + x)) * 4;

        atlasData[dstIdx] = canvas.data[srcIdx]!;
        atlasData[dstIdx + 1] = canvas.data[srcIdx + 1]!;
        atlasData[dstIdx + 2] = canvas.data[srcIdx + 2]!;
        atlasData[dstIdx + 3] = canvas.data[srcIdx + 3]!;
      }
    }
  }

  const manifest = {
    cell: CELL_SIZE,
    sheet: "sprites.png",
    note: "Tactical HD Sprite Atlas with seamless textures and military hardware sprites.",
    sprites: manifestSprites,
  };

  const pngBuffer = encodePNG(ATLAS_W, ATLAS_H, atlasData);
  const jsonContent = JSON.stringify(manifest, null, 2);

  // Write to client/public
  const publicDir = path.join(ROOT, "client", "public");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "sprites.png"), pngBuffer);
  fs.writeFileSync(path.join(publicDir, "atlas.json"), jsonContent);

  // Write to dist if it exists
  const distDir = path.join(ROOT, "dist");
  if (fs.existsSync(distDir)) {
    fs.writeFileSync(path.join(distDir, "sprites.png"), pngBuffer);
    fs.writeFileSync(path.join(distDir, "atlas.json"), jsonContent);
  }

  console.log(`Successfully generated ${ATLAS_W}x${ATLAS_H} Tactical HD atlas! (${pngBuffer.length} bytes)`);
}

// Execute when run directly
buildTacticalHDAtlas();

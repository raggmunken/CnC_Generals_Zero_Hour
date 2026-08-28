/**
 * Parametric sprite generation.
 *
 * Hand-placing bezier points blind is what makes authored SVG look wrong:
 * proportions drift and nothing is symmetrical. So nothing here is
 * hand-placed. Every sprite is composed from primitives by a function whose
 * maths guarantees symmetry, and the subjects are deliberately machine-like --
 * tanks and buildings genuinely are boxes and cylinders, which is exactly what
 * this approach is good at and organic shapes are not.
 *
 * Light is fixed top-left throughout so highlights and shadows agree.
 */

export interface Palette {
  body: string;
  bodyLit: string;
  bodyDark: string;
  metal: string;
  metalDark: string;
  glass: string;
  outline: string;
}

/** Faction tints. Only `body` changes; the greys stay shared so the set coheres. */
export const FACTIONS: Record<string, Palette> = {
  red: { body: "#c2483d", bodyLit: "#e0705f", bodyDark: "#8d2f28", metal: "#6f7378", metalDark: "#3f4347", glass: "#9fd4e8", outline: "#1c1a19" },
  blue: { body: "#3f77c0", bodyLit: "#6098db", bodyDark: "#2a5288", metal: "#6f7378", metalDark: "#3f4347", glass: "#9fd4e8", outline: "#1c1a19" },
};

const S = 64; // authoring canvas; sprites are drawn to fill it and scaled down

function svg(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">${inner}</svg>`;
}

/** Rounded rect centred on (cx,cy). Symmetry comes from the maths, not from me. */
function rect(cx: number, cy: number, w: number, h: number, r: number, fill: string, extra = ""): string {
  return `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${extra}/>`;
}

function circle(cx: number, cy: number, r: number, fill: string, extra = ""): string {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${extra}/>`;
}

/**
 * Top-down battle tank: two tread bands, a chamfered hull, a turret and a
 * barrel. Barrel points +Y (down) so the renderer can rotate by heading.
 */
export function tank(p: Palette): string {
  const cx = S / 2;
  const cy = S / 2;
  const hullW = 26;
  const hullL = 34;
  const treadW = 9;
  const treadL = 46; // deliberately longer than the hull: the overhang is the
                     // silhouette cue that says "tracked vehicle" at 24px.
  return svg(`
    <g stroke="${p.outline}" stroke-width="2" stroke-linejoin="round">
      ${rect(cx - hullW / 2 - treadW / 2, cy, treadW, treadL, 3, p.metalDark)}
      ${rect(cx + hullW / 2 + treadW / 2, cy, treadW, treadL, 3, p.metalDark)}
      ${rect(cx, cy, hullW, hullL, 3, p.body)}
      ${circle(cx, cy + 1, 11, p.bodyDark)}
      ${circle(cx, cy + 1, 8, p.bodyLit)}
      ${rect(cx, cy + 19, 7, 24, 2, p.metalDark)}
    </g>`);
}

/** Top-down infantry: helmet dome and shoulders. Small and silhouette-led. */
export function infantry(p: Palette): string {
  const cx = S / 2;
  const cy = S / 2;
  // Not an attempt at a human figure -- that is what made the first pass look
  // like a snail. A wedge pointing along +Y is unmistakable at any size and
  // shows facing for free.
  return svg(`
    <g stroke="${p.outline}" stroke-width="2" stroke-linejoin="round">
      <path d="M ${cx} ${cy + 20} L ${cx - 15} ${cy - 14} L ${cx} ${cy - 6} L ${cx + 15} ${cy - 14} Z"
            fill="${p.body}"/>
      <path d="M ${cx} ${cy + 20} L ${cx - 15} ${cy - 14} L ${cx} ${cy - 6} Z" fill="${p.bodyLit}"/>
      ${circle(cx, cy + 4, 5, p.bodyDark)}
    </g>`);
}

/** Harvester: a bigger, blunter hull with a collection bucket at the front. */
export function harvester(p: Palette): string {
  const cx = S / 2;
  const cy = S / 2;
  return svg(`
    <g stroke="${p.outline}" stroke-width="2" stroke-linejoin="round">
      ${rect(cx - 19, cy, 9, 42, 3, p.metalDark)}
      ${rect(cx + 19, cy, 9, 42, 3, p.metalDark)}
      ${rect(cx, cy - 2, 28, 38, 4, p.body)}
      ${rect(cx, cy - 12, 24, 10, 2, p.glass)}
      ${rect(cx, cy + 20, 34, 10, 3, p.metal)}
    </g>`);
}

/** Command building: footprint, roof plate, and a lit core so it reads as "yours". */
export function building(p: Palette): string {
  const cx = S / 2;
  const cy = S / 2;
  return svg(`
    <g stroke="${p.outline}" stroke-width="1.5" stroke-linejoin="round">
      ${rect(cx, cy, 52, 52, 4, p.metalDark)}
      ${rect(cx, cy, 44, 44, 3, p.metal)}
      ${rect(cx, cy - 2, 30, 30, 2, p.body)}
      ${rect(cx, cy - 2, 18, 18, 2, p.bodyLit)}
      ${circle(cx, cy + 20, 4, p.glass)}
    </g>`);
}

export const SPRITES = { tank, infantry, harvester, building };

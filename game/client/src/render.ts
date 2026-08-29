/**
 * Pixi renderer.
 *
 * Terrain is drawn once into a single Graphics object; only units and the
 * selection overlay are touched per frame. Redrawing 4096 tiles every frame is
 * the obvious way to make a 2D RTS stutter for no reason.
 */
import { Application, Assets, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import { Terrain } from "../../shared/types.js";

/** Screen pixels per world unit at zoom 1. */
export const BASE_TILE_PX = 24;

/** The transient effects the renderer knows how to draw. */
export type EffectKind = "ping" | "attack" | "explosion" | "bigExplosion" | "dust" | "debris";

/** Terrain enum -> atlas key. */
const TERRAIN_SPRITE: Record<number, string> = {
  [Terrain.Ground]: "terrain.ground",
  [Terrain.Rough]: "terrain.rough",
  [Terrain.Water]: "terrain.water",
  [Terrain.Mountain]: "terrain.mountain",
  [Terrain.Trees]: "terrain.trees",
};

const TERRAIN_COLOR: Record<number, number> = {
  [Terrain.Ground]: 0x3f5133,
  [Terrain.Rough]: 0x59502f,
  [Terrain.Water]: 0x24506b,
  [Terrain.Mountain]: 0x4a4642,
  [Terrain.Trees]: 0x2b3d22,
};

/** Player colours: red team, blue team, then spares. */
// Multiplied over the neutral art, so these have to stay light: a saturated
// mid-tone here crushes every panel line on a vehicle into one flat mass.
export const PLAYER_COLOR = [0xd63838, 0x4a8fd6, 0x86cf9a, 0xe3cd83];

export class Renderer {
  readonly app = new Application();
  readonly world = new Container();

  private terrainLayer = new Graphics();
  /** Terrain baked into one texture; see buildTerrain. */
  private terrainSprite = new Sprite();
  /** Soft shadows, drawn under everything mobile or built. */
  private shadowLayer = new Graphics();
  private supplyLayer = new Graphics();
  private buildingLayer = new Graphics();
  private rangeLayer = new Graphics();
  private unitLayer = new Graphics();
  private fxLayer = new Graphics();
  /**
   * Fog is a low-res bitmap (one pixel per tile) upscaled with bilinear
   * filtering, so the edge of vision feathers instead of stepping tile by
   * tile. Rect-drawn fog on a 96x96 map was both chunkier and slower.
   */
  private fogCanvas: HTMLCanvasElement | null = null;
  private fogSprite = new Sprite();

  /** Sub-textures cut from the sheet, keyed as in atlas.json. */
  private atlas = new Map<string, Texture>();
  /**
   * Live sprites keyed by entity id.
   *
   * Pooled rather than recreated: churning display objects every frame is the
   * standard way to make a 2D renderer stutter, and entity ids give a stable
   * key to reuse against.
   */
  private unitSprites = new Map<number, Sprite>();
  private buildingSprites = new Map<number, Sprite>();
  private unitContainer = new Container();
  private buildingContainer = new Container();
  private supplySprites = new Map<number, Sprite>();
  private supplyContainer = new Container();
  private selectSprites = new Map<number, Sprite>();
  private selectContainer = new Container();
  /** The sheet as a bitmap, for compositing terrain outside of Pixi. */
  private sheet: ImageBitmap | null = null;
  private cells: Record<string, { x: number; y: number; w: number; h: number }> = {};
  /** Last seen position and facing per unit, so sprites turn as they drive. */
  private facing = new Map<number, { x: number; y: number; a: number }>();
  private overlay = new Graphics();

  /**
   * Short-lived visual effects: order pings, muzzle flashes, explosions.
   *
   * Purely client-side and derived from snapshot diffs rather than sent by the
   * server -- a unit that vanishes from a visible tile blew up, and no wire
   * field can say that better than the disappearance already does.
   */
  private effects: Array<{ kind: EffectKind; x: number; y: number; born: number; size: number }> = [];

  camX = 0;
  camY = 0;
  zoom = 1;

  async init(): Promise<void> {
    await this.app.init({
      resizeTo: window,
      background: 0x11150f,
      antialias: true,
    });
    document.body.appendChild(this.app.canvas);

    // Buildings sit under units so infantry standing on a base stay visible.
    this.world.addChild(
      this.terrainLayer,
      this.terrainSprite,
      this.shadowLayer,
      this.supplyLayer,
      this.supplyContainer,
      this.buildingLayer,
      this.buildingContainer,
      this.rangeLayer,
      this.selectContainer,
      this.unitLayer,
      this.unitContainer,
      this.fxLayer,
      this.fogSprite,
    );
    this.app.stage.addChild(this.world, this.overlay);
  }

  /**
   * Load the sprite sheet, if there is one.
   *
   * Optional on purpose: the game stays playable with the primitive shapes if
   * the art is missing or being redrawn, rather than failing to start.
   */
  async loadAtlas(): Promise<boolean> {
    try {
      const manifest = await (await fetch("/atlas.json")).json();
      const sheet: Texture = await Assets.load(`/${manifest.sheet}`);
      this.cells = manifest.sprites;
      // A second, plain copy of the sheet: terrain is composited on a 2D canvas
      // rather than as thousands of sprites, and that needs a drawable image.
      try {
        this.sheet = await createImageBitmap(await (await fetch(`/${manifest.sheet}`)).blob());
      } catch {
        this.sheet = null;
      }
      for (const [key, cell] of Object.entries(manifest.sprites as Record<string, {
        x: number; y: number; w: number; h: number;
      }>)) {
        this.atlas.set(key, new Texture({
          source: sheet.source,
          frame: new Rectangle(cell.x, cell.y, cell.w, cell.h),
        }));
      }
      return this.atlas.size > 0;
    } catch {
      return false;
    }
  }

  get hasAtlas(): boolean {
    return this.atlas.size > 0;
  }

  get tilePx(): number {
    return BASE_TILE_PX * this.zoom;
  }

  /**
   * Draw the map once. Called on welcome, and on any map change.
   *
   * The flat-colour pass always runs: it is the fallback when there is no
   * sheet, and it under-paints the tiles so a texture that fails to decode
   * still leaves a legible map. With a sheet, every tile is composited into one
   * texture on an offscreen canvas -- a sprite per tile would be tens of
   * thousands of display objects on a large map, for an image that never
   * changes after the match starts.
   */
  buildTerrain(width: number, height: number, tiles: number[]): void {
    const g = this.terrainLayer;
    g.clear();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const t = tiles[y * width + x] ?? Terrain.Ground;
        g.rect(x, y, 1, 1).fill(TERRAIN_COLOR[t] ?? 0x000000);
      }
    }

    const old = this.terrainSprite.texture;
    this.terrainSprite.visible = false;
    if (!this.sheet) return;

    // High Definition 48px resolution per tile for crystal clear terrain
    const TP = 48;
    const canvas = document.createElement("canvas");
    canvas.width = width * TP;
    canvas.height = height * TP;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = this.cells[TERRAIN_SPRITE[tiles[y * width + x] ?? Terrain.Ground] ?? ""];
        if (!cell) continue;
        ctx.drawImage(this.sheet, cell.x, cell.y, cell.w, cell.h, x * TP, y * TP, TP, TP);
      }
    }

    this.blendTerrain(ctx, width, height, tiles, TP);

    this.terrainSprite.texture = Texture.from(canvas);
    this.terrainSprite.scale.set(1 / TP);
    this.terrainSprite.visible = true;
    if (old && old !== Texture.EMPTY) old.destroy(true);
  }

  /**
   * Advanced multi-pass organic terrain blending:
   * 1. Micro-contrast variation across terrain plains
   * 2. Directional elevation drop shadows from mountains and trees
   * 3. Organic wavy biome seam blending using noise modulation
   * 4. Realistic shoreline beach fringes and coastal water foam
   */
  private blendTerrain(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    tiles: number[],
    TP: number,
  ): void {
    const at = (x: number, y: number): number =>
      x < 0 || y < 0 || x >= width || y >= height ? -1 : (tiles[y * width + x] ?? Terrain.Ground);
    const css = (c: number, a: number): string =>
      `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;

    // 1. Organic micro-contrast variation
    const SUB = 4;
    const step = TP / SUB;
    for (let y = 0; y < height * SUB; y++) {
      for (let x = 0; x < width * SUB; x++) {
        let h = (x * 73856093) ^ (y * 19349663);
        h = (h ^ (h >> 13)) * 0x5bd1e995;
        const v = (((h >>> 0) % 100) / 100) * 2 - 1; // [-1, 1)
        ctx.fillStyle = v < 0 ? `rgba(0,0,0,${-v * 0.035})` : `rgba(255,255,255,${v * 0.025})`;
        ctx.fillRect(x * step, y * step, step, step);
      }
    }

    // 2. Directional Elevation Shadows: Mountains and Trees cast soft shadows onto adjacent lower ground
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const here = at(x, y);
        const isElevated = here === Terrain.Mountain || here === Terrain.Trees;
        if (!isElevated) continue;

        // Shadow cast towards south and east (light from top-left)
        const east = at(x + 1, y);
        if (east >= 0 && east !== Terrain.Mountain && east !== Terrain.Trees) {
          const shadowGrad = ctx.createLinearGradient((x + 1) * TP, 0, (x + 1) * TP + TP * 0.35, 0);
          shadowGrad.addColorStop(0, "rgba(0,0,0,0.45)");
          shadowGrad.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = shadowGrad;
          ctx.fillRect((x + 1) * TP, y * TP, TP * 0.35, TP);
        }
        const south = at(x, y + 1);
        if (south >= 0 && south !== Terrain.Mountain && south !== Terrain.Trees) {
          const shadowGrad = ctx.createLinearGradient(0, (y + 1) * TP, 0, (y + 1) * TP + TP * 0.35);
          shadowGrad.addColorStop(0, "rgba(0,0,0,0.45)");
          shadowGrad.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = shadowGrad;
          ctx.fillRect(x * TP, (y + 1) * TP, TP, TP * 0.35);
        }
      }
    }

    // 3. Organic Biome Edge Blending & Shoreline System
    const DIRS: Array<[number, number]> = [
      [1, 0], [0, 1],
    ];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const here = at(x, y);
        for (const [dx, dy] of DIRS) {
          const there = at(x + dx, y + dy);
          if (there < 0 || there === here) continue;

          const horizontal = dx === 1;
          const sx = horizontal ? (x + 1) * TP : x * TP;
          const sy = horizontal ? y * TP : (y + 1) * TP;

          const waterEdge = here === Terrain.Water || there === Terrain.Water;
          const band = waterEdge ? TP * 0.45 : TP * 0.35;

          for (const [, to, flip] of [[here, there, 0], [there, here, 1]] as const) {
            const g = horizontal
              ? ctx.createLinearGradient(sx + (flip ? band : -band), 0, sx, 0)
              : ctx.createLinearGradient(0, sy + (flip ? band : -band), 0, sy);

            const color = TERRAIN_COLOR[to] ?? 0;
            const strength = waterEdge ? 0.5 : 0.35;
            g.addColorStop(0, css(color, 0));
            g.addColorStop(0.7, css(color, strength * 0.6));
            g.addColorStop(1, css(color, strength));
            ctx.fillStyle = g;
            if (horizontal) {
              ctx.fillRect(flip ? sx : sx - band, sy, band, TP);
            } else {
              ctx.fillRect(sx, flip ? sy : sy - band, TP, band);
            }
          }

          if (waterEdge) {
            // Golden sand beach band on land side
            const landFlip = here === Terrain.Water ? 1 : 0;
            const sand = TP * 0.26;
            const sg = horizontal
              ? ctx.createLinearGradient(sx + (landFlip ? sand : -sand), 0, sx, 0)
              : ctx.createLinearGradient(0, sy + (landFlip ? sand : -sand), 0, sy);
            sg.addColorStop(0, "rgba(195,175,120,0)");
            sg.addColorStop(0.6, "rgba(195,175,120,0.35)");
            sg.addColorStop(1, "rgba(215,195,135,0.65)");
            ctx.fillStyle = sg;
            if (horizontal) ctx.fillRect(landFlip ? sx : sx - sand, sy, sand, TP);
            else ctx.fillRect(sx, landFlip ? sy : sy - sand, TP, sand);

            // Shallow turquoise water tint on water side
            const waterFlip = here === Terrain.Water ? 0 : 1;
            const sh = TP * 0.35;
            const wg = horizontal
              ? ctx.createLinearGradient(sx + (waterFlip ? sh : -sh), 0, sx, 0)
              : ctx.createLinearGradient(0, sy + (waterFlip ? sh : -sh), 0, sy);
            wg.addColorStop(0, "rgba(100,200,210,0)");
            wg.addColorStop(0.5, "rgba(100,200,210,0.25)");
            wg.addColorStop(1, "rgba(140,225,235,0.5)");
            ctx.fillStyle = wg;
            if (horizontal) ctx.fillRect(waterFlip ? sx : sx - sh, sy, sh, TP);
            else ctx.fillRect(sx, waterFlip ? sy : sy - sh, TP, sh);

            // Crisp foam wave contour line at the water-land boundary
            ctx.fillStyle = "rgba(240,250,255,0.4)";
            if (horizontal) {
              const fx = sx + (waterFlip ? -1 : 0);
              ctx.fillRect(fx, sy, 2, TP);
            } else {
              const fy = sy + (waterFlip ? -1 : 0);
              ctx.fillRect(sx, fy, TP, 2);
            }
          }
        }
      }
    }
  }

  /** World coordinates -> screen pixels. */
  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.camX) * this.tilePx, y: (wy - this.camY) * this.tilePx };
  }

  /** Screen pixels -> world coordinates. */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: sx / this.tilePx + this.camX, y: sy / this.tilePx + this.camY };
  }

  /** Apply camera to the world container. Terrain is in world units, so scale it. */
  applyCamera(): void {
    this.world.scale.set(this.tilePx);
    this.world.position.set(-this.camX * this.tilePx, -this.camY * this.tilePx);
  }

  /**
   * Supply piles. Radius tracks how much is left, so a worked-out pile visibly
   * shrinks and the map reads its own economy without a UI overlay.
   */
  drawSupply(nodes: Array<{ id: number; x: number; y: number; amount: number; max: number }>): void {
    const g = this.supplyLayer;
    g.clear();
    // First draw call of every frame, so it owns clearing the shadow pass.
    this.shadowLayer.clear();
    const tex = this.atlas.get("overlay.supply");
    const live = new Set<number>();
    for (const n of nodes) {
      if (n.amount <= 0) continue;
      const frac = Math.max(0.18, Math.min(1, n.amount / n.max));
      const r = 1.5 * frac + 0.4;
      if (tex) {
        live.add(n.id);
        const sp = this.sprite(this.supplySprites, this.supplyContainer, n.id, tex);
        sp.position.set(n.x, n.y);
        sp.rotation = 0;
        sp.scale.set((r * 2.3) / tex.frame.width);
      } else {
        g.circle(n.x, n.y, r).fill(0xc9a227);
        g.circle(n.x, n.y, r).stroke({ color: 0x7d6416, width: 0.08 });
      }
    }
    this.reap(this.supplySprites, live);
  }

  drawBuildings(
    buildings: Array<{
      owner: number;
      x: number;
      y: number;
      id: number;
      type: string;
      size: number;
      progress: number;
      selected: boolean;
      hpFrac: number;
    }>,
  ): void {
    const g = this.buildingLayer;
    g.clear();
    const live = new Set(buildings.map((b) => b.id));
    this.reap(this.buildingSprites, live);
    for (const b of buildings) {
      const color = PLAYER_COLOR[b.owner % PLAYER_COLOR.length]!;

      // Anchoring shadow: without one the sprite floats over the terrain.
      this.shadowLayer.ellipse(
        b.x + b.size / 2 + 0.22, b.y + b.size - 0.05, b.size * 0.55, b.size * 0.16,
      ).fill({ color: 0x000000, alpha: 0.3 });

      const tex = this.atlas.get(`building.${b.type}`);
      const sp = tex
        ? this.sprite(this.buildingSprites, this.buildingContainer, b.id, tex)
        : null;

      if (b.progress < 1) {
        if (sp) sp.visible = false;
        // Under construction: outline the footprint and fill from the bottom
        // up, so progress is readable without a separate progress bar.
        g.rect(b.x, b.y, b.size, b.size).fill({ color, alpha: 0.18 });
        const h = b.size * b.progress;
        g.rect(b.x, b.y + b.size - h, b.size, h).fill({ color, alpha: 0.55 });
        g.rect(b.x, b.y, b.size, b.size).stroke({ color, width: 0.08, alpha: 0.9 });
      } else if (sp) {
        sp.visible = true;
        sp.position.set(b.x + b.size / 2, b.y + b.size / 2);
        sp.tint = color;
        sp.width = b.size;
        sp.height = b.size;
      } else {
        g.rect(b.x + 0.1, b.y + 0.1, b.size - 0.2, b.size - 0.2).fill(0x2a2724);
        g.rect(b.x + 0.25, b.y + 0.25, b.size - 0.5, b.size - 0.5).fill(color);
      }

      if (b.selected) {
        g.rect(b.x - 0.1, b.y - 0.1, b.size + 0.2, b.size + 0.2).stroke({ color: 0xffffff, width: 0.09 });
      }

      this.healthBar(g, b.x + b.size / 2, b.y - 0.35, b.size * 0.8, b.hpFrac);
    }
  }

  /**
   * Weapon reach of everything selected.
   *
   * Under the units rather than over them, so a big selection does not bury
   * the army it describes. Alpha falls off with the number of rings: forty
   * overlapping circles at readable strength is a white disc, and the useful
   * reading from a large selection is the shape of its coverage, not any one
   * unit's ring.
   */
  drawRanges(rings: Array<{ x: number; y: number; r: number; strong: boolean }>): void {
    const g = this.rangeLayer;
    g.clear();
    if (rings.length === 0) return;
    const alpha = Math.max(0.09, Math.min(0.5, 0.75 / Math.sqrt(rings.length)));
    for (const c of rings) {
      g.circle(c.x, c.y, c.r).stroke({
        color: c.strong ? 0xffd27a : 0xf0e3b8,
        width: (c.strong ? 0.1 : 0.06) / this.zoom,
        alpha: c.strong ? Math.max(alpha, 0.55) : alpha,
      });
    }
  }

  /** Ghost footprint that follows the cursor while placing a building. */
  drawPlacementGhost(ghost: { x: number; y: number; size: number; ok: boolean } | null): void {
    if (!ghost) return;
    const g = this.buildingLayer;
    const color = ghost.ok ? 0x8ce07a : 0xe07a7a;
    g.rect(ghost.x, ghost.y, ghost.size, ghost.size).fill({ color, alpha: 0.3 });
    g.rect(ghost.x, ghost.y, ghost.size, ghost.size).stroke({ color, width: 0.1 });
  }

  /** Reuse or create a pooled sprite for an entity. */
  private sprite(
    pool: Map<number, Sprite>,
    parent: Container,
    id: number,
    texture: Texture,
  ): Sprite {
    let sp = pool.get(id);
    if (!sp) {
      sp = new Sprite(texture);
      sp.anchor.set(0.5);
      parent.addChild(sp);
      pool.set(id, sp);
    } else if (sp.texture !== texture) {
      sp.texture = texture;
    }
    return sp;
  }

  /** Drop sprites for entities that no longer exist. */
  private reap(pool: Map<number, Sprite>, live: Set<number>): void {
    for (const [id, sp] of pool) {
      if (live.has(id)) continue;
      sp.destroy();
      pool.delete(id);
    }
  }

  drawUnits(
    units: Array<{
      id: number; owner: number; type: string;
      x: number; y: number; radius: number; hpFrac: number; air?: boolean;
    }>,
    selected: ReadonlySet<number>,
  ): void {
    const g = this.unitLayer;
    g.clear();

    const live = new Set<number>();
    const picked = new Set<number>();
    const ring = this.atlas.get("overlay.selection");
    for (const u of units) {
      live.add(u.id);
      const color = PLAYER_COLOR[u.owner % PLAYER_COLOR.length]!;

      // Aircraft hover above their tile: the shadow and the selection ring
      // stay on the ground (they mark the tile), the body rides above them.
      const airLift = u.air ? 0.6 : 0;

      // A unit without a shadow reads as floating; offset down-right so the
      // light appears to come from up-left, matching the art's shading. An
      // aircraft's shadow is smaller and fainter: it is farther away.
      this.shadowLayer.ellipse(u.x + 0.14, u.y + u.radius * 0.55, u.radius * (u.air ? 0.7 : 0.95), u.radius * 0.42)
        .fill({ color: 0x000000, alpha: u.air ? 0.16 : 0.26 });

      if (selected.has(u.id) && ring) {
        // The drawn ring, not a filled disc: at this sprite size a disc large
        // enough to be seen is large enough to hide the unit standing on it.
        picked.add(u.id);
        const sp = this.sprite(this.selectSprites, this.selectContainer, u.id, ring);
        sp.position.set(u.x, u.y);
        sp.rotation = 0;
        sp.scale.set(Math.max(1.15, u.radius * 3.6) / ring.frame.width);
        sp.tint = 0xdff5d0;
      } else if (selected.has(u.id)) {
        g.circle(u.x, u.y, u.radius * 1.45).fill(0xffffff);
      }

      const tex = this.atlas.get(`unit.${u.type}`);
      if (tex) {
        const sp = this.sprite(this.unitSprites, this.unitContainer, u.id, tex);
        sp.position.set(u.x, u.y - airLift);
        // Sprites are drawn neutral grey, so tinting gives every faction from
        // one sheet rather than one sheet per player colour.
        sp.tint = color;
        // Drawn larger than the collision radius on purpose: a sprite sized
        // exactly to its footprint is unreadably small for infantry at normal
        // zoom, and readability matters more than physical honesty here.
        const draw = Math.max(0.95, u.radius * 3.2);
        sp.scale.set(draw / tex.frame.width);
        sp.rotation = this.headingOf(u.id, u.x, u.y);
      } else {
        g.circle(u.x, u.y - airLift, u.radius).fill(color);
      }

      this.healthBar(g, u.x, u.y - airLift - u.radius - 0.3, u.radius * 2.2, u.hpFrac);
    }
    this.reap(this.unitSprites, live);
    this.reap(this.selectSprites, picked);
    for (const id of [...this.facing.keys()]) if (!live.has(id)) this.facing.delete(id);
  }

  /**
   * Which way a unit is pointing, from where it has been.
   *
   * The server sends no heading, and it does not need to: the art all faces
   * down, so the client can turn each sprite along its own motion. The
   * threshold keeps a stationary unit from spinning on interpolation jitter,
   * and the angle is kept when it stops so units do not snap back north.
   */
  private headingOf(id: number, x: number, y: number): number {
    const prev = this.facing.get(id);
    if (!prev) {
      this.facing.set(id, { x, y, a: 0 });
      return 0;
    }
    const dx = x - prev.x;
    const dy = y - prev.y;
    if (dx * dx + dy * dy > 4e-4) {
      prev.a = Math.atan2(dy, dx) - Math.PI / 2;
      // Spawn subtle movement dust for ground units
      if (Math.random() < 0.25) {
        this.spawnEffect("dust", prev.x + (Math.random() - 0.5) * 0.3, prev.y + (Math.random() - 0.5) * 0.3, 0.4);
      }
      prev.x = x;
      prev.y = y;
    }
    return prev.a;
  }

  /**
   * Muzzle-to-target lines for shots fired recently.
   *
   * The sim reports a shot for exactly one 15Hz tick, which is 66ms -- too
   * brief to register. The caller keeps them alive a little longer and passes
   * an alpha so they fade out instead of blinking.
   */
  drawTracers(tracers: Array<{ x0: number; y0: number; x1: number; y1: number; alpha: number }>): void {
    const g = this.fxLayer;
    g.clear();
    for (const t of tracers) {
      g.moveTo(t.x0, t.y0).lineTo(t.x1, t.y1)
        .stroke({ color: 0xffe9a3, width: 0.07, alpha: t.alpha });
      // Muzzle flash at the origin, impact spark where it lands: the line
      // alone reads as a ruler, not a shot.
      g.circle(t.x0, t.y0, 0.2).fill({ color: 0xfff3c4, alpha: t.alpha * 0.9 });
      g.circle(t.x1, t.y1, 0.14).fill({ color: 0xffb35c, alpha: t.alpha });
    }
    this.drawEffects(performance.now());
  }

  /** A health bar above anything damaged. Full-health things stay uncluttered. */
  private healthBar(g: Graphics, x: number, y: number, w: number, frac: number): void {
    if (frac >= 0.999) return;
    const h = 0.14;
    const clamped = Math.max(0, Math.min(1, frac));
    g.rect(x - w / 2, y, w, h).fill({ color: 0x000000, alpha: 0.55 });
    g.rect(x - w / 2, y, w * clamped, h).fill(
      clamped > 0.6 ? 0x6fd06f : clamped > 0.3 ? 0xd9c04a : 0xd05a4a,
    );
  }

  /** Marker showing where a selected building sends its production. */
  drawRally(from: { x: number; y: number } | null, to: { x: number; y: number } | null): void {
    if (!from || !to) return;
    const g = this.fxLayer;
    g.moveTo(from.x, from.y).lineTo(to.x, to.y)
      .stroke({ color: 0x9fe870, width: 0.06, alpha: 0.55 });
    g.circle(to.x, to.y, 0.35).stroke({ color: 0x9fe870, width: 0.08 });
  }

  /**
   * Draw the fog of war.
   *
   * Rendered as one pixel per tile into a canvas, then upscaled to map size
   * with bilinear filtering -- the feathered edge falls out of the upscale for
   * free, where the old rectangle pass stepped hard at every tile boundary.
   * Two states: never seen is opaque, seen but not currently observed is dim
   * so remembered terrain and buildings stay readable.
   */
  drawFog(width: number, height: number, explored: Uint8Array, visible: Uint8Array): void {
    if (!this.fogCanvas || this.fogCanvas.width !== width || this.fogCanvas.height !== height) {
      this.fogCanvas = document.createElement("canvas");
      this.fogCanvas.width = width;
      this.fogCanvas.height = height;
      const tex = Texture.from(this.fogCanvas);
      tex.source.scaleMode = "linear";
      this.fogSprite.texture = tex;
      this.fogSprite.width = width;
      this.fogSprite.height = height;
    }
    const ctx = this.fogCanvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(width, height);
    const d = img.data;
    for (let i = 0; i < width * height; i++) {
      if (visible[i]) continue;
      const a = explored[i] ? 115 : 255;
      d[i * 4] = 5;
      d[i * 4 + 1] = 7;
      d[i * 4 + 2] = 10;
      d[i * 4 + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    this.fogSprite.texture.source.update();
  }

  /** Queue a visual effect; see this.effects for why these are client-side. */
  spawnEffect(kind: EffectKind, x: number, y: number, size = 1): void {
    this.effects.push({ kind, x, y, born: performance.now(), size });
    // A stuck client should not accumulate effects forever.
    if (this.effects.length > 300) this.effects.splice(0, this.effects.length - 300);
  }

  /** Exposed for tests: how many effects are alive right now. */
  get effectCount(): number {
    return this.effects.length;
  }

  /** Render order pings, dust particles, and explosions into the fx layer. */
  private drawEffects(now: number): void {
    const g = this.fxLayer;
    const live: typeof this.effects = [];
    for (const e of this.effects) {
      const age = now - e.born;
      if (e.kind === "dust") {
        const dur = 400;
        if (age < dur) {
          live.push(e);
          const t = age / dur;
          const r = e.size * (0.3 + t * 0.8);
          g.circle(e.x, e.y, r).fill({ color: 0x827d6c, alpha: 0.22 * (1 - t) });
        }
      } else if (e.kind === "ping" || e.kind === "attack") {
        const dur = 420;
        if (age < dur) {
          live.push(e);
          const t = age / dur;
          const color = e.kind === "ping" ? 0x9fe870 : 0xe05a4a;
          // Ring closes inward on the target point -- an order lands somewhere.
          const r = 0.25 + (1 - t) * 1.1;
          g.circle(e.x, e.y, r).stroke({ color, width: 0.1, alpha: 0.3 + 0.7 * (1 - t) });
          if (e.kind === "attack") {
            const c = 0.18;
            g.moveTo(e.x - c, e.y - c).lineTo(e.x + c, e.y + c)
              .moveTo(e.x - c, e.y + c).lineTo(e.x + c, e.y - c)
              .stroke({ color, width: 0.09, alpha: 0.9 * (1 - t) });
          }
        }
      } else if (e.kind === "explosion" || e.kind === "bigExplosion") {
        const big = e.kind === "bigExplosion";
        const dur = big ? 850 : 550;
        if (age < dur) {
          live.push(e);
          const t = age / dur;
          const s = e.size * (big ? 1.7 : 1.1);

          // Fiery flash core
          if (t < 0.4) {
            const ft = t / 0.4;
            g.circle(e.x, e.y, s * (0.5 + ft * 1.2)).fill({ color: 0xfff6cf, alpha: 0.95 * (1 - ft) });
            g.circle(e.x, e.y, s * (0.3 + ft * 0.8)).fill({ color: 0xffaa33, alpha: 0.8 * (1 - ft) });
          }

          // Expanding shockwave ring
          g.circle(e.x, e.y, s * (0.35 + t * 2.6))
            .stroke({ color: 0xff7722, width: 0.16 * (1 - t) + 0.04, alpha: 0.85 * (1 - t) });

          // Flying debris sparks
          for (let sp = 0; sp < (big ? 8 : 5); sp++) {
            const ang = (sp * Math.PI * 2) / (big ? 8 : 5) + e.x * 3.7;
            const dist = s * (0.4 + t * 2.2);
            g.circle(e.x + Math.cos(ang) * dist, e.y + Math.sin(ang) * dist, 0.12 * (1 - t))
              .fill({ color: 0xffdd44, alpha: 1 - t });
          }

          // Dark volumetric smoke clouds drifting upward
          for (let k = 0; k < 4; k++) {
            const a = (k / 4) * Math.PI * 2 + e.x;
            g.circle(e.x + Math.cos(a) * s * t * 0.95, e.y + Math.sin(a) * s * t * 0.95 - t * 0.7 * s, s * 0.38)
              .fill({ color: 0x2e2c29, alpha: 0.45 * (1 - t) });
          }
        }
      }
    }
    this.effects = live;
  }

  /** Screen-space overlay: the selection box. */
  drawSelectionBox(box: { x0: number; y0: number; x1: number; y1: number } | null): void {
    const g = this.overlay;
    g.clear();
    if (!box) return;
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    const w = Math.abs(box.x1 - box.x0);
    const h = Math.abs(box.y1 - box.y0);
    g.rect(x, y, w, h).fill({ color: 0x9fe870, alpha: 0.12 }).stroke({ color: 0x9fe870, width: 1.5 });
  }
}

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

const TERRAIN_COLOR: Record<number, number> = {
  [Terrain.Ground]: 0x3f5133,
  [Terrain.Rough]: 0x59502f,
  [Terrain.Water]: 0x24506b,
  [Terrain.Mountain]: 0x4a4642,
  [Terrain.Trees]: 0x2b3d22,
};

/** Player colours: red team, blue team, then spares. */
export const PLAYER_COLOR = [0xd2564b, 0x4b8cd2, 0x54b06a, 0xd0b24a];

export class Renderer {
  readonly app = new Application();
  readonly world = new Container();

  private terrainLayer = new Graphics();
  private supplyLayer = new Graphics();
  private buildingLayer = new Graphics();
  private unitLayer = new Graphics();
  private fxLayer = new Graphics();
  private fogLayer = new Graphics();

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
  private overlay = new Graphics();

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
      this.supplyLayer,
      this.buildingLayer,
      this.buildingContainer,
      this.unitLayer,
      this.unitContainer,
      this.fxLayer,
      this.fogLayer,
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

  /** Draw the map once. Called on welcome, and on any map change. */
  buildTerrain(width: number, height: number, tiles: number[]): void {
    const g = this.terrainLayer;
    g.clear();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const t = tiles[y * width + x] ?? Terrain.Ground;
        g.rect(x, y, 1, 1).fill(TERRAIN_COLOR[t] ?? 0x000000);
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
  drawSupply(nodes: Array<{ x: number; y: number; amount: number; max: number }>): void {
    const g = this.supplyLayer;
    g.clear();
    for (const n of nodes) {
      if (n.amount <= 0) continue;
      const frac = Math.max(0.18, Math.min(1, n.amount / n.max));
      g.circle(n.x, n.y, 1.5 * frac + 0.4).fill(0xc9a227);
      g.circle(n.x, n.y, 1.5 * frac + 0.4).stroke({ color: 0x7d6416, width: 0.08 });
    }
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
      x: number; y: number; radius: number; hpFrac: number;
    }>,
    selected: ReadonlySet<number>,
  ): void {
    const g = this.unitLayer;
    g.clear();

    const live = new Set<number>();
    for (const u of units) {
      live.add(u.id);
      const color = PLAYER_COLOR[u.owner % PLAYER_COLOR.length]!;

      if (selected.has(u.id)) {
        // Selection ring under the body so it reads as a halo.
        g.circle(u.x, u.y, u.radius * 1.45).fill(0xffffff);
      }

      const tex = this.atlas.get(`unit.${u.type}`);
      if (tex) {
        const sp = this.sprite(this.unitSprites, this.unitContainer, u.id, tex);
        sp.position.set(u.x, u.y);
        // Sprites are drawn neutral grey, so tinting gives every faction from
        // one sheet rather than one sheet per player colour.
        sp.tint = color;
        // Drawn larger than the collision radius on purpose: a sprite sized
        // exactly to its footprint is unreadably small for infantry at normal
        // zoom, and readability matters more than physical honesty here.
        const draw = Math.max(0.95, u.radius * 3.2);
        sp.width = draw;
        sp.height = draw;
      } else {
        g.circle(u.x, u.y, u.radius).fill(color);
      }

      this.healthBar(g, u.x, u.y - u.radius - 0.3, u.radius * 2.2, u.hpFrac);
    }
    this.reap(this.unitSprites, live);
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
    }
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
   * Two states: never seen is opaque, seen but not currently observed is dim
   * so remembered terrain and buildings stay readable. Rectangles are merged
   * into row runs first -- a 96x96 map is over nine thousand tiles, and
   * emitting one rect each would cost more than the rest of the frame.
   */
  drawFog(width: number, height: number, explored: Uint8Array, visible: Uint8Array): void {
    const g = this.fogLayer;
    g.clear();

    for (let y = 0; y < height; y++) {
      let runStart = -1;
      let runKind = 0; // 1 = unexplored, 2 = explored but not visible

      const flush = (endX: number) => {
        if (runStart < 0) return;
        const alpha = runKind === 1 ? 1 : 0.45;
        g.rect(runStart, y, endX - runStart, 1).fill({ color: 0x05070a, alpha });
        runStart = -1;
      };

      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const kind = !explored[i] ? 1 : visible[i] ? 0 : 2;
        if (kind !== runKind) {
          flush(x);
          runKind = kind;
          if (kind !== 0) runStart = x;
        }
      }
      flush(width);
    }
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

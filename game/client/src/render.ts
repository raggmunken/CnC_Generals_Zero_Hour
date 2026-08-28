/**
 * Pixi renderer.
 *
 * Terrain is drawn once into a single Graphics object; only units and the
 * selection overlay are touched per frame. Redrawing 4096 tiles every frame is
 * the obvious way to make a 2D RTS stutter for no reason.
 */
import { Application, Container, Graphics } from "pixi.js";
import { Terrain } from "../../shared/types.js";

/** Screen pixels per world unit at zoom 1. */
export const BASE_TILE_PX = 24;

const TERRAIN_COLOR: Record<number, number> = {
  [Terrain.Ground]: 0x3f5133,
  [Terrain.Rough]: 0x59502f,
  [Terrain.Water]: 0x1e3a4c,
  [Terrain.Cliff]: 0x2a2724,
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
    this.world.addChild(this.terrainLayer, this.supplyLayer, this.buildingLayer, this.unitLayer);
    this.app.stage.addChild(this.world, this.overlay);
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
      size: number;
      progress: number;
      selected: boolean;
    }>,
  ): void {
    const g = this.buildingLayer;
    g.clear();
    for (const b of buildings) {
      const color = PLAYER_COLOR[b.owner % PLAYER_COLOR.length]!;

      if (b.progress < 1) {
        // Under construction: outline the footprint and fill from the bottom
        // up, so progress is readable without a separate progress bar.
        g.rect(b.x, b.y, b.size, b.size).fill({ color, alpha: 0.18 });
        const h = b.size * b.progress;
        g.rect(b.x, b.y + b.size - h, b.size, h).fill({ color, alpha: 0.55 });
        g.rect(b.x, b.y, b.size, b.size).stroke({ color, width: 0.08, alpha: 0.9 });
      } else {
        g.rect(b.x + 0.1, b.y + 0.1, b.size - 0.2, b.size - 0.2).fill(0x2a2724);
        g.rect(b.x + 0.25, b.y + 0.25, b.size - 0.5, b.size - 0.5).fill(color);
      }

      if (b.selected) {
        g.rect(b.x - 0.1, b.y - 0.1, b.size + 0.2, b.size + 0.2).stroke({ color: 0xffffff, width: 0.09 });
      }
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

  drawUnits(
    units: Array<{ id: number; owner: number; x: number; y: number; radius: number }>,
    selected: ReadonlySet<number>,
  ): void {
    const g = this.unitLayer;
    g.clear();
    for (const u of units) {
      const color = PLAYER_COLOR[u.owner % PLAYER_COLOR.length]!;
      if (selected.has(u.id)) {
        // Selection ring drawn under the body so it reads as a halo.
        g.circle(u.x, u.y, u.radius * 1.45).fill(0xffffff);
      }
      g.circle(u.x, u.y, u.radius).fill(color);
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

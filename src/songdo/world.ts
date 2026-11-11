// 충돌·지면 질의: 지형 높이장 + 건물 상자 + 다리 상판.
import { HeightField } from './heightfield';
import { WATER_DECALS, distToSeg, pointInPoly, polyBounds, type P2 } from './geo';

/** 회전된 상자 (Y축 회전, 바닥 base ~ 꼭대기 top) */
export interface Box {
  x: number; z: number; hx: number; hz: number; c: number; s: number; base: number; top: number;
  /** 지붕에 설 수 없는 상자 (탑 장식 등) */
  noRoof?: boolean;
}

export interface DeckSeg { a: P2; b: P2; ya: number; yb: number; half: number }

const CELL = 200;

export class World {
  readonly boxes: Box[] = [];
  private grid = new Map<number, number[]>();
  readonly decks: DeckSeg[] = [];
  private deckGrid = new Map<number, number[]>();
  private decals = WATER_DECALS.map((w) => ({ pts: w.pts, b: polyBounds(w.pts) }));
  constructor(readonly hf: HeightField) {}

  private key(i: number, j: number) { return (i + 1000) * 4096 + (j + 1000); }

  addBox(b: Box) {
    const id = this.boxes.length;
    this.boxes.push(b);
    const r = Math.hypot(b.hx, b.hz);
    const i0 = Math.floor((b.x - r) / CELL), i1 = Math.floor((b.x + r) / CELL);
    const j0 = Math.floor((b.z - r) / CELL), j1 = Math.floor((b.z + r) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = this.key(i, j);
      let a = this.grid.get(k);
      if (!a) this.grid.set(k, (a = []));
      a.push(id);
    }
  }
  addDeck(d: DeckSeg) {
    const id = this.decks.length;
    this.decks.push(d);
    const x0 = Math.min(d.a.x, d.b.x) - d.half, x1 = Math.max(d.a.x, d.b.x) + d.half;
    const z0 = Math.min(d.a.z, d.b.z) - d.half, z1 = Math.max(d.a.z, d.b.z) + d.half;
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
      for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
        const k = this.key(i, j);
        let a = this.deckGrid.get(k);
        if (!a) this.deckGrid.set(k, (a = []));
        a.push(id);
      }
  }

  /** 점 근처 상자들 */
  near(x: number, z: number): number[] {
    return this.grid.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? [];
  }

  /** 상자 지역 좌표 (회전 해제) */
  local(b: Box, x: number, z: number): { lx: number; lz: number } {
    const dx = x - b.x, dz = z - b.z;
    return { lx: dx * b.c + dz * b.s, lz: -dx * b.s + dz * b.c };
  }
  inside2D(b: Box, x: number, z: number, pad = 0): boolean {
    const { lx, lz } = this.local(b, x, z);
    return Math.abs(lx) <= b.hx + pad && Math.abs(lz) <= b.hz + pad;
  }

  terrain(x: number, z: number): number { return this.hf.at(x, z); }

  /** 다리 상판 높이 (없으면 -Infinity) */
  deckAt(x: number, z: number): number {
    const ids = this.deckGrid.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!ids) return -Infinity;
    let best = -Infinity;
    for (const id of ids) {
      const d = this.decks[id];
      const dx = d.b.x - d.a.x, dz = d.b.z - d.a.z;
      const l2 = dx * dx + dz * dz;
      const t = Math.min(1, Math.max(0, ((x - d.a.x) * dx + (z - d.a.z) * dz) / l2));
      if (distToSeg(x, z, d.a, d.b) <= d.half) best = Math.max(best, d.ya + (d.yb - d.ya) * t);
    }
    return best;
  }

  /** 공원 수로 등 얕은 물 위인가 */
  inDecalWater(x: number, z: number): boolean {
    for (const d of this.decals) {
      if (x < d.b.x0 || x > d.b.x1 || z < d.b.z0 || z > d.b.z1) continue;
      if (pointInPoly(x, z, d.pts)) return true;
    }
    return false;
  }

  /**
   * 발 아래 지면: 지형·다리 상판·지붕 중 y+step 이하에서 가장 높은 곳.
   * water = 그 지면이 물(바다 수면 0 또는 수로)인가
   */
  ground(x: number, z: number, y: number, step = 1.2): { h: number; water: boolean; roof: boolean } {
    let h = this.hf.at(x, z);
    let water = false;
    if (h < 0.3) { water = true; h = 0; }
    else if (this.inDecalWater(x, z)) water = true;
    const deck = this.deckAt(x, z);
    let roof = false;
    if (deck > h && deck <= y + step) { h = deck; water = false; }
    for (const id of this.near(x, z)) {
      const b = this.boxes[id];
      if (b.noRoof || b.top <= h || b.top > y + step) continue;
      if (this.inside2D(b, x, z)) { h = b.top; water = false; roof = true; }
    }
    return { h, water, roof };
  }

  /** 점이 건물 안에 있는가 (비행기 충돌) */
  hitBox(x: number, y: number, z: number): Box | null {
    for (const id of this.near(x, z)) {
      const b = this.boxes[id];
      if (y < b.base || y > b.top) continue;
      if (this.inside2D(b, x, z)) return b;
    }
    return null;
  }

  /** 원(반지름 r, 높이 y~y+hgt)을 건물 벽 밖으로 밀어낸다 (걷기) */
  pushOut(p: { x: number; z: number }, y: number, r: number, hgt: number, step = 0.6) {
    for (let iter = 0; iter < 2; iter++) {
      for (const id of this.near(p.x, p.z)) {
        const b = this.boxes[id];
        if (b.top <= y + step || b.base >= y + hgt) continue;
        const { lx, lz } = this.local(b, p.x, p.z);
        const ox = b.hx + r - Math.abs(lx), oz = b.hz + r - Math.abs(lz);
        if (ox <= 0 || oz <= 0) continue;
        let nlx = lx, nlz = lz;
        if (ox < oz) nlx = Math.sign(lx || 1) * (b.hx + r);
        else nlz = Math.sign(lz || 1) * (b.hz + r);
        p.x = b.x + nlx * b.c - nlz * b.s;
        p.z = b.z + nlx * b.s + nlz * b.c;
      }
    }
  }
}

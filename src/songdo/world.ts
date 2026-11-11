// 충돌·지면 질의: 지형 높이장 + 건물(실제 외곽선 다각형) + 상자(교각·주탑 등) + 다리 상판.
import type { HeightField } from './heightfield';
import { distToSeg, type P2 } from './geo';

/** 회전된 상자 (Y축 회전, 바닥 base ~ 꼭대기 top). 지역→월드: dx = lx*c - lz*s, dz = lx*s + lz*c */
export interface Box {
  x: number; z: number; hx: number; hz: number; c: number; s: number; base: number; top: number;
  noRoof?: boolean;
}
/** 건물: 외곽선 (월드 좌표, x,z 교대로) */
export interface Poly { pts: Float32Array; base: number; top: number; x0: number; z0: number; x1: number; z1: number }
export interface DeckSeg { a: P2; b: P2; ya: number; yb: number; half: number }

const CELL = 100;

export class World {
  readonly boxes: Box[] = [];
  readonly polys: Poly[] = [];
  readonly decks: DeckSeg[] = [];
  private boxGrid = new Map<number, number[]>();
  private polyGrid = new Map<number, number[]>();
  private deckGrid = new Map<number, number[]>();
  constructor(readonly hf: HeightField) {}

  private key(i: number, j: number) { return (i + 2000) * 8192 + (j + 2000); }
  private insert(grid: Map<number, number[]>, id: number, x0: number, z0: number, x1: number, z1: number) {
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
      for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
        const k = this.key(i, j);
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(id);
      }
  }
  private cellOf(grid: Map<number, number[]>, x: number, z: number) {
    return grid.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)));
  }

  addBox(b: Box) {
    const r = Math.hypot(b.hx, b.hz);
    this.boxes.push(b);
    this.insert(this.boxGrid, this.boxes.length - 1, b.x - r, b.z - r, b.x + r, b.z + r);
  }
  addPoly(pts: Float32Array, base: number, top: number) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); z0 = Math.min(z0, pts[i + 1]); z1 = Math.max(z1, pts[i + 1]); }
    this.polys.push({ pts, base, top, x0, z0, x1, z1 });
    this.insert(this.polyGrid, this.polys.length - 1, x0, z0, x1, z1);
  }
  addDeck(d: DeckSeg) {
    this.decks.push(d);
    this.insert(this.deckGrid, this.decks.length - 1, Math.min(d.a.x, d.b.x) - d.half, Math.min(d.a.z, d.b.z) - d.half, Math.max(d.a.x, d.b.x) + d.half, Math.max(d.a.z, d.b.z) + d.half);
  }

  local(b: Box, x: number, z: number) {
    const dx = x - b.x, dz = z - b.z;
    return { lx: dx * b.c + dz * b.s, lz: -dx * b.s + dz * b.c };
  }
  inside2D(b: Box, x: number, z: number, pad = 0): boolean {
    const { lx, lz } = this.local(b, x, z);
    return Math.abs(lx) <= b.hx + pad && Math.abs(lz) <= b.hz + pad;
  }
  inPoly(p: Poly, x: number, z: number): boolean {
    if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) return false;
    const a = p.pts;
    let inside = false;
    for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
      const xi = a[i], zi = a[i + 1], xj = a[j], zj = a[j + 1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  terrain(x: number, z: number): number { return this.hf.at(x, z); }

  deckAt(x: number, z: number): number {
    const ids = this.cellOf(this.deckGrid, x, z);
    if (!ids) return -Infinity;
    let best = -Infinity;
    for (const id of ids) {
      const d = this.decks[id];
      const dx = d.b.x - d.a.x, dz = d.b.z - d.a.z;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.min(1, Math.max(0, ((x - d.a.x) * dx + (z - d.a.z) * dz) / l2));
      if (distToSeg(x, z, d.a, d.b) <= d.half) best = Math.max(best, d.ya + (d.yb - d.ya) * t);
    }
    return best;
  }

  /** 발 아래 지면 (지형·다리·지붕 중 y+step 이하의 가장 높은 곳) */
  ground(x: number, z: number, y: number, step = 1.2): { h: number; water: boolean; sea: boolean; roof: boolean } {
    let h = this.hf.at(x, z);
    const w = this.hf.waterAt(x, z);
    let water = w !== 0 || h < 0.3, sea = w === 2 || h < 0.3;
    if (sea) h = Math.max(h, 0);
    const deck = this.deckAt(x, z);
    let roof = false;
    if (deck > h && deck <= y + step) { h = deck; water = false; sea = false; }
    for (const id of this.cellOf(this.boxGrid, x, z) ?? []) {
      const b = this.boxes[id];
      if (b.noRoof || b.top <= h || b.top > y + step) continue;
      if (this.inside2D(b, x, z)) { h = b.top; water = false; sea = false; roof = true; }
    }
    for (const id of this.cellOf(this.polyGrid, x, z) ?? []) {
      const p = this.polys[id];
      if (p.top <= h || p.top > y + step) continue;
      if (this.inPoly(p, x, z)) { h = p.top; water = false; sea = false; roof = true; }
    }
    return { h, water, sea, roof };
  }

  /** 점이 구조물 안에 있는가 (비행기 충돌) */
  hitAt(x: number, y: number, z: number): { top: number } | null {
    for (const id of this.cellOf(this.boxGrid, x, z) ?? []) {
      const b = this.boxes[id];
      if (y < b.base || y > b.top) continue;
      if (this.inside2D(b, x, z)) return b;
    }
    for (const id of this.cellOf(this.polyGrid, x, z) ?? []) {
      const p = this.polys[id];
      if (y < p.base || y > p.top) continue;
      if (this.inPoly(p, x, z)) return p;
    }
    return null;
  }

  /** 원(반지름 r)을 벽 밖으로 밀어낸다 (걷기) */
  pushOut(p: { x: number; z: number }, y: number, r: number, hgt: number, step = 0.6) {
    for (let iter = 0; iter < 3; iter++) {
      for (const id of this.cellOf(this.boxGrid, p.x, p.z) ?? []) {
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
      for (const id of this.cellOf(this.polyGrid, p.x, p.z) ?? []) {
        const q = this.polys[id];
        if (q.top <= y + step || q.base >= y + hgt) continue;
        if (p.x < q.x0 - r || p.x > q.x1 + r || p.z < q.z0 - r || p.z > q.z1 + r) continue;
        // 가장 가까운 변
        const a = q.pts;
        let bd = Infinity, bx = 0, bz = 0;
        for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
          const ax = a[j], az = a[j + 1], cx = a[i], cz = a[i + 1];
          const dx = cx - ax, dz = cz - az, l2 = dx * dx + dz * dz || 1;
          const t = Math.min(1, Math.max(0, ((p.x - ax) * dx + (p.z - az) * dz) / l2));
          const ex = ax + dx * t, ez = az + dz * t;
          const d = Math.hypot(p.x - ex, p.z - ez);
          if (d < bd) { bd = d; bx = ex; bz = ez; }
        }
        const inside = this.inPoly(q, p.x, p.z);
        if (!inside && bd >= r) continue;
        let nx = p.x - bx, nz = p.z - bz;
        const l = Math.hypot(nx, nz) || 1;
        nx /= l; nz /= l;
        if (inside) { nx = -nx; nz = -nz; }
        p.x = bx + nx * r * 1.01;
        p.z = bz + nz * r * 1.01;
      }
    }
  }
}

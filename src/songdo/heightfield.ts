// 지형 높이장 (순수 계산, DOM 없음 → 테스트 가능). 렌더 메시와 충돌이 같은 값을 쓴다.
import { FLAT_ZONES, LANDS, PEAKS, fbm, polyBounds, pointInPoly, sdfPoly, type LandPoly, type P2 } from './geo';

export const HF = {
  x0: -34000, z0: -26000, // 서북 모서리
  x1: 22000, z1: 16000,
  cell: 100,
};
export const SEA_FLOOR = -12;
export const RECLAIM_H = 4;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Prep { L: LandPoly; b: { x0: number; x1: number; z0: number; z1: number } }
let prepared: Prep[] | null = null;
const prep = () => (prepared ??= LANDS.map((L) => ({ L, b: polyBounds(L.pts) })));
const flatB = FLAT_ZONES.map((f) => ({ ...f, b: polyBounds(f.pts) }));

/** 해석적 높이 (격자 생성용) */
export function rawHeight(x: number, z: number): number {
  let h = SEA_FLOOR;
  let natural = 0; // 내륙 정도 0..1
  let peakF = 0; // 봉우리 적용 정도 (해안 가까이도 산이 솟게)
  let urban = 0;
  for (const { L, b } of prep()) {
    const pad = 1600;
    if (x < b.x0 - pad || x > b.x1 + pad || z < b.z0 - pad || z > b.z1 + pad) continue;
    const s = sdfPoly(x, z, L.pts);
    if (L.kind === 'reclaim') {
      const hh = SEA_FLOOR + (RECLAIM_H - SEA_FLOOR) * smooth(-140, 5, s);
      if (hh > h) { h = hh; }
      if (s > 0) urban = 1;
    } else {
      const shore = smooth(-350, 120, s);
      const hh = SEA_FLOOR + (2.5 - SEA_FLOOR) * shore;
      if (hh > h) h = hh;
      natural = Math.max(natural, smooth(0, 1500, s));
      peakF = Math.max(peakF, smooth(-60, 300, s));
    }
  }
  if ((natural > 0 || peakF > 0) && urban === 0) {
    const hill = Math.max(0, (fbm(x / 2600, z / 2600, 4) - 0.38) * 70);
    let peaks = 0;
    for (const p of PEAKS) {
      const dx = x - p.at.x, dz = z - p.at.z;
      const d2 = (dx * dx + dz * dz) / (p.r * p.r);
      if (d2 < 9) peaks += p.h * Math.exp(-d2 * 1.4) * (0.85 + 0.3 * fbm(x / 300, z / 300, 2));
    }
    h = h + hill * natural + peaks * peakF;
  }
  for (const f of flatB) {
    if (x < f.b.x0 - 400 || x > f.b.x1 + 400 || z < f.b.z0 - 400 || z > f.b.z1 + 400) continue;
    const s = sdfPoly(x, z, f.pts);
    const w = smooth(-350, 50, s);
    if (w > 0 && h > -1) h = h + (f.h - h) * w;
  }
  return h;
}

export class HeightField {
  readonly nx: number;
  readonly nz: number;
  readonly h: Float32Array;
  constructor(data?: Float32Array) {
    this.nx = Math.round((HF.x1 - HF.x0) / HF.cell) + 1;
    this.nz = Math.round((HF.z1 - HF.z0) / HF.cell) + 1;
    if (data) { this.h = data; return; }
    this.h = new Float32Array(this.nx * this.nz);
    for (let j = 0; j < this.nz; j++) {
      const z = HF.z0 + j * HF.cell;
      for (let i = 0; i < this.nx; i++) this.h[j * this.nx + i] = rawHeight(HF.x0 + i * HF.cell, z);
    }
  }
  /** 렌더 삼각형과 같은 보간 (셀 대각선 b-c) */
  at(x: number, z: number): number {
    const fx0 = (x - HF.x0) / HF.cell, fz0 = (z - HF.z0) / HF.cell;
    if (fx0 < 0 || fz0 < 0 || fx0 >= this.nx - 1 || fz0 >= this.nz - 1) return SEA_FLOOR;
    const i = Math.floor(fx0), j = Math.floor(fz0);
    const fx = fx0 - i, fz = fz0 - j;
    const n = this.nx;
    const a = this.h[j * n + i], b = this.h[j * n + i + 1], c = this.h[(j + 1) * n + i], d = this.h[(j + 1) * n + i + 1];
    if (fx + fz <= 1) return a + (b - a) * fx + (c - a) * fz;
    return d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
  }
  /** 경사 (높이 차/수평 거리) */
  slope(x: number, z: number): number {
    const e = 20;
    return Math.hypot(this.at(x + e, z) - this.at(x - e, z), this.at(x, z + e) - this.at(x, z - e)) / (2 * e);
  }
}

export function insideLand(p: P2, name: string): boolean {
  const L = LANDS.find((l) => l.name === name);
  return !!L && pointInPoly(p.x, p.z, L.pts);
}

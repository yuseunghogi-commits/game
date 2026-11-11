// 지형 높이장: 실제 고도 자료(40m 격자) + 물 마스크(10m). 렌더 메시와 충돌이 같은 값을 쓴다.
import type { Meta } from './data';

export const SEA_FLOOR = -12;

export class HeightField {
  readonly nx: number;
  readonly nz: number;
  readonly x0: number; readonly z0: number; readonly x1: number; readonly z1: number;
  readonly cell: number;
  private wcell: number; private wx: number; private wz: number;
  constructor(meta: Meta, readonly h: Float32Array, readonly water: Uint8Array) {
    this.nx = meta.nx; this.nz = meta.nz; this.cell = meta.cell;
    [this.x0, this.z0, this.x1, this.z1] = meta.bounds;
    this.wcell = meta.wcell; this.wx = meta.wx; this.wz = meta.wz;
  }
  /** 렌더 삼각형과 같은 보간 (셀 대각선 b-c) */
  at(x: number, z: number): number {
    const fx0 = (x - this.x0) / this.cell, fz0 = (z - this.z0) / this.cell;
    if (fx0 < 0 || fz0 < 0 || fx0 >= this.nx - 1 || fz0 >= this.nz - 1) return SEA_FLOOR;
    const i = Math.floor(fx0), j = Math.floor(fz0);
    const fx = fx0 - i, fz = fz0 - j;
    const n = this.nx;
    const a = this.h[j * n + i], b = this.h[j * n + i + 1], c = this.h[(j + 1) * n + i], d = this.h[(j + 1) * n + i + 1];
    if (fx + fz <= 1) return a + (b - a) * fx + (c - a) * fz;
    return d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
  }
  slope(x: number, z: number): number {
    const e = 20;
    return Math.hypot(this.at(x + e, z) - this.at(x - e, z), this.at(x, z + e) - this.at(x, z - e)) / (2 * e);
  }
  /** 0 = 땅, 1 = 호수·수로·강, 2 = 바다 */
  waterAt(x: number, z: number): number {
    const i = Math.floor((z - this.z0) / this.wcell), j = Math.floor((x - this.x0) / this.wcell);
    if (i < 0 || j < 0 || i >= this.wz || j >= this.wx) return 2;
    return this.water[i * this.wx + j];
  }
  inBounds(x: number, z: number, pad = 0) {
    return x > this.x0 + pad && x < this.x1 - pad && z > this.z0 + pad && z < this.z1 - pad;
  }
}

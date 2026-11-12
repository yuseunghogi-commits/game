// 실제 건물 외곽선을 세워 만든 건물 메시. 800m 조각 단위로 묶고,
// 큰 건물(높이 25m 이상 등)은 처음에 모두, 작은 건물은 카메라 가까운 조각만 만들어 둔다.
import * as THREE from 'three';
import type { Buildings } from './data';
import type { World } from './world';
import type { HeightField } from './heightfield';
import { buildingMaterial } from './builder';

const CHUNK = 800;
const NEAR_R = 3200, FAR_R = 4400;
const FLOOR_H = [2.9, 3.9, 3.4, 6.0, 3.0, 3.9, 3.1];
const SHADER_STYLE = [0, 1, 2, 3, 4, 5, 2];
const ROOF_TILES: [number, number, number][] = [[92, 94, 100], [128, 72, 60], [70, 88, 116], [110, 104, 96]];

interface Chunk { big: number[]; small: number[]; mesh: THREE.Mesh | null; cx: number; cz: number }

export class BuildingSet {
  readonly group = new THREE.Group();
  readonly base: Float32Array;
  readonly beacons: THREE.Vector3[] = [];
  private chunks = new Map<number, Chunk>();
  private bigMeshes: THREE.Mesh[] = [];
  private seed: Float32Array;
  /** hidden: 직접 모델링한 랜드마크로 바꿔 그릴 건물 번호 (충돌은 그대로) */
  constructor(private b: Buildings, hf: HeightField, world: World, private hidden: Set<number> = new Set()) {
    this.group.name = 'buildings';
    const n = b.n;
    this.base = new Float32Array(n);
    this.seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // 바닥 = 꼭짓점 지면 높이 중 최저
      let g = Infinity;
      const s = b.start[i] * 2, c = b.count[i];
      const step = Math.max(1, Math.floor(c / 8));
      for (let k = 0; k < c; k += step) g = Math.min(g, hf.at(b.cx[i] + b.verts[s + k * 2], b.cz[i] + b.verts[s + k * 2 + 1]));
      g = Math.min(g, hf.at(b.cx[i], b.cz[i]));
      if (!isFinite(g)) g = 0;
      this.base[i] = Math.max(g, 0.5) - 0.4;
      this.seed[i] = ((i * 0.6180339) % 1);
      // 충돌
      const pts = new Float32Array(c * 2);
      for (let k = 0; k < c; k++) { pts[k * 2] = b.cx[i] + b.verts[s + k * 2]; pts[k * 2 + 1] = b.cz[i] + b.verts[s + k * 2 + 1]; }
      world.addPoly(pts, this.base[i] + b.minH[i], this.base[i] + b.h[i]);
      if (b.h[i] > 110) this.beacons.push(new THREE.Vector3(b.cx[i], this.base[i] + b.h[i] + 1.5, b.cz[i]));
      // 조각 배정
      const key = this.key(b.cx[i], b.cz[i]);
      let ch = this.chunks.get(key);
      if (!ch) {
        ch = { big: [], small: [], mesh: null, cx: (Math.floor(b.cx[i] / CHUNK) + 0.5) * CHUNK, cz: (Math.floor(b.cz[i] / CHUNK) + 0.5) * CHUNK };
        this.chunks.set(key, ch);
      }
      let ext = 0;
      for (let k = 0; k < c; k++) ext = Math.max(ext, Math.abs(b.verts[s + k * 2]), Math.abs(b.verts[s + k * 2 + 1]));
      if (b.h[i] >= 25 || ext > 45) ch.big.push(i); else ch.small.push(i);
    }
    // 큰 건물: 조각 16개(3.2km)씩 묶어 한 메시
    const groups = new Map<number, number[]>();
    for (const [, ch] of this.chunks) {
      const k = Math.floor(ch.cx / (CHUNK * 4)) * 4096 + Math.floor(ch.cz / (CHUNK * 4));
      let a = groups.get(k);
      if (!a) groups.set(k, (a = []));
      a.push(...ch.big);
    }
    for (const [, ids] of groups) {
      if (!ids.length) continue;
      const m = this.makeMesh(ids);
      this.bigMeshes.push(m);
      this.group.add(m);
    }
  }
  private key(x: number, z: number) { return (Math.floor(x / CHUNK) + 1000) * 4096 + Math.floor(z / CHUNK) + 1000; }
  get count() { return this.b.n; }

  /** 카메라 근처 작은 건물 조각 만들기·버리기 (프레임당 시간 제한) */
  update(cam: THREE.Vector3, budgetMs = 6) {
    const t0 = performance.now();
    const todo: Chunk[] = [];
    for (const [, ch] of this.chunks) {
      if (!ch.small.length) continue;
      const d = Math.hypot(ch.cx - cam.x, ch.cz - cam.z);
      if (ch.mesh && d > FAR_R) {
        this.group.remove(ch.mesh);
        ch.mesh.geometry.dispose();
        ch.mesh = null;
      } else if (!ch.mesh && d < NEAR_R) todo.push(ch);
    }
    todo.sort((a, b) => Math.hypot(a.cx - cam.x, a.cz - cam.z) - Math.hypot(b.cx - cam.x, b.cz - cam.z));
    for (const ch of todo) {
      ch.mesh = this.makeMesh(ch.small);
      this.group.add(ch.mesh);
      if (performance.now() - t0 > budgetMs) break;
    }
  }
  /** 처음 위치 주변을 한꺼번에 만든다 */
  prime(cam: THREE.Vector3) { this.update(cam, 1e9); }

  private makeMesh(ids: number[]): THREE.Mesh {
    const b = this.b;
    // 크기 미리 세기
    let nv = 0, ni = 0;
    for (const i of ids) {
      const c = b.count[i];
      nv += c * 6 + 1; ni += c * 6 + c * 3;
    }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Uint8Array(nv * 3), sty = new Float32Array(nv * 4), tops = new Float32Array(nv);
    const idx = new Uint32Array(ni);
    let v = 0, q = 0;
    const contour: THREE.Vector2[] = [];
    for (const i of ids) {
      if (this.hidden.has(i)) continue;
      const c = b.count[i], s = b.start[i] * 2;
      const base = this.base[i] + b.minH[i];
      const top = this.base[i] + b.h[i];
      const st = b.style[i];
      const pitched = (b.flags[i] & 2) !== 0;
      const r5 = b.color[i];
      const wr = ((r5 >> 11) & 31) * 8.2, wg = ((r5 >> 5) & 63) * 4.05, wb = (r5 & 31) * 8.2;
      const seed = this.seed[i];
      const fh = FLOOR_H[st] ?? 3.3, ss = SHADER_STYLE[st] ?? 2;
      // 면적 부호로 방향 판단
      let a2 = 0;
      for (let k = 0; k < c; k++) {
        const k2 = (k + 1) % c;
        a2 += b.verts[s + k * 2] * b.verts[s + k2 * 2 + 1] - b.verts[s + k2 * 2] * b.verts[s + k * 2 + 1];
      }
      const ccw = a2 > 0;
      let minExt = Infinity;
      for (let k = 0; k < c; k++) minExt = Math.min(minExt, Math.hypot(b.verts[s + k * 2], b.verts[s + k * 2 + 1]));
      const roofH = pitched ? Math.min(4.5, Math.max(1.5, minExt * 0.55)) : 0;
      const wallTop = top - roofH;
      const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number, cr: number, cg: number, cb: number) => {
        pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
        nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
        col[v * 3] = cr; col[v * 3 + 1] = cg; col[v * 3 + 2] = cb;
        sty[v * 4] = ss; sty[v * 4 + 1] = seed; sty[v * 4 + 2] = fh; sty[v * 4 + 3] = this.base[i];
        tops[v] = wallTop;
        return v++;
      };
      // 벽
      for (let k = 0; k < c; k++) {
        const k2 = (k + 1) % c;
        const ax = b.cx[i] + b.verts[s + k * 2], az = b.cz[i] + b.verts[s + k * 2 + 1];
        const bx = b.cx[i] + b.verts[s + k2 * 2], bz = b.cz[i] + b.verts[s + k2 * 2 + 1];
        const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
        // 바깥 법선: 반시계(ccw)면 (dz,-dx)
        let nx = dz / L, nz = -dx / L;
        if (!ccw) { nx = -nx; nz = -nz; }
        const a0 = put(ax, base, az, nx, 0, nz, wr, wg, wb), b0 = put(bx, base, bz, nx, 0, nz, wr, wg, wb);
        const b1 = put(bx, wallTop, bz, nx, 0, nz, wr, wg, wb), a1 = put(ax, wallTop, az, nx, 0, nz, wr, wg, wb);
        // (a0,b0,b1)의 법선 ∝ (-dz, 0, dx)
        if (-dz * nx + dx * nz > 0) { idx[q++] = a0; idx[q++] = b0; idx[q++] = b1; idx[q++] = a0; idx[q++] = b1; idx[q++] = a1; }
        else { idx[q++] = a0; idx[q++] = b1; idx[q++] = b0; idx[q++] = a0; idx[q++] = a1; idx[q++] = b1; }
      }
      // 지붕
      if (pitched) {
        const tile = ROOF_TILES[Math.floor(seed * 7.3) % ROOF_TILES.length];
        const apex = put(b.cx[i], top, b.cz[i], 0, 1, 0, tile[0], tile[1], tile[2]);
        for (let k = 0; k < c; k++) {
          const k2 = (k + 1) % c;
          const ax = b.cx[i] + b.verts[s + k * 2], az = b.cz[i] + b.verts[s + k * 2 + 1];
          const bx = b.cx[i] + b.verts[s + k2 * 2], bz = b.cz[i] + b.verts[s + k2 * 2 + 1];
          // 면 법선
          const ux = bx - ax, uz = bz - az, wx = b.cx[i] - ax, wy = roofH, wz = b.cz[i] - az;
          let nx = 0 * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - 0 * wx;
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
          const flip = ny < 0;
          if (flip) { nx = -nx; ny = -ny; nz = -nz; }
          const pa = put(ax, wallTop, az, nx, ny, nz, tile[0], tile[1], tile[2]);
          const pb = put(bx, wallTop, bz, nx, ny, nz, tile[0], tile[1], tile[2]);
          if (flip) { idx[q++] = pa; idx[q++] = apex; idx[q++] = pb; } else { idx[q++] = pa; idx[q++] = pb; idx[q++] = apex; }
        }
      } else {
        contour.length = 0;
        const v0 = v;
        const rr = wr * 0.72, rg = wg * 0.72, rb = wb * 0.72;
        for (let k = 0; k < c; k++) {
          const x = b.cx[i] + b.verts[s + k * 2], z = b.cz[i] + b.verts[s + k * 2 + 1];
          contour.push(new THREE.Vector2(x, z));
          put(x, top, z, 0, 1, 0, rr, rg, rb);
        }
        const tris = THREE.ShapeUtils.triangulateShape(contour, []);
        for (const t of tris) {
          const p0 = contour[t[0]], p1 = contour[t[1]], p2 = contour[t[2]];
          // 위를 향하게: (p1-p0)x(p2-p0) 의 y = uz*vx - ux*vz
          const ny = (p1.y - p0.y) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.y - p0.y);
          if (ny > 0) { idx[q++] = v0 + t[0]; idx[q++] = v0 + t[1]; idx[q++] = v0 + t[2]; }
          else { idx[q++] = v0 + t[0]; idx[q++] = v0 + t[2]; idx[q++] = v0 + t[1]; }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, v * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, v * 3), 3, true));
    g.setAttribute('aStyle', new THREE.BufferAttribute(sty.subarray(0, v * 4), 4));
    g.setAttribute('aTop', new THREE.BufferAttribute(tops.subarray(0, v), 1));
    g.setIndex(new THREE.BufferAttribute(idx.subarray(0, q), 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, bldMat());
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }
}

let mat: THREE.Material | null = null;
export function bldMat(): THREE.Material {
  if (mat) return mat;
  const c = buildingMaterial.clone();
  c.vertexColors = true;
  c.onBeforeCompile = buildingMaterial.onBeforeCompile;
  c.customProgramCacheKey = () => 'bld-vc';
  mat = c;
  return c;
}

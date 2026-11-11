// 송도국제도시 · 인천 내륙 · 영종하늘도시 건물, 도로, 공원, 랜드마크.
import * as THREE from 'three';
import {
  LANDS, SD_ROT, SD_U, SD_V, SONGDO_UV, WATER_DECALS, fbm, km, pointInPoly, rng, sd, sdfPoly, type P2,
} from './geo';
import type { World } from './world';
import { Builder, FlatBuilder, buildingMaterial } from './builder';
import { BStyle, setStyle } from './materials';
import { RECLAIM_H } from './heightfield';

export interface RoadSeg { a: P2; b: P2; width: number; y: number; ya?: number; yb?: number }

const U = new THREE.Vector2(SD_U.e, -SD_U.n); // 월드 (x,z)
const V = new THREE.Vector2(SD_V.e, -SD_V.n);
const G = RECLAIM_H; // 송도 지면 높이

/** 송도 격자 */
export const GRID = { u0: -1.2, du: 0.45, v0: 0.15, dv: 0.4, nu: 26, nv: 14 };
const mainU = (k: number) => k % 3 === 0;
const mainV = (j: number) => j % 3 === 1;
const roadW = (main: boolean) => (main ? 50 : 26);

type Zone = 'apt' | 'aptHigh' | 'office' | 'commercial' | 'campus' | 'industrial' | 'park' | 'golf' | 'eleven' | 'none';
interface Region { u0: number; u1: number; v0: number; v1: number; z: Zone }
const REGIONS: Region[] = [
  { u0: 2.55, u1: 4.8, v0: 1.95, v1: 2.55, z: 'park' },
  { u0: 0.6, u1: 2.1, v0: 2.55, v1: 3.95, z: 'golf' },
  { u0: 1.2, u1: 2.1, v0: 1.1, v1: 1.75, z: 'park' },
  { u0: 5.6, u1: 6.4, v0: 0.5, v1: 1.2, z: 'park' },
  { u0: 6.0, u1: 7.4, v0: 1.95, v1: 3.2, z: 'campus' },
  { u0: 3.0, u1: 4.6, v0: 3.75, v1: 4.75, z: 'campus' },
  { u0: 7.4, u1: 10.1, v0: 3.15, v1: 5.0, z: 'industrial' },
  { u0: 5.0, u1: 5.9, v0: 3.3, v1: 3.9, z: 'commercial' },
  { u0: 9.2, u1: 10.3, v0: 0.4, v1: 4.4, z: 'eleven' },
  { u0: 1.9, u1: 5.3, v0: 1.5, v1: 3.3, z: 'office' },
  { u0: -1.3, u1: 1.0, v0: 0.6, v1: 3.0, z: 'aptHigh' },
];
function zoneAt(u: number, v: number): Zone {
  for (const r of REGIONS) if (u >= r.u0 && u <= r.u1 && v >= r.v0 && v <= r.v1) return r.z;
  return 'apt';
}

const songdoPts = () => LANDS[1].pts;

/** 송도 격자 블록 순회 */
function forBlocks(cb: (i: number, j: number, u0: number, u1: number, v0: number, v1: number) => void) {
  const poly = songdoPts();
  for (let i = 0; i < GRID.nu; i++) for (let j = 0; j < GRID.nv; j++) {
    const u0 = GRID.u0 + i * GRID.du, u1 = u0 + GRID.du, v0 = GRID.v0 + j * GRID.dv, v1 = v0 + GRID.dv;
    const ok = [[u0, v0], [u1, v0], [u0, v1], [u1, v1]].every(([u, v]) => { const p = sd(u, v); return sdfPoly(p.x, p.z, poly) > 30; });
    if (ok) cb(i, j, u0, u1, v0, v1);
  }
}

/** 블록 지역 좌표(m, 블록 중심 기준) → 월드 */
function blockFrame(u0: number, u1: number, v0: number, v1: number, i: number, j: number) {
  const c = sd((u0 + u1) / 2, (v0 + v1) / 2);
  // 도로 폭을 뺀 내부 크기
  const wu = (u1 - u0) * 1000 - roadW(mainU(i)) / 2 - roadW(mainU(i + 1)) / 2;
  const wv = (v1 - v0) * 1000 - roadW(mainV(j)) / 2 - roadW(mainV(j + 1)) / 2;
  const offU = (roadW(mainU(i)) - roadW(mainU(i + 1))) / 4;
  const offV = (roadW(mainV(j)) - roadW(mainV(j + 1))) / 4;
  const at = (a: number, b: number): P2 => ({ x: c.x + U.x * (a + offU) + V.x * (b + offV), z: c.z + U.y * (a + offU) + V.y * (b + offV) });
  return { at, wu, wv };
}

const APT_COLORS = [0xf2efe8, 0xece6da, 0xe8ecef, 0xf4f1ea, 0xdcd8cf, 0xe9e2d3, 0xd9e1e6];
const APT_ACCENT = [0x6f8fb3, 0xc9785a, 0x7da37a, 0x8a7fb0, 0xb7a06d];
const GLASS = [0x5e88a8, 0x4f7590, 0x6b9bb5, 0x7b8f9c, 0x3f6f8a, 0x8fb0c4, 0x55707f];
const LOW = [0xd8cfc0, 0xbfb6a8, 0xc9b8a0, 0xa9a49c, 0xd2c4b0, 0xb39b84, 0xe0dcd2];

export interface CityResult {
  group: THREE.Group;
  roads: RoadSeg[];
  streetLights: THREE.Vector3[];
  beacons: THREE.Vector3[];
}

export function buildCity(world: World): CityResult {
  const group = new THREE.Group();
  group.name = 'city';
  const b = new Builder(world);
  const R = rng(20251111);
  const roads: RoadSeg[] = [];
  const parks = new FlatBuilder();
  const green = new THREE.Color(0x4f7a3a), green2 = new THREE.Color(0x6a9a45), plaza = new THREE.Color(0xa6a299);

  // ── 송도 블록 ──
  forBlocks((i, j, u0, u1, v0, v1) => {
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    const zone = zoneAt(uc, vc);
    const { at, wu, wv } = blockFrame(u0, u1, v0, v1, i, j);
    const blockQuad = (col: THREE.Color, inset = 0, y = G + 0.06) => {
      const hu = wu / 2 - inset, hv = wv / 2 - inset;
      const p = [at(-hu, -hv), at(hu, -hv), at(hu, hv), at(-hu, hv)];
      parks.quad(...(p.map((q) => new THREE.Vector3(q.x, y, q.z)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]), col);
    };
    const add = (a: number, bb: number, w: number, d: number, h: number, color: number | THREE.Color, style: BStyle, floorH = 3, rotOff = 0) => {
      const p = at(a, bb);
      b.add({ x: p.x, z: p.z, w, d, h, rot: SD_ROT + rotOff, base: G, color, style, floorH, seed: R() });
    };
    switch (zone) {
      case 'park': case 'golf':
        blockQuad(zone === 'golf' ? green2 : green, 0, G + 0.05);
        if (zone === 'golf' && R() < 0.4) { const p = new THREE.Color(0x8fbf5a); blockQuad(p, 60, G + 0.09); }
        break;
      case 'apt': case 'aptHigh': {
        blockQuad(new THREE.Color(0x5d7d4c), 6);
        const high = zone === 'aptHigh';
        const tower = R() < 0.3; // 탑상형
        const colW = tower ? 50 : 62, rowD = high ? 62 : 72;
        const cols = Math.max(1, Math.floor((wu - 50) / colW)), rows = Math.max(1, Math.floor((wv - 50) / rowD));
        const base = APT_COLORS[(R() * APT_COLORS.length) | 0];
        const accent = APT_ACCENT[(R() * APT_ACCENT.length) | 0];
        const floorsBase = high ? 42 : 27 + R() * 12;
        for (let cI = 0; cI < cols; cI++) for (let rI = 0; rI < rows; rI++) {
          if (R() < 0.08) continue;
          const a = -((cols - 1) * colW) / 2 + cI * colW + (R() - 0.5) * 6;
          const bb = -((rows - 1) * rowD) / 2 + rI * rowD + (R() - 0.5) * 6;
          const floors = Math.round(floorsBase + (R() - 0.3) * (high ? 22 : 12));
          const h = floors * 2.9;
          const w = tower ? 26 : 34 + R() * 8, d = tower ? 26 : 15 + R() * 3;
          add(a, bb, w, d, h, base, BStyle.Apartment, 2.9);
          if (R() < 0.45) add(a, bb, w * 0.4, d * 0.6, h + 6, accent, BStyle.Plain);
        }
        // 단지 상가
        if (R() < 0.6) add(-wu / 2 + 30, -wv / 2 + 18, 45, 22, 9, LOW[(R() * LOW.length) | 0], BStyle.Low, 4.2);
        break;
      }
      case 'office': {
        blockQuad(plaza, 4);
        const n = 1 + ((R() * 3) | 0);
        const glass = GLASS[(R() * GLASS.length) | 0];
        // 저층부
        add(0, wv * 0.18, wu * 0.8, wv * 0.4, 14 + R() * 12, LOW[(R() * LOW.length) | 0], BStyle.Glass, 4.5);
        for (let k = 0; k < n; k++) {
          const a = (k - (n - 1) / 2) * (wu / Math.max(n, 1.5)) * 0.85;
          const s = 34 + R() * 16;
          const floors = 22 + R() * 30 + (uc < 3.2 ? 12 : 0);
          add(a, -wv * 0.15, s, s * (0.8 + R() * 0.3), floors * 3.9, glass, BStyle.Office, 3.9);
        }
        break;
      }
      case 'commercial': {
        blockQuad(plaza, 4);
        for (let k = 0; k < 4; k++) {
          const a = (R() - 0.5) * (wu - 100), bb = (R() - 0.5) * (wv - 80);
          add(a, bb, 60 + R() * 50, 40 + R() * 30, 12 + R() * 18, LOW[(R() * LOW.length) | 0], BStyle.Low, 5);
        }
        break;
      }
      case 'campus': {
        blockQuad(green, 4);
        const n = 4 + ((R() * 4) | 0);
        for (let k = 0; k < n; k++) {
          const a = (R() - 0.5) * (wu - 90), bb = (R() - 0.5) * (wv - 60);
          const col = R() < 0.5 ? 0xb5715a : 0xe6e2da;
          add(a, bb, 50 + R() * 40, 18 + R() * 10, 14 + R() * 18, col, BStyle.Low, 3.8, R() < 0.3 ? Math.PI / 2 : 0);
        }
        break;
      }
      case 'industrial': {
        blockQuad(plaza, 4);
        const n = 1 + ((R() * 2) | 0);
        for (let k = 0; k < n; k++) {
          const a = (k - (n - 1) / 2) * wu * 0.48;
          add(a, (R() - 0.5) * 60, wu * (n === 1 ? 0.7 : 0.4), wv * 0.55, 16 + R() * 18, R() < 0.5 ? 0xe8ecee : 0xd5dde4, BStyle.Industrial, 6);
        }
        add(wu * 0.3, wv * 0.35, 30, 18, 28 + R() * 20, 0xdfe5ea, BStyle.Office, 4);
        break;
      }
      case 'eleven': {
        blockQuad(new THREE.Color(0x8a8268), 2);
        if (R() < 0.35) {
          for (let k = 0; k < 4; k++) {
            const floors = 10 + R() * 35;
            add((k % 2 - 0.5) * 120, ((k >> 1) - 0.5) * 120, 34, 16, floors * 2.9, 0xd9d6cf, BStyle.Apartment, 2.9);
          }
        }
        break;
      }
      default: break;
    }
  });

  // 해안 공원(송도 가장자리 녹지)
  {
    const poly = songdoPts();
    const n = poly.length;
    for (let k = 0; k < n; k++) {
      const a = poly[k], c = poly[(k + 1) % n];
      const dx = c.x - a.x, dz = c.z - a.z, L = Math.hypot(dx, dz);
      const nx = dz / L, nz = -dx / L; // 안쪽 법선은 다각형 감김에 따라 다름 → 중점으로 판단
      const mid = { x: (a.x + c.x) / 2 + nx * 40, z: (a.z + c.z) / 2 + nz * 40 };
      const s = pointInPoly(mid.x, mid.z, poly) ? 1 : -1;
      const off = 90 * s;
      const p = [a, c, { x: c.x + nx * off, z: c.z + nz * off }, { x: a.x + nx * off, z: a.z + nz * off }];
      parks.quad(...(p.map((q) => new THREE.Vector3(q.x, G + 0.04, q.z)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]), green);
    }
  }

  // ── 송도 도로 ──
  const roadMeshB = new FlatBuilder();
  const asphalt = new THREE.Color(0x3a3c40);
  const poly = songdoPts();
  const lineRuns = (fixed: 'u' | 'v', val: number, from: number, to: number, w: number, skipZones: boolean) => {
    const step = 0.025;
    let start: number | null = null;
    for (let t = from; t <= to + 1e-9; t += step) {
      const p = fixed === 'u' ? sd(val, t) : sd(t, val);
      const uu = fixed === 'u' ? val : t, vv = fixed === 'u' ? t : val;
      const z = zoneAt(uu, vv);
      const blocked = skipZones && (z === 'park' || z === 'golf' || z === 'campus');
      const inside = sdfPoly(p.x, p.z, poly) > 20 && !blocked;
      if (inside && start === null) start = t;
      if ((!inside || t + step > to + 1e-9) && start !== null) {
        const end = inside ? t : t - step;
        if (end - start > 0.05) {
          const a = fixed === 'u' ? sd(val, start) : sd(start, val);
          const c = fixed === 'u' ? sd(val, end) : sd(end, val);
          roads.push({ a, b: c, width: w, y: G + 0.12 });
        }
        start = null;
      }
    }
  };
  for (let k = 0; k <= GRID.nu; k++) lineRuns('u', GRID.u0 + k * GRID.du, -0.2, 6, roadW(mainU(k)), !mainU(k));
  for (let j = 0; j <= GRID.nv; j++) lineRuns('v', GRID.v0 + j * GRID.dv, -1.6, 10.8, roadW(mainV(j)), !mainV(j));
  // 송도 ↔ 내륙 다리 (수로 건너기) + 신항 연결
  for (const u of [0.15, 1.5, 3.0, 4.2, 5.55, 7.05, 8.4]) roads.push({ a: sd(u, -0.35), b: sd(u, 0.2), width: 40, y: G + 0.12, ya: 3.5, yb: G + 0.12 });
  roads.push({ a: sd(4.65, 5.2), b: sd(4.65, 6.1), width: 36, y: G + 0.12 });

  // ── 내륙·영종 건물 ──
  scatterTown(world, b, R, { x0: -5600, x1: 13500, n0: -6.5, n1: 18.5 }, 150, 0.46);
  scatterTown(world, b, R, { x0: -10200, x1: -6400, n0: 5.2, n1: 9.4 }, 120, 0.3, true);
  scatterTown(world, b, R, { x0: -14500, x1: -10200, n0: 9.5, n1: 14.2 }, 170, 0.62);

  // ── 인천신항 ──
  buildNewPort(world, b, group, R);

  // ── 랜드마크 ──
  buildLandmarks(world, b, group);

  const inst = b.build();
  group.add(inst);

  // 도로 메시
  const streetLights: THREE.Vector3[] = [];
  for (const r of roads) {
    const dx = r.b.x - r.a.x, dz = r.b.z - r.a.z, L = Math.hypot(dx, dz);
    const nx = -dz / L, nz = dx / L, hw = r.width / 2;
    const ya = r.ya ?? r.y, yb = r.yb ?? r.y;
    roadMeshB.quad(
      new THREE.Vector3(r.a.x + nx * hw, ya, r.a.z + nz * hw), new THREE.Vector3(r.b.x + nx * hw, yb, r.b.z + nz * hw),
      new THREE.Vector3(r.b.x - nx * hw, yb, r.b.z - nz * hw), new THREE.Vector3(r.a.x - nx * hw, ya, r.a.z - nz * hw),
      asphalt, [0, 0, L / 10, 0, L / 10, r.width / 10, 0, r.width / 10],
    );
    for (let s = 20; s < L; s += 45) {
      const t = s / L;
      for (const side of [-1, 1]) streetLights.push(new THREE.Vector3(r.a.x + dx * t + nx * (hw + 2) * side, r.y + 9, r.a.z + dz * t + nz * (hw + 2) * side));
    }
  }
  const roadMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, map: makeRoadTexture() });
  const roadMesh = new THREE.Mesh(roadMeshB.geometry(), roadMat);
  roadMesh.receiveShadow = true;
  roadMesh.renderOrder = 1;
  group.add(roadMesh);

  const parkMesh = new THREE.Mesh(parks.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  parkMesh.receiveShadow = true;
  group.add(parkMesh);

  // 공원 수로 (얕은 물 장식)
  const water = new THREE.MeshStandardMaterial({ color: 0x2e6a82, roughness: 0.05, metalness: 0.2 });
  for (const w of WATER_DECALS) {
    const shape = new THREE.Shape(w.pts.map((p) => new THREE.Vector2(p.x, -p.z)));
    const g = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, water);
    m.position.y = G + 0.18;
    m.receiveShadow = true;
    group.add(m);
  }
  return { group, roads, streetLights, beacons: b.beacons };
}

function makeRoadTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d8d8d8';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`; g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2); }
  // 차선 점선 (가로 방향 = 길이 방향)
  g.fillStyle = '#ffffff';
  g.fillRect(0, 62, 60, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 자연 지형 위 마을·아파트 단지 흩뿌리기 */
function scatterTown(world: World, b: Builder, R: () => number, area: { x0: number; x1: number; n0: number; n1: number }, cell: number, thresh: number, dense = false) {
  const hf = world.hf;
  const songdo = songdoPts();
  for (let x = area.x0; x <= area.x1; x += cell) {
    for (let nk = area.n0 * 1000; nk <= area.n1 * 1000; nk += cell) {
      const z = -nk;
      const px = x + (R() - 0.5) * cell * 0.4, pz = z + (R() - 0.5) * cell * 0.4;
      const h = hf.at(px, pz);
      if (h < 3 || h > 70) continue;
      if (hf.slope(px, pz) > 0.13) continue;
      if (pointInPoly(px, pz, songdo)) continue;
      const dens = fbm(px / 1800 + 7, pz / 1800 + 3, 3);
      if (!dense && dens < thresh) continue;
      // 해안에서 조금 떨어진 곳만
      if (hf.at(px + 120, pz) < 0.5 || hf.at(px - 120, pz) < 0.5 || hf.at(px, pz + 120) < 0.5 || hf.at(px, pz - 120) < 0.5) continue;
      const rot = Math.floor(fbm(px / 2500, pz / 2500, 2) * 8) * (Math.PI / 16);
      const cs = Math.cos(rot), sn = Math.sin(rot);
      const place = (a: number, c: number, w: number, d: number, hh: number, col: number, style: BStyle, fh: number) => {
        const wx = px + a * cs + c * sn, wz = pz - a * sn + c * cs;
        const g0 = Math.min(hf.at(wx - w / 2, wz), hf.at(wx + w / 2, wz), hf.at(wx, wz - d / 2), hf.at(wx, wz + d / 2));
        const g1 = Math.max(hf.at(wx - w / 2, wz), hf.at(wx + w / 2, wz), hf.at(wx, wz - d / 2), hf.at(wx, wz + d / 2));
        if (g0 < 1) return;
        b.add({ x: wx, z: wz, w, d, h: hh + (g1 - g0), rot, base: g0 - 0.5, color: col, style, floorH: fh, seed: R() });
      };
      const aptChance = dense ? 0.9 : dens > thresh + 0.12 ? 0.55 : 0.12;
      if (R() < aptChance) {
        const col = APT_COLORS[(R() * APT_COLORS.length) | 0];
        const floors = dense ? 25 + R() * 15 : 15 + R() * 20;
        for (let k = 0; k < 2; k++) place(-cell * 0.22 + k * cell * 0.45, (R() - 0.5) * 20, 32, 15, floors * 2.9 * (0.85 + R() * 0.3), col, BStyle.Apartment, 2.9);
      } else {
        const n = 2 + ((R() * 3) | 0);
        for (let k = 0; k < n; k++) {
          const w = 12 + R() * 14, d = 10 + R() * 10;
          place((R() - 0.5) * (cell - 30), (R() - 0.5) * (cell - 30), w, d, 6 + R() * 12, LOW[(R() * LOW.length) | 0], BStyle.Low, 3);
        }
      }
    }
  }
}

/** 인천신항: 컨테이너 크레인과 야적장 */
function buildNewPort(world: World, b: Builder, group: THREE.Group, R: () => number) {
  // 야적장 컨테이너 줄
  const cols = [0xc0392b, 0x2e86c1, 0x27ae60, 0xd68910, 0x7d3c98, 0x839192, 0xa04000];
  for (let u = 3.0; u < 6.3; u += 0.045) {
    for (let v = 6.3; v < 8.0; v += 0.07) {
      if (R() < 0.15) continue;
      const p = sd(u, v);
      const stack = 1 + ((R() * 4) | 0);
      b.add({ x: p.x, z: p.z, w: 12.2, d: 30, h: stack * 2.6, rot: SD_ROT + Math.PI / 2, base: G, color: cols[(R() * cols.length) | 0], style: BStyle.Plain, collide: true });
    }
  }
  // 안벽 크레인 (바다 쪽 = V 큰 쪽)
  const red = new THREE.MeshStandardMaterial({ color: 0xc8382c, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.6 });
  for (let k = 0; k < 9; k++) {
    const u = 3.2 + k * 0.38;
    const v = 8.45 + (u - 2.9) * (0.25 / 4);
    const p = sd(u, v);
    const crane = makeCrane(red, white);
    crane.position.set(p.x, G, p.z);
    crane.rotation.y = SD_ROT;
    group.add(crane);
    world.addBox({ x: p.x, z: p.z, hx: 12, hz: 18, c: Math.cos(SD_ROT), s: -Math.sin(SD_ROT), base: G, top: G + 72, noRoof: true });
  }
}

function makeCrane(red: THREE.Material, white: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const leg = new THREE.BoxGeometry(2, 50, 2);
  for (const [x, z] of [[-10, -14], [10, -14], [-10, 14], [10, 14]]) {
    const m = new THREE.Mesh(leg, red); m.position.set(x, 25, z); m.castShadow = true; g.add(m);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(24, 6, 4), red); beam.position.set(0, 52, -14); g.add(beam);
  const beam2 = beam.clone(); beam2.position.z = 14; g.add(beam2);
  // 붐: V(+z 지역) 방향, 바다 쪽으로 길게
  const boom = new THREE.Mesh(new THREE.BoxGeometry(5, 4, 110), white); boom.position.set(0, 56, 35); boom.castShadow = true; g.add(boom);
  const house = new THREE.Mesh(new THREE.BoxGeometry(8, 7, 10), white); house.position.set(0, 61, -5); g.add(house);
  const a = new THREE.Mesh(new THREE.BoxGeometry(2, 22, 2), red); a.position.set(0, 70, -10); g.add(a);
  return g;
}

/** 이름 있는 건물들 */
function buildLandmarks(world: World, b: Builder, group: THREE.Group) {
  const mat = buildingMaterial;
  const addMesh = (geo: THREE.BufferGeometry, at: P2, y: number, rot: number, style: BStyle, color: number, floorH: number, seed = 0.3) => {
    setStyle(geo, style, seed, floorH, y);
    const c = new THREE.Color(color);
    const cols = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < cols.length; i += 3) { cols[i] = c.r; cols[i + 1] = c.g; cols[i + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const m = new THREE.Mesh(geo, landmarkMat(mat));
    m.position.set(at.x, y, at.z);
    m.rotation.y = rot;
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const box = (at: P2, w: number, d: number, top: number, rot = SD_ROT, base = G) =>
    world.addBox({ x: at.x, z: at.z, hx: w / 2, hz: d / 2, c: Math.cos(rot), s: -Math.sin(rot), base, top });

  // 동북아무역센터 NEATT: 305m, 위로 갈수록 가늘어지는 사각 기둥 + 비스듬한 왕관
  {
    const at = sd(2.45, 2.22);
    const g = new THREE.CylinderGeometry(19, 33, 280, 4, 12).rotateY(Math.PI / 4).translate(0, 140, 0);
    addMesh(g, at, G, SD_ROT, BStyle.Glass, 0x7fa5bd, 4.1, 0.71);
    const crown = new THREE.CylinderGeometry(6, 19, 25, 4).rotateY(Math.PI / 4).translate(0, 292, 0);
    addMesh(crown, at, G, SD_ROT, BStyle.Plain, 0xa9c2d2, 4);
    const pod = new THREE.BoxGeometry(110, 22, 80).translate(0, 11, 0);
    addMesh(pod, sd(2.45, 2.32), G, SD_ROT, BStyle.Glass, 0x9fb4c0, 5.5);
    box(at, 50, 50, G + 305);
    box(sd(2.45, 2.32), 110, 80, G + 22);
    b.beacons.push(new THREE.Vector3(at.x, G + 307, at.z));
  }
  // G타워 (33층) + 트라이볼
  {
    const at = sd(2.0, 2.15);
    addMesh(new THREE.BoxGeometry(48, 150, 30).translate(0, 75, 0), at, G, SD_ROT, BStyle.Glass, 0x6d95ad, 4.2, 0.2);
    addMesh(new THREE.BoxGeometry(56, 8, 36).translate(0, 152, 0), at, G, SD_ROT, BStyle.Plain, 0xd8dde0, 4);
    box(at, 56, 36, G + 156);
    const tb = sd(2.24, 1.87);
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.35, metalness: 0.1 });
    for (let k = 0; k < 3; k++) {
      const off = { x: tb.x + U.x * (k - 1) * 38, z: tb.z + U.y * (k - 1) * 38 };
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(22, 8, 12, 24), white);
      bowl.position.set(off.x, G + 8 + k * 1.5, off.z);
      bowl.castShadow = true;
      group.add(bowl);
      world.addBox({ x: off.x, z: off.z, hx: 18, hz: 18, c: 1, s: 0, base: G, top: G + 14 + k * 1.5 });
    }
  }
  // 포스코타워 송도 (쌍둥이)
  {
    for (const du of [-0.04, 0.04]) {
      const at = sd(4.55 + du, 2.68);
      addMesh(new THREE.BoxGeometry(38, 165, 26).translate(0, 82.5, 0), at, G, SD_ROT, BStyle.Glass, 0x5f8296, 4.2, 0.5 + du);
      box(at, 38, 26, G + 165);
      b.beacons.push(new THREE.Vector3(at.x, G + 167, at.z));
    }
  }
  // 더샵 퍼스트월드 (원통형 고층 4동)
  {
    for (let k = 0; k < 4; k++) {
      const at = sd(2.78 + (k % 2) * 0.17, 2.72 + (k >> 1) * 0.16);
      const h = 190 + k * 8;
      addMesh(new THREE.CylinderGeometry(17, 17, h, 20).translate(0, h / 2, 0), at, G, SD_ROT, BStyle.Apartment, 0xe2e4e6, 2.9, 0.1 * k);
      box(at, 32, 32, G + h, 0);
      b.beacons.push(new THREE.Vector3(at.x, G + h + 1.5, at.z));
    }
  }
  // 송도컨벤시아: 낮은 전시장 + 삼각 지붕 줄
  {
    const at = sd(3.95, 2.72);
    addMesh(new THREE.BoxGeometry(280, 18, 120).translate(0, 9, 0), at, G, SD_ROT, BStyle.Glass, 0xb7c3c9, 6);
    for (let k = 0; k < 6; k++) {
      const g = new THREE.ConeGeometry(34, 16, 4).rotateY(Math.PI / 4).scale(1, 1, 2.2).translate(-115 + k * 46, 26, 0);
      addMesh(g, at, G, SD_ROT, BStyle.Plain, 0xd9dfe2, 4);
    }
    box(at, 280, 120, G + 28);
  }
  // 송도 한옥마을: 낮은 기와집들
  {
    const roof = new THREE.MeshStandardMaterial({ color: 0x3b3f44, roughness: 0.8 });
    const wall = new THREE.MeshStandardMaterial({ color: 0xe9e1cf, roughness: 0.9 });
    for (let k = 0; k < 10; k++) {
      const u = 4.3 + (k % 5) * 0.035, v = 1.99 + Math.floor(k / 5) * 0.045;
      const at = sd(u, v);
      const body = new THREE.Mesh(new THREE.BoxGeometry(20, 5, 11), wall);
      body.position.set(at.x, G + 2.5, at.z); body.rotation.y = SD_ROT; body.castShadow = true;
      const r = new THREE.Mesh(new THREE.ConeGeometry(15, 5, 4).rotateY(Math.PI / 4).scale(1.4, 1, 0.75), roof);
      r.position.set(at.x, G + 7.3, at.z); r.rotation.y = SD_ROT; r.castShadow = true;
      group.add(body, r);
      box(at, 20, 11, G + 8);
    }
  }
  // 아울렛, 인천대 본관, 연세대 언더우드관 비슷한 시계탑(창작)
  {
    const at = sd(5.45, 3.6);
    addMesh(new THREE.BoxGeometry(260, 22, 130).translate(0, 11, 0), at, G, SD_ROT, BStyle.Low, 0xcab89c, 5.5);
    box(at, 260, 130, G + 22);
    const inu = sd(3.8, 4.1);
    addMesh(new THREE.BoxGeometry(70, 70, 40).translate(0, 35, 0), inu, G, SD_ROT, BStyle.Glass, 0x8aa3b5, 4);
    box(inu, 70, 40, G + 70);
    const tower = sd(6.7, 2.5);
    addMesh(new THREE.BoxGeometry(14, 42, 14).translate(0, 21, 0), tower, G, SD_ROT, BStyle.Low, 0xb5715a, 4);
    box(tower, 14, 14, G + 42);
  }
  // 바이오 단지 연구동 (창작한 이름 없는 큰 공장들은 블록에서 생성)
  // 달빛축제공원 무대
  {
    const at = sd(1.65, 1.42);
    const stage = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 1.5, 32, 1, false, 0, Math.PI), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
    stage.position.set(at.x, G + 0.8, at.z);
    stage.rotation.y = SD_ROT;
    group.add(stage);
  }
  // 청량산 송신탑 (창작)
  void km;
}

const lmCache = new Map<THREE.Material, THREE.Material>();
function landmarkMat(base: THREE.MeshStandardMaterial): THREE.Material {
  let m = lmCache.get(base);
  if (!m) {
    const c = base.clone();
    c.vertexColors = true;
    c.onBeforeCompile = base.onBeforeCompile;
    c.customProgramCacheKey = () => 'landmark';
    lmCache.set(base, c);
    m = c;
  }
  return m;
}

export { SONGDO_UV };

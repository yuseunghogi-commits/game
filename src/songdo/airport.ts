// 인천국제공항: 활주로(표지 텍스처), 유도로, 계류장, 여객터미널, 관제탑, 주기된 여객기, 활주로 등화.
import * as THREE from 'three';
import { AP_D, AP_P, AP_ROT, RUNWAYS, ap, km, runwayEnds, type P2, type Runway } from './geo';
import type { World } from './world';
import { FlatBuilder, buildingMaterial } from './builder';
import { BStyle, setStyle } from './materials';
import { makeAirlinerMesh } from './aircraftModels';
import type { RoadSeg } from './city';

const D = new THREE.Vector2(AP_D.e, -AP_D.n); // 월드 (x,z)
const Pv = new THREE.Vector2(AP_P.e, -AP_P.n);
const GY = 6; // 공항 지면 높이

export interface AirportResult {
  group: THREE.Group;
  lights: { pos: THREE.Vector3; color: THREE.Color }[];
  roads: RoadSeg[];
}

/** 공항 좌표 (d,p km) + 지역 오프셋(m) → 월드 */
function apm(d: number, p: number, dm = 0, pm = 0): P2 {
  const b = ap(d, p);
  return { x: b.x + D.x * dm + Pv.x * pm, z: b.z + D.y * dm + Pv.y * pm };
}

function runwayTexture(r: Runway): THREE.Texture {
  const W = 256, H = 4096;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4a4c50'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 6000; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.15})`; g.fillRect(Math.random() * W, Math.random() * H, 3, 3); }
  // 타이어 자국
  g.fillStyle = 'rgba(20,20,20,0.35)';
  for (const y0 of [260, H - 900]) g.fillRect(W * 0.35, y0, W * 0.3, 640);
  const m = H / r.len; // px per m
  g.fillStyle = '#f4f4f4';
  // 가장자리 선
  g.fillRect(4, 0, 4, H); g.fillRect(W - 8, 0, 4, H);
  // 중앙선 점선 (30m 선 + 20m 간격)
  for (let y = 120 * m; y < H - 120 * m; y += 50 * m) g.fillRect(W / 2 - 2, y, 4, 30 * m);
  // 활주로 시단 표지 (피아노 건반) + 번호
  const ends: [number, string, boolean][] = [[0, r.a, false], [H, r.b, true]];
  for (const [y0, label, flip] of ends) {
    const dir = flip ? -1 : 1;
    for (let k = 0; k < 16; k++) {
      if (k === 7 || k === 8) continue;
      const x = 14 + k * 14.5;
      g.fillRect(x, flip ? y0 - 6 - 45 * m : y0 + 6, 9, 45 * m);
    }
    g.save();
    g.translate(W / 2, y0 + dir * (6 + 60 * m));
    if (!flip) g.rotate(Math.PI);
    g.font = `bold ${Math.round(30 * m * 1.4)}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, 0, 0);
    g.restore();
    // 접지 구역 표지
    for (let k = 0; k < 3; k++) {
      const yy = y0 + dir * (300 + k * 150) * m;
      g.fillRect(W * 0.2, yy, 14, 22 * m * dir);
      g.fillRect(W * 0.8 - 14, yy, 14, 22 * m * dir);
    }
    const aim = y0 + dir * 400 * m;
    g.fillRect(W * 0.26, aim, 22, 50 * m * dir);
    g.fillRect(W * 0.74 - 22, aim, 22, 50 * m * dir);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  return t;
}

export function buildAirport(world: World): AirportResult {
  const group = new THREE.Group();
  group.name = 'airport';
  const lights: AirportResult['lights'] = [];
  const white = new THREE.Color(1, 0.95, 0.85), green = new THREE.Color(0.2, 1, 0.3), red = new THREE.Color(1, 0.15, 0.1), blue = new THREE.Color(0.3, 0.5, 1);

  // 활주로
  for (const r of RUNWAYS) {
    const { a, b } = runwayEnds(r);
    const c = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const geo = new THREE.PlaneGeometry(r.width, r.len).rotateX(-Math.PI / 2);
    // PlaneGeometry: 지역 -z(위쪽 v=1)… 텍스처 v=1이 a(시작)쪽이 되도록 회전
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: runwayTexture(r), roughness: 0.85 }));
    mesh.position.set(c.x, GY + 0.1, c.z);
    // 지역 +z(텍스처 아래, v=0 → 캔버스 아래 = b 끝)가 D 방향
    mesh.rotation.y = Math.atan2(D.x, D.y);
    mesh.receiveShadow = true;
    group.add(mesh);
    // 갓길
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(r.width + 30, r.len + 120).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x6e7068, roughness: 1 }));
    sh.position.set(c.x, GY + 0.05, c.z);
    sh.rotation.y = mesh.rotation.y;
    sh.receiveShadow = true;
    group.add(sh);
    // 등화
    const L = r.len, hw = r.width / 2 + 1.5;
    for (let s = 0; s <= L; s += 60) {
      for (const side of [-1, 1]) {
        lights.push({ pos: v3(apm(r.d0 - L / 2000, r.p, s, side * hw), GY + 0.6), color: white });
      }
    }
    for (let s = 60; s < L - 60; s += 30) lights.push({ pos: v3(apm(r.d0 - L / 2000, r.p, s, 0), GY + 0.3), color: s < 900 || s > L - 900 ? new THREE.Color(1, 0.5, 0.4) : white });
    for (let k = -8; k <= 8; k++) {
      lights.push({ pos: v3(apm(r.d0 - L / 2000, r.p, -1, k * 3.6), GY + 0.6), color: green });
      lights.push({ pos: v3(apm(r.d0 + L / 2000, r.p, 1, k * 3.6), GY + 0.6), color: green });
    }
    // 진입등 (양쪽 끝 바깥 900m)
    for (const [d0, dir] of [[r.d0 - L / 2000, -1], [r.d0 + L / 2000, 1]] as [number, number][]) {
      for (let s = 30; s <= 900; s += 30) {
        const w = s % 150 === 0 ? 5 : 1;
        for (let k = -w; k <= w; k++) lights.push({ pos: v3(apm(d0, r.p, dir * s, k * 2.5), GY + 1.0), color: white });
      }
    }
  }

  // 유도로 · 계류장
  const fb = new FlatBuilder();
  const taxi = new THREE.Color(0x55575a), apron = new THREE.Color(0x8e9092);
  const rect = (d0: number, d1: number, p0: number, p1: number, col: THREE.Color, y = GY + 0.08) => {
    const pts = [ap(d0, p0), ap(d1, p0), ap(d1, p1), ap(d0, p1)];
    fb.quad(...(pts.map((q) => new THREE.Vector3(q.x, y, q.z)) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]), col);
  };
  // 평행 유도로
  for (const p of [-0.95, 0.75, 2.35, 3.65]) rect(-2.4, 1.4, p - 0.012, p + 0.012, taxi);
  // 연결 유도로
  for (const d of [-2.35, -1.6, -0.9, -0.2, 0.5, 1.2]) {
    rect(d - 0.012, d + 0.012, -1.2, 1.0, taxi, GY + 0.07);
    rect(d - 0.012, d + 0.012, 1.0, 3.9, taxi, GY + 0.07);
  }
  // 계류장
  rect(-0.6, 0.55, -0.75, 0.55, apron, GY + 0.09); // T1 앞
  rect(-1.55, -1.05, -0.75, 0.55, apron, GY + 0.09); // 탑승동
  rect(-2.9, -1.9, 1.25, 2.2, apron, GY + 0.09); // T2
  rect(0.7, 1.4, 1.2, 2.2, apron, GY + 0.09); // 화물
  const flat = new THREE.Mesh(fb.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  flat.receiveShadow = true;
  group.add(flat);
  // 유도로 중심 녹색등
  for (const p of [-0.95, 0.75, 2.35, 3.65]) for (let d = -2.4; d <= 1.4; d += 0.06) lights.push({ pos: v3(ap(d, p), GY + 0.3), color: green });
  for (const p of [-0.95, 0.75, 2.35, 3.65]) for (let d = -2.4; d <= 1.4; d += 0.12) for (const s of [-1, 1]) lights.push({ pos: v3(ap(d, p + s * 0.016), GY + 0.4), color: blue });

  // 터미널 건물 (곡선 지붕 형태를 여러 상자로 근사)
  const addB = (geo: THREE.BufferGeometry, at: P2, rot: number, style: BStyle, color: number, top: number, hx: number, hz: number, floorH = 6) => {
    setStyle(geo, style, 0.4, floorH, GY);
    const cl = new THREE.Color(color);
    const cols = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < cols.length; i += 3) { cols[i] = cl.r; cols[i + 1] = cl.g; cols[i + 2] = cl.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const m = new THREE.Mesh(geo, apMat());
    m.position.set(at.x, GY, at.z);
    m.rotation.y = rot;
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    if (hx > 0) world.addBox({ x: at.x, z: at.z, hx, hz, c: Math.cos(rot), s: -Math.sin(rot), base: GY, top: GY + top });
  };
  const terminal = (cd: number, cp: number, span: number, depth: number, face: 1 | -1) => {
    // 활주로 방향(D)으로 길게, 곡선형 배치
    const n = 9;
    for (let k = 0; k < n; k++) {
      const t = (k / (n - 1) - 0.5) * 2; // -1..1
      const along = t * span / 2;
      const bow = (1 - t * t) * 90 * face;
      const at = apm(cd, cp, along, bow);
      const ang = AP_ROT + Math.atan((-2 * t * 90 * face) / (span / 2));
      const segL = span / n + 8;
      addB(new THREE.BoxGeometry(segL, 24, depth).translate(0, 12, 0), at, ang, BStyle.Glass, 0xc9d3da, 24, segL / 2, depth / 2, 8);
      // 곡면 지붕
      const roof = new THREE.CylinderGeometry(depth * 0.62, depth * 0.62, segL, 16, 1, false, -Math.PI / 2.6, Math.PI / 1.3).rotateZ(Math.PI / 2).scale(1, 0.28, 1).translate(0, 24, 0);
      addB(roof, at, ang, BStyle.Plain, 0xe9edf0, 0, 0, 0);
    }
  };
  terminal(0.15, -0.15, 1050, 140, -1); // T1
  terminal(-2.45, 2.05, 750, 120, 1); // T2
  // 탑승동 (긴 건물)
  addB(new THREE.BoxGeometry(900, 20, 55).translate(0, 10, 0), ap(-1.3, -0.1), AP_ROT, BStyle.Glass, 0xc3cdd4, 20, 450, 27.5);
  // 연결 통로
  addB(new THREE.BoxGeometry(30, 12, 600).translate(0, 10, 0), ap(-0.75, -0.1), AP_ROT, BStyle.Glass, 0xbfc7cc, 0, 0, 0);
  // 관제탑 (약 100m)
  {
    const at = ap(-0.9, 0.95);
    const shaft = new THREE.CylinderGeometry(7, 10, 92, 16).translate(0, 46, 0);
    addB(shaft, at, 0, BStyle.Plain, 0xe4e6e8, 92, 9, 9);
    const cab = new THREE.CylinderGeometry(15, 11, 12, 16).translate(0, 98, 0);
    addB(cab, at, 0, BStyle.Glass, 0x4f6f88, 104, 12, 12, 3);
    lights.push({ pos: new THREE.Vector3(at.x, GY + 106, at.z), color: red });
  }
  // 정비 격납고 · 화물터미널
  for (let k = 0; k < 4; k++) addB(new THREE.BoxGeometry(120, 32, 90).translate(0, 16, 0), ap(0.8 + k * 0.15, 1.55), AP_ROT, BStyle.Industrial, 0xdfe3e6, 32, 60, 45);
  for (let k = 0; k < 3; k++) addB(new THREE.BoxGeometry(110, 26, 90).translate(0, 13, 0), ap(-3.4 + k * 0.15, 1.1), AP_ROT, BStyle.Industrial, 0xd4dbe0, 26, 55, 45);

  // 주기된 여객기
  const parked = makeAirlinerMesh({ livery: 0x1f4e9a, accent: 0xd6a536 });
  const parked2 = makeAirlinerMesh({ livery: 0x7a8fa3, accent: 0x3a6fb0 });
  const gates: { at: P2; rot: number; m: THREE.Object3D }[] = [];
  for (let k = 0; k < 8; k++) gates.push({ at: apm(-0.45 + k * 0.13, -0.15, 0, 140), rot: noseRot(-Pv.x, -Pv.y), m: k % 2 ? parked : parked2 });
  for (let k = 0; k < 6; k++) gates.push({ at: apm(-1.62 + k * 0.12, -0.1, 0, 70), rot: noseRot(-Pv.x, -Pv.y), m: k % 2 ? parked2 : parked });
  for (let k = 0; k < 5; k++) gates.push({ at: apm(-2.75 + k * 0.13, 2.05, 0, -150), rot: noseRot(Pv.x, Pv.y), m: k % 2 ? parked : parked2 });
  for (const g of gates) {
    const m = g.m.clone();
    m.position.set(g.at.x, GY + 3.6, g.at.z);
    m.rotation.y = g.rot;
    group.add(m);
    world.addBox({ x: g.at.x, z: g.at.z, hx: 4, hz: 4, c: 1, s: 0, base: GY, top: GY + 12, noRoof: true });
  }

  // 공항 ↔ 인천대교 고속도로
  const roads: RoadSeg[] = [];
  const hw: P2[] = [ap(1.1, -0.55), ap(2.6, -0.2), km(-13.5, 4.9), km(-12.0, 5.3), km(-10.9, 5.6)];
  for (let k = 0; k < hw.length - 1; k++) roads.push({ a: hw[k], b: hw[k + 1], width: 34, y: GY + 0.2 });
  // 터미널 앞 도로
  roads.push({ a: apm(-0.5, -0.15, 0, -170), b: apm(0.8, -0.15, 0, -170), width: 30, y: GY + 0.15 });
  return { group, lights, roads };
}

/** 기수(지역 -z)를 월드 방향 (dx,dz)로 향하게 하는 Y 회전 */
export const noseRot = (dx: number, dz: number) => Math.atan2(-dx, -dz);

function v3(p: P2, y: number) { return new THREE.Vector3(p.x, y, p.z); }

let apMatCache: THREE.Material | null = null;
function apMat(): THREE.Material {
  if (apMatCache) return apMatCache;
  const c = buildingMaterial.clone();
  c.vertexColors = true;
  c.onBeforeCompile = buildingMaterial.onBeforeCompile;
  c.customProgramCacheKey = () => 'landmark';
  apMatCache = c;
  return c;
}

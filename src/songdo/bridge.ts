// 인천대교: 영종도 ↔ 송도 해상 다리 (약 10km), 가운데 800m 사장교 구간과 역Y자 주탑 2개.
import * as THREE from 'three';
import { BRIDGE_MAIN_SPAN, INCHEON_BRIDGE, LANDMARKS, km, sd, type P2 } from './geo';
import type { World } from './world';
import type { RoadSeg } from './city';

export interface BridgeResult { group: THREE.Group; lights: THREE.Vector3[]; beacons: THREE.Vector3[]; roads: RoadSeg[]; path: { p: P2; y: number }[] }

const PROFILE: [number, number][] = [
  [0, 0], [0.06, 18], [0.25, 38], [0.42, 64], [BRIDGE_MAIN_SPAN.from, 74], [BRIDGE_MAIN_SPAN.to, 74], [0.6, 64], [0.8, 36], [0.94, 16], [1, 0],
];
const HALF_W = 16;

function profileAt(t: number, y0: number, y1: number): number {
  const last = PROFILE.length - 1;
  for (let i = 0; i < last; i++) {
    const [a, ya0] = PROFILE[i], [b, yb0] = PROFILE[i + 1];
    if (t < a || t > b) continue;
    const ya = i === 0 ? y0 : ya0, yb = i + 1 === last ? y1 : yb0;
    const k = (t - a) / (b - a);
    return ya + (yb - ya) * k * k * (3 - 2 * k);
  }
  return y1;
}

export function buildBridge(world: World): BridgeResult {
  const group = new THREE.Group();
  group.name = 'bridge';
  const ctrl = [km(-10.9, 5.6), ...INCHEON_BRIDGE];
  const curve = new THREE.CatmullRomCurve3(ctrl.map((p) => new THREE.Vector3(p.x, 0, p.z)), false, 'centripetal');
  const N = 220;
  const pts = curve.getSpacedPoints(N);
  const y0 = world.terrain(pts[0].x, pts[0].z) + 0.4;
  const y1 = world.terrain(pts[N].x, pts[N].z) + 0.4;
  const path = pts.map((p, i) => ({ p: { x: p.x, z: p.z }, y: profileAt(i / N, y0, y1) }));

  // 상판 (상자 인스턴스)
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x9a9da0, roughness: 0.8 });
  const topMat = new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.9 });
  const deck = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), deckMat, N);
  const top = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), topMat, N);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const lights: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) {
    const a = path[i], b = path[i + 1];
    const dx = b.p.x - a.p.x, dz = b.p.z - a.p.z, dy = b.y - a.y;
    const L = Math.hypot(dx, dz);
    // 지역 z축을 진행 방향으로
    e.set(-Math.atan2(dy, L), Math.atan2(dx, dz), 0, 'YXZ');
    q.setFromEuler(e);
    const mid = new THREE.Vector3((a.p.x + b.p.x) / 2, (a.y + b.y) / 2, (a.p.z + b.p.z) / 2);
    m.compose(mid.clone().setY(mid.y - 1.6), q, new THREE.Vector3(HALF_W * 2, 3, Math.hypot(L, dy) + 0.6));
    deck.setMatrixAt(i, m);
    m.compose(mid.clone().setY(mid.y - 0.05), q, new THREE.Vector3(HALF_W * 2 - 2, 0.12, Math.hypot(L, dy) + 0.6));
    top.setMatrixAt(i, m);
    world.addDeck({ a: a.p, b: b.p, ya: a.y, yb: b.y, half: HALF_W });
    const nx = dz / L, nz = -dx / L;
    for (const s of [-1, 1]) lights.push(new THREE.Vector3(a.p.x + nx * (HALF_W - 0.5) * s, a.y + 1.2, a.p.z + nz * (HALF_W - 0.5) * s));
  }
  deck.castShadow = true; deck.receiveShadow = true; top.receiveShadow = true;
  group.add(deck, top);

  // 교각
  const pierMat = new THREE.MeshStandardMaterial({ color: 0xb8bbbd, roughness: 0.85 });
  const pierGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const piers: THREE.Matrix4[] = [];
  const tFrom = BRIDGE_MAIN_SPAN.from, tTo = BRIDGE_MAIN_SPAN.to;
  for (let i = 2; i < N - 1; i += 2) {
    const t = i / N;
    if (t > tFrom - 0.005 && t < tTo + 0.005) continue;
    const a = path[i];
    const ground = Math.max(world.terrain(a.p.x, a.p.z), -12);
    const h = a.y - 3 - ground;
    if (h < 2) continue;
    const b = path[i + 1];
    const yaw = Math.atan2(b.p.x - a.p.x, b.p.z - a.p.z);
    for (const s of [-1, 1]) {
      const nx = Math.cos(yaw) * s * 8, nz = -Math.sin(yaw) * s * 8;
      piers.push(new THREE.Matrix4().compose(new THREE.Vector3(a.p.x + nx, ground, a.p.z + nz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(4, h, 6)));
      world.addBox({ x: a.p.x + nx, z: a.p.z + nz, hx: 2.5, hz: 3.5, c: Math.cos(yaw), s: -Math.sin(yaw), base: ground, top: a.y - 3.2, noRoof: true });
    }
  }
  const pierMesh = new THREE.InstancedMesh(pierGeo, pierMat, piers.length);
  piers.forEach((pm, i) => pierMesh.setMatrixAt(i, pm));
  pierMesh.castShadow = true;
  group.add(pierMesh);

  // 주탑 (역Y자, 높이 238.5m) + 사장 케이블
  const beacons: THREE.Vector3[] = [];
  const towerMat = new THREE.MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.7 });
  const cablePts: THREE.Vector3[] = [];
  const towerIdx = [Math.round(tFrom * N), Math.round(tTo * N)];
  for (const ti of towerIdx) {
    const a = path[ti], b = path[ti + 1];
    const yaw = Math.atan2(b.p.x - a.p.x, b.p.z - a.p.z);
    const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)); // 다리 옆 방향
    const base = new THREE.Vector3(a.p.x, -2, a.p.z);
    const H = 238.5, joinH = 175, spread = 36;
    const tg = new THREE.Group();
    tg.position.copy(base);
    tg.rotation.y = yaw;
    for (const s of [-1, 1]) {
      // 다리(기둥) 한쪽: 바닥 ±spread → joinH에서 중앙
      const len = Math.hypot(spread, joinH);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(6, len, 9), towerMat);
      leg.position.set(s * spread / 2, joinH / 2, 0);
      leg.rotation.z = s * Math.atan2(spread, joinH);
      leg.castShadow = true;
      tg.add(leg);
      for (let k = 0; k < 4; k++) {
        const hh = (k + 0.5) * joinH / 4;
        const off = spread * (1 - hh / joinH);
        world.addBox({ x: base.x + side.x * off * s, z: base.z + side.z * off * s, hx: 4, hz: 5, c: Math.cos(yaw), s: -Math.sin(yaw), base: hh - joinH / 8, top: hh + joinH / 8, noRoof: true });
      }
    }
    const col = new THREE.Mesh(new THREE.BoxGeometry(7, H - joinH + 4, 9), towerMat);
    col.position.set(0, joinH + (H - joinH) / 2 - 2, 0);
    col.castShadow = true;
    tg.add(col);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(spread * 1.2, 5, 8), towerMat);
    beam.position.set(0, a.y - 6, 0);
    tg.add(beam);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(spread * 2 + 20, 8, 30), towerMat);
    foot.position.set(0, 2, 0);
    tg.add(foot);
    group.add(tg);
    world.addBox({ x: base.x, z: base.z, hx: 4, hz: 5, c: Math.cos(yaw), s: -Math.sin(yaw), base: joinH - 5, top: H, noRoof: true });
    beacons.push(new THREE.Vector3(base.x, H + 1, base.z));
    // 케이블: 주탑 위쪽에서 상판 양쪽 가장자리로 부채꼴
    for (let k = 1; k <= 14; k++) {
      for (const dir of [-1, 1]) {
        const j = ti + dir * k;
        if (j < 0 || j > N) continue;
        const p = path[j];
        const topY = joinH + 10 + k * 3.8;
        for (const s of [-1, 1]) {
          cablePts.push(new THREE.Vector3(base.x, topY, base.z));
          cablePts.push(new THREE.Vector3(p.p.x + side.x * (HALF_W - 1) * s, p.y + 0.5, p.p.z + side.z * (HALF_W - 1) * s));
        }
      }
    }
  }
  const cables = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(cablePts), new THREE.LineBasicMaterial({ color: 0xe8e8e8 }));
  group.add(cables);
  // 랜드마크 위치 보정
  const lm = LANDMARKS.find((l) => l.id === 'bridge');
  if (lm) { const a = path[towerIdx[0]].p, b = path[towerIdx[1]].p; lm.at = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }; }

  // 송도 쪽 연결 도로
  const end = path[N].p;
  const roads: RoadSeg[] = [{ a: end, b: sd(0.15, 1.75), width: 34, y: 4.12 }];
  return { group, lights, beacons, roads, path };
}

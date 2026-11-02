// 행성 위 시설 모형 (저폴리, 코드로 생성). 크기는 행성 반지름 1 기준 — 잘 보이도록 과장되어 있다.
// 상태 표시: 건설 중 = 반투명 골조, 정지·고장 = 어둡게, 머리 위 표시등 = 전조(주황)·고장(빨강)·선택(시안).

import * as THREE from 'three';
import type { SizeId, TypeId } from '../sim/data';

const lam = (color: number, emissive = 0x000000) => new THREE.MeshLambertMaterial({ color, emissive });
const MAT = {
  // 밤에도 윤곽이 보이도록 약한 자체 발광을 둔다
  concrete: lam(0x9aa3ad, 0x2a3038),
  dark: lam(0x2a3440, 0x141a22),
  white: lam(0xe4e8ec, 0x3a4048),
  panel: lam(0x1f4f7a, 0x123a5c),
  battery: lam(0x4f9a6a, 0x183a26),
  amber: lam(0xf2b248, 0x7a5010),
  steel: lam(0x8b95a1, 0x262a30),
  glow: new THREE.MeshBasicMaterial({ color: 0x4fd1e0 }),
};
const GHOST = new THREE.MeshBasicMaterial({ color: 0x8b95a1, wireframe: true, transparent: true, opacity: 0.55 });
const OFF = lam(0x3a4350, 0x050608);
const LAMP = { warning: 0xf2b248, failed: 0xe5604d, inspection: 0x4fd1e0, selected: 0x4fd1e0 };

// 공유 지오메트리
const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 12),
  sphereHalf: new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
  tower: (() => {
    // 냉각탑: 쌍곡면 회전체
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 10; i++) { const y = i / 10; pts.push(new THREE.Vector2(0.75 + 0.45 * Math.pow(y - 0.65, 2) * 2.2, y)); }
    return new THREE.LatheGeometry(pts, 16);
  })(),
  blade: (() => { const g = new THREE.BoxGeometry(0.06, 1, 0.02); g.translate(0, 0.5, 0); return g; })(),
  lamp: new THREE.SphereGeometry(1, 10, 8),
};

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y + (geo === G.box || geo === G.cyl ? sy / 2 : 0), z);
  m.userData.base = mat;
  return m;
}

const U = 0.022; // 기본 단위 (행성 반지름 1 기준)

function thermal(g: THREE.Group) {
  g.add(mesh(G.box, MAT.concrete, 2.4 * U, 0.7 * U, 1.6 * U, -0.4 * U, 0, 0));
  const t = mesh(G.tower, MAT.white, 0.75 * U, 2.6 * U, 0.75 * U, 1.3 * U, 0, 0.3 * U);
  g.add(t);
  g.add(mesh(G.cyl, MAT.steel, 0.12 * U, 3.6 * U, 0.12 * U, -1.2 * U, 0, -0.4 * U));
  g.add(mesh(G.cyl, MAT.amber, 0.13 * U, 0.25 * U, 0.13 * U, -1.2 * U, 3.2 * U, -0.4 * U));
}

function nuclear(g: THREE.Group) {
  g.add(mesh(G.box, MAT.concrete, 3.2 * U, 0.5 * U, 2.2 * U, 0, 0, 0));
  const dome = mesh(G.cyl, MAT.white, 0.9 * U, 1.1 * U, 0.9 * U, -0.8 * U, 0.5 * U, 0);
  g.add(dome);
  const cap = new THREE.Mesh(G.sphereHalf, MAT.white);
  cap.userData.base = MAT.white;
  cap.scale.setScalar(0.9 * U);
  cap.position.set(-0.8 * U, 1.6 * U, 0);
  g.add(cap);
  g.add(mesh(G.tower, MAT.concrete, 1.0 * U, 3.4 * U, 1.0 * U, 1.4 * U, 0, -0.6 * U));
  g.add(mesh(G.tower, MAT.concrete, 0.9 * U, 3.0 * U, 0.9 * U, 1.6 * U, 0, 1.2 * U));
}

function solar(g: THREE.Group) {
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const p = mesh(G.box, MAT.panel, 1.0 * U, 0.06 * U, 0.6 * U, i * 1.15 * U, 0.25 * U, j * 0.8 * U);
    p.rotation.x = -0.45;
    g.add(p);
    g.add(mesh(G.cyl, MAT.steel, 0.05 * U, 0.3 * U, 0.05 * U, i * 1.15 * U, 0, j * 0.8 * U));
  }
}

function wind(g: THREE.Group) {
  const spots = [[0, 0], [1.6, 0.8], [-1.4, 1.0]];
  for (const [x, z] of spots) {
    g.add(mesh(G.cyl, MAT.white, 0.1 * U, 3.6 * U, 0.1 * U, x * U, 0, z * U));
    g.add(mesh(G.box, MAT.white, 0.18 * U, 0.16 * U, 0.4 * U, x * U, 3.55 * U, z * U));
    const rotor = new THREE.Group();
    rotor.position.set(x * U, 3.62 * U, (z + 0.24) * U);
    rotor.userData.rotor = true;
    for (let k = 0; k < 3; k++) {
      const b = new THREE.Mesh(G.blade, MAT.white);
      b.userData.base = MAT.white;
      b.scale.set(1.6 * U, 1.5 * U, 1.6 * U);
      b.rotation.z = (k * Math.PI * 2) / 3;
      rotor.add(b);
    }
    rotor.rotation.z = x;
    g.add(rotor);
  }
}

function storage(g: THREE.Group) {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
    g.add(mesh(G.box, MAT.battery, 1.2 * U, 0.5 * U, 0.45 * U, (i - 1) * 1.3 * U, 0, (j - 0.5) * 0.65 * U));
    g.add(mesh(G.box, MAT.amber, 1.21 * U, 0.06 * U, 0.46 * U, (i - 1) * 1.3 * U, 0.38 * U, (j - 0.5) * 0.65 * U));
  }
}

function substation(g: THREE.Group) {
  for (const x of [-1, 1]) for (const z of [-1, 1]) g.add(mesh(G.cyl, MAT.steel, 0.05 * U, 1.8 * U, 0.05 * U, x * 1.0 * U, 0, z * 0.7 * U));
  for (const z of [-1, 1]) g.add(mesh(G.box, MAT.steel, 2.1 * U, 0.06 * U, 0.06 * U, 0, 1.7 * U, z * 0.7 * U));
  g.add(mesh(G.box, MAT.dark, 0.8 * U, 0.6 * U, 0.6 * U, 0, 0, 0));
  g.add(mesh(G.box, MAT.glow, 0.3 * U, 0.05 * U, 0.3 * U, 0, 0.62 * U, 0));
}

const BUILDERS: Record<TypeId, (g: THREE.Group) => void> = { thermal, nuclear, solar, wind, storage, substation };
const SIZE_SCALE: Record<SizeId, number> = { small: 0.75, medium: 1, large: 1.35 };

export function buildFacilityModel(type: TypeId, size: SizeId, modules: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Group();
  BUILDERS[type](body);
  // 모듈 확장: 옆에 같은 모형을 작게 덧붙인다
  for (let k = 0; k < modules; k++) {
    const extra = new THREE.Group();
    BUILDERS[type](extra);
    extra.scale.setScalar(0.6);
    extra.position.set((k === 0 ? 1 : -1) * 3.2 * U, 0, 1.6 * U);
    body.add(extra);
  }
  g.add(body);
  const lamp = new THREE.Mesh(G.lamp, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
  lamp.scale.setScalar(0.35 * U);
  lamp.position.set(0, 5 * U, 0);
  lamp.visible = false;
  lamp.userData.lamp = true;
  g.add(lamp);
  g.scale.setScalar(SIZE_SCALE[size]);
  g.userData.mode = 'on';
  return g;
}

export function setModelState(g: THREE.Group, mode: 'on' | 'off' | 'build', health: string, time: number, selected: boolean) {
  if (g.userData.mode !== mode) {
    g.userData.mode = mode;
    g.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.userData.lamp) return;
      o.material = mode === 'build' ? GHOST : mode === 'off' ? OFF : o.userData.base;
    });
  }
  const lamp = g.children.find((c) => c.userData.lamp) as THREE.Mesh | undefined;
  if (!lamp) return;
  const color = health === 'failed' ? LAMP.failed : health === 'warning' ? LAMP.warning : health === 'inspection' ? LAMP.inspection : selected ? LAMP.selected : null;
  lamp.visible = color !== null;
  if (color !== null) {
    const m = lamp.material as THREE.MeshBasicMaterial;
    m.color.setHex(color);
    m.opacity = 0.55 + 0.45 * Math.sin(time / (health === 'failed' ? 140 : 300));
  }
}

export function spinRotors(g: THREE.Group, delta: number) {
  if (!delta) return;
  g.traverse((o) => { if (o.userData.rotor) o.rotation.z += delta; });
}

// 인천국제공항: 실제 활주로 4개(번호·표지 텍스처), 활주로 등화, 탑승구에 세운 여객기.
// 터미널·탑승동·격납고 건물은 지도 자료의 실제 외곽선으로 따로 그려진다.
import * as THREE from 'three';
import type { Meta } from './data';
import type { World } from './world';
import { headingOf, type P2 } from './geo';
import { makeAirlinerMesh } from './aircraftModels';

export interface RunwayInfo { ref: string; label: string; a: P2; b: P2; len: number; width: number; heading: number; labelA: string; labelB: string }

/** "15L/33R" → a 끝(착륙 방향 a→b) 번호 고르기 */
export function runwayInfo(r: Meta['runways'][number]): RunwayInfo {
  const a = { x: r.a[0], z: r.a[1] }, b = { x: r.b[0], z: r.b[1] };
  const hdg = headingOf(b.x - a.x, b.z - a.z);
  const [p, q] = r.ref.split('/');
  const num = (s: string) => parseInt(s, 10) * 10;
  const diff = (x: number) => Math.abs(((x - (hdg + 8.5) + 540) % 360) - 180); // 자북 편차 약 -8.5°
  const aIsP = diff(num(p)) < diff(num(q));
  return {
    ref: r.ref, label: r.name || r.ref, a, b, len: Math.hypot(b.x - a.x, b.z - a.z), width: r.width, heading: hdg,
    labelA: aIsP ? p : q, labelB: aIsP ? q : p,
  };
}

function runwayTexture(r: RunwayInfo): THREE.Texture {
  const W = 256, H = 4096;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4c4e52'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 7000; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.14})`; g.fillRect(Math.random() * W, Math.random() * H, 3, 3); }
  g.fillStyle = 'rgba(20,20,20,0.35)';
  for (const y0 of [220, H - 860]) g.fillRect(W * 0.33, y0, W * 0.34, 640);
  const m = H / r.len;
  g.fillStyle = '#f4f4f4';
  g.fillRect(4, 0, 4, H); g.fillRect(W - 8, 0, 4, H);
  for (let y = 120 * m; y < H - 120 * m; y += 50 * m) g.fillRect(W / 2 - 2, y, 4, 30 * m);
  const ends: [number, string, boolean][] = [[0, r.labelA, false], [H, r.labelB, true]];
  for (const [y0, label, flip] of ends) {
    const dir = flip ? -1 : 1;
    for (let k = 0; k < 16; k++) {
      if (k === 7 || k === 8) continue;
      g.fillRect(14 + k * 14.5, flip ? y0 - 6 - 45 * m : y0 + 6, 9, 45 * m);
    }
    g.save();
    g.translate(W / 2, y0 + dir * (6 + 66 * m));
    if (!flip) g.rotate(Math.PI);
    g.font = `bold ${Math.round(30 * m * 1.3)}px sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(label, 0, 0);
    g.restore();
    for (let k = 0; k < 3; k++) {
      const yy = y0 + dir * (300 + k * 150) * m;
      g.fillRect(W * 0.2, Math.min(yy, yy + 22 * m * dir), 14, 22 * m);
      g.fillRect(W * 0.8 - 14, Math.min(yy, yy + 22 * m * dir), 14, 22 * m);
    }
    const aim = y0 + dir * 400 * m;
    g.fillRect(W * 0.26, Math.min(aim, aim + 50 * m * dir), 22, 50 * m);
    g.fillRect(W * 0.74 - 22, Math.min(aim, aim + 50 * m * dir), 22, 50 * m);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  return t;
}

export interface AirportResult { group: THREE.Group; lights: { pos: THREE.Vector3; color: THREE.Color }[]; runways: RunwayInfo[] }

export const noseRot = (dx: number, dz: number) => Math.atan2(-dx, -dz);

export function buildAirport(meta: Meta, world: World): AirportResult {
  const group = new THREE.Group();
  group.name = 'airport';
  const lights: AirportResult['lights'] = [];
  const GY = meta.airportH;
  const white = new THREE.Color(1, 0.95, 0.85), green = new THREE.Color(0.2, 1, 0.3), red = new THREE.Color(1, 0.15, 0.1);
  const runways = meta.runways.map(runwayInfo);
  for (const r of runways) {
    const c = { x: (r.a.x + r.b.x) / 2, z: (r.a.z + r.b.z) / 2 };
    const dx = (r.b.x - r.a.x) / r.len, dz = (r.b.z - r.a.z) / r.len;
    const rot = Math.atan2(dx, dz);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(r.width, r.len).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: runwayTexture(r), roughness: 0.85 }));
    mesh.position.set(c.x, world.terrain(c.x, c.z) + 0.45, c.z);
    mesh.rotation.y = rot;
    mesh.receiveShadow = true;
    group.add(mesh);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(r.width + 24, r.len + 100).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x77796f, roughness: 1 }));
    sh.position.set(c.x, world.terrain(c.x, c.z) + 0.4, c.z);
    sh.rotation.y = rot;
    sh.receiveShadow = true;
    group.add(sh);
    const at = (s: number, off: number, y: number) => new THREE.Vector3(r.a.x + dx * s - dz * off, GY + y, r.a.z + dz * s + dx * off);
    const hw = r.width / 2 + 1.5;
    for (let s = 0; s <= r.len; s += 60) for (const sd of [-1, 1]) lights.push({ pos: at(s, sd * hw, 0.9), color: white });
    for (let s = 60; s < r.len - 60; s += 30) lights.push({ pos: at(s, 0, 0.6), color: s < 900 || s > r.len - 900 ? new THREE.Color(1, 0.5, 0.4) : white });
    for (let k = -8; k <= 8; k++) { lights.push({ pos: at(-1, k * 3.6, 0.9), color: green }); lights.push({ pos: at(r.len + 1, k * 3.6, 0.9), color: green }); }
    for (const [s0, dir] of [[0, -1], [r.len, 1]] as [number, number][]) {
      for (let s = 30; s <= 900; s += 30) {
        const w = s % 150 === 0 ? 5 : 1;
        for (let k = -w; k <= w; k++) lights.push({ pos: at(s0 + dir * s, k * 2.5, 1.2), color: white });
      }
    }
  }
  // 탑승구 여객기: 가장 가까운 큰 건물(터미널) 쪽으로 기수
  const liveries = [makeAirlinerMesh({ livery: 0x1f4e9a, accent: 0xd6a536 }), makeAirlinerMesh({ livery: 0x7a8fa3, accent: 0x3a6fb0 }), makeAirlinerMesh({ livery: 0xb03a2e, accent: 0x222222 }), makeAirlinerMesh({ livery: 0x2f7d5b, accent: 0xe0e0e0 })];
  let gi = 0;
  const used: P2[] = [];
  for (const [gx, gz] of meta.gates) {
    if (used.some((u) => Math.hypot(u.x - gx, u.z - gz) < 45)) continue;
    // 가장 가까운 건물 벽
    let best = Infinity, bx = 0, bz = 0;
    for (const p of world.polys) {
      if (p.top - p.base < 12 || gx < p.x0 - 150 || gx > p.x1 + 150 || gz < p.z0 - 150 || gz > p.z1 + 150) continue;
      const a = p.pts;
      for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
        const ax = a[j], az = a[j + 1], ex = a[i] - ax, ez = a[i + 1] - az, l2 = ex * ex + ez * ez || 1;
        const t = Math.min(1, Math.max(0, ((gx - ax) * ex + (gz - az) * ez) / l2));
        const qx = ax + ex * t, qz = az + ez * t, d = Math.hypot(gx - qx, gz - qz);
        if (d < best) { best = d; bx = qx; bz = qz; }
      }
    }
    if (best > 140) continue;
    const dx = (bx - gx) / (best || 1), dz = (bz - gz) / (best || 1);
    const cx = bx - dx * 30, cz = bz - dz * 30;
    if (world.hitAt(cx, GY + 4, cz)) continue;
    used.push({ x: gx, z: gz });
    const m = liveries[gi++ % liveries.length].clone();
    m.position.set(cx, GY + 3.6, cz);
    m.rotation.y = noseRot(dx, dz);
    group.add(m);
    world.addBox({ x: cx, z: cz, hx: 3, hz: 3, c: 1, s: 0, base: GY, top: GY + 12, noRoof: true });
    if (gi > 70) break;
  }
  void red;
  return { group, lights, runways };
}

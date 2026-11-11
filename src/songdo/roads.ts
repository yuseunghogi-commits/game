// 실제 도로·철도·유도로를 지형 위 띠 메시로 깐다. 다리 구간은 자료의 상판 높이를 쓰고 교각을 세운다.
import * as THREE from 'three';
import { RC, type Roads } from './data';
import type { HeightField } from './heightfield';
import type { World } from './world';
import { withImagery } from './imagery';

export interface RoadLine { cls: number; width: number; pts: THREE.Vector3[]; bridge: boolean }

/** 종류별 높이 띄움 (교차로 겹침 방지) */
const LIFT: Record<number, number> = { 1: 0.42, 2: 0.4, 3: 0.38, 4: 0.36, 5: 0.34, 6: 0.3, 7: 0.28, 8: 0.26, 9: 0.24, 10: 0.33, 11: 0.33, 12: 0.2, 13: 0.18 };

export function processRoads(r: Roads, hf: HeightField): RoadLine[] {
  const lines: RoadLine[] = [];
  for (let i = 0; i < r.n; i++) {
    const s = r.start[i], c = r.count[i], cls = r.cls[i];
    const lift = LIFT[cls] ?? 0.3;
    const pts: THREE.Vector3[] = [];
    let bridge = false;
    const elev = (k: number) => r.y[s + k] - hf.at(r.x[s + k], r.z[s + k]) > 2;
    for (let k = 0; k < c; k++) {
      const x = r.x[s + k], z = r.z[s + k];
      const e = elev(k);
      if (e) bridge = true;
      if (k > 0) {
        // 지면 구간은 25m마다 점을 넣어 지형에 붙인다
        const px = r.x[s + k - 1], pz = r.z[s + k - 1];
        const L = Math.hypot(x - px, z - pz);
        const pe = elev(k - 1);
        const n = Math.floor(L / 25);
        for (let j = 1; j < n; j++) {
          const t = j / n, ix = px + (x - px) * t, iz = pz + (z - pz) * t;
          const y = pe && e ? r.y[s + k - 1] + (r.y[s + k] - r.y[s + k - 1]) * t : hf.at(ix, iz) + lift;
          pts.push(new THREE.Vector3(ix, y, iz));
        }
      }
      pts.push(new THREE.Vector3(x, e ? r.y[s + k] : hf.at(x, z) + lift, z));
    }
    lines.push({ cls, width: r.width[i], pts, bridge });
  }
  return lines;
}

function makeTex(kind: 'road' | 'major' | 'rail' | 'taxi' | 'foot'): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d')!;
  const base = kind === 'rail' ? '#7a736b' : kind === 'foot' ? '#c9c2b6' : kind === 'taxi' ? '#5d5f62' : '#46484c';
  g.fillStyle = base; g.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 1600; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${Math.random() * 0.07})`; g.fillRect(Math.random() * 64, Math.random() * 256, 2, 2); }
  if (kind === 'road') { g.fillStyle = '#e8e8e0'; g.fillRect(31, 0, 2, 110); }
  if (kind === 'major') {
    g.fillStyle = '#e6c84a'; g.fillRect(30, 0, 1.5, 256); g.fillRect(32.5, 0, 1.5, 256);
    g.fillStyle = '#e8e8e0';
    for (const x of [15, 47]) g.fillRect(x, 0, 1.5, 110);
    g.fillRect(2, 0, 1.2, 256); g.fillRect(61, 0, 1.2, 256);
  }
  if (kind === 'taxi') { g.fillStyle = '#e7c235'; g.fillRect(31, 0, 2, 256); g.fillStyle = '#e7c235'; g.fillRect(1, 0, 1, 256); g.fillRect(62, 0, 1, 256); }
  if (kind === 'rail') {
    g.fillStyle = '#4b3a2c';
    for (let y = 0; y < 256; y += 16) g.fillRect(8, y, 48, 6);
    g.fillStyle = '#b8b8b8'; g.fillRect(18, 0, 3, 256); g.fillRect(43, 0, 3, 256);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export interface RoadResult { group: THREE.Group; lights: THREE.Vector3[] }

export function buildRoads(lines: RoadLine[], hf: HeightField, world: World): RoadResult {
  const group = new THREE.Group();
  group.name = 'roads';
  const kinds = { road: makeTex('road'), major: makeTex('major'), rail: makeTex('rail'), taxi: makeTex('taxi'), foot: makeTex('foot') };
  type K = keyof typeof kinds;
  const bufs: Record<K, { pos: number[]; uv: number[]; idx: number[] }> = { road: { pos: [], uv: [], idx: [] }, major: { pos: [], uv: [], idx: [] }, rail: { pos: [], uv: [], idx: [] }, taxi: { pos: [], uv: [], idx: [] }, foot: { pos: [], uv: [], idx: [] } };
  const side = { pos: [] as number[], idx: [] as number[] };
  const piers: THREE.Matrix4[] = [];
  const lights: THREE.Vector3[] = [];
  const kindOf = (cls: number): K => cls <= 3 ? 'major' : cls <= 8 ? 'road' : cls === 9 ? 'foot' : cls <= 11 ? 'rail' : 'taxi';
  for (const ln of lines) {
    const K = kindOf(ln.cls);
    const B = bufs[K];
    const hw = ln.width / 2;
    const pts = ln.pts;
    const n = pts.length;
    if (n < 2) continue;
    const v0 = B.pos.length / 3;
    let dist = 0;
    for (let k = 0; k < n; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
      let dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      // 꺾인 곳 이음 (마이터, 너무 길면 제한)
      let nx = -dz, nz = dx;
      if (k > 0 && k < n - 1) {
        const p = pts[k - 1], c = pts[k], q = pts[k + 1];
        const d1x = c.x - p.x, d1z = c.z - p.z, l1 = Math.hypot(d1x, d1z) || 1;
        const d2x = q.x - c.x, d2z = q.z - c.z, l2 = Math.hypot(d2x, d2z) || 1;
        const m1x = -d1z / l1, m1z = d1x / l1, m2x = -d2z / l2, m2z = d2x / l2;
        let mx = m1x + m2x, mz = m1z + m2z;
        const ml = Math.hypot(mx, mz) || 1;
        mx /= ml; mz /= ml;
        const cos = mx * m1x + mz * m1z;
        const sc = 1 / Math.max(0.5, cos);
        nx = mx * sc; nz = mz * sc;
      }
      if (k > 0) dist += pts[k].distanceTo(pts[k - 1]);
      const p = pts[k];
      B.pos.push(p.x + nx * hw, p.y, p.z + nz * hw, p.x - nx * hw, p.y, p.z - nz * hw);
      const u = dist / (K === 'rail' ? 6 : 12);
      B.uv.push(0, u, 1, u);
      if (k > 0) {
        const i = v0 + k * 2;
        // 위를 향하게 감기
        const a0 = i - 2, a1 = i - 1, b0 = i, b1 = i + 1;
        const ax = B.pos[a0 * 3], az = B.pos[a0 * 3 + 2], bx = B.pos[b0 * 3], bz = B.pos[b0 * 3 + 2], cx = B.pos[a1 * 3], cz = B.pos[a1 * 3 + 2];
        const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        if (ny > 0) B.idx.push(a0, b0, a1, a1, b0, b1); else B.idx.push(a0, a1, b0, a1, b1, b0);
      }
    }
    // 다리: 상판 옆면·교각·충돌·조명
    if (ln.bridge) {
      let lastPier = -1e9;
      let d2 = 0;
      for (let k = 0; k < n - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        const ga = Math.max(hf.at(a.x, a.z), -12), gb = Math.max(hf.at(b.x, b.z), -12);
        const ea = a.y - Math.max(ga, 0) > 2.5, eb = b.y - Math.max(gb, 0) > 2.5;
        const segL = a.distanceTo(b);
        d2 += segL;
        if (!(ea || eb)) continue;
        world.addDeck({ a: { x: a.x, z: a.z }, b: { x: b.x, z: b.z }, ya: a.y, yb: b.y, half: hw + 0.5 });
        // 옆면 (두께 2m)
        const dx = (b.x - a.x) / (segL || 1), dz = (b.z - a.z) / (segL || 1);
        for (const s of [-1, 1]) {
          const ox = -dz * hw * s, oz = dx * hw * s;
          const i = side.pos.length / 3;
          side.pos.push(a.x + ox, a.y + 0.1, a.z + oz, b.x + ox, b.y + 0.1, b.z + oz, b.x + ox, b.y - 2.2, b.z + oz, a.x + ox, a.y - 2.2, a.z + oz);
          side.idx.push(i, i + 1, i + 2, i, i + 2, i + 3, i, i + 2, i + 1, i, i + 3, i + 2);
        }
        if (d2 - lastPier > 55 && ea) {
          lastPier = d2;
          const h = a.y - 2.2 - ga;
          if (h > 3) {
            const yaw = Math.atan2(dx, dz);
            piers.push(new THREE.Matrix4().compose(new THREE.Vector3(a.x, ga, a.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(Math.min(ln.width * 0.8, 14), h, 3.5)));
            world.addBox({ x: a.x, z: a.z, hx: Math.min(ln.width * 0.4, 7), hz: 1.8, c: Math.cos(yaw), s: -Math.sin(yaw), base: ga, top: a.y - 2.3, noRoof: true });
          }
        }
        if (ln.cls <= 3 && Math.floor(d2 / 50) !== Math.floor((d2 - segL) / 50)) {
          lights.push(new THREE.Vector3(a.x - dz * (hw - 0.3), a.y + 1.1, a.z + dx * (hw - 0.3)), new THREE.Vector3(a.x + dz * (hw - 0.3), a.y + 1.1, a.z - dx * (hw - 0.3)));
        }
      }
    } else if (ln.cls <= 5) {
      // 가로등
      let d2 = 0;
      for (let k = 0; k < n - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        const L = a.distanceTo(b);
        for (let s = (40 - (d2 % 40)); s < L; s += 40) {
          const t = s / L, dx = (b.x - a.x) / L, dz = (b.z - a.z) / L;
          for (const sd of [-1, 1]) lights.push(new THREE.Vector3(a.x + (b.x - a.x) * t - dz * (hw + 1.5) * sd, a.y + (b.y - a.y) * t + 9, a.z + (b.z - a.z) * t + dx * (hw + 1.5) * sd));
        }
        d2 += L;
      }
    }
  }
  for (const k of Object.keys(bufs) as K[]) {
    const B = bufs[k];
    if (!B.idx.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
    g.setIndex(B.idx);
    g.computeVertexNormals();
    const rm = new THREE.MeshStandardMaterial({ map: kinds[k], roughness: k === 'foot' ? 0.95 : 0.85 });
    if (k !== 'rail' && k !== 'taxi') withImagery(rm, 'road');
    const m = new THREE.Mesh(g, rm);
    m.receiveShadow = true;
    m.name = 'roads-' + k;
    group.add(m);
  }
  if (side.idx.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(side.pos, 3));
    g.setIndex(side.idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xa9acae, roughness: 0.85 }));
    m.castShadow = true;
    group.add(m);
  }
  if (piers.length) {
    const pm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0xb7babc, roughness: 0.85 }), piers.length);
    piers.forEach((m, i) => pm.setMatrixAt(i, m));
    pm.castShadow = true;
    pm.computeBoundingSphere();
    group.add(pm);
  }
  return { group, lights };
}

export { RC };

// 나무: 공원·숲·가로수 위치(자료)에 낮은 다각형 나무를 인스턴스로 심는다. 카메라 근처 조각만 만든다.
import * as THREE from 'three';
import type { Trees } from './data';
import type { HeightField } from './heightfield';

const CHUNK = 600, NEAR_R = 2600, FAR_R = 3400;

function treeGeometry(): THREE.BufferGeometry {
  const crown = new THREE.IcosahedronGeometry(1, 1);
  crown.scale(0.55, 0.62, 0.55).translate(0, 0.62, 0);
  const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.36, 5).translate(0, 0.18, 0);
  const parts: [THREE.BufferGeometry, [number, number, number]][] = [[crown, [1, 1, 1]], [trunk, [0.55, 0.42, 0.32]]];
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  for (const [g0, c] of parts) {
    const g = g0.toNonIndexed();
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
      // 수관 아래쪽은 조금 어둡게
      const shade = c[0] === 1 ? 0.75 + 0.25 * Math.min(1, p.getY(i) / 1.0) : 1;
      col.push(c[0] * shade, c[1] * shade, c[2] * shade);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

const GREENS = [[0.23, 0.38, 0.18], [0.28, 0.44, 0.2], [0.2, 0.33, 0.17], [0.33, 0.47, 0.22], [0.25, 0.4, 0.24]];

export class TreeSet {
  readonly group = new THREE.Group();
  private chunks = new Map<number, { ids: number[]; cx: number; cz: number; mesh: THREE.InstancedMesh | null }>();
  private geo = treeGeometry();
  private mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  constructor(private t: Trees, private hf: HeightField) {
    this.group.name = 'trees';
    for (let i = 0; i < t.n; i++) {
      const k = (Math.floor(t.x[i] / CHUNK) + 1000) * 4096 + Math.floor(t.z[i] / CHUNK) + 1000;
      let c = this.chunks.get(k);
      if (!c) this.chunks.set(k, (c = { ids: [], cx: (Math.floor(t.x[i] / CHUNK) + 0.5) * CHUNK, cz: (Math.floor(t.z[i] / CHUNK) + 0.5) * CHUNK, mesh: null }));
      c.ids.push(i);
    }
  }
  prime(cam: THREE.Vector3) { this.update(cam, 1e9); }
  /** 점이 나무 수관(타원체) 안인가 (카메라가 나무 속으로 들어가지 않게) */
  inCrown(p: THREE.Vector3): boolean {
    const c = this.chunks.get((Math.floor(p.x / CHUNK) + 1000) * 4096 + Math.floor(p.z / CHUNK) + 1000);
    if (!c || !c.mesh) return false;
    for (const i of c.ids) {
      const dx = this.t.x[i] - p.x, dz = this.t.z[i] - p.z;
      if (dx * dx + dz * dz > 100) continue;
      const r = ((i * 2654435761) >>> 0) / 4294967296;
      const kind = this.t.kind[i];
      const size = kind === 0 ? 8 + r * 7 : kind === 1 ? 6 + r * 6 : 5 + r * 3;
      const cy = this.hf.at(this.t.x[i], this.t.z[i]) + size * 0.62;
      const rx = size * 0.55 * (0.85 + r * 0.3) + 0.4, ry = size * 0.62 + 0.4;
      const ex = dx / rx, ez = dz / rx, ey = (p.y - cy) / ry;
      if (ex * ex + ez * ez + ey * ey < 1) return true;
    }
    return false;
  }
  update(cam: THREE.Vector3, budgetMs = 4) {
    const t0 = performance.now();
    // 높이 올라가면 나무 거리 줄이기 (멀리서는 지면 그림이 대신함)
    const alt = Math.max(0, cam.y - this.hf.at(cam.x, cam.z));
    const near = alt > 1500 ? 0 : NEAR_R, far = alt > 1500 ? 0 : FAR_R;
    const todo: { ids: number[]; cx: number; cz: number; mesh: THREE.InstancedMesh | null }[] = [];
    for (const [, c] of this.chunks) {
      const d = Math.hypot(c.cx - cam.x, c.cz - cam.z);
      if (c.mesh && d > far) { this.group.remove(c.mesh); c.mesh.dispose(); c.mesh = null; }
      else if (!c.mesh && d < near) todo.push(c);
    }
    todo.sort((a, b) => Math.hypot(a.cx - cam.x, a.cz - cam.z) - Math.hypot(b.cx - cam.x, b.cz - cam.z));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    const yAxis = new THREE.Vector3(0, 1, 0);
    for (const c of todo) {
      const mesh = new THREE.InstancedMesh(this.geo, this.mat, c.ids.length);
      c.ids.forEach((i, k) => {
        const h = this.hf.at(this.t.x[i], this.t.z[i]);
        const r = ((i * 2654435761) >>> 0) / 4294967296;
        const kind = this.t.kind[i];
        const size = kind === 0 ? 8 + r * 7 : kind === 1 ? 6 + r * 6 : 5 + r * 3;
        p.set(this.t.x[i], h - 0.2, this.t.z[i]);
        q.setFromAxisAngle(yAxis, r * 6.28);
        s.set(size * (0.85 + r * 0.3), size, size * (0.85 + r * 0.3));
        m.compose(p, q, s);
        mesh.setMatrixAt(k, m);
        const g = GREENS[Math.floor(r * 97) % GREENS.length];
        col.setRGB(g[0] * (kind === 0 ? 0.85 : 1.05), g[1] * (kind === 0 ? 0.85 : 1.05), g[2]);
        mesh.setColorAt(k, col);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      c.mesh = mesh;
      this.group.add(mesh);
      if (performance.now() - t0 > budgetMs) break;
    }
  }
}

// 도로 위 자동차 (충돌 없는 장식). 밤에는 전조등·미등 점을 함께 움직인다.
import * as THREE from 'three';
import type { RoadSeg } from './city';
import { makeGlowSprite } from './materials';
import { rng } from './geo';

interface Car { road: number; s: number; dir: 1 | -1; lane: number; v: number }

const COLORS = [0xf2f2f2, 0x1b1b1d, 0x8d9399, 0x3a4f6e, 0x9b2c2c, 0xc9ccd0, 0x2e4d3a, 0xd9c7a0];

export class Traffic {
  readonly mesh: THREE.InstancedMesh;
  readonly lights: THREE.Points;
  private cars: Car[] = [];
  private lens: number[];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private sc = new THREE.Vector3(1, 1, 1);
  private lightPos: Float32Array;

  constructor(private roads: RoadSeg[], count: number) {
    const R = rng(77);
    this.lens = roads.map((r) => Math.hypot(r.b.x - r.a.x, r.b.z - r.a.z));
    const total = this.lens.reduce((a, b) => a + b, 0);
    for (let i = 0; i < count; i++) {
      // 길이에 비례해 도로 고르기
      let t = R() * total, k = 0;
      while (k < roads.length - 1 && t > this.lens[k]) { t -= this.lens[k]; k++; }
      const lanes = Math.max(1, Math.floor(roads[k].width / 7));
      this.cars.push({ road: k, s: t, dir: R() < 0.5 ? 1 : -1, lane: 1 + Math.floor(R() * lanes), v: 9 + R() * 9 });
    }
    const body = new THREE.BoxGeometry(1.85, 1.0, 4.5).translate(0, 0.85, 0);
    const cabin = new THREE.BoxGeometry(1.6, 0.6, 2.3).translate(0, 1.6, 0.2);
    const geo = mergeBoxes(body, cabin);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.4 }), count);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) this.mesh.setColorAt(i, c.setHex(COLORS[(R() * COLORS.length) | 0]));
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.lightPos = new Float32Array(count * 2 * 3);
    const lc = new Float32Array(count * 2 * 3);
    for (let i = 0; i < count; i++) { lc.set([1, 0.95, 0.8], i * 6); lc.set([1, 0.1, 0.05], i * 6 + 3); }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.lightPos, 3));
    lg.setAttribute('color', new THREE.BufferAttribute(lc, 3));
    this.lights = new THREE.Points(lg, new THREE.PointsMaterial({ size: 3.5, map: makeGlowSprite(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.lights.frustumCulled = false;
    this.update(0);
  }

  update(dt: number) {
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const r = this.roads[car.road], L = this.lens[car.road];
      car.s += car.v * dt * car.dir;
      if (car.s > L) { car.s = L; car.dir = -1; }
      if (car.s < 0) { car.s = 0; car.dir = 1; }
      const t = car.s / L;
      const dx = (r.b.x - r.a.x) / L, dz = (r.b.z - r.a.z) / L;
      const nx = -dz, nz = dx;
      const off = (car.lane * 3.4 - 1.5) * car.dir;
      const ya = r.ya ?? r.y, yb = r.yb ?? r.y;
      this.p.set(r.a.x + dx * car.s + nx * off, ya + (yb - ya) * t, r.a.z + dz * car.s + nz * off);
      const fx = dx * car.dir, fz = dz * car.dir;
      this.e.set(0, Math.atan2(-fx, -fz), 0);
      this.q.setFromEuler(this.e);
      this.m.compose(this.p, this.q, this.sc);
      this.mesh.setMatrixAt(i, this.m);
      const j = i * 6;
      this.lightPos[j] = this.p.x + fx * 2.4; this.lightPos[j + 1] = this.p.y + 0.8; this.lightPos[j + 2] = this.p.z + fz * 2.4;
      this.lightPos[j + 3] = this.p.x - fx * 2.4; this.lightPos[j + 4] = this.p.y + 0.9; this.lightPos[j + 5] = this.p.z - fz * 2.4;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    (this.lights.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}

function mergeBoxes(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const ga = a.toNonIndexed(), gb = b.toNonIndexed();
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const x = ga.attributes[name].array as Float32Array, y = gb.attributes[name].array as Float32Array;
    const z = new Float32Array(x.length + y.length);
    z.set(x); z.set(y, x.length);
    g.setAttribute(name, new THREE.BufferAttribute(z, 3));
  }
  return g;
}

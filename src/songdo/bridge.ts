// 인천대교 사장교 구간: 역Y자 주탑 2개(238.5m)와 사장 케이블. 상판·교각은 도로 자료로 그려진다.
import * as THREE from 'three';
import type { Meta } from './data';
import type { World } from './world';

export interface BridgeResult { group: THREE.Group; beacons: THREE.Vector3[]; lights: THREE.Vector3[] }

export function buildPylons(meta: Meta, world: World): BridgeResult {
  const group = new THREE.Group();
  group.name = 'incheon-bridge';
  const beacons: THREE.Vector3[] = [];
  const lights: THREE.Vector3[] = [];
  const mat = new THREE.MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.7 });
  const cable: THREE.Vector3[] = [];
  const H = 238.5, joinH = 175, spread = 42;
  for (const p of meta.pylons) {
    const L = Math.hypot(p.dx, p.dz) || 1;
    const fx = p.dx / L, fz = p.dz / L;
    const yaw = Math.atan2(fx, fz);
    const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const tg = new THREE.Group();
    tg.position.set(p.x, -3, p.z);
    tg.rotation.y = yaw;
    for (const s of [-1, 1]) {
      const len = Math.hypot(spread, joinH);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(7, len, 10), mat);
      leg.position.set((s * spread) / 2, joinH / 2, 0);
      leg.rotation.z = s * Math.atan2(spread, joinH);
      leg.castShadow = true;
      tg.add(leg);
      for (let k = 0; k < 5; k++) {
        const hh = ((k + 0.5) * joinH) / 5;
        const off = spread * (1 - hh / joinH);
        world.addBox({ x: p.x + side.x * off * s, z: p.z + side.z * off * s, hx: 4.5, hz: 5.5, c: Math.cos(yaw), s: -Math.sin(yaw), base: hh - joinH / 10 - 3, top: hh + joinH / 10 - 3, noRoof: true });
      }
    }
    const col = new THREE.Mesh(new THREE.BoxGeometry(8, H - joinH + 6, 10), mat);
    col.position.set(0, joinH + (H - joinH) / 2 - 3, 0);
    col.castShadow = true;
    tg.add(col);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(spread * 2 + 24, 10, 34), mat);
    foot.position.set(0, 3, 0);
    tg.add(foot);
    const deckY = Math.max(world.deckAt(p.x, p.z), 60);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(spread * 1.25, 5, 9), mat);
    beam.position.set(0, deckY - 3 + 3 - 7, 0);
    tg.add(beam);
    group.add(tg);
    world.addBox({ x: p.x, z: p.z, hx: 5, hz: 6, c: Math.cos(yaw), s: -Math.sin(yaw), base: joinH - 10, top: H, noRoof: true });
    beacons.push(new THREE.Vector3(p.x, H + 1, p.z));
    for (let k = 1; k <= 7; k++) lights.push(new THREE.Vector3(p.x, joinH + k * 9, p.z).addScaledVector(side, 0));
    // 케이블: 앞뒤 14개씩, 양쪽 가장자리로
    for (let k = 1; k <= 14; k++) {
      for (const dir of [-1, 1]) {
        const d = dir * k * 27;
        const topY = joinH + 6 + k * 4.0;
        for (const s of [-1, 1]) {
          const ex = p.x + fx * d + side.x * 18 * s, ez = p.z + fz * d + side.z * 18 * s;
          let dy = world.deckAt(ex, ez);
          if (!isFinite(dy)) dy = deckY;
          cable.push(new THREE.Vector3(p.x, topY, p.z), new THREE.Vector3(ex, dy + 0.5, ez));
        }
      }
    }
  }
  group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(cable), new THREE.LineBasicMaterial({ color: 0xe9e9e9 })));
  return { group, beacons, lights };
}

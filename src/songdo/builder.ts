// 건물 상자를 모아 하나의 InstancedMesh로 만들고 충돌 상자도 등록한다.
import * as THREE from 'three';
import type { World } from './world';
import { BStyle, makeBuildingMaterial } from './materials';

export interface BuildingSpec {
  x: number; z: number; w: number; d: number; h: number; rot: number; base: number;
  color: number | THREE.Color; style: BStyle; floorH?: number; seed?: number; collide?: boolean; noShadow?: boolean;
}

export const buildingMaterial = makeBuildingMaterial();

export class Builder {
  private specs: BuildingSpec[] = [];
  /** 높은 건물 꼭대기 (항공장애등) */
  readonly beacons: THREE.Vector3[] = [];
  constructor(private world: World) {}

  add(s: BuildingSpec) {
    this.specs.push(s);
    if (s.collide !== false) {
      this.world.addBox({
        x: s.x, z: s.z, hx: s.w / 2, hz: s.d / 2, c: Math.cos(s.rot), s: -Math.sin(s.rot),
        base: s.base - 2, top: s.base + s.h,
      });
    }
    if (s.h > 110) this.beacons.push(new THREE.Vector3(s.x, s.base + s.h + 1.5, s.z));
  }
  get count() { return this.specs.length; }

  build(): THREE.InstancedMesh {
    const n = this.specs.length;
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mesh = new THREE.InstancedMesh(geo, buildingMaterial, n);
    const style = new Float32Array(n * 4);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    this.specs.forEach((s, i) => {
      q.setFromAxisAngle(yAxis, s.rot);
      p.set(s.x, s.base, s.z);
      sc.set(s.w, s.h, s.d);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, typeof s.color === 'number' ? c.setHex(s.color) : s.color);
      style[i * 4] = s.style;
      style[i * 4 + 1] = s.seed ?? (i * 0.6180339) % 1;
      style[i * 4 + 2] = s.floorH ?? 3;
      style[i * 4 + 3] = s.base;
    });
    geo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(style, 4));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.name = 'buildings';
    return mesh;
  }
}

/** 리본(띠) 메시 빌더: 도로·활주로 유도로·공원 등 평평한 면 */
export class FlatBuilder {
  pos: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  /** 사각형 (네 꼭짓점 높이 각각) */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color, uvs?: number[]) {
    const i = this.pos.length / 3;
    for (const v of [a, b, c, d]) { this.pos.push(v.x, v.y, v.z); this.col.push(color.r, color.g, color.b); }
    if (uvs) this.uv.push(...uvs); else this.uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    // 위를 향하도록 감는 방향을 고른다
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    if (ny > 0) this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    else this.idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

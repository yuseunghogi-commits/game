// 공용 건물 재질과 평면 띠 메시 도우미.
import * as THREE from 'three';
import { makeBuildingMaterial } from './materials';

export const buildingMaterial = makeBuildingMaterial();

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

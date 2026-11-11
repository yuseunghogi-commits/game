// 지형 메시 (실제 고도 + 땅 쓰임새 그림) 와 바다.
import * as THREE from 'three';
import type { HeightField } from './heightfield';
import { makeDetailTexture, makeWaterNormal } from './materials';

const CH = 64; // 조각당 셀 수

export function buildTerrain(hf: HeightField, ground: THREE.Texture): THREE.Group {
  const group = new THREE.Group();
  group.name = 'terrain';
  const detail = makeDetailTexture();
  const mat = new THREE.MeshStandardMaterial({ map: ground, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = { value: detail };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;\nvarying vec3 vTW;')
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  float d1 = texture2D(uDetail, vTW.xz / 23.0).r;
  float d2 = texture2D(uDetail, vTW.xz / 170.0).r;
  float dist = length(vTW - cameraPosition);
  float k = clamp(1.0 - dist / 2500.0, 0.0, 1.0);
  diffuseColor.rgb *= mix(1.0, d1 * 1.12, k) * mix(1.0, d2 * 1.1, 0.6);
}`);
  };
  const W = hf.x1 - hf.x0, Hh = hf.z1 - hf.z0;
  for (let cj = 0; cj < hf.nz - 1; cj += CH) {
    for (let ci = 0; ci < hf.nx - 1; ci += CH) {
      const ni = Math.min(CH, hf.nx - 1 - ci) + 1, nj = Math.min(CH, hf.nz - 1 - cj) + 1;
      // 바다 밑 조각은 건너뛰기
      let maxH = -Infinity;
      for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) maxH = Math.max(maxH, hf.h[(cj + j) * hf.nx + ci + i]);
      if (maxH < -1.5) continue;
      const pos = new Float32Array(ni * nj * 3), uv = new Float32Array(ni * nj * 2);
      for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) {
        const k = j * ni + i, gi = ci + i, gj = cj + j;
        const x = hf.x0 + gi * hf.cell, z = hf.z0 + gj * hf.cell;
        pos[k * 3] = x; pos[k * 3 + 1] = hf.h[gj * hf.nx + gi]; pos[k * 3 + 2] = z;
        uv[k * 2] = (x - hf.x0) / W; uv[k * 2 + 1] = 1 - (z - hf.z0) / Hh;
      }
      const idx = new Uint32Array((ni - 1) * (nj - 1) * 6);
      let p = 0;
      for (let j = 0; j < nj - 1; j++) for (let i = 0; i < ni - 1; i++) {
        const a = j * ni + i, b = a + 1, c = a + ni, d = c + 1;
        idx[p++] = a; idx[p++] = c; idx[p++] = b;
        idx[p++] = b; idx[p++] = c; idx[p++] = d;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      group.add(m);
    }
  }
  return group;
}

export function buildSea(): { mesh: THREE.Mesh; update: (t: number) => void } {
  const nrm = makeWaterNormal();
  nrm.repeat.set(2500, 2500);
  const m = new THREE.MeshStandardMaterial({
    color: 0x2a5868, roughness: 0.1, metalness: 0.1, normalMap: nrm, normalScale: new THREE.Vector2(0.25, 0.25),
  });
  // 큰 삼각형은 로그 깊이 정밀도 문제로 가까운 물체를 덮어 버리므로 잘게 나눈다
  const g = new THREE.PlaneGeometry(200000, 200000, 160, 160).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(-7000, 0, -5000);
  mesh.receiveShadow = true;
  mesh.name = 'sea';
  return { mesh, update: (t: number) => nrm.offset.set(t * 0.004, t * 0.0027) };
}

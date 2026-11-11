// 지형 메시와 바다.
import * as THREE from 'three';
import { HF, HeightField } from './heightfield';
import { LANDS, fbm, pointInPoly, toAp } from './geo';
import { makeDetailTexture, makeWaterNormal } from './materials';

export function buildTerrain(hf: HeightField): THREE.Mesh {
  const { nx, nz } = hf;
  const pos = new Float32Array(nx * nz * 3);
  const col = new Float32Array(nx * nz * 3);
  const uv = new Float32Array(nx * nz * 2);
  const songdo = LANDS[1].pts;
  const newport = LANDS[2].pts;
  const c = new THREE.Color();
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = HF.x0 + i * HF.cell, z = HF.z0 + j * HF.cell;
      const y = hf.h[k];
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      uv[k * 2] = x / 60; uv[k * 2 + 1] = z / 60;
      const n = fbm(x / 900, z / 900, 3);
      const sl = hf.slope(x, z);
      if (y < -0.5) c.setRGB(0.42, 0.40, 0.33); // 갯벌·바닥
      else if (y < 2.6 && sl < 0.08 && !(y > 3.5)) c.setRGB(0.70, 0.64, 0.50); // 모래·갯벌 경계
      else {
        const a = toAp({ x, z });
        const inAirport = a.d > -4.5 && a.d < 3.3 && a.p > -2.3 && a.p < 4.7;
        const inCity = pointInPoly(x, z, songdo) || pointInPoly(x, z, newport);
        if (inAirport) c.setRGB(0.40 + n * 0.08, 0.50 + n * 0.08, 0.30);
        else if (inCity) c.setRGB(0.47 + n * 0.06, 0.50 + n * 0.06, 0.44);
        else {
          // 자연 지형: 낮은 곳은 도시/논, 높은 곳은 숲
          const forest = Math.min(1, Math.max(0, (y - 25) / 60 + (n - 0.5)));
          const urban = Math.max(0, 1 - y / 35) * (x > -6000 ? 0.75 : 0.35);
          c.setRGB(0.36, 0.47, 0.27);
          c.lerp(new THREE.Color(0.52, 0.52, 0.49), urban * (0.6 + n * 0.4));
          c.lerp(new THREE.Color(0.17, 0.29, 0.15), forest);
          if (sl > 0.45) c.lerp(new THREE.Color(0.45, 0.42, 0.38), Math.min(1, (sl - 0.45) * 2));
        }
      }
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let p = 0;
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, cc = a + nx, d = cc + 1;
    idx[p++] = a; idx[p++] = cc; idx[p++] = b;
    idx[p++] = b; idx[p++] = cc; idx[p++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  const tex = makeDetailTexture();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, roughness: 0.95, metalness: 0 });
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

export function buildSea(): { mesh: THREE.Mesh; update: (t: number) => void } {
  const nrm = makeWaterNormal();
  nrm.repeat.set(2500, 2500);
  const nrm2 = nrm.clone();
  const m = new THREE.MeshStandardMaterial({
    color: 0x24566b, roughness: 0.08, metalness: 0.15, normalMap: nrm, normalScale: new THREE.Vector2(0.22, 0.22),
    envMapIntensity: 1.0,
  });
  const g = new THREE.PlaneGeometry(200000, 200000, 1, 1).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(-6000, 0, -5000);
  mesh.receiveShadow = true;
  mesh.name = 'sea';
  void nrm2;
  return {
    mesh,
    update(t: number) {
      nrm.offset.set(t * 0.004, t * 0.0027);
    },
  };
}

// 직접 모델링한 랜드마크: 지도 자료의 외곽선·높이를 바탕으로 모양을 더 실제에 가깝게 만든다.
// 해당 자료 건물은 그리지 않고(충돌은 유지) 이 모형으로 바꿔 그린다.
import * as THREE from 'three';
import type { Buildings } from './data';
import type { HeightField } from './heightfield';
import { landmark } from './geo';

export interface LandmarkPick { hidden: Set<number>; build: (base: Float32Array) => THREE.Group }

/** 외곽선의 긴 변 방향과 그 방향 기준 반폭 */
function obb(b: Buildings, i: number) {
  const s = b.start[i] * 2, c = b.count[i];
  let best = 0, ang = 0;
  for (let k = 0; k < c; k++) {
    const k2 = (k + 1) % c;
    const dx = b.verts[s + k2 * 2] - b.verts[s + k * 2], dz = b.verts[s + k2 * 2 + 1] - b.verts[s + k * 2 + 1];
    const L = Math.hypot(dx, dz);
    if (L > best) { best = L; ang = Math.atan2(dz, dx); }
  }
  const ux = Math.cos(ang), uz = Math.sin(ang);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let k = 0; k < c; k++) {
    const x = b.verts[s + k * 2], z = b.verts[s + k * 2 + 1];
    const a = x * ux + z * uz, bb = -x * uz + z * ux;
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, bb); b1 = Math.max(b1, bb);
  }
  const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
  return { cx: b.cx[i] + ca * ux - cb * uz, cz: b.cz[i] + ca * uz + cb * ux, ux, uz, ha: (a1 - a0) / 2, hb: (b1 - b0) / 2 };
}

function nearest(b: Buildings, x: number, z: number, r: number, ok: (i: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < b.n; i++) if (Math.hypot(b.cx[i] - x, b.cz[i] - z) < r && ok(i)) out.push(i);
  return out;
}

/** 사각 단면을 (아래 반폭) → (위 반폭)으로 쌓은 기둥: 네 꼭짓점 높이를 따로 줄 수 있다 */
function prism(o: ReturnType<typeof obb>, y0: number, ha0: number, hb0: number, topY: [number, number, number, number], ha1: number, hb1: number, style: number, floorH: number, base: number, color: THREE.Color): THREE.BufferGeometry {
  const P = (a: number, bb: number, y: number) => new THREE.Vector3(o.cx + a * o.ux - bb * o.uz, y, o.cz + a * o.uz + bb * o.ux);
  const bot = [P(-ha0, -hb0, y0), P(ha0, -hb0, y0), P(ha0, hb0, y0), P(-ha0, hb0, y0)];
  const top = [P(-ha1, -hb1, topY[0]), P(ha1, -hb1, topY[1]), P(ha1, hb1, topY[2]), P(-ha1, hb1, topY[3])];
  const pos: number[] = [], nor: number[] = [], st: number[] = [], tp: number[] = [], col: number[] = [];
  const maxTop = Math.max(...topY);
  const tri = (a: THREE.Vector3, b2: THREE.Vector3, c: THREE.Vector3) => {
    const nrm = new THREE.Vector3().subVectors(b2, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    for (const v of [a, b2, c]) {
      pos.push(v.x, v.y, v.z); nor.push(nrm.x, nrm.y, nrm.z); st.push(style, 0.37, floorH, base); tp.push(maxTop); col.push(color.r, color.g, color.b);
    }
  };
  // 옆면 (바깥을 향하게: 위에서 보아 반시계 순서를 밖으로)
  const center = new THREE.Vector3(o.cx, 0, o.cz);
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4;
    const a = bot[k], b2 = bot[k2], c = top[k2], d = top[k];
    const out = new THREE.Vector3((a.x + b2.x) / 2 - center.x, 0, (a.z + b2.z) / 2 - center.z);
    const nrm = new THREE.Vector3().subVectors(b2, a).cross(new THREE.Vector3().subVectors(c, a));
    if (nrm.dot(out) > 0) { tri(a, b2, c); tri(a, c, d); } else { tri(a, c, b2); tri(a, d, c); }
  }
  // 윗면
  const n1 = new THREE.Vector3().subVectors(top[1], top[0]).cross(new THREE.Vector3().subVectors(top[2], top[0]));
  if (n1.y > 0) { tri(top[0], top[1], top[2]); tri(top[0], top[2], top[3]); } else { tri(top[0], top[2], top[1]); tri(top[0], top[3], top[2]); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aStyle', new THREE.Float32BufferAttribute(st, 4));
  g.setAttribute('aTop', new THREE.Float32BufferAttribute(tp, 1));
  return g;
}

export function pickLandmarks(b: Buildings, hf: HeightField, mat: () => THREE.Material): LandmarkPick {
  const hidden = new Set<number>();
  const jobs: ((base: Float32Array, g: THREE.Group) => void)[] = [];

  // ── 포스코타워-송도 (옛 동북아무역센터, 305m): 위로 좁아지는 유리탑 + 한쪽으로 기운 꼭대기 ──
  const pt = landmark('posco').at;
  const tower = nearest(b, pt.x, pt.z, 120, (i) => b.h[i] > 200).sort((p, q) => b.h[q] - b.h[p])[0];
  if (tower !== undefined) {
    nearest(b, pt.x, pt.z, 70, (i) => b.h[i] > 150).forEach((i) => hidden.add(i));
    jobs.push((base, g) => {
      const o = obb(b, tower);
      const y0 = base[tower];
      const H = b.h[tower];
      const bodyTop = y0 + H * 0.9;
      const glass = new THREE.Color(0.42, 0.56, 0.66);
      const body = prism(o, y0, o.ha, o.hb, [bodyTop, bodyTop, bodyTop, bodyTop], o.ha * 0.66, o.hb * 0.66, 5, 4.1, y0, glass);
      const crown = prism(o, bodyTop, o.ha * 0.66, o.hb * 0.66, [y0 + H, y0 + H, bodyTop + 8, bodyTop + 8], o.ha * 0.52, o.hb * 0.62, 1, 4.1, y0, new THREE.Color(0.66, 0.74, 0.8));
      for (const geo of [body, crown]) {
        const m = new THREE.Mesh(geo, mat());
        m.castShadow = true; m.receiveShadow = true;
        g.add(m);
      }
      // 저층부(포디움)
      const pod = prism(o, y0, o.ha * 1.7, o.hb * 1.5, [y0 + 18, y0 + 18, y0 + 18, y0 + 18], o.ha * 1.7, o.hb * 1.5, 5, 4.5, y0, new THREE.Color(0.55, 0.62, 0.66));
      const pm = new THREE.Mesh(pod, mat()); pm.receiveShadow = true; g.add(pm);
    });
  }

  // ── 트라이볼: 얕은 연못 위에 놓인 세 개의 그릇 모양 공연장 ──
  const tb = landmark('tribowl').at;
  const tri = nearest(b, tb.x, tb.z, 70, (i) => b.h[i] < 40);
  if (tri.length) {
    tri.forEach((i) => hidden.add(i));
    jobs.push((base, g) => {
      const y0 = Math.min(...tri.map((i) => base[i]));
      const white = new THREE.MeshStandardMaterial({ color: 0xf1f1ee, roughness: 0.35, metalness: 0.05 });
      const o = obb(b, tri.sort((p, q) => b.count[q] - b.count[p])[0]);
      const r = Math.max(10, Math.min(o.ha, o.hb) * 0.62);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + Math.atan2(o.uz, o.ux);
        const cx = tb.x + Math.cos(a) * r * 1.05, cz = tb.z + Math.sin(a) * r * 1.05;
        const prof = [new THREE.Vector2(3.5, 0), new THREE.Vector2(5, 4), new THREE.Vector2(r * 0.55, 9), new THREE.Vector2(r, 15 + k * 1.5), new THREE.Vector2(r - 0.6, 15.4 + k * 1.5), new THREE.Vector2(0, 14 + k * 1.5)];
        const bowl = new THREE.Mesh(new THREE.LatheGeometry(prof, 48), white);
        bowl.position.set(cx, y0, cz);
        bowl.castShadow = true; bowl.receiveShadow = true;
        g.add(bowl);
      }
    });
  }

  // ── 송도컨벤시아: 전시장 지붕 위로 줄지어 솟은 삼각 지붕 ──
  const cv = landmark('convensia').at;
  const halls = nearest(b, cv.x, cv.z, 260, (i) => {
    const o = obb(b, i);
    return o.ha * o.hb * 4 > 9000 && b.h[i] < 45;
  });
  if (halls.length) {
    jobs.push((base, g) => {
      const roofMat = new THREE.MeshStandardMaterial({ color: 0xd7dde1, roughness: 0.4, metalness: 0.35, side: THREE.DoubleSide });
      for (const i of halls) {
        const o = obb(b, i);
        const yTop = base[i] + b.h[i];
        const nPk = Math.max(3, Math.round(o.ha / 22));
        const step = (o.ha * 2) / nPk;
        for (let k = 0; k < nPk; k++) {
          const a0 = -o.ha + k * step;
          const P = (a: number, bb: number, y: number) => new THREE.Vector3(o.cx + a * o.ux - bb * o.uz, y, o.cz + a * o.uz + bb * o.ux);
          const h = Math.min(22, step * 0.55);
          const v = [P(a0, -o.hb, yTop), P(a0 + step, -o.hb, yTop), P(a0 + step / 2, -o.hb * 0.92, yTop + h), P(a0, o.hb, yTop), P(a0 + step, o.hb, yTop), P(a0 + step / 2, o.hb * 0.92, yTop + h)];
          const geo = new THREE.BufferGeometry().setFromPoints([v[0], v[1], v[2], v[3], v[5], v[4], v[0], v[2], v[5], v[0], v[5], v[3], v[1], v[4], v[5], v[1], v[5], v[2]]);
          geo.computeVertexNormals();
          const m = new THREE.Mesh(geo, roofMat);
          m.castShadow = true;
          g.add(m);
        }
      }
    });
  }
  void hf;
  return {
    hidden,
    build: (base) => {
      const g = new THREE.Group();
      g.name = 'landmarks';
      for (const j of jobs) j(base, g);
      return g;
    },
  };
}

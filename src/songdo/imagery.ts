// 항공·위성사진 (Esri World Imagery) 실시간 타일 → 지형·낮은 지붕에 입힌다.
// 사진은 저장하지 않고 실행 중에 받아 쓴다 (출처 표시: Esri, Maxar, Earthstar Geographics).
// 단계마다 N×N 칸 텍스처를 고리처럼 돌려 쓴다: 전역 타일 (x,y)는 칸 (x mod N, y mod N)에 들어간다.
import * as THREE from 'three';
import { fromLatLon, toLatLon } from './geo';

const URL = (z: number, x: number, y: number) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const R = 6371008.8;
const TS = 256;

interface Level {
  z: number; n: number;
  tex: THREE.DataTexture;     // 사진 아틀라스 (N*256)²
  slots: THREE.DataTexture;   // N×N: 칸에 들어 있는 타일 (기준 타일 대비 x,y) + 적재 여부
  slotData: Float32Array;
  refTX: number; refTY: number; // 기준 타일 (정수)
  xref: number; zref: number;   // 기준 타일 모서리의 월드 좌표
  kx: number; a1: number; a2: number;
  center: { x: number; y: number }; // 카메라 타일 (기준 대비)
  fixedCenter: boolean;
  pending: Set<string>;
  dirty: boolean;
  uniforms: Record<string, THREE.IUniform>;
}

function tileXY(lat: number, lon: number, z: number) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}
function tileLatLon(tx: number, ty: number, z: number) {
  const n = 2 ** z;
  const lon = (tx / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return { lat, lon };
}

const dummy = new THREE.DataTexture(new Uint8Array(4), 1, 1);
dummy.needsUpdate = true;
/** 지형·도로·건물 셰이더가 공유하는 uniform (Imagery가 값을 채운다) */
export const IMG_U: Record<string, THREE.IUniform> = { uImgOn: { value: 0 } };
for (let i = 0; i < 3; i++) {
  IMG_U[`uImg${i}Tex`] = { value: dummy };
  IMG_U[`uImg${i}Slots`] = { value: dummy };
  IMG_U[`uImg${i}A`] = { value: new THREE.Vector4(0, 0, 0, 1) };
  IMG_U[`uImg${i}B`] = { value: new THREE.Vector4() };
  IMG_U[`uImg${i}C`] = { value: new THREE.Vector2(-1e6, -1e6) };
}

export class Imagery {
  enabled = true;
  readonly levels: Level[] = [];
  readonly uniforms = IMG_U;
  private inflight = 0;
  private failures = 0;
  private gl: WebGL2RenderingContext;

  constructor(private renderer: THREE.WebGLRenderer, worldCenter: { x: number; z: number }) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    const maxTex = renderer.capabilities.maxTextureSize;
    // 단계: z13 전체(고정), z15 약 7.8km, z17 약 3.9km(큰 텍스처 지원 시) / 2km
    const defs: [number, number, boolean][] = [[13, 16, true], [15, 8, false], [17, maxTex >= 8192 ? 16 : 8, false]];
    defs.forEach(([z, n, fixed], i) => this.levels.push(this.makeLevel(i, z, n, fixed, worldCenter)));
    IMG_U.uImgOn.value = 1;
  }

  private makeLevel(i: number, z: number, n: number, fixed: boolean, center: { x: number; z: number }): Level {
    const size = n * TS;
    const tex = new THREE.DataTexture(new Uint8Array(size * size * 4), size, size);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 8;
    tex.flipY = false;
    tex.needsUpdate = true;
    const slotData = new Float32Array(n * n * 4);
    const slots = new THREE.DataTexture(slotData, n, n, THREE.RGBAFormat, THREE.FloatType);
    slots.minFilter = slots.magFilter = THREE.NearestFilter;
    slots.needsUpdate = true;
    // 기준 타일: 시작 위치의 타일 모서리
    const ll = toLatLon(center);
    const t = tileXY(ll.lat, ll.lon, z);
    const refTX = Math.floor(t.x), refTY = Math.floor(t.y);
    const c = tileLatLon(refTX, refTY, z);
    const w = fromLatLon(c.lat, c.lon);
    const lat0 = (c.lat * Math.PI) / 180;
    const nn = 2 ** z;
    // 월드 x(m) → 타일: 경도 선형
    const lonPerM = 1 / (fromLatLon(c.lat, c.lon + 1).x - w.x);
    const kx = (lonPerM * nn) / 360;
    const sec = 1 / Math.cos(lat0), tan = Math.tan(lat0);
    const a1 = (nn / (2 * Math.PI)) * sec, a2 = (nn / (2 * Math.PI)) * 0.5 * sec * tan;
    const L: Level = {
      z, n, tex, slots, slotData, refTX, refTY, xref: w.x, zref: w.z, kx, a1, a2,
      center: { x: 0, y: 0 }, fixedCenter: fixed, pending: new Set(), dirty: false, uniforms: {},
    };
    const p = `uImg${i}`;
    L.uniforms = {
      [`${p}Tex`]: { value: tex }, [`${p}Slots`]: { value: slots },
      [`${p}A`]: { value: new THREE.Vector4(w.x, w.z, kx, n) },          // xref, zref, kx, N
      [`${p}B`]: { value: new THREE.Vector4(a1, a2, ((refTX % n) + n) % n, ((refTY % n) + n) % n) }, // a1, a2, refMod
      [`${p}C`]: { value: new THREE.Vector2(0, 0) },                      // 창 중심 (기준 대비 타일)
    };
    for (const k of Object.keys(L.uniforms)) IMG_U[k].value = L.uniforms[k].value;
    L.uniforms = IMG_U;
    if (fixed) {
      // 전체 지역 가운데에 고정 (기준 = 지역 가운데라서 0,0)
      L.center = { x: 0, y: 0 };
      (IMG_U[`${p}C`].value as THREE.Vector2).set(0.5, 0.5);
    }
    return L;
  }

  /** 월드 좌표 → 기준 대비 타일 좌표 */
  private rel(L: Level, x: number, z: number) {
    const d = -(z - L.zref) / R;
    return { x: (x - L.xref) * L.kx, y: -(L.a1 * d + L.a2 * d * d) };
  }

  setEnabled(on: boolean) { this.enabled = on; IMG_U.uImgOn.value = on ? 1 : 0; }

  update(cam: THREE.Vector3, ground: number) {
    if (!this.enabled) return;
    const alt = cam.y - ground;
    // 자세한 단계부터 요청 (단계마다 동시 요청 몫을 둔다)
    [...this.levels.entries()].reverse().forEach(([i, L]) => {
      if (i === 2 && alt > 3000) return;
      if (!L.fixedCenter) {
        const r = this.rel(L, cam.x, cam.z);
        const cx = Math.floor(r.x), cy = Math.floor(r.y);
        if (cx !== L.center.x || cy !== L.center.y) {
          L.center = { x: cx, y: cy };
          (L.uniforms[`uImg${i}C`].value as THREE.Vector2).set(cx + 0.5, cy + 0.5);
        }
      }
      // 창 안 타일 중 없는 것 요청 (가까운 순)
      const half = Math.floor(L.n / 2) - 1;
      const want: [number, number, number][] = [];
      for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) {
        const tx = L.center.x + dx, ty = L.center.y + dy;
        const s = this.slotOf(L, tx, ty);
        const k = s * 4;
        if (L.slotData[k + 2] === 1 && L.slotData[k] === tx && L.slotData[k + 1] === ty) continue;
        const key = `${tx},${ty}`;
        if (L.pending.has(key)) continue;
        want.push([dx * dx + dy * dy, tx, ty]);
      }
      want.sort((a, b) => a[0] - b[0]);
      const share = i === 2 ? 10 : i === 1 ? 6 : 4;
      for (const [, tx, ty] of want) {
        if (L.pending.size >= share || this.inflight >= 20 || this.failures > 60) break;
        this.fetchTile(L, tx, ty);
      }
    });
    for (const L of this.levels) if (L.dirty) {
      L.dirty = false;
      L.slots.needsUpdate = true;
      const gl = this.gl;
      const p = this.renderer.properties.get(L.tex) as { __webglTexture?: WebGLTexture };
      if (p.__webglTexture) {
        this.renderer.state.bindTexture(gl.TEXTURE_2D, p.__webglTexture);
        gl.generateMipmap(gl.TEXTURE_2D);
      }
    }
  }

  private slotOf(L: Level, tx: number, ty: number) {
    const sx = (((tx + L.refTX) % L.n) + L.n) % L.n, sy = (((ty + L.refTY) % L.n) + L.n) % L.n;
    return sy * L.n + sx;
  }

  private fetchTile(L: Level, tx: number, ty: number) {
    const key = `${tx},${ty}`;
    L.pending.add(key);
    this.inflight++;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.inflight--;
      L.pending.delete(key);
      // 그사이 창이 움직였으면 버린다
      const half = Math.floor(L.n / 2) - 1;
      if (Math.abs(tx - L.center.x) > half || Math.abs(ty - L.center.y) > half) return;
      this.upload(L, tx, ty, img);
    };
    img.onerror = () => { this.inflight--; L.pending.delete(key); this.failures++; };
    img.src = URL(L.z, L.refTX + tx, L.refTY + ty);
  }

  private upload(L: Level, tx: number, ty: number, img: HTMLImageElement) {
    const gl = this.gl;
    if (!(this.renderer.properties.get(L.tex) as { __webglTexture?: WebGLTexture }).__webglTexture) this.renderer.initTexture(L.tex);
    const p = this.renderer.properties.get(L.tex) as { __webglTexture?: WebGLTexture };
    if (!p.__webglTexture) return;
    const s = this.slotOf(L, tx, ty);
    const sx = s % L.n, sy = Math.floor(s / L.n);
    this.renderer.state.bindTexture(gl.TEXTURE_2D, p.__webglTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, sx * TS, sy * TS, gl.RGBA, gl.UNSIGNED_BYTE, img);
    const k = s * 4;
    L.slotData[k] = tx; L.slotData[k + 1] = ty; L.slotData[k + 2] = 1;
    L.dirty = true;
  }
}

/** 셰이더 조각: imgColor(worldXZ) → vec4(rgb, 가중치). 단계 높을수록 우선. */
export const IMAGERY_GLSL = /* glsl */ `
uniform float uImgOn;
${[0, 1, 2].map((i) => `uniform sampler2D uImg${i}Tex; uniform sampler2D uImg${i}Slots; uniform vec4 uImg${i}A; uniform vec4 uImg${i}B; uniform vec2 uImg${i}C;`).join('\n')}
vec4 imgLevel(vec2 wxz, sampler2D tex, sampler2D slots, vec4 A, vec4 B, vec2 C) {
  float N = A.w;
  float d = -(wxz.y - A.y) / ${R.toFixed(1)};
  vec2 g = vec2((wxz.x - A.x) * A.z, -(B.x * d + B.y * d * d));
  // 창 가장자리에서 서서히 사라지게
  vec2 dc = abs(g - C);
  float edge = N * 0.5 - 1.0 - max(dc.x, dc.y);
  float w = clamp(edge, 0.0, 1.0);
  if (w <= 0.0) return vec4(0.0);
  vec2 t = floor(g);
  vec2 slot = mod(t + B.zw, N);
  vec4 s = texture2D(slots, (slot + 0.5) / N);
  if (s.z < 0.5 || any(greaterThan(abs(s.xy - t), vec2(0.1)))) return vec4(0.0);
  vec2 uv = (slot + fract(g)) / N;
  vec3 c = textureGrad(tex, uv, dFdx(g) / N, dFdy(g) / N).rgb;
  return vec4(c, w);
}
vec4 imgColor(vec2 wxz) {
  vec4 r = vec4(0.0);
  vec4 a = imgLevel(wxz, uImg0Tex, uImg0Slots, uImg0A, uImg0B, uImg0C);
  r = vec4(mix(r.rgb, a.rgb, a.w), max(r.w, a.w));
  a = imgLevel(wxz, uImg1Tex, uImg1Slots, uImg1A, uImg1B, uImg1C);
  r = vec4(mix(r.rgb, a.rgb, a.w), max(r.w, a.w));
  a = imgLevel(wxz, uImg2Tex, uImg2Slots, uImg2A, uImg2B, uImg2C);
  r = vec4(mix(r.rgb, a.rgb, a.w), max(r.w, a.w));
  return vec4(r.rgb, r.w * uImgOn);
}
`;

/** 재질에 사진 입히기. mode: ground(지형) · road(도로) */
export function withImagery(m: THREE.Material, mode: 'ground' | 'road') {
  const prev = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    Object.assign(sh.uniforms, IMG_U);
    if (!sh.vertexShader.includes('varying vec3 vTW;')) {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vTW;');
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + IMAGERY_GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec4 im = imgColor(vTW.xz);
  diffuseColor.rgb = mix(diffuseColor.rgb, im.rgb * ${mode === 'road' ? '0.95' : '1.0'}, im.w * ${mode === 'road' ? '0.82' : '1.0'});
}`);
  };
  m.customProgramCacheKey = () => 'img-' + mode;
  m.needsUpdate = true;
}

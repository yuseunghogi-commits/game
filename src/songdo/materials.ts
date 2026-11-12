// 공용 재질: 건물 창문 무늬(월드 좌표 기반 셰이더), 밤 조명, 지면 디테일 텍스처, 물결 노멀맵.
import * as THREE from 'three';
import { IMG_U, IMAGERY_GLSL } from './imagery';

/** 0 = 낮, 1 = 밤 (창문 불빛·가로등 세기) */
export const nightU = { value: 0 };

/** 건물 스타일 (aStyle.x) */
export enum BStyle { Apartment = 0, Office = 1, Low = 2, Industrial = 3, Plain = 4, Glass = 5 }

/**
 * 창문 무늬가 있는 건물 재질. 인스턴스/일반 메시 모두 `aStyle`(vec4: 스타일, 시드, 층높이, 바닥 높이) 속성이 필요하다.
 * 무늬는 월드 좌표로 계산하므로 크기가 다른 상자를 하나의 지오메트리로 찍어도 창 크기가 일정하다.
 */
export function makeBuildingMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0.05 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = nightU;
    Object.assign(sh.uniforms, IMG_U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aStyle;
attribute float aTop;
varying vec3 vWPos;
varying vec3 vWNorm;
varying vec4 vStyle;
varying float vTop;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
{
  vec4 wp4 = vec4(transformed, 1.0);
  vec3 wn = objectNormal;
  #ifdef USE_INSTANCING
    wp4 = instanceMatrix * wp4;
    wn = mat3(instanceMatrix) * wn;
  #endif
  wp4 = modelMatrix * wp4;
  vWPos = wp4.xyz;
  vWNorm = normalize(mat3(modelMatrix) * wn);
  vStyle = aStyle;
  vTop = aTop;
}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uNight;
varying vec3 vWPos;
varying vec3 vWNorm;
varying vec4 vStyle;
varying float vTop;
float bHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
${IMAGERY_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float bLit = 0.0;
float bGlass = 0.0;
float bMetal = 0.0;
{
  vec3 n = normalize(vWNorm);
  float wall = 1.0 - step(0.6, abs(n.y));
  int st = int(vStyle.x + 0.5);
  float seed = vStyle.y;
  float base = vStyle.w;
  float top = vTop > base + 1.0 ? vTop : base + 10000.0;
  vec2 t = normalize(vec2(-n.z, n.x) + 1e-5);
  float hpos = dot(vWPos.xz, t);
  float y = vWPos.y - base;
  float fh = max(vStyle.z, 1.0);
  float fy = y / fh;
  float fl = floor(fy);
  float fyf = fract(fy);
  float fromTop = top - vWPos.y;
  float mpp = max(fwidth(hpos), fwidth(vWPos.y));            // 화소당 미터
  float det = clamp(1.6 - mpp * 1.1, 0.0, 1.0);             // 멀면 잔무늬를 평균색으로
  vec3 wallC = diffuseColor.rgb;
  vec3 col = wallC;
  float win = 0.0;
  float unitId = 0.0;
  if (st == 0) {
    // ── 한국 아파트: 세대마다 넓은 베란다 창, 층마다 흰 슬래브 띠, 유리 난간, 1층 필로티, 꼭대기 장식 ──
    float uw = 3.6 + fract(seed * 7.0) * 1.6;
    float ux = hpos / uw;
    float fx = fract(ux);
    unitId = floor(ux);
    float pier = 1.0 - step(0.07, fx) * step(fx, 0.93);
    float slab = 1.0 - step(0.1, fyf);
    win = (1.0 - pier) * (1.0 - slab);
    float curtain = bHash(vec2(unitId, fl) + seed * 31.0);
    vec3 glassC = mix(vec3(0.16, 0.22, 0.26), vec3(0.34, 0.40, 0.42), curtain * 0.6);
    glassC = mix(glassC, vec3(0.62, 0.58, 0.50), step(0.86, curtain));          // 커튼 친 창
    float rail = step(0.1, fyf) * step(fyf, 0.36);
    vec3 railC = mix(glassC, vec3(0.55, 0.62, 0.66), 0.55);
    vec3 cW = mix(glassC, railC, rail);
    cW = mix(cW, cW * 0.75, step(abs(fx - 0.5), 0.012));                          // 창 문살
    vec3 detailC = mix(wallC * mix(0.92, 1.0, slab), cW, win);
    vec3 avgC = mix(wallC, vec3(0.30, 0.36, 0.40), 0.5);
    col = mix(avgC, detailC, det);
    // 1층 필로티 (어둡게 들어간 부분)
    if (fl < 1.0) col = mix(col, wallC * 0.38, step(0.15, fyf) * (1.0 - pier));
    // 꼭대기 장식 띠: 단지마다 다른 색
    vec3 accent = fract(seed * 13.0) < 0.25 ? vec3(0.20, 0.30, 0.48) : fract(seed * 13.0) < 0.5 ? vec3(0.62, 0.36, 0.26) : fract(seed * 13.0) < 0.75 ? vec3(0.30, 0.45, 0.36) : vec3(0.55, 0.57, 0.60);
    float crown = step(fromTop, 5.5);
    col = mix(col, mix(accent, wallC, step(0.5, fract(hpos / 9.0)) * 0.25), crown);
    win *= 1.0 - crown;
    bLit = win * step(0.62, bHash(vec2(unitId, fl) + seed * 11.0)) * step(1.0, fl);
  } else if (st == 1 || st == 5) {
    // ── 유리 커튼월: 1.5m 멀리언, 층 사이 스팬드럴, 위로 갈수록 하늘 반사 ──
    float mw = st == 5 ? 1.5 : 1.9;
    float fx = fract(hpos / mw);
    float mull = 1.0 - step(0.04, fx) * step(fx, 0.96);
    float span = 1.0 - step(0.12, fyf);
    vec3 glassC = mix(wallC * 0.55, vec3(0.22, 0.33, 0.42), 0.45) * mix(0.9, 1.25, clamp(y / max(top - base, 30.0), 0.0, 1.0));
    vec3 frame = mix(wallC, vec3(0.70, 0.73, 0.75), 0.5);
    vec3 detailC = mix(glassC, frame, max(mull * 0.9, span * 0.8));
    col = mix(mix(glassC, frame, 0.18), detailC, det);
    win = (1.0 - mull) * (1.0 - span);
    float crown = step(fromTop, 3.5);
    col = mix(col, frame * 1.1, crown);
    win *= 1.0 - crown;
    bGlass = (1.0 - crown) * mix(0.85, 1.0 - max(mull, span) * 0.7, det);
    unitId = floor(hpos / mw / 3.0);
    bLit = win * step(0.55, bHash(vec2(unitId, fl) + seed * 5.0)) * step(1.0, fl);
  } else if (st == 3) {
    // ── 공장·창고: 세로 골강판, 높은 띠창 ──
    float rib = 0.5 + 0.5 * sin(hpos * 6.2831 / 0.8);
    col = wallC * mix(1.0, 0.9 + 0.1 * rib, det);
    float band = step(0.72, y / max(top - base, 6.0)) * step(y / max(top - base, 6.0), 0.86);
    col = mix(col, vec3(0.30, 0.38, 0.45), band * 0.8);
    win = band;
    bLit = band * 0.5;
  } else if (st == 2) {
    // ── 상가·빌라·학교: 테두리 있는 창, 1층 가게 유리와 간판 ──
    float ww = 3.4;
    float ux = hpos / ww;
    float fx = fract(ux);
    unitId = floor(ux);
    float w2 = step(0.16, fx) * step(fx, 0.84) * step(0.3, fyf) * step(fyf, 0.85);
    float frameM = (step(0.12, fx) * step(fx, 0.88) * step(0.25, fyf) * step(fyf, 0.9)) * (1.0 - w2);
    vec3 cW = mix(vec3(0.14, 0.17, 0.20), vec3(0.32, 0.36, 0.38), bHash(vec2(unitId, fl) + seed));
    vec3 detailC = mix(wallC, cW, w2);
    detailC = mix(detailC, wallC * 0.7, frameM);
    col = mix(mix(wallC, cW, 0.35), detailC, det);
    win = w2;
    bool street = (top - base) < 45.0 && fl < 1.0 && y > 0.2;
    if (street && bHash(vec2(seed * 91.0, 1.0)) < 0.7) {
      // 가게 유리 + 간판 띠 (구간마다 다른 색)
      float seg = floor(hpos / 6.0);
      float h1 = bHash(vec2(seg, seed * 17.0));
      vec3 signC = h1 < 0.2 ? vec3(0.80, 0.16, 0.14) : h1 < 0.4 ? vec3(0.12, 0.32, 0.70) : h1 < 0.55 ? vec3(0.95, 0.78, 0.15) : h1 < 0.7 ? vec3(0.10, 0.55, 0.30) : h1 < 0.85 ? vec3(0.95, 0.95, 0.93) : vec3(0.85, 0.40, 0.10);
      float signBand = step(0.72, fyf) * step(fyf, 0.95);
      vec3 shop = mix(vec3(0.22, 0.26, 0.28), signC, signBand);
      col = mix(col, shop, det * 0.9 + 0.1);
      win = 1.0 - signBand;
      bLit = signBand * 1.6 + (1.0 - signBand) * 0.8;
    } else {
      bLit = win * step(0.6, bHash(vec2(unitId, fl) + seed * 3.0)) * step(1.0, fl);
    }
  } else {
    col = wallC * (0.95 + 0.05 * bHash(floor(vWPos.xz / 2.0)));
  }
  col = mix(wallC * 0.78, col, wall);            // 지붕
  diffuseColor.rgb = col;
  bLit *= wall * step(0.0, fy);
  bGlass *= wall;
  // 낮은 건물 지붕에는 항공사진 (높은 건물은 사진에서 기울어져 보여 맞지 않음)
  if (n.y > 0.45 && vWPos.y - base < 45.0) {
    vec4 im = imgColor(vWPos.xz);
    diffuseColor.rgb = mix(diffuseColor.rgb, im.rgb, im.w * 0.9);
  } else if (n.y > 0.6) {
    // 높은 건물 옥상: 회색 바닥 + 기계실 느낌의 얼룩
    diffuseColor.rgb = mix(vec3(0.46, 0.47, 0.47), vec3(0.62, 0.62, 0.60), bHash(floor(vWPos.xz / 6.0)));
  }
}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.06, bGlass);
metalnessFactor = mix(metalnessFactor, 0.75, bGlass);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float warm = bHash(floor(vec2(vWPos.x, vWPos.z) / 9.0) + vStyle.y);
  vec3 lightC = mix(vec3(1.0, 0.78, 0.45), vec3(0.85, 0.92, 1.0), step(0.6, warm));
  // 간판(bLit > 1.5)은 제 색으로 빛난다
  lightC = mix(lightC, diffuseColor.rgb * 1.6, step(1.5, bLit));
  totalEmissiveRadiance += lightC * min(bLit, 1.2) * uNight * 1.1;
}`);
  };
  return m;
}

/** 일반 지오메트리에 aStyle 속성을 채운다 */
export function setStyle(geo: THREE.BufferGeometry, style: number, seed: number, floorH: number, base: number): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { a[i * 4] = style; a[i * 4 + 1] = seed; a[i * 4 + 2] = floorH; a[i * 4 + 3] = base; }
  geo.setAttribute('aStyle', new THREE.BufferAttribute(a, 4));
  return geo;
}

/** 지면 디테일 (밝기 잡음) */
export function makeDetailTexture(): THREE.Texture {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const img = g.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    const x = i % s, y = (i / s) | 0;
    const v = 0.86 + 0.14 * (0.5 + 0.5 * Math.sin(x * 0.21 + Math.sin(y * 0.13) * 2) * Math.sin(y * 0.17 + Math.cos(x * 0.09) * 2)) - Math.random() * 0.08;
    const b = Math.max(0, Math.min(255, v * 255));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 물결 노멀맵 (타일링되는 사인 합) */
export function makeWaterNormal(): THREE.Texture {
  const s = 256;
  const h = new Float32Array(s * s);
  const waves: [number, number, number, number][] = [];
  for (let i = 0; i < 14; i++) {
    const kx = Math.round((Math.random() - 0.5) * 16), ky = Math.round((Math.random() - 0.5) * 16);
    waves.push([kx, ky || 1, Math.random() * 6.28, 1 / (1 + Math.hypot(kx, ky) * 0.4)]);
  }
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    let v = 0;
    for (const [kx, ky, ph, a] of waves) v += a * Math.sin(((kx * x + ky * y) / s) * Math.PI * 2 + ph);
    h[y * s + x] = v;
  }
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const img = g.createImageData(s, s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const dx = h[y * s + ((x + 1) % s)] - h[y * s + ((x - 1 + s) % s)];
    const dy = h[((y + 1) % s) * s + x] - h[((y - 1 + s) % s) * s + x];
    const nx = -dx * 0.5, ny = -dy * 0.5, nz = 1;
    const l = Math.hypot(nx, ny, nz);
    const i = (y * s + x) * 4;
    img.data[i] = ((nx / l) * 0.5 + 0.5) * 255;
    img.data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255;
    img.data[i + 2] = ((nz / l) * 0.5 + 0.5) * 255;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 둥근 점 스프라이트 (불빛용) */
export function makeGlowSprite(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

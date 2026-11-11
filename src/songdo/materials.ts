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
varying vec3 vWPos;
varying vec3 vWNorm;
varying vec4 vStyle;`)
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
}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uNight;
varying vec3 vWPos;
varying vec3 vWNorm;
varying vec4 vStyle;
float bHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
${IMAGERY_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float bWin = 0.0;
float bLit = 0.0;
float bGlass = 0.0;
{
  vec3 n = normalize(vWNorm);
  float wall = 1.0 - step(0.6, abs(n.y));
  int st = int(vStyle.x + 0.5);
  float winW = st == 0 ? 3.2 : st == 1 ? 2.4 : st == 2 ? 3.6 : st == 3 ? 7.0 : st == 5 ? 1.8 : 1000.0;
  vec2 t = normalize(vec2(-n.z, n.x) + 1e-5);
  float hx = dot(vWPos.xz, t) / winW;
  float fy = (vWPos.y - vStyle.w) / max(vStyle.z, 1.0);
  vec2 cell = floor(vec2(hx, fy));
  vec2 f = fract(vec2(hx, fy));
  float w;
  if (st == 1 || st == 5) w = step(0.07, f.x) * step(f.x, 0.93) * step(0.1, f.y) * step(f.y, 0.94);
  else if (st == 0) w = step(0.1, f.x) * step(f.x, 0.9) * step(0.32, f.y) * step(f.y, 0.86);
  else if (st == 3) w = step(0.3, f.x) * step(f.x, 0.7) * step(0.55, f.y) * step(f.y, 0.8);
  else w = step(0.18, f.x) * step(f.x, 0.82) * step(0.3, f.y) * step(f.y, 0.82);
  float fill = st == 1 || st == 5 ? 0.78 : st == 0 ? 0.43 : st == 3 ? 0.1 : 0.4;
  float aa = clamp(1.6 - max(fwidth(hx), fwidth(fy)) * 2.2, 0.0, 1.0);
  w = mix(fill, w, aa);
  w *= wall * step(0.0, fy) * (st == 4 ? 0.0 : 1.0);
  bWin = w;
  float seed = vStyle.y;
  float lit = step(0.68, bHash(cell + vec2(seed * 17.0, seed * 3.0)));
  bLit = mix(0.12, lit, aa) * w * step(1.0, fy);
  vec3 glass = (st == 1 || st == 5) ? mix(diffuseColor.rgb * 0.55, vec3(0.20, 0.28, 0.36), 0.55) : vec3(0.10, 0.13, 0.17);
  vec3 wallC = (st == 1 || st == 5) ? diffuseColor.rgb * 0.85 : diffuseColor.rgb;
  diffuseColor.rgb = mix(wallC, glass, w);
  // 지붕은 조금 어둡게
  diffuseColor.rgb *= mix(0.78, 1.0, wall);
  bGlass = w;
  // 낮은 건물 지붕에는 항공사진 (높은 건물은 사진에서 기울어져 보여 맞지 않음)
  if (n.y > 0.45 && vWPos.y - vStyle.w < 45.0) {
    vec4 im = imgColor(vWPos.xz);
    diffuseColor.rgb = mix(diffuseColor.rgb, im.rgb, im.w * 0.9);
  }
}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.12, bGlass);
metalnessFactor = mix(metalnessFactor, 0.35, bGlass);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float warm = bHash(floor(vec2(vWPos.x, vWPos.z) / 9.0) + vStyle.y);
  vec3 lightC = mix(vec3(1.0, 0.78, 0.45), vec3(0.85, 0.92, 1.0), step(0.6, warm));
  totalEmissiveRadiance += lightC * bLit * uNight * 1.1;
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

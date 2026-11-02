// 변동 출력 곡선 (결정적). Baseline §12.11

import type { RegionDef } from './data';
import { localMinute } from './market';
import { PPM } from './units';

function hash2(a: number, b: number): number {
  let h = (Math.imul(a, 2654435761) ^ Math.imul(b, 1597334677)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967295;
}

/** 태양광 출력 계수 (ppm): 현지 6–18시 사인 곡선 × 지역 자원 × 위도 */
export function solarPpm(r: RegionDef, step: number): number {
  const m = localMinute(r, step);
  const x = (m - 360) / 720;
  if (x <= 0 || x >= 1) return 0;
  const sun = Math.sin(Math.PI * x);
  const resource = 0.45 + 0.11 * r.solar;
  const latF = Math.cos((r.lat * Math.PI) / 180);
  return Math.floor(sun * resource * latF * PPM);
}

/** 풍력 출력 계수 (ppm): 6시간 간격 결정적 값 사이를 부드럽게 보간 */
export function windPpm(r: RegionDef, seed: number, step: number): number {
  const knot = Math.floor(step / 360);
  const t = (step % 360) / 360;
  const a = hash2(knot, r.id * 7919 + seed);
  const b = hash2(knot + 1, r.id * 7919 + seed);
  const u = t * t * (3 - 2 * t);
  const v = a + (b - a) * u;
  const base = 0.08 + 0.09 * r.wind;
  return Math.floor(Math.min(1, v * base * 1.25) * PPM);
}

// 가상 행성 지형 (순수 함수, DOM 없음).
// 시뮬레이션(지역 배치)과 화면(텍스처)이 같은 함수를 쓰므로 둘이 어긋나지 않는다.
// 지구가 아닌 가상 대륙이다 (사용자 확정: 완전한 가상 행성).

function hash3(i: number, j: number, k: number, seed: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1440662683) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
  const c = (a: number, b: number, d: number) => hash3(xi + a, yi + b, zi + d, seed);
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * xf;
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * xf;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * xf;
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * xf;
  const y0 = x00 + (x10 - x00) * yf;
  const y1 = x01 + (x11 - x01) * yf;
  return y0 + (y1 - y0) * zf; // 0..1
}

function fbm(x: number, y: number, z: number, seed: number, octaves: number): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm; // 0..1
}

export const SEA_LEVEL = 0.52;

/** 위도·경도(도) → 단위 구 좌표. 경도 0은 +Z 방향. */
export function latLonToVec(latDeg: number, lonDeg: number): [number, number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
}

/** 고도 0..1. SEA_LEVEL 이상이면 육지. */
export function heightAt(latDeg: number, lonDeg: number, seed: number, octaves = 6): number {
  const [x, y, z] = latLonToVec(latDeg, lonDeg);
  // 큰 대륙 형태 + 세부 + 도메인 왜곡으로 해안선을 비튼다.
  const wx = fbm(x * 1.3 + 5.1, y * 1.3, z * 1.3, seed + 7, 3) - 0.5;
  const wy = fbm(x * 1.3, y * 1.3 + 9.7, z * 1.3, seed + 13, 3) - 0.5;
  const px = x + wx * 0.6, py = y + wy * 0.6, pz = z;
  const continent = fbm(px * 1.1, py * 1.1, pz * 1.1, seed, 3);
  const detail = fbm(px * 3.2, py * 3.2, pz * 3.2, seed + 31, octaves);
  let h = continent * 0.72 + detail * 0.28;
  // 극지방은 약간 낮춰 넓은 빙해를 만든다.
  h -= Math.max(0, Math.abs(latDeg) - 72) * 0.004;
  return h;
}

/** 습도 0..1 (사막·숲 구분용). */
export function moistureAt(latDeg: number, lonDeg: number, seed: number): number {
  const [x, y, z] = latLonToVec(latDeg, lonDeg);
  const m = fbm(x * 2.1 + 3.3, y * 2.1 - 1.7, z * 2.1, seed + 57, 4);
  // 위도 25° 부근은 건조대.
  const dryBelt = Math.exp(-Math.pow((Math.abs(latDeg) - 25) / 10, 2)) * 0.25;
  return Math.min(1, Math.max(0, m - dryBelt + 0.05));
}

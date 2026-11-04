// 가상 행성 텍스처 생성 (웹 워커). 시뮬레이션과 같은 terrain 함수를 쓴다.
// 색감은 디자이너가 보낸 가상 지도 시안(심해 남색 · 얕은 바다 청록 · 숲 · 사막 · 빙하)을 따른다.

import { heightAt, moistureAt, SEA_LEVEL } from '../world/terrain';

interface Req { seed: number; width: number; height: number; cities: { lat: number; lon: number }[] }
// 출력: day(색, a=바다 255), night(야간 불빛), relief(r·g = 동·북 방향 기울기, b = 바다), ids(r = 가장 가까운 지역 번호 → 지역 경계·색칠)

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const DEEP: RGB = [8, 28, 58];
const OCEAN: RGB = [14, 58, 98];
const SHALLOW: RGB = [38, 170, 176];
const SAND: RGB = [196, 152, 96];
const DESERT: RGB = [205, 150, 88];
const GRASS: RGB = [92, 120, 58];
const FOREST: RGB = [48, 86, 40];
const ROCK: RGB = [112, 98, 84];
const SNOW: RGB = [232, 238, 244];

function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

self.onmessage = (ev: MessageEvent<Req>) => {
  const { seed, width: W, height: H, cities } = ev.data;
  const day = new Uint8ClampedArray(W * H * 4);
  const night = new Uint8ClampedArray(W * H * 4);
  const relief = new Uint8ClampedArray(W * H * 4);
  const ids = new Uint8ClampedArray(W * H * 4);
  const cv = cities.map((c) => { const la = (c.lat * Math.PI) / 180, lo = (c.lon * Math.PI) / 180; return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)]; });
  const heights = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const lat = 90 - ((y + 0.5) / H) * 180;
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W) * 360 - 180;
      heights[y * W + x] = heightAt(lat, lon, seed, 5);
    }
    if (y % 32 === 0) (self as unknown as Worker).postMessage({ progress: (y / H) * 0.8 });
  }
  for (let y = 0; y < H; y++) {
    const lat = 90 - ((y + 0.5) / H) * 180;
    const alat = Math.abs(lat);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const lon = ((x + 0.5) / W) * 360 - 180;
      const h = heights[i];
      // 간단한 음영: 동서 기울기
      const hx = heights[y * W + ((x + 1) % W)] - heights[y * W + ((x - 1 + W) % W)];
      const shade = 1; // 음영은 화면 셰이더가 기울기 지도로 계산한다
      let c: RGB;
      let land = false;
      if (h < SEA_LEVEL) {
        const depth = clamp01((SEA_LEVEL - h) / 0.12);
        c = depth < 0.18 ? mix(SHALLOW, OCEAN, depth / 0.18) : mix(OCEAN, DEEP, (depth - 0.18) / 0.82);
        if (alat > 76) c = mix(c, SNOW, clamp01((alat - 76) / 6) * 0.9);
      } else {
        land = true;
        const e = clamp01((h - SEA_LEVEL) / 0.22);
        const m = moistureAt(lat, lon, seed);
        if (e < 0.03) c = SAND;
        else {
          const lowland = m < 0.38 ? mix(DESERT, GRASS, clamp01((m - 0.28) / 0.1)) : mix(GRASS, FOREST, clamp01((m - 0.45) / 0.2));
          c = e > 0.62 ? mix(lowland, ROCK, clamp01((e - 0.62) / 0.2)) : lowland;
          if (e > 0.82) c = mix(c, SNOW, clamp01((e - 0.82) / 0.1));
        }
        if (alat > 66) c = mix(c, SNOW, clamp01((alat - 66) / 8));
        c = [c[0] * shade, c[1] * shade, c[2] * shade];
      }
      const n = 0.94 + hash(x, y) * 0.1;
      const o = (H - 1 - y) * W + x; // 텍스처는 아래 행부터 (v=0 = 남극)
      day[o * 4] = c[0] * n; day[o * 4 + 1] = c[1] * n; day[o * 4 + 2] = c[2] * n; day[o * 4 + 3] = 255;
      // 지형 기울기 (화면에서 노멀로 바꿔 산·계곡 음영을 만든다). 동서 간격은 위도에 따라 좁아진다.
      const cosl = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
      const hy = heights[Math.max(0, y - 1) * W + x] - heights[Math.min(H - 1, y + 1) * W + x];
      const g = land ? 60 * (W / 2048) : 6 * (W / 2048);
      relief[o * 4] = 128 + Math.max(-127, Math.min(127, (hx / cosl) * g));
      relief[o * 4 + 1] = 128 + Math.max(-127, Math.min(127, hy * g));
      relief[o * 4 + 2] = land ? 0 : 255;
      relief[o * 4 + 3] = 255;
      // 가장 가까운 지역 (구면 내적 최대)
      const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
      const px = Math.cos(la) * Math.sin(lo), py = Math.sin(la), pz = Math.cos(la) * Math.cos(lo);
      let best = 0, bd = -2;
      for (let k = 0; k < cv.length; k++) { const d = px * cv[k][0] + py * cv[k][1] + pz * cv[k][2]; if (d > bd) { bd = d; best = k; } }
      ids[o * 4] = best; ids[o * 4 + 1] = land ? 255 : 0; ids[o * 4 + 3] = 255;

      // 야간 불빛: 지역 중심(도시) 주변 + 해안선, 육지에서만
      let light = 0;
      if (land && alat < 70) {
        for (const ct of cities) {
          const dLat = lat - ct.lat;
          let dLon = Math.abs(lon - ct.lon);
          if (dLon > 180) dLon = 360 - dLon;
          const d2 = dLat * dLat + dLon * dLon * Math.cos((lat * Math.PI) / 180) ** 2;
          light += Math.exp(-d2 / 22) * 1.1;
        }
        const coast = h < SEA_LEVEL + 0.015 ? 0.22 : 0;
        light += coast;
        const r = hash(x * 7 + 3, y * 13 + 1);
        light = r < light * 0.5 ? 0.6 + r : light * 0.08;
      }
      const L = clamp01(light);
      night[o * 4] = 255 * L; night[o * 4 + 1] = 178 * L; night[o * 4 + 2] = 90 * L; night[o * 4 + 3] = 255;
    }
    if (y % 32 === 0) (self as unknown as Worker).postMessage({ progress: 0.8 + (y / H) * 0.2 });
  }
  (self as unknown as Worker).postMessage({ done: true, day, night, relief, ids, width: W, height: H }, [day.buffer, night.buffer, relief.buffer, ids.buffer]);
};

// 좌표 변환·랜드마크·지명·기하 도우미.
// 좌표: 월드 x = 동쪽(m), z = 남쪽(m) (Three.js에서 -z가 북쪽). 기준점 = 북위 37.39°, 동경 126.65° (국소 등장방형 투영).
import type { Meta } from './data';

export interface P2 { x: number; z: number }

export const ORIGIN = { lat: 37.39, lon: 126.65 };
const R = 6371008.8;
let MPD_LAT = (Math.PI / 180) * R;
let MPD_LON = MPD_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);

export function fromLatLon(lat: number, lon: number): P2 {
  return { x: (lon - ORIGIN.lon) * MPD_LON, z: -(lat - ORIGIN.lat) * MPD_LAT };
}
export function toLatLon(p: P2): { lat: number; lon: number } {
  return { lat: ORIGIN.lat - p.z / MPD_LAT, lon: ORIGIN.lon + p.x / MPD_LON };
}

/** 헤딩(도, 북=0 시계방향) → 월드 방향 */
export function headingDir(deg: number): P2 {
  const r = (deg * Math.PI) / 180;
  return { x: Math.sin(r), z: -Math.cos(r) };
}
/** 월드 방향 → 헤딩(도) */
export function headingOf(dx: number, dz: number): number {
  return ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
}

export interface Landmark { id: string; name: string; at: P2; kind: 'airport' | 'songdo' | 'other' }
/** 자료(meta.json)에서 채운다 */
export const LANDMARKS: Landmark[] = [];

export function initGeo(meta: Meta) {
  MPD_LAT = meta.mpdLat;
  MPD_LON = meta.mpdLon;
  LANDMARKS.length = 0;
  for (const l of meta.landmarks) LANDMARKS.push({ id: l.id, name: l.name, at: { x: l.x, z: l.z }, kind: l.kind });
}
export const landmark = (id: string) => LANDMARKS.find((l) => l.id === id)!;

/** 대략적 지역 이름 (위도·경도 상자) */
const REGIONS: { name: string; lat0: number; lat1: number; lon0: number; lon1: number }[] = [
  { name: '인천국제공항', lat0: 37.425, lat1: 37.495, lon0: 126.37, lon1: 126.475 },
  { name: '영종도', lat0: 37.42, lat1: 37.53, lon0: 126.475, lon1: 126.61 },
  { name: '무의도', lat0: 37.36, lat1: 37.42, lon0: 126.39, lon1: 126.44 },
  { name: '인천신항', lat0: 37.33, lat1: 37.36, lon0: 126.59, lon1: 126.65 },
  { name: '송도국제도시', lat0: 37.355, lat1: 37.43, lon0: 126.59, lon1: 126.70 },
  { name: '청라국제도시', lat0: 37.51, lat1: 37.56, lon0: 126.61, lon1: 126.69 },
  { name: '인천 중구', lat0: 37.44, lat1: 37.49, lon0: 126.59, lon1: 126.65 },
  { name: '인천 연수구', lat0: 37.40, lat1: 37.44, lon0: 126.64, lon1: 126.70 },
  { name: '인천 미추홀구', lat0: 37.43, lat1: 37.47, lon0: 126.64, lon1: 126.71 },
  { name: '인천 남동구', lat0: 37.37, lat1: 37.47, lon0: 126.69, lon1: 126.77 },
  { name: '인천 부평·서구', lat0: 37.47, lat1: 37.60, lon0: 126.64, lon1: 126.80 },
  { name: '시흥', lat0: 37.28, lat1: 37.40, lon0: 126.70, lon1: 126.80 },
];

export function placeName(p: P2, water = false): string {
  let best = '', bd = Infinity;
  for (const l of LANDMARKS) {
    const d = Math.hypot(l.at.x - p.x, l.at.z - p.z);
    if (d < bd) { bd = d; best = l.name; }
  }
  if (bd < 450) return best + ' 부근';
  const { lat, lon } = toLatLon(p);
  for (const r of REGIONS) if (lat >= r.lat0 && lat <= r.lat1 && lon >= r.lon0 && lon <= r.lon1) return water && r.name !== '송도국제도시' ? r.name + ' 앞바다' : r.name;
  return water ? '인천 앞바다' : '인천';
}

// ── 기하 도우미 ──
export function pointInPoly(x: number, z: number, pts: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
export function distToSeg(x: number, z: number, a: P2, b: P2): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = a.x + dx * t - x, ez = a.z + dz * t - z;
  return Math.sqrt(ex * ex + ez * ez);
}

/** 결정론 난수 */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

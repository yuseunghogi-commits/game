// 송도·영종도·인천 지리 데이터.
// 좌표: 월드 x = 동쪽(m), z = 남쪽(m) (Three.js에서 -z가 북쪽). 기준점 = 북위 37.39°, 동경 126.65° (송도 부근).
// 지형 모양은 실측 데이터가 아니라 지도 기억을 바탕으로 한 근사치다 (해안선·랜드마크 위치는 대략 수백 m 오차).

export const ORIGIN = { lat: 37.39, lon: 126.65 };
export const KM_PER_DEG_LAT = 110.95;
export const KM_PER_DEG_LON = 88.2;

export interface P2 { x: number; z: number }

/** km 단위 (동쪽, 북쪽) → 월드 m */
export const km = (east: number, north: number): P2 => ({ x: east * 1000, z: -north * 1000 });

export function fromLatLon(lat: number, lon: number): P2 {
  return km((lon - ORIGIN.lon) * KM_PER_DEG_LON, (lat - ORIGIN.lat) * KM_PER_DEG_LAT);
}
export function toLatLon(p: P2): { lat: number; lon: number } {
  return { lat: ORIGIN.lat - p.z / 1000 / KM_PER_DEG_LAT, lon: ORIGIN.lon + p.x / 1000 / KM_PER_DEG_LON };
}

// ── 송도 격자 좌표계 (U: 옛 해안선을 따라 동남동, V: 바다 쪽 남남서), 단위 km ──
const SD_C0 = { e: -3.5, n: 3.6 };
const SD_ANG = (21 * Math.PI) / 180;
export const SD_U = { e: Math.cos(SD_ANG), n: -Math.sin(SD_ANG) };
export const SD_V = { e: -Math.sin(SD_ANG), n: -Math.cos(SD_ANG) };
/** 방향 벡터(월드 x,z)에 지역 x축을 맞추는 Three.js Y축 회전 */
export const rotFor = (dx: number, dz: number) => Math.atan2(-dz, dx);
/** 송도 격자 방향 (Three.js Y축 회전): 건물 지역 x축이 U축과 나란하도록 */
export const SD_ROT = rotFor(SD_U.e, -SD_U.n);

export function sd(u: number, v: number): P2 {
  return km(SD_C0.e + SD_U.e * u + SD_V.e * v, SD_C0.n + SD_U.n * u + SD_V.n * v);
}
export function toSd(p: P2): { u: number; v: number } {
  const e = p.x / 1000 - SD_C0.e;
  const n = -p.z / 1000 - SD_C0.n;
  return { u: e * SD_U.e + n * SD_U.n, v: e * SD_V.e + n * SD_V.n };
}

// ── 인천공항 좌표계 (D: 활주로 방향 142°, P: 직각 북동쪽), 기준 = 제1여객터미널, 단위 km ──
const AP_T1 = { e: -17.62, n: 6.57 };
export const RWY_HEADING_DEG = 142;
const AP_H = (RWY_HEADING_DEG * Math.PI) / 180;
export const AP_D = { e: Math.sin(AP_H), n: Math.cos(AP_H) };
export const AP_P = { e: Math.cos(AP_H), n: -Math.sin(AP_H) };
/** 공항 격자 방향 (Three.js Y축 회전): 지역 x축 = 활주로 방향 */
export const AP_ROT = rotFor(AP_D.e, -AP_D.n);
export function ap(d: number, p: number): P2 {
  return km(AP_T1.e + AP_D.e * d + AP_P.e * p, AP_T1.n + AP_D.n * d + AP_P.n * p);
}
export function toAp(q: P2): { d: number; p: number } {
  const e = q.x / 1000 - AP_T1.e;
  const n = -q.z / 1000 - AP_T1.n;
  return { d: e * AP_D.e + n * AP_D.n, p: e * AP_P.e + n * AP_P.n };
}

/** 헤딩(도, 북=0 시계방향) → 월드 방향 벡터 */
export function headingDir(deg: number): P2 {
  const r = (deg * Math.PI) / 180;
  return { x: Math.sin(r), z: -Math.cos(r) };
}

// ── 땅 다각형 ──
export type LandKind = 'reclaim' | 'natural';
export interface LandPoly { name: string; kind: LandKind; pts: P2[] }

const K = (pts: [number, number][]) => pts.map(([e, n]) => km(e, n));
const S = (pts: [number, number][]) => pts.map(([u, v]) => sd(u, v));
const A = (pts: [number, number][]) => pts.map(([d, p]) => ap(d, p));

export const SONGDO_UV: [number, number][] = [
  [-0.6, 0.15], [9.2, 0.15], [10.0, 1.2], [10.2, 4.4], [8.6, 5.0], [6.0, 5.4], [3.6, 5.3], [1.6, 4.6], [0.2, 3.6], [-0.9, 2.4], [-1.2, 1.0],
];

export const LANDS: LandPoly[] = [
  {
    name: '인천 내륙', kind: 'natural', pts: [
      ...K([[24, -18], [24, 28], [-3.6, 28], [-4.4, 22], [-4.6, 17.0], [-3.8, 15.0], [-3.2, 13.2], [-3.4, 11.5], [-4.4, 10.6], [-5.0, 9.9], [-4.6, 9.1], [-3.9, 8.6], [-4.3, 7.6], [-5.3, 6.9], [-5.3, 5.6], [-4.6, 4.8]]),
      // 옛 송도 해안선 (송도와 수로를 사이에 둠)
      ...S([[-1.0, -0.15], [2.0, -0.15], [5.0, -0.15], [8.0, -0.15], [9.5, -0.15]]),
      ...K([[5.75, -1.0], [5.6, -2.6], [4.9, -4.5], [4.2, -5.3], [3.3, -5.6], [3.6, -6.6], [6, -8], [9, -10], [14, -13], [18, -18]]),
    ],
  },
  { name: '송도국제도시', kind: 'reclaim', pts: S(SONGDO_UV) },
  { name: '인천신항', kind: 'reclaim', pts: S([[2.6, 5.9], [6.6, 5.9], [6.9, 8.4], [2.9, 8.7]]) },
  {
    name: '영종도', kind: 'natural', pts: K([
      [-16.67, 13.15], [-19.2, 11.6], [-22.35, 8.72], [-24.8, 7.8], [-25.6, 6.0], [-24.6, 4.6], [-22.6, 4.0], [-20.4, 3.2], [-17.42, 2.41],
      [-14.5, 3.6], [-11.5, 4.6], [-10.0, 5.0], [-8.2, 5.6], [-6.8, 6.8], [-6.3, 8.6], [-6.6, 10.6], [-6.0, 12.2], [-7.0, 13.8], [-8.6, 14.6],
      [-10.5, 14.3], [-12.5, 14.6], [-14.6, 14.0],
    ]),
  },
  { name: '인천국제공항', kind: 'reclaim', pts: A([[-4.6, -2.4], [3.4, -2.4], [3.4, 4.8], [-4.6, 4.8]]) },
  { name: '무의도', kind: 'natural', pts: K([[-21.6, 1.8], [-19.6, 2.2], [-18.6, 1.0], [-18.8, -0.6], [-20.2, -1.4], [-21.4, -0.4]]) },
  { name: '작약도', kind: 'natural', pts: K([[-6.4, 11.2], [-6.0, 11.4], [-5.8, 11.0], [-6.2, 10.8]]) },
  { name: '팔미도', kind: 'natural', pts: K([[-11.2, -6.8], [-10.8, -6.6], [-10.6, -7.1], [-11.0, -7.3]]) },
  { name: '선재도', kind: 'natural', pts: K([[-6.8, -11.5], [-5.2, -11.0], [-4.6, -12.6], [-6.0, -13.6], [-7.2, -12.8]]) },
];

/** 땅 다각형 위에 겹쳐 그리는 물 (공원 수로·호수). 지형 격자보다 가늘어서 따로 그린다. */
export interface WaterDecal { name: string; pts: P2[] }
export const WATER_DECALS: WaterDecal[] = [
  { name: '센트럴파크 수로', pts: S([[2.7, 2.2], [4.65, 2.2], [4.65, 2.29], [3.7, 2.31], [3.55, 2.4], [3.3, 2.4], [3.2, 2.31], [2.7, 2.3]]) },
  { name: '트라이볼 연못', pts: S([[2.1, 1.8], [2.38, 1.8], [2.38, 1.94], [2.1, 1.94]]) },
  { name: '해돋이공원 호수', pts: S([[5.8, 0.75], [6.2, 0.75], [6.2, 0.98], [5.8, 0.98]]) },
];

// ── 산 (가우시안 봉우리) ──
export interface Peak { name: string; at: P2; h: number; r: number }
export const PEAKS: Peak[] = [
  { name: '청량산', at: km(0.9, 2.4), h: 172, r: 700 },
  { name: '문학산', at: km(1.8, 5.4), h: 217, r: 900 },
  { name: '봉재산', at: km(-0.6, 4.1), h: 104, r: 500 },
  { name: '소래산', at: km(10.5, 5.2), h: 299, r: 1200 },
  { name: '원적산', at: km(5.3, 11.0), h: 200, r: 1100 },
  { name: '계양산', at: km(6.2, 18.5), h: 395, r: 1500 },
  { name: '수봉산', at: km(-0.4, 8.6), h: 104, r: 500 },
  { name: '백운산', at: km(-7.6, 10.1), h: 255, r: 1100 },
  { name: '금산', at: km(-10.2, 12.6), h: 140, r: 900 },
  { name: '오성산', at: km(-13.2, 13.4), h: 172, r: 800 },
  { name: '호룡곡산', at: km(-20.0, 0.2), h: 246, r: 900 },
  { name: '국사봉', at: km(-20.6, 1.4), h: 230, r: 700 },
  { name: '오봉산', at: km(-24.2, 6.4), h: 140, r: 700 },
  { name: '선재도 봉우리', at: km(-6.0, -12.3), h: 90, r: 600 },
];

/** 평평하게 다지는 구역 (공항·송도·신항 전체 + 영종하늘도시) */
export const FLAT_ZONES: { pts: P2[]; h: number }[] = [
  { pts: A([[-4.4, -2.2], [3.2, -2.2], [3.2, 4.6], [-4.4, 4.6]]), h: 6 },
  { pts: K([[-9.6, 5.2], [-7.2, 6.0], [-6.6, 7.6], [-7.0, 8.8], [-9.0, 8.6], [-10.2, 6.8]]), h: 6 },
];

// ── 활주로 ──
export interface Runway { name: string; a: string; b: string; p: number; d0: number; len: number; width: number }
// d0 = 활주로 중심의 D 좌표(km), p = 옆 위치(km), len/width = m
export const RUNWAYS: Runway[] = [
  { name: '15R/33L', a: '15R', b: '33L', p: -1.2, d0: -0.5, len: 3750, width: 60 },
  { name: '15L/33R', a: '15L', b: '33R', p: 1.0, d0: -0.5, len: 3750, width: 60 },
  { name: '16R/34L', a: '16R', b: '34L', p: 2.6, d0: -0.7, len: 4000, width: 60 },
  { name: '16L/34R', a: '16L', b: '34R', p: 3.9, d0: -0.7, len: 3750, width: 60 },
];
export function runwayEnds(r: Runway): { a: P2; b: P2 } {
  const half = r.len / 2000;
  return { a: ap(r.d0 - half, r.p), b: ap(r.d0 + half, r.p) };
}

// ── 인천대교 (중심선, 월드 좌표, 높이 = 노면 m) ──
export interface BridgePt { p: P2; y: number }
export const BRIDGE_MAIN_SPAN = { from: 0.47, to: 0.555 }; // 경로 비율 (사장교 구간)
export const INCHEON_BRIDGE: P2[] = K([
  [-10.3, 4.2], [-10.0, 2.6], [-9.3, 1.3], [-8.2, 0.55], [-7.0, 0.35], [-5.9, 0.7], [-5.1, 1.5], [-4.75, 2.0],
]);

// ── 랜드마크 (지도·순간이동·위치 표시) ──
export interface Landmark { id: string; name: string; at: P2; kind: 'airport' | 'songdo' | 'other'; desc?: string }
export const LANDMARKS: Landmark[] = [
  { id: 't1', name: '인천공항 제1여객터미널', at: ap(0, 0), kind: 'airport' },
  { id: 't2', name: '인천공항 제2여객터미널', at: ap(-2.4, 1.8), kind: 'airport' },
  { id: 'neatt', name: '동북아무역센터 (NEATT)', at: sd(2.45, 2.22), kind: 'songdo', desc: '높이 305m' },
  { id: 'park', name: '송도 센트럴파크', at: sd(3.6, 2.08), kind: 'songdo' },
  { id: 'tribowl', name: '트라이볼', at: sd(2.24, 1.87), kind: 'songdo' },
  { id: 'gtower', name: 'G타워', at: sd(2.0, 2.15), kind: 'songdo' },
  { id: 'convensia', name: '송도컨벤시아', at: sd(3.95, 2.72), kind: 'songdo' },
  { id: 'posco', name: '포스코타워 송도', at: sd(4.55, 2.68), kind: 'songdo' },
  { id: 'firstworld', name: '더샵 퍼스트월드', at: sd(2.9, 2.8), kind: 'songdo' },
  { id: 'hanok', name: '송도 한옥마을', at: sd(4.4, 1.98), kind: 'songdo' },
  { id: 'yonsei', name: '연세대 국제캠퍼스', at: sd(6.7, 2.6), kind: 'songdo' },
  { id: 'inu', name: '인천대학교', at: sd(3.8, 4.25), kind: 'songdo' },
  { id: 'moonlight', name: '송도 달빛축제공원', at: sd(1.65, 1.42), kind: 'songdo' },
  { id: 'golf', name: '잭니클라우스 골프클럽', at: sd(1.35, 3.25), kind: 'songdo' },
  { id: 'outlet', name: '현대프리미엄아울렛', at: sd(5.45, 3.6), kind: 'songdo' },
  { id: 'bio', name: '송도 바이오단지', at: sd(8.6, 4.0), kind: 'songdo' },
  { id: 'haedoji', name: '해돋이공원', at: sd(6.0, 0.9), kind: 'songdo' },
  { id: 'newport', name: '인천신항', at: sd(4.7, 7.2), kind: 'other' },
  { id: 'bridge', name: '인천대교 주탑', at: km(-7.6, 0.42), kind: 'other' },
  { id: 'skycity', name: '영종하늘도시', at: km(-8.3, 7.0), kind: 'other' },
  { id: 'wolmido', name: '월미도', at: km(-4.75, 9.4), kind: 'other' },
  { id: 'cheongnyang', name: '청량산', at: km(0.9, 2.4), kind: 'other' },
];

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
/** 부호 있는 거리: 안쪽 +, 바깥 − (m) */
export function sdfPoly(x: number, z: number, pts: P2[]): number {
  let d = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) d = Math.min(d, distToSeg(x, z, pts[i], pts[j]));
  return pointInPoly(x, z, pts) ? d : -d;
}
export function polyBounds(pts: P2[]) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  return { x0, x1, z0, z1 };
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
/** 2D 값 노이즈 (0..1) */
function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
export function fbm(x: number, z: number, oct = 4): number {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += amp * vnoise(x * f, z * f); f *= 2.03; amp *= 0.5; }
  return s;
}

/** 위치에 가장 가까운 지명 */
export function placeName(p: P2): string {
  const s = toSd(p);
  const inSongdo = pointInPoly(p.x, p.z, LANDS[1].pts);
  let best = '', bd = Infinity;
  for (const l of LANDMARKS) {
    const d = Math.hypot(l.at.x - p.x, l.at.z - p.z);
    if (d < bd) { bd = d; best = l.name; }
  }
  if (bd < 700) return best + ' 부근';
  if (inSongdo) {
    if (s.u < 1.5) return '송도 6·8공구';
    if (s.u < 5.2) return '송도 국제업무지구';
    if (s.u < 7.5) return '송도 지식정보산업단지';
    return '송도 바이오·11공구';
  }
  const a = toAp(p);
  if (a.d > -4.6 && a.d < 3.4 && a.p > -2.4 && a.p < 4.8) return '인천국제공항';
  for (const L of LANDS) if (pointInPoly(p.x, p.z, L.pts)) return L.name;
  return '인천 앞바다';
}

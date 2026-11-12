// 실제 지도 자료 (tools/songdo-data/build.py가 만든 public/songdo/*) 읽기.
// 자료 출처: OpenStreetMap 기여자(ODbL) · Overture Maps · AWS Terrain Tiles.

export interface Meta {
  version: number;
  origin: [number, number];
  mpdLat: number; mpdLon: number;
  bounds: [number, number, number, number];
  cell: number; nx: number; nz: number;
  wcell: number; wx: number; wz: number;
  ground: { w: number; h: number };
  runways: { ref: string; name: string; a: [number, number]; b: [number, number]; width: number }[];
  airportH: number;
  gates: [number, number][];
  landmarks: { id: string; name: string; x: number; z: number; kind: 'songdo' | 'airport' | 'other' }[];
  pylons: { x: number; z: number; dx: number; dz: number }[];
  named: Record<string, [number, number, number]>;
  attribution: string;
}

export interface Buildings {
  n: number;
  cx: Float64Array; cz: Float64Array;
  h: Float32Array; minH: Float32Array;
  start: Uint32Array; count: Uint16Array;
  color: Uint16Array; style: Uint8Array; flags: Uint8Array;
  /** 중심 기준 꼭짓점 (m), x,z 교대로 */
  verts: Float32Array;
}

export interface Roads {
  n: number;
  start: Uint32Array; count: Uint32Array;
  x: Float32Array; z: Float32Array; y: Float32Array;
  cls: Uint8Array; width: Float32Array; flags: Uint8Array;
}

/** 도로 종류 코드 (build.py ROAD/RAIL과 같음) */
export const RC = { Motorway: 1, Trunk: 2, Primary: 3, Secondary: 4, Tertiary: 5, Residential: 6, Service: 7, Pedestrian: 8, Foot: 9, Rail: 10, Mono: 11, Taxiway: 12, Taxilane: 13 } as const;

export interface Trees { n: number; x: Float32Array; z: Float32Array; kind: Uint8Array }
/** 호수·수로 수면 삼각형 (바다와 이어진 물 제외) */
export interface WaterAreas { n: number; y: Float32Array; xz: Float32Array }

/** 곡선 지붕 삼각형 (y = 지면 위 높이) */
export interface Roofs { n: number; xz: Float32Array; y: Float32Array }
export function parseRoofs(buf: ArrayBuffer): Roofs {
  const dv = new DataView(buf);
  magic(dv, 'SDF1');
  const n = dv.getUint32(4, true);
  const i32 = new Int32Array(buf.slice(8, 8 + n * 24));
  const y = new Float32Array(buf.slice(8 + n * 24, 8 + n * 24 + n * 12));
  const xz = new Float32Array(i32.length);
  for (let i = 0; i < i32.length; i++) xz[i] = i32[i] / 10;
  return { n, xz, y };
}

export interface MapData {
  meta: Meta;
  heights: Float32Array;
  water: Uint8Array;
  buildings: Buildings;
  roads: Roads;
  trees: Trees;
  areas: WaterAreas;
  roofs: Roofs | null;
  groundUrl: string;
}

function magic(dv: DataView, s: string) {
  const m = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (m !== s) throw new Error(`자료 형식이 다릅니다: ${m} ≠ ${s}`);
}

export function parseTerrain(buf: ArrayBuffer): Float32Array {
  const i16 = new Int16Array(buf);
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 10;
  return f;
}

export function parseBuildings(buf: ArrayBuffer): Buildings {
  const dv = new DataView(buf);
  magic(dv, 'SDB2');
  const n = dv.getUint32(4, true), nv = dv.getUint32(8, true);
  let o = 12;
  const c = new Int32Array(buf.slice(o, o + n * 8)); o += n * 8;
  const h16 = new Uint16Array(buf.slice(o, o + n * 2)); o += n * 2;
  const m16 = new Uint16Array(buf.slice(o, o + n * 2)); o += n * 2;
  const count = new Uint16Array(buf.slice(o, o + n * 2)); o += n * 2;
  const color = new Uint16Array(buf.slice(o, o + n * 2)); o += n * 2;
  const v16 = new Int16Array(buf.slice(o, o + nv * 4)); o += nv * 4;
  const style = new Uint8Array(buf.slice(o, o + n)); o += n;
  const flags = new Uint8Array(buf.slice(o, o + n));
  const cx = new Float64Array(n), cz = new Float64Array(n), h = new Float32Array(n), minH = new Float32Array(n), start = new Uint32Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    cx[i] = c[i * 2] / 10; cz[i] = c[i * 2 + 1] / 10; h[i] = h16[i] / 10; minH[i] = m16[i] / 10;
    start[i] = s; s += count[i];
  }
  const verts = new Float32Array(nv * 2);
  for (let i = 0; i < nv * 2; i++) verts[i] = v16[i] / 4;
  return { n, cx, cz, h, minH, start, count, color, style, flags, verts };
}

export function parseRoads(buf: ArrayBuffer): Roads {
  const dv = new DataView(buf);
  magic(dv, 'SDR1');
  const n = dv.getUint32(4, true), np = dv.getUint32(8, true);
  let o = 12;
  const count = new Uint32Array(buf.slice(o, o + n * 4)); o += n * 4;
  const xz = new Int32Array(buf.slice(o, o + np * 8)); o += np * 8;
  const y16 = new Int16Array(buf.slice(o, o + np * 2)); o += np * 2;
  const cls = new Uint8Array(buf.slice(o, o + n)); o += n;
  const w8 = new Uint8Array(buf.slice(o, o + n)); o += n;
  const flags = new Uint8Array(buf.slice(o, o + n));
  const start = new Uint32Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) { start[i] = s; s += count[i]; }
  const x = new Float32Array(np), z = new Float32Array(np), y = new Float32Array(np);
  for (let i = 0; i < np; i++) { x[i] = xz[i * 2] / 10; z[i] = xz[i * 2 + 1] / 10; y[i] = y16[i] / 10; }
  const width = new Float32Array(n);
  for (let i = 0; i < n; i++) width[i] = w8[i] / 4;
  return { n, start, count, x, z, y, cls, width, flags };
}

export function parseTrees(buf: ArrayBuffer): Trees {
  const dv = new DataView(buf);
  magic(dv, 'SDT1');
  const n = dv.getUint32(4, true);
  const xz = new Int32Array(buf.slice(8, 8 + n * 8));
  const kind = new Uint8Array(buf.slice(8 + n * 8, 8 + n * 9));
  const x = new Float32Array(n), z = new Float32Array(n);
  for (let i = 0; i < n; i++) { x[i] = xz[i * 2] / 10; z[i] = xz[i * 2 + 1] / 10; }
  return { n, x, z, kind };
}

export function parseAreas(buf: ArrayBuffer): WaterAreas {
  const dv = new DataView(buf);
  magic(dv, 'SDA3');
  const n = dv.getUint32(4, true);
  const y = new Float32Array(buf.slice(8, 8 + n * 4));
  const i32 = new Int32Array(buf.slice(8 + n * 4, 8 + n * 4 + n * 24));
  const xz = new Float32Array(i32.length);
  for (let i = 0; i < i32.length; i++) xz[i] = i32[i] / 10;
  return { n, y, xz };
}

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const u8 = new Uint8Array(buf);
  // 서버가 이미 풀어서 준 경우 (Content-Encoding: gzip)
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return buf;
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return await new Response(stream).arrayBuffer();
}

export async function loadMapData(base: string, progress: (f: number, s: string) => void): Promise<MapData> {
  const get = async (name: string) => {
    const r = await fetch(`${base}${name}`);
    if (!r.ok) throw new Error(`${name} 을(를) 불러오지 못했습니다 (${r.status})`);
    return gunzip(await r.arrayBuffer());
  };
  progress(0.02, '지도 정보');
  const meta = (await (await fetch(`${base}meta.json`)).json()) as Meta;
  progress(0.06, '지형 고도 자료');
  const [t, w] = await Promise.all([get('terrain.bin.gz'), get('water.bin.gz')]);
  progress(0.12, '건물 12만 채 자료');
  const [b, r, tr, a, rf] = await Promise.all([get('buildings.bin.gz'), get('roads.bin.gz'), get('trees.bin.gz'), get('areas.bin.gz'), get('roofs.bin.gz').catch(() => null)]);
  return {
    meta,
    heights: parseTerrain(t),
    water: new Uint8Array(w),
    buildings: parseBuildings(b),
    roads: parseRoads(r),
    trees: parseTrees(tr),
    areas: parseAreas(a),
    roofs: rf ? parseRoofs(rf) : null,
    groundUrl: `${base}ground.jpg`,
  };
}

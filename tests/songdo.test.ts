// 송도 플라이트: 실제 지도 자료(public/songdo) 로 지형·충돌·비행 역학 테스트
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { HeightField } from '../src/songdo/heightfield';
import { World } from '../src/songdo/world';
import { Aircraft, SPECS, type FlightInput } from '../src/songdo/aircraft';
import { Walker } from '../src/songdo/walker';
import { initGeo, landmark, headingOf, fromLatLon } from '../src/songdo/geo';
import { parseBuildings, parseTerrain, type Meta } from '../src/songdo/data';
import { runwayInfo } from '../src/songdo/airport';

const dir = 'public/songdo/';
const buf = (f: string) => { const b = gunzipSync(readFileSync(dir + f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const meta = JSON.parse(readFileSync(dir + 'meta.json', 'utf8')) as Meta;
initGeo(meta);
const hf = new HeightField(meta, parseTerrain(buf('terrain.bin.gz')), new Uint8Array(buf('water.bin.gz')));
const world = new World(hf);
const bld = parseBuildings(buf('buildings.bin.gz'));
for (let i = 0; i < bld.n; i++) {
  const s = bld.start[i] * 2, c = bld.count[i];
  const pts = new Float32Array(c * 2);
  for (let k = 0; k < c; k++) { pts[k * 2] = bld.cx[i] + bld.verts[s + k * 2]; pts[k * 2 + 1] = bld.cz[i] + bld.verts[s + k * 2 + 1]; }
  const g = Math.max(0.5, hf.at(bld.cx[i], bld.cz[i])) - 0.4;
  world.addPoly(pts, g + bld.minH[i], g + bld.h[i]);
}
const runways = meta.runways.map(runwayInfo);
const r15 = runways.find((r) => r.labelA === '15L' || r.labelB === '15L')!;

function runwayPlane(id: 'airliner' | 'light') {
  const fromA = r15.labelA === '15L';
  const s = fromA ? r15.a : r15.b, e = fromA ? r15.b : r15.a;
  const dx = (e.x - s.x) / r15.len, dz = (e.z - s.z) / r15.len;
  const a = new Aircraft(SPECS[id]);
  const p = { x: s.x + dx * 180, z: s.z + dz * 180 };
  a.place(p.x, world.ground(p.x, p.z, 1e4).h + a.spec.gearH, p.z, headingOf(dx, dz));
  return a;
}

describe('실제 지도 자료', () => {
  it('건물 10만 채 이상, 활주로 4개, 15L 방향 약 142°', () => {
    expect(bld.n).toBeGreaterThan(100000);
    expect(runways.length).toBe(4);
    expect(r15.heading).toBeGreaterThan(135);
    expect(r15.heading).toBeLessThan(150);
    expect(r15.len).toBeGreaterThan(3600);
  });
  it('포스코타워-송도는 약 305m, 송도 땅 위', () => {
    const p = landmark('posco').at;
    expect(hf.waterAt(p.x, p.z)).toBe(0);
    expect(hf.at(p.x, p.z)).toBeGreaterThan(1);
    const hit = world.hitAt(p.x, 250, p.z);
    expect(hit).not.toBeNull();
    expect(hit!.top).toBeGreaterThan(290);
  });
  it('공항과 송도 사이는 바다, 청량산은 언덕', () => {
    const mid = fromLatLon(37.40, 126.53);
    expect(hf.waterAt(mid.x, mid.z)).toBe(2);
    expect(hf.at(mid.x, mid.z)).toBeLessThan(0);
    const c = landmark('cheongnyang').at;
    expect(hf.at(c.x, c.z)).toBeGreaterThan(80);
  });
});

describe('비행', () => {
  const fly = (a: Aircraft, sec: number, inp: (t: number) => Partial<FlightInput>) => {
    for (let t = 0; t < sec; t += 1 / 120) a.step(1 / 120, { pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: false, ...inp(t) }, world);
  };
  for (const id of ['airliner', 'light'] as const) {
    it(`${id}: 15L 활주로 안에서 이륙해 상승`, () => {
      const a = runwayPlane(id);
      const start = a.pos.clone();
      let liftoff = -1;
      for (let t = 0; t < 60 && liftoff < 0; t += 1 / 120) {
        a.step(1 / 120, { pitch: a.speed > a.spec.vRot ? 1 : 0, roll: 0, yaw: 0, throttle: 1, brake: false }, world);
        if (!a.onGround) liftoff = t;
      }
      expect(a.crashed).toBeNull();
      expect(liftoff).toBeGreaterThan(0);
      expect(Math.hypot(a.pos.x - start.x, a.pos.z - start.z)).toBeLessThan(r15.len - 300);
      a.gearDown = false;
      const y0 = a.pos.y;
      fly(a, 20, () => ({ pitch: 0 }));
      expect(a.crashed).toBeNull();
      expect(a.pos.y).toBeGreaterThan(y0 + 30);
    });
  }
  it('포스코타워에 부딪히면 추락', () => {
    const p = landmark('posco').at;
    const a = new Aircraft(SPECS.light);
    a.place(p.x - 600, 150, p.z, 90, 45);
    fly(a, 30, () => ({ throttle: 0.7 }));
    expect(a.crashed).toMatch(/건물/);
  });
  it('바다에 내려앉으면 추락', () => {
    const p = fromLatLon(37.40, 126.53);
    const a = new Aircraft(SPECS.light);
    a.place(p.x, 20, p.z, 0, 30);
    fly(a, 20, () => ({ pitch: -1, throttle: 0 }));
    expect(a.crashed).toMatch(/바다/);
  });
});

describe('걷기', () => {
  it('센트럴파크에서 걷고, 건물 벽은 통과하지 못한다', () => {
    const w = new Walker();
    const p = landmark('park').at;
    w.place(p.x, p.z, world);
    const z0 = w.pos.clone();
    for (let i = 0; i < 240; i++) w.step(1 / 60, { fwd: 1, side: 0, run: false, jump: false, camYaw: 0 }, world);
    expect(w.pos.distanceTo(z0)).toBeGreaterThan(3);
    // 포스코타워로 달려가도 벽에서 멈춤
    const t = landmark('posco').at;
    const w2 = new Walker();
    w2.place(t.x - 80, t.z, world);
    const yaw = Math.atan2(-(t.x - w2.pos.x), -(t.z - w2.pos.z));
    for (let i = 0; i < 1200; i++) w2.step(1 / 60, { fwd: 1, side: 0, run: true, jump: false, camYaw: yaw }, world);
    expect(world.hitAt(w2.pos.x, w2.pos.y + 1, w2.pos.z)).toBeNull();
  });
});


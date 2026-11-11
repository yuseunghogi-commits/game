// 송도 플라이트: 지형·충돌·비행 역학 테스트
import { describe, expect, it } from 'vitest';
import { HeightField } from '../src/songdo/heightfield';
import { World } from '../src/songdo/world';
import { Aircraft, SPECS, type FlightInput } from '../src/songdo/aircraft';
import { Walker } from '../src/songdo/walker';
import { LANDMARKS, RUNWAYS, RWY_HEADING_DEG, ap, sd } from '../src/songdo/geo';

const hf = new HeightField();
const world = new World(hf);
const lm = (id: string) => LANDMARKS.find((l) => l.id === id)!.at;

function runwayPlane(id: 'airliner' | 'light') {
  const r = RUNWAYS[1];
  const s = ap(r.d0 - r.len / 2000 + 0.25, r.p);
  const a = new Aircraft(SPECS[id]);
  a.place(s.x, world.ground(s.x, s.z, 1e4).h + a.spec.gearH, s.z, RWY_HEADING_DEG);
  return a;
}

describe('지형', () => {
  it('송도·공항은 평평한 땅, 사이는 바다', () => {
    expect(hf.at(lm('park').x, lm('park').z)).toBeCloseTo(4, 0);
    const t1 = lm('t1');
    expect(hf.at(t1.x, t1.z)).toBeGreaterThan(3);
    // 공항과 송도 사이 바다
    const mid = { x: (t1.x + lm('neatt').x) / 2, z: (t1.z + lm('neatt').z) / 2 + 3000 };
    expect(hf.at(mid.x, mid.z)).toBeLessThan(0);
  });
  it('청량산은 송도 옆 언덕', () => {
    const c = lm('cheongnyang');
    expect(hf.at(c.x, c.z)).toBeGreaterThan(100);
  });
});

describe('충돌', () => {
  it('건물 상자 안/밖, 지붕 위 서기, 벽 밀어내기', () => {
    const w = new World(hf);
    const p = sd(5, 1);
    w.addBox({ x: p.x, z: p.z, hx: 10, hz: 5, c: Math.cos(0.4), s: -Math.sin(0.4), base: 4, top: 50 });
    expect(w.hitBox(p.x, 20, p.z)).not.toBeNull();
    expect(w.hitBox(p.x + 30, 20, p.z)).toBeNull();
    expect(w.ground(p.x, p.z, 51).h).toBe(50);
    expect(w.ground(p.x, p.z, 10).h).toBeCloseTo(4, 0);
    const q = { x: p.x, z: p.z };
    w.pushOut(q, 4, 0.4, 1.8);
    expect(w.inside2D(w.boxes[0], q.x, q.z)).toBe(false);
  });
});

describe('비행', () => {
  const fly = (a: Aircraft, sec: number, inp: (t: number) => Partial<FlightInput>) => {
    for (let t = 0; t < sec; t += 1 / 120) a.step(1 / 120, { pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: false, ...inp(t) }, world);
  };
  for (const id of ['airliner', 'light'] as const) {
    it(`${id}: 활주로 안에서 이륙해 상승`, () => {
      const a = runwayPlane(id);
      const start = a.pos.clone();
      let liftoff = -1;
      for (let t = 0; t < 60 && liftoff < 0; t += 1 / 120) {
        a.step(1 / 120, { pitch: a.speed > a.spec.vRot ? 1 : 0, roll: 0, yaw: 0, throttle: 1, brake: false }, world);
        if (!a.onGround) liftoff = t;
      }
      expect(a.crashed).toBeNull();
      expect(liftoff).toBeGreaterThan(0);
      const roll = Math.hypot(a.pos.x - start.x, a.pos.z - start.z);
      expect(roll).toBeLessThan(RUNWAYS[1].len - 300);
      a.gearDown = false;
      const y0 = a.pos.y;
      fly(a, 20, () => ({ pitch: 0 }));
      expect(a.crashed).toBeNull();
      expect(a.pos.y).toBeGreaterThan(y0 + 30);
    });
  }
  it('손을 떼면 대체로 수평 비행 유지, 선회 가능', () => {
    const a = new Aircraft(SPECS.airliner);
    a.place(0, 800, 0, 90, 120);
    a.throttle = 0.5;
    fly(a, 10, () => ({ throttle: 0.55 }));
    expect(Math.abs(a.pos.y - 800)).toBeLessThan(120);
    const h0 = a.heading;
    fly(a, 8, (t) => ({ roll: t < 1.5 ? 1 : 0, throttle: 0.6 }));
    expect(Math.abs(((a.heading - h0 + 540) % 360) - 180)).toBeGreaterThan(10);
    expect(a.crashed).toBeNull();
  });
  it('바다에 내려앉으면 추락', () => {
    const a = new Aircraft(SPECS.light);
    a.place(-8000, 20, 3000, 0, 30);
    fly(a, 20, () => ({ pitch: -1, throttle: 0 }));
    expect(a.crashed).toMatch(/바다/);
  });
});

describe('걷기', () => {
  it('센트럴파크 바닥에 서고 앞으로 걷는다', () => {
    const w = new Walker();
    const p = sd(3.6, 2.05);
    w.place(p.x, p.z, world);
    const z0 = w.pos.clone();
    for (let i = 0; i < 240; i++) w.step(1 / 60, { fwd: 1, side: 0, run: false, jump: false, camYaw: 0 }, world);
    expect(w.onGround).toBe(true);
    expect(w.wading).toBe(false);
    expect(w.pos.distanceTo(z0)).toBeGreaterThan(5);
  });
});

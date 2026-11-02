// 확장 기능: 모듈 확장(Q47), 접속점(S-08), 긴급 복구, 계획 건설(Q32), 핵분열 발전(후속 확장),
// 긴급 알림(S-21), 시설 실적, 지도 크기, v3 → v4 마이그레이션.
import { afterEach, describe, expect, it } from 'vitest';
import {
  advance, buildCheck, connectionPoints, createGame, expandCheck, issue, ledgerCash, netWorth, pendingCash, rushCost, step, SCHEMA_VERSION, type GameState,
} from '../src/sim/sim';
import { EVENTS, HUB_BASE_KW, MODULES, specOf } from '../src/sim/data';
import { deserialize, serialize, stateHash } from '../src/sim/save';
import { STEPS_PER_DAY, STEPS_PER_DI } from '../src/sim/units';
import { licensed } from './helpers';

const savedEvents = JSON.parse(JSON.stringify(EVENTS));
afterEach(() => Object.assign(EVENTS, JSON.parse(JSON.stringify(savedEvents))));
const quiet = () => Object.assign(EVENTS, { facilityWarnPerYear: 0, linePerYearPer1000Km: 0, hubPerYear: 0 });
const days = (s: GameState, n: number) => advance(s, n * STEPS_PER_DAY);
const invariant = (s: GameState) => expect(s.cash).toBe(ledgerCash(s) + pendingCash(s));

function withSolar(s: GameState, region = 0) {
  licensed(s, [region]);
  issue(s, { kind: 'build', regionId: region, type: 'solar', size: 'small' });
  days(s, 6);
  const f = s.facilities.find((x) => x.type === 'solar')!;
  expect(f.status).toBe('operating');
  return f;
}

describe('모듈 확장 (Q47)', () => {
  it('운영 중 시설에 +50% 모듈, 공사 기간 = 본 시설의 30%, 공사 중에도 기존 출력 유지', () => {
    quiet();
    const s = createGame(1);
    const f = withSolar(s);
    const base = specOf('solar', 'small');
    const cash0 = s.cash;
    issue(s, { kind: 'expand', facilityId: f.id });
    step(s);
    expect(f.expansion).not.toBeNull();
    expect(s.cash).toBeLessThan(cash0);
    expect(f.capKw).toBe(base.capKw);
    const nw = netWorth(s);
    expect(Math.abs(nw - netWorth(s))).toBe(0);
    const daysNeeded = Math.max(1, Math.round(base.buildDays * MODULES.timeShare));
    days(s, daysNeeded + 1);
    expect(f.expansion).toBeNull();
    expect(f.modules).toBe(1);
    expect(f.capKw).toBe(base.capKw + Math.round(base.capKw * MODULES.capShare));
    invariant(s);
  });
  it('최대 모듈 수와 중복 공사를 막는다', () => {
    quiet();
    const s = createGame(1);
    const f = withSolar(s);
    issue(s, { kind: 'expand', facilityId: f.id });
    step(s);
    expect(expandCheck(s, f)).toContain('이미 확장 공사 중');
    f.modules = MODULES.max;
    f.expansion = null;
    expect(expandCheck(s, f)).toContain(`${MODULES.max}개까지`);
  });
  it('확장 중인 시설은 매각할 수 없다', () => {
    quiet();
    const s = createGame(1);
    const f = withSolar(s);
    issue(s, { kind: 'expand', facilityId: f.id });
    step(s);
    issue(s, { kind: 'sellFacility', facilityId: f.id });
    step(s);
    expect(s.facilities.some((x) => x.id === f.id)).toBe(true);
  });
});

describe('접속점 (S-08)', () => {
  it('기본 접속점이 차면 변전점에 붙고, 변전점 고장은 그 시설만 멈춘다', () => {
    quiet();
    const s = createGame(1);
    licensed(s, [0]);
    issue(s, { kind: 'build', regionId: 0, type: 'thermal', size: 'large' }); // 60 MW
    issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'medium' }); // 20 MW → 기본 80 MW 가득
    step(s);
    expect(buildCheck(s, 0, 'solar', 'small')).toContain('접속 용량 부족');
    issue(s, { kind: 'build', regionId: 0, type: 'substation', size: 'medium' });
    days(s, 13);
    const sub = s.facilities.find((f) => f.type === 'substation')!;
    expect(sub.status).toBe('operating');
    issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'small' });
    step(s);
    const extra = s.facilities[s.facilities.length - 1];
    expect(extra.pointId).toBe(sub.id);
    const pts = connectionPoints(s, 0);
    expect(pts.length).toBe(2);
    expect(pts[0].capKw).toBe(HUB_BASE_KW);
    days(s, 6);
    expect(extra.status).toBe('operating');
    // 정오까지 진행 후 변전점 고장 → 붙은 태양광만 0
    while (Math.floor((s.step % STEPS_PER_DAY) / 60) !== 12) step(s);
    sub.health = { s: 'failed', until: s.step + STEPS_PER_DAY };
    advance(s, STEPS_PER_DI);
    expect(extra.lastGenWh).toBe(0);
    const solarMain = s.facilities.find((f) => f.type === 'solar' && f.pointId === 0)!;
    expect(solarMain.lastGenWh).toBeGreaterThan(0);
  });
  it('접속한 시설이 있는 변전점은 매각할 수 없다', () => {
    quiet();
    const s = createGame(1);
    licensed(s, [0]);
    issue(s, { kind: 'build', regionId: 0, type: 'thermal', size: 'large' });
    issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'medium' });
    issue(s, { kind: 'build', regionId: 0, type: 'substation', size: 'medium' });
    days(s, 13);
    issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'small' });
    days(s, 6);
    const sub = s.facilities.find((f) => f.type === 'substation')!;
    issue(s, { kind: 'sellFacility', facilityId: sub.id });
    step(s);
    expect(s.facilities.some((f) => f.id === sub.id)).toBe(true);
    expect(s.notices.some((n) => n.text.includes('접속한 시설이 있습니다'))).toBe(true);
  });
});

describe('긴급 복구', () => {
  it('남은 복구 기간을 절반으로, 비용을 원장에 기록, 한 번만', () => {
    quiet();
    const s = createGame(1);
    const f = withSolar(s);
    const until = s.step + 4 * STEPS_PER_DAY;
    f.health = { s: 'failed', until };
    const cash0 = s.cash;
    issue(s, { kind: 'rushRepair', target: 'facility', id: f.id });
    step(s);
    expect(f.health.s).toBe('failed');
    if (f.health.s !== 'failed') return;
    expect(f.health.rushed).toBe(true);
    expect(f.health.until).toBeLessThan(until - STEPS_PER_DAY);
    expect(cash0 - s.cash).toBeGreaterThanOrEqual(rushCost('facility', f.capexMinor));
    const until2 = f.health.until;
    issue(s, { kind: 'rushRepair', target: 'facility', id: f.id });
    step(s);
    expect(f.health.s === 'failed' && f.health.until).toBe(until2);
    days(s, 3);
    expect(f.health.s).toBe('ok');
    invariant(s);
  });
});

describe('계획 건설 (Q32)', () => {
  it('순서대로 승인, 동시 건설 한도가 차면 맨 앞에서 멈추고 사유 표시', () => {
    quiet();
    const s = createGame(1);
    licensed(s, [0, 1]);
    step(s);
    for (let i = 0; i < 5; i++) issue(s, { kind: 'planAdd', item: { kind: 'build', regionId: i % 2, type: 'solar', size: 'small' } });
    advance(s, STEPS_PER_DI * 2);
    expect(s.facilities.length).toBe(3); // 동시 건설 3건
    expect(s.plan.length).toBe(2);
    expect(s.planBlocked).toContain('동시 건설');
    days(s, 6);
    advance(s, STEPS_PER_DI);
    expect(s.plan.length).toBe(0);
    expect(s.facilities.length).toBe(5);
    expect(s.notices.some((n) => n.text.startsWith('[계획] 건설 승인'))).toBe(true);
    invariant(s);
  });
  it('일시정지·순서 변경·삭제', () => {
    const s = createGame(1);
    issue(s, { kind: 'planPause', paused: true });
    issue(s, { kind: 'planAdd', item: { kind: 'build', regionId: 0, type: 'solar', size: 'small' } });
    issue(s, { kind: 'planAdd', item: { kind: 'build', regionId: 1, type: 'wind', size: 'small' } });
    step(s);
    const [a, b] = s.plan;
    issue(s, { kind: 'planMove', id: b.id, dir: -1 });
    step(s);
    expect(s.plan[0].id).toBe(b.id);
    issue(s, { kind: 'planRemove', id: a.id });
    advance(s, STEPS_PER_DI);
    expect(s.plan.map((p) => p.id)).toEqual([b.id]);
    expect(s.facilities.length).toBe(0);
  });
});

describe('핵분열 발전 (후속 확장)', () => {
  it('연구 전에는 거부, 연구 후 건설·기저 출력(최소 80%)', () => {
    quiet();
    const s = createGame(1);
    licensed(s, [0]);
    step(s);
    expect(buildCheck(s, 0, 'nuclear', 'small')).toContain('연구 필요');
    s.research.done.push('gen1', 'gen2', 'gen3');
    expect(buildCheck(s, 0, 'nuclear', 'small')).toBeNull();
    issue(s, { kind: 'build', regionId: 0, type: 'nuclear', size: 'small' });
    const spec = specOf('nuclear', 'small');
    days(s, spec.buildDays + 2);
    const f = s.facilities[0];
    expect(f.status).toBe('operating');
    // gen2 연구로 최소 출력 −10%p → 70%
    expect(f.outputKw).toBeGreaterThanOrEqual(Math.floor(f.capKw * 0.7) - 1);
    invariant(s);
  });
});

describe('긴급 알림 (S-21)', () => {
  it('핵심 부하 정전·연체는 긴급 등급, 고장 같은 일반 오류는 아님', () => {
    quiet();
    const s = createGame(1);
    licensed(s, [0]);
    issue(s, { kind: 'acquireLicense', regionId: 0, type: 'RET', size: 'small' });
    step(s);
    s.offers.push({ id: 999, kind: 'direct', regionId: 0, mwKw: 5_000, shapePpm: new Array(24).fill(1_000_000), priceMinor: 120_00, termDays: 30, critical: true, expiresAt: s.step + STEPS_PER_DAY });
    issue(s, { kind: 'acceptOffer', offerId: 999 });
    advance(s, STEPS_PER_DI * 3);
    const urgent = s.notices.filter((n) => n.urgent);
    expect(urgent.length).toBe(1); // 하루 한 번
    expect(urgent[0].text).toContain('핵심 부하 정전');
    expect(s.noticeSeq).toBeGreaterThanOrEqual(s.notices.length);
  });
});

describe('시설 실적', () => {
  it('일별 발전량·수익·가동률 기록 (최근 30일)', () => {
    quiet();
    const s = createGame(1);
    const f = withSolar(s);
    days(s, 35);
    expect(f.stats.days.length).toBe(30);
    const d = f.stats.days[f.stats.days.length - 1];
    expect(d.genWh).toBeGreaterThan(0);
    expect(d.revMinor).toBeGreaterThan(0);
    expect(d.di).toBe(96);
    expect(d.upDI).toBe(96);
    expect(d.opexMinor).toBe(f.fixedMinorPerDay);
    expect(f.stats.life.days).toBeGreaterThanOrEqual(35);
  });
});

describe('지도 크기', () => {
  it('48·96 지역: 이름 중복 없음, 하루 진행', () => {
    for (const n of [48, 96]) {
      const s = createGame({ seed: 5, regionCount: n });
      expect(s.regions.length).toBe(n);
      expect(new Set(s.regions.map((r) => r.name)).size).toBe(n);
      const t0 = Date.now();
      days(s, 1);
      expect(Date.now() - t0).toBeLessThan(8000);
      invariant(s);
    }
  });
});

describe('v3 → v4 마이그레이션', () => {
  it('v3 상태에 새 필드를 채우고 계속 진행', () => {
    quiet();
    const s = createGame(1);
    withSolar(s);
    const v3: Record<string, unknown> = JSON.parse(JSON.stringify(s));
    v3.schemaVersion = 3;
    for (const k of ['plan', 'planPaused', 'planBlocked', 'noticeSeq']) delete v3[k];
    delete (v3.rules as Record<string, unknown>).regionCount;
    v3.facilities = (v3.facilities as Record<string, unknown>[]).map((f) => { const g = { ...f }; for (const k of ['pointId', 'modules', 'expansion', 'stats']) delete g[k]; return g; });
    const m = deserialize(JSON.stringify({ schemaVersion: 3, hash: stateHash(v3), state: v3 }));
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m.facilities[0].pointId).toBe(0);
    expect(m.facilities[0].stats.days).toEqual([]);
    expect(m.plan).toEqual([]);
    days(m, 2);
    expect(m.facilities[0].stats.days.length).toBe(2);
    expect(deserialize(serialize(m)).step).toBe(m.step);
    invariant(m);
  });
});

// 간편 모드(성장형) 코어 테스트
import { describe, expect, it } from 'vitest';
import * as C from '../src/idle/core';

const home = (s: C.IdleState) => s.order[0];

describe('간편 모드', () => {
  it('시작: 한 지역만 열림, 3칸, 태양광을 지을 돈', () => {
    const s = C.newIdle(1, 0);
    expect(C.unlockedCount(s)).toBe(1);
    expect(s.regions[home(s)].slots.length).toBe(C.START_SLOTS);
    expect(C.build(s, home(s), 0, 'solar')).toBeNull();
    expect(s.regions[home(s)].slots[0]).toEqual({ type: 'solar', level: 1 });
    expect(C.build(s, home(s), 0, 'wind')).toBe('이미 시설이 있습니다');
  });
  it('연구 전에는 상위 발전 건설 불가', () => {
    const s = C.newIdle(1, 0);
    s.money = 1e12;
    expect(C.build(s, home(s), 0, 'nuclear')).toBe('연구가 필요합니다');
    expect(C.doResearch(s, 'nuclear')).toBe('선행 연구 필요');
    expect(C.doResearch(s, 'hydro')).toBeNull();
    expect(C.doResearch(s, 'nuclear')).toBeNull();
    expect(C.build(s, home(s), 0, 'nuclear')).toBeNull();
  });
  it('일괄 레벨업 비용 = 1레벨씩 올린 합, 최대 구매는 돈을 넘지 않음', () => {
    let sum = 0;
    for (let l = 3; l < 13; l++) sum += C.levelCost('wind', l);
    expect(C.bulkCost('wind', 3, 10)).toBeCloseTo(sum, 6);
    const money = 12345;
    const k = C.maxAffordable('solar', 1, money);
    expect(C.bulkCost('solar', 1, k)).toBeLessThanOrEqual(money);
    expect(C.bulkCost('solar', 1, k + 1)).toBeGreaterThan(money);
  });
  it('레벨 이정표마다 출력 2배', () => {
    const s = C.newIdle(1, 0);
    const ri = home(s);
    const out = (lv: number) => C.slotOutput(s, ri, { type: 'thermal', level: lv });
    expect(out(10) / out(9)).toBeCloseTo((10 / 9) * 2, 6);
    expect(out(25) / out(24)).toBeCloseTo((25 / 24) * 2, 6);
  });
  it('태양광은 밤에 0, 야간 저장 연구 후 50%', () => {
    const s = C.newIdle(1, 0);
    const ri = home(s);
    const lon = C.regionDefs(1)[ri].lon;
    const midnight = ((0 - lon / 360) % 1 + 1) % 1 * C.DAY_SECONDS;
    expect(C.sunFactor(s, ri, midnight)).toBe(0);
    s.research.push('storage');
    expect(C.sunFactor(s, ri, midnight)).toBe(0.5);
  });
  it('진행하면 돈이 생산량만큼 늘고, 부스트는 2배', () => {
    const s = C.newIdle(1, 0);
    const ri = home(s);
    s.regions[ri].slots[0] = { type: 'thermal', level: 10 };
    s.nextSurgeAt = 1e9;
    const inc = C.income(s);
    const m0 = s.money;
    C.tick(s, 10);
    expect(s.money - m0).toBeCloseTo(inc * 10, 3);
    expect(C.boost(s)).toBeNull();
    expect(C.income(s)).toBeCloseTo(inc * 2, 6);
    expect(C.boost(s)).toBe('아직 준비 중');
  });
  it('수요 급증: 열린 지역 가격 2배가 일정 시간', () => {
    const s = C.newIdle(1, 0);
    s.nextSurgeAt = s.time + 1;
    const ev = C.tick(s, 2);
    expect(ev.surge).toBe(home(s));
    expect(C.regionPrice(s, home(s))).toBeCloseTo(C.regionBonus(1, home(s)).price * 2, 6);
  });
  it('지역 열기 비용은 점점 커지고 순서대로 열린다', () => {
    const s = C.newIdle(1, 0);
    s.money = 1e15;
    const c1 = C.regionCost(s);
    const next = C.nextRegion(s)!;
    expect(C.unlockRegion(s)).toBeNull();
    expect(s.regions[next].unlocked).toBe(true);
    expect(C.regionCost(s)).toBeGreaterThan(c1 * 10);
  });
  it('부지 확장: 최대 8칸, 비용 증가, 부지 개발 연구로 절반', () => {
    const s = C.newIdle(1, 0);
    s.money = 1e15;
    const ri = home(s);
    const c = C.slotCost(s, ri);
    expect(C.expandSlots(s, ri)).toBeNull();
    expect(C.slotCost(s, ri)).toBeGreaterThan(c);
    const before = C.slotCost(s, ri);
    s.research.push('land');
    expect(C.slotCost(s, ri)).toBe(Math.round(before / 2));
    while (s.regions[ri].slots.length < C.MAX_SLOTS) C.expandSlots(s, ri);
    expect(C.expandSlots(s, ri)).toBe('부지를 더 넓힐 수 없습니다');
  });
  it('오프라인 수익: 평균 출력 × 효율 50%, 기본 2시간 한도', () => {
    const s = C.newIdle(1, 0);
    s.regions[home(s)].slots[0] = { type: 'thermal', level: 20 };
    const avg = C.income(s, s.time, true);
    const r = C.offlineEarnings(s, 10 * 3600);
    expect(r.seconds).toBe(2 * 3600);
    expect(r.money).toBeCloseTo(avg * 7200 * 0.5, 3);
    const s2 = C.newIdle(1, 0);
    s2.savedAt = 0;
    s2.regions[home(s2)].slots[0] = { type: 'thermal', level: 20 };
    const got = C.applyOffline(s2, 3600 * 1000);
    expect(got.seconds).toBe(3600);
    expect(s2.money).toBeGreaterThan(15);
  });
  it('매니저: 가진 돈의 절반 안에서 지역마다 가장 싼 레벨업', () => {
    const s = C.newIdle(1, 0);
    const ri = home(s);
    s.regions[ri].slots[0] = { type: 'solar', level: 5 };
    s.regions[ri].slots[1] = { type: 'wind', level: 5 };
    s.money = 1000;
    C.managerStep(s);
    expect(s.regions[ri].slots[0].level).toBe(5);
    s.research.push('manager');
    C.managerStep(s);
    expect(s.regions[ri].slots[0].level).toBe(6);
    expect(s.regions[ri].slots[1].level).toBe(5);
  });
  it('목표: 달성해야 받고, 보상 지급 후 다음 목표', () => {
    const s = C.newIdle(1, 0);
    expect(C.claimQuest(s)).toBe('아직 달성하지 못했습니다');
    C.build(s, home(s), 0, 'solar');
    const m = s.money;
    expect(C.claimQuest(s)).toBeNull();
    expect(s.money).toBe(m + C.QUESTS[0].reward);
    expect(C.currentQuest(s)?.id).toBe(C.QUESTS[1].id);
  });
  it('상장: 명성을 얻고 회사는 새로 시작, 명성 하나당 수익 +10%', () => {
    const s = C.newIdle(1, 0);
    expect(C.prestige(s)).not.toBeNull();
    s.earned = 4e9;
    s.lifetime = 4e9;
    s.money = 1e9;
    s.research.push('grid1');
    expect(C.starsFor(s.earned)).toBe(4);
    expect(C.prestige(s)).toBeNull();
    expect(s.stars).toBe(4);
    expect(s.research).toEqual([]);
    expect(s.money).toBe(50);
    expect(s.lifetime).toBe(4e9);
    expect(C.globalMult(s, false)).toBeCloseTo(1.4, 6);
  });
  it('숫자 표시', () => {
    expect(C.fmt(999)).toBe('999');
    expect(C.fmt(1234)).toBe('1.23K');
    expect(C.fmt(12_345_678)).toBe('12.3M');
    expect(C.fmt(1e33)).toBe('1.00Dc');
    expect(C.fmt(1e36)).toBe('1.00aa');
    expect(C.fmt(1e39)).toBe('1.00ab');
  });
  it('저장 왕복', () => {
    const s = C.newIdle(1, 0);
    C.build(s, home(s), 0, 'solar');
    C.tick(s, 30);
    const t = C.deserializeIdle(C.serializeIdle(s, 123));
    expect(t.savedAt).toBe(123);
    expect(t.regions).toEqual(s.regions);
    expect(() => C.deserializeIdle('{"v":2}')).toThrow();
  });
});

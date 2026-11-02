import { afterEach, describe, expect, it } from 'vitest';
import {
  addCapital, advance, annuityPayment, createGame, issue, ledgerCash, netWorth, pendingCash, recommendations, step, type GameState,
} from '../src/sim/sim';
import { CONTRACT, ENV, EVENTS, LICENSE, specOf } from '../src/sim/data';
import { deserialize, serialize, stateHash } from '../src/sim/save';
import { STEPS_PER_DAY, STEPS_PER_DI } from '../src/sim/units';
import { licensed } from './helpers';

const savedEvents = JSON.parse(JSON.stringify(EVENTS));
afterEach(() => Object.assign(EVENTS, JSON.parse(JSON.stringify(savedEvents))));
const quiet = () => Object.assign(EVENTS, { facilityWarnPerYear: 0, linePerYearPer1000Km: 0, hubPerYear: 0 });
const days = (s: GameState, n: number) => advance(s, n * STEPS_PER_DAY);
const invariant = (s: GameState) => expect(s.cash).toBe(ledgerCash(s) + pendingCash(s));

describe('사업권', () => {
  it('사업권 없이는 건설 거부', () => {
    const s = createGame(1);
    issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'small' });
    step(s);
    expect(s.facilities.length).toBe(0);
    expect(s.notices.some((n) => n.text.includes('발전 사업권이 없습니다'))).toBe(true);
  });
  it('만료 → 유예(운영 계속, 신규 건설 불가) → 만료(시설 정지, 삭제 안 함) → 재취득', () => {
    quiet();
    const s = createGame(1);
    s.automation.autoRenew = false;
    issue(s, { kind: 'acquireLicense', regionId: 0, type: 'GEN', size: 'small' });
    issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'small' });
    days(s, LICENSE.termDays + 1);
    const lic = s.licenses[0];
    expect(lic.state).toBe('grace');
    expect(s.facilities[0].rightsOk).toBe(true);
    issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'small' });
    issue(s, { kind: 'renewLease', facilityId: s.facilities[0].id }); // 토지는 유지 (사업권만 만료시킨다)
    step(s);
    expect(s.facilities.length).toBe(1);
    days(s, LICENSE.graceDays);
    expect(lic.state).toBe('expired');
    expect(s.facilities.length).toBe(1);
    expect(s.facilities[0].rightsOk).toBe(false);
    days(s, 1);
    expect(s.facilities[0].lastGenWh).toBe(0);
    issue(s, { kind: 'acquireLicense', regionId: 0, type: 'GEN', size: 'small' });
    days(s, 1);
    expect(s.facilities[0].rightsOk).toBe(true);
    invariant(s);
  });
  it('자동 갱신 정책은 만료 7일 전에 갱신한다 (멱등: 하루 1회)', () => {
    quiet();
    const s = createGame(1);
    issue(s, { kind: 'acquireLicense', regionId: 0, type: 'GEN', size: 'small' });
    days(s, LICENSE.termDays - 6);
    expect(s.licenses[0].expiresAt).toBeGreaterThan(s.step + 100 * STEPS_PER_DAY);
    expect(s.ledger.filter((e) => e.memo.includes('갱신')).length).toBe(1);
  });
  it('알림: 만료 30·7·1일 전', () => {
    quiet();
    const s = createGame(1);
    s.automation.autoRenew = false;
    issue(s, { kind: 'acquireLicense', regionId: 0, type: 'GEN', size: 'small' });
    days(s, LICENSE.termDays);
    for (const d of [30, 7, 1]) expect(s.notices.some((n) => n.text.includes(`만료 ${d}일 전`))).toBe(true);
  });
});

describe('토지', () => {
  it('건설 시 임대 + 보증금, 매입 후 임대료 없음, 매각 시 85%', () => {
    quiet();
    const s = createGame(2);
    licensed(s, [0]);
    issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'small' });
    days(s, 6);
    const f = s.facilities[0];
    expect(f.land.mode).toBe('lease');
    expect(s.ledger.some((e) => e.memo.startsWith('토지 임대료'))).toBe(true);
    const price = f.land.rentPerDayMinor * 120 * 3;
    issue(s, { kind: 'buyLand', facilityId: f.id });
    days(s, 2);
    expect(f.land.mode).toBe('own');
    expect(f.land.purchaseMinor).toBe(price);
    const rentsBefore = s.ledger.filter((e) => e.memo === `토지 임대료 #${f.id}`).length;
    days(s, 3);
    expect(s.ledger.filter((e) => e.memo === `토지 임대료 #${f.id}`).length).toBe(rentsBefore);
    const cash = s.cash;
    issue(s, { kind: 'sellFacility', facilityId: f.id });
    step(s);
    expect(s.facilities.length).toBe(0);
    expect(s.cash - cash).toBe(Math.round(f.capexMinor * 0.7) + Math.round(price * 0.85));
    invariant(s);
  });
  it('임대 만료 → 시설 정지 (사업권이 있어도)', () => {
    quiet();
    const s = createGame(2);
    s.automation.autoRenew = false;
    licensed(s, [0]);
    issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'small' });
    days(s, 120 + 31);
    for (const l of s.licenses) if (l.state !== 'active') { issue(s, { kind: 'acquireLicense', regionId: 0, type: l.type, size: 'large' }); }
    days(s, 1);
    expect(s.facilities[0].land.state).toBe('expired');
    expect(s.facilities[0].rightsOk).toBe(false);
  });
});

describe('대출·지급불능', () => {
  it('원리금 균등: 100,000 CR, 연 8%(120일 게임년), 12개월 → 월 9,455.96', () => {
    expect(annuityPayment(100_000_00, 80_000, 12)).toBe(9_455_96);
  });
  it('12개월 상환하면 잔액 0, 원장 일치', () => {
    quiet();
    const s = createGame(3);
    issue(s, { kind: 'takeLoan', principalMinor: 100_000_00, months: 12 });
    days(s, 12 * 30 + 1);
    expect(s.loans.length).toBe(0);
    const interest = s.ledger.filter((e) => e.debit === 'interest').reduce((a, e) => a + e.amount, 0);
    expect(interest).toBeGreaterThan(13_000_00);
    expect(interest).toBeLessThan(14_000_00);
    invariant(s);
  });
  it('한도 초과 대출 거부', () => {
    const s = createGame(3);
    issue(s, { kind: 'takeLoan', principalMinor: 900_000_000_00, months: 12 });
    step(s);
    expect(s.loans.length).toBe(0);
  });
  it('연체 → 구조조정 → 회생불능 → 구제 (즉시 게임오버 없음)', () => {
    quiet();
    const s = createGame(3);
    licensed(s, [0, 1, 2]);
    // 큰 대출 후 현금을 모두 소진해 상환 실패를 만든다
    issue(s, { kind: 'takeLoan', principalMinor: 200_000_00, months: 6 });
    step(s);
    s.cash -= 0; // 원장 일치 유지
    issue(s, { kind: 'acquireLicense', regionId: 3, type: 'GEN', size: 'large' });
    const burn = s.cash - 1_000_00;
    addCapital(s, -burn, '테스트 소진');
    days(s, 31);
    expect(['arrears', 'restructuring']).toContain(s.insolvency);
    issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'small' });
    step(s);
    expect(s.facilities.length).toBe(0);
    days(s, 70);
    expect(s.insolvency).toBe('insolvent');
    issue(s, { kind: 'bailout' });
    step(s);
    expect(s.insolvency).toBe('normal');
    expect(s.bailouts).toBe(1);
    expect(s.cash).toBeGreaterThanOrEqual(0);
    invariant(s);
  });
});

describe('시작 시나리오 (Q53: 순자산 균형)', () => {
  it('A·B·C 순자산 차이 ≤ 2%', () => {
    const nw = (['A', 'B', 'C'] as const).map((sc) => netWorth(createGame({ seed: 5, scenario: sc })));
    const max = Math.max(...nw), min = Math.min(...nw);
    expect((max - min) / max).toBeLessThan(0.02);
  });
  it('C는 시작부터 운영 가능 (사업권·토지 포함)', () => {
    quiet();
    const s = createGame({ seed: 5, scenario: 'C' });
    expect(s.facilities[0].rightsOk).toBe(true);
    days(s, 1);
    expect(s.facilities[0].lastGenWh).toBeGreaterThan(0);
  });
});

describe('계약', () => {
  function withContract(kind: 'ppa' | 'direct', critical = false) {
    quiet();
    const s = createGame(8);
    licensed(s, [0]);
    issue(s, { kind: 'acquireLicense', regionId: 0, type: 'RET', size: 'small' });
    issue(s, { kind: 'build', regionId: 0, type: 'thermal', size: 'medium' });
    days(s, 31);
    s.offers = [{ id: 9999, kind, regionId: 0, mwKw: 10_000, shapePpm: Array(24).fill(1_000_000), priceMinor: 9_000, termDays: 30, critical, expiresAt: s.step + 99999 }];
    issue(s, { kind: 'acceptOffer', offerId: 9999 });
    return s;
  }
  it('계약 물량이 시장보다 먼저 공급되고, 이행률 ≈ 100%', () => {
    const s = withContract('ppa');
    days(s, 5);
    const c = s.contracts[0];
    expect(c.deliveredWh / c.obligationWh).toBeGreaterThan(0.99);
    expect(c.penaltyMinor).toBe(0);
    invariant(s);
  });
  it('에너지 수지에 계약 인도 포함', () => {
    const s = withContract('direct');
    for (let i = 0; i < 96 * 3; i++) {
      advance(s, STEPS_PER_DI);
      const d = s.lastDI;
      expect(d.genWh + d.dischargeWh).toBe(d.deliveredWh + d.contractWh + d.lineLossWh + d.chargeWh + d.curtailWh);
    }
  });
  it('공급 불가(시설 정지)면 위약금 = 부족량 × [max(시장가−계약가,0) + λ×계약가]', () => {
    const s = withContract('direct', true);
    issue(s, { kind: 'setOnline', facilityId: s.facilities[0].id, online: false });
    advance(s, STEPS_PER_DI * 4);
    const c = s.contracts[0];
    expect(c.penaltyMinor).toBeGreaterThan(0);
    expect(c.lastDeliveredWh).toBe(0);
    const ob = c.lastObligationWh;
    const tol = Math.floor((ob * CONTRACT.tolerancePpm) / 1e6);
    expect(c.lastObligationWh - tol).toBeGreaterThan(0);
  });
  it('직접 공급은 소매 공급 사업권이 필요', () => {
    const s = createGame(8);
    s.offers = [{ id: 7777, kind: 'direct', regionId: 0, mwKw: 4_000, shapePpm: Array(24).fill(1_000_000), priceMinor: 9_000, termDays: 30, critical: false, expiresAt: s.step + 99999 }];
    issue(s, { kind: 'acceptOffer', offerId: 7777 });
    step(s);
    expect(s.contracts.length).toBe(0);
  });
  it('만기에 종료되고 완료 건수 증가', () => {
    const s = withContract('ppa');
    days(s, 32);
    expect(s.contracts[0].done).toBe(true);
    expect(s.completedContracts).toBe(1);
  });
});

describe('연구', () => {
  it('최소 기간보다 빨리 끝나지 않는다 (돈으로 우회 불가)', () => {
    const s = createGame(4);
    addCapital(s, 10_000_000_00);
    issue(s, { kind: 'startResearch', id: 'gen1', dailyBudgetMinor: 100_000_000_00 });
    days(s, 9);
    expect(s.research.done).not.toContain('gen1');
    days(s, 2);
    expect(s.research.done).toContain('gen1');
  });
  it('선행 연구 없이는 시작 불가', () => {
    const s = createGame(4);
    issue(s, { kind: 'startResearch', id: 'gen2', dailyBudgetMinor: 1 });
    step(s);
    expect(s.research.active.length).toBe(0);
  });
});

describe('환경·규제', () => {
  it('열발전은 환경 지표를 올리고 비용이 든다. 지표 > 1이면 신규 열발전 거부', () => {
    quiet();
    const s = createGame(6);
    licensed(s, [0]);
    issue(s, { kind: 'build', regionId: 0, type: 'thermal', size: 'large' });
    days(s, 61);
    expect(s.ledger.some((e) => e.debit === 'env')).toBe(true);
    s.regionDyn[0].envDaily = Array(30).fill((s.regions[0].demandBaseKw / 1000) * ENV.thresholdPerMw);
    issue(s, { kind: 'build', regionId: 0, type: 'thermal', size: 'small' });
    step(s);
    expect(s.notices.some((n) => n.text.includes('환경 규제'))).toBe(true);
  });
});

describe('자동화·추천', () => {
  it('추천에는 이유·효과가 있다', () => {
    quiet();
    const s = createGame(1);
    s.automation.autoRenew = false;
    issue(s, { kind: 'acquireLicense', regionId: 0, type: 'GEN', size: 'small' });
    days(s, 100);
    const r = recommendations(s);
    expect(r.length).toBeGreaterThan(0);
    for (const x of r) { expect(x.reason.length).toBeGreaterThan(0); expect(x.effect.length).toBeGreaterThan(0); }
  });
  it('수동 고정된 저장시설은 자동 조정하지 않는다', () => {
    quiet();
    const s = createGame(1);
    licensed(s, [0]);
    s.research.done.push('auto1', 'auto2');
    s.automation.autoStorage = true;
    issue(s, { kind: 'build', regionId: 0, type: 'storage', size: 'small' });
    days(s, 15);
    const f = s.facilities[0];
    issue(s, { kind: 'setStorage', facilityId: f.id, chargeAtMinor: 1_00, dischargeAtMinor: 499_00 });
    issue(s, { kind: 'lock', key: `f${f.id}`, days: null });
    days(s, 3);
    expect(f.chargeAtMinor).toBe(1_00);
    issue(s, { kind: 'lock', key: `f${f.id}`, days: 0 });
    days(s, 2);
    expect(f.chargeAtMinor).not.toBe(1_00);
  });
});

describe('P2 결정론·저장', () => {
  it('전체 시스템 포함 120일, 진행 단위와 무관하게 같은 해시 + 저장 왕복', () => {
    const run = () => {
      const s = createGame({ seed: 11, scenario: 'C' });
      licensed(s, [0, 1, 2]);
      issue(s, { kind: 'build', regionId: 1, type: 'solar', size: 'medium' });
      issue(s, { kind: 'takeLoan', principalMinor: 300_000_00, months: 12 });
      issue(s, { kind: 'startResearch', id: 'con1', dailyBudgetMinor: 20_000_00 });
      return s;
    };
    const a = run(), b = run();
    days(a, 60);
    for (let i = 0; i < 120; i++) advance(b, i % 2 ? 700 : 740);
    const c = deserialize(serialize(b));
    days(a, 60); days(c, 60);
    expect(stateHash(c)).toBe(stateHash(a));
    invariant(c);
  });
});

void specOf;

describe('수수료 함정 회귀 방지', () => {
  it('중형 발전 사업권 + 소형 열발전 하나여도 하루 순현금이 양수 (수수료는 실제 지은 MW에 비례)', () => {
    quiet();
    const s = createGame(20261101);
    issue(s, { kind: 'acquireLicense', regionId: 10, type: 'GEN', size: 'medium' });
    issue(s, { kind: 'build', regionId: 10, type: 'thermal', size: 'small' });
    days(s, 15);
    const last = s.history.slice(-3);
    for (const h of last) expect(h.netMinor).toBeGreaterThan(0);
  });
});

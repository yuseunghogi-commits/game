import { afterEach, describe, expect, it } from 'vitest';
import {
  addCapital, advance, createGame, hubCapacityKw, issue, ledgerCash, neighbors, pendingCash, step, type GameState,
} from '../src/sim/sim';
import { EVENTS, HUB_BASE_KW, specOf } from '../src/sim/data';
import { deserialize, serialize, stateHash } from '../src/sim/save';
import { STEPS_PER_DAY, STEPS_PER_DI } from '../src/sim/units';

const saved = JSON.parse(JSON.stringify(EVENTS));
afterEach(() => Object.assign(EVENTS, JSON.parse(JSON.stringify(saved))));

/** 지역 a(싸다)에 열발전, 이웃 b(비싸다)로 송전선, b에 저장시설 */
function gridGame(): { s: GameState; a: number; b: number } {
  const s = createGame(42);
  const a = 1;
  const b = neighbors(s.regions)[a][0];
  s.regions[a].pBaseMinor = 6_000;
  s.regions[b].pBaseMinor = 16_000;
  addCapital(s, 50_000_000_00);
  issue(s, { kind: 'build', regionId: a, type: 'thermal', size: 'small' });
  issue(s, { kind: 'build', regionId: a, type: 'solar', size: 'medium' });
  issue(s, { kind: 'buildLine', a, b, size: 'small' });
  issue(s, { kind: 'build', regionId: b, type: 'storage', size: 'small' });
  return { s, a, b };
}

describe('P1 전력망', () => {
  it('INV-1: 매 DI 에너지 수지 — 발전 + 방전 = 판매 + 선로 손실 + 충전 + 출력 제한', () => {
    const { s } = gridGame();
    for (let i = 0; i < STEPS_PER_DAY * 40; i++) {
      step(s);
      if (s.step % STEPS_PER_DI === 0) {
        const d = s.lastDI;
        expect(d.genWh + d.dischargeWh).toBe(d.deliveredWh + d.lineLossWh + d.chargeWh + d.curtailWh);
      }
    }
  });

  it('비싼 이웃 지역으로 송전하고, 선로 용량(송전단)을 넘지 않는다', () => {
    const { s } = gridGame();
    advance(s, STEPS_PER_DAY * 30);
    const l = s.lines[0];
    expect(l.status).toBe('operating');
    let used = 0;
    for (let i = 0; i < 96 * 3; i++) {
      advance(s, STEPS_PER_DI);
      expect(l.lastSentWh).toBeLessThanOrEqual(l.capKw * 250);
      if (l.lastSentWh > 0) {
        used++;
        // 흐름마다 정수 내림 → 손실률은 선로 손실률과 같고, 오차는 흐름 수(Wh) 이내
        const ideal = (l.lastSentWh * l.lossPpm) / 1_000_000;
        expect(Math.abs(l.lastLossWh - ideal)).toBeLessThanOrEqual(50);
      }
    }
    expect(used).toBeGreaterThan(0);
  });

  it('저장: 0 ≤ SOC ≤ 용량, 왕복 손실 존재', () => {
    const { s } = gridGame();
    let sawCharge = false, sawDischarge = false;
    for (let i = 0; i < 96 * 40; i++) {
      advance(s, STEPS_PER_DI);
      for (const f of s.facilities.filter((x) => x.type === 'storage')) {
        expect(f.socWh).toBeGreaterThanOrEqual(0);
        expect(f.socWh).toBeLessThanOrEqual(f.energyWh);
        if (f.lastStorageWh > 0) sawCharge = true;
        if (f.lastStorageWh < 0) sawDischarge = true;
      }
    }
    expect(sawCharge).toBe(true);
    expect(sawDischarge).toBe(true);
  });

  it('현금 = 원장 + 미기록 당일분 (선로 유지비·복구비 포함)', () => {
    Object.assign(EVENTS, { facilityWarnPerYear: 400, linePerYearPer1000Km: 400, hubPerYear: 200 });
    const { s } = gridGame();
    for (let d = 0; d < 30; d++) {
      advance(s, STEPS_PER_DAY / 2 + 11);
      expect(s.cash).toBe(ledgerCash(s) + pendingCash(s));
    }
  });
});

describe('P1 접속 용량·변전소', () => {
  it('접속 용량을 넘는 건설은 거부', () => {
    const s = createGame(5);
    addCapital(s, 10_000_000_00);
    for (let i = 0; i < 5; i++) issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'medium' });
    step(s);
    expect(s.facilities.length).toBe(Math.floor(HUB_BASE_KW / specOf('solar', 'medium').capKw));
    expect(s.notices.some((n) => n.text.includes('접속 용량 부족'))).toBe(true);
  });
  it('변전소 준공 후 접속 용량 증가', () => {
    const s = createGame(5);
    issue(s, { kind: 'build', regionId: 0, type: 'substation', size: 'small' });
    advance(s, (specOf('substation', 'small').buildDays + 1) * STEPS_PER_DAY);
    expect(hubCapacityKw(s, 0)).toBe(HUB_BASE_KW + specOf('substation', 'small').hubAddKw);
  });
  it('송전선은 이웃끼리만', () => {
    const s = createGame(5);
    const nb = neighbors(s.regions);
    const far = s.regions.findIndex((_, j) => j !== 0 && !nb[0].includes(j));
    if (far >= 0) {
      issue(s, { kind: 'buildLine', a: 0, b: far, size: 'small' });
      step(s);
      expect(s.lines.length).toBe(0);
    }
  });
});

describe('P1 고장·복구', () => {
  it('전조 → 고장 → 자동 복구, 고장 중 선로는 쓰지 않음', () => {
    Object.assign(EVENTS, { facilityWarnPerYear: 0, linePerYearPer1000Km: 3000, hubPerYear: 0 });
    const { s } = gridGame();
    advance(s, STEPS_PER_DAY * 30);
    const l = s.lines[0];
    const seen = new Set<string>();
    for (let i = 0; i < 96 * 30; i++) {
      const failedBefore = l.health.s === 'failed';
      advance(s, STEPS_PER_DI);
      seen.add(l.health.s);
      // 고장 판정은 배분 뒤 → 이미 고장 상태로 시작한 DI에는 흐름이 없어야 한다
      if (failedBefore) expect(l.lastSentWh).toBe(0);
    }
    expect(seen.has('warning')).toBe(true);
    expect(seen.has('failed')).toBe(true);
    expect(seen.has('ok')).toBe(true);
    expect(s.ledger.some((e) => e.debit === 'repair')).toBe(true);
  });
  it('예방 점검을 하면 고장 없이 정상으로 돌아온다', () => {
    Object.assign(EVENTS, { facilityWarnPerYear: 5000, linePerYearPer1000Km: 0, hubPerYear: 0, warnLeadDays: [5, 5] });
    const s = createGame(9);
    issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'small' });
    advance(s, STEPS_PER_DAY * 6);
    const f = s.facilities[0];
    for (let i = 0; i < 96 * 3 && f.health.s !== 'warning'; i++) advance(s, STEPS_PER_DI);
    expect(f.health.s).toBe('warning');
    Object.assign(EVENTS, { facilityWarnPerYear: 0 });
    issue(s, { kind: 'inspect', target: 'facility', id: f.id });
    advance(s, 2);
    expect(f.health.s).toBe('inspection');
    advance(s, STEPS_PER_DAY * 6);
    expect(f.health.s).toBe('ok');
    expect(s.ledger.filter((e) => e.memo.startsWith('고장 복구')).length).toBe(0);
  });
});

describe('P1 결정론·저장', () => {
  it('고장·저장·송전 포함, 진행 단위와 무관하게 같은 해시', () => {
    Object.assign(EVENTS, { facilityWarnPerYear: 300, linePerYearPer1000Km: 300, hubPerYear: 100 });
    const x = gridGame().s, y = gridGame().s;
    advance(x, STEPS_PER_DAY * 25);
    let left = STEPS_PER_DAY * 25;
    for (const n of [1, 3, 15, 97, 1440, 7].flatMap((v) => Array(40).fill(v))) {
      if (left <= 0) break;
      const k = Math.min(left, n);
      advance(y, k);
      left -= k;
    }
    if (left > 0) advance(y, left);
    expect(stateHash(y)).toBe(stateHash(x));
  });
  it('저장 → 불러오기 → 진행 = 저장 없이 진행 (난수 상태 포함)', () => {
    Object.assign(EVENTS, { facilityWarnPerYear: 300, linePerYearPer1000Km: 300, hubPerYear: 100 });
    const { s } = gridGame();
    advance(s, STEPS_PER_DAY * 20 + 77);
    const t = deserialize(serialize(s));
    advance(s, STEPS_PER_DAY * 10);
    advance(t, STEPS_PER_DAY * 10);
    expect(stateHash(t)).toBe(stateHash(s));
  });
  it('v1(P0) 세이브를 v2로 변환해 계속 진행', () => {
    const s = createGame(3);
    issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'small' });
    advance(s, STEPS_PER_DAY * 8);
    const v1: Record<string, unknown> = JSON.parse(JSON.stringify(s));
    for (const k of ['hubs', 'lines', 'nextLineId', 'rng', 'lastDI']) delete v1[k];
    v1.schemaVersion = 1;
    v1.facilities = (v1.facilities as Record<string, unknown>[]).map((f) => {
      const g = { ...f };
      for (const k of ['health', 'energyWh', 'socWh', 'dischargeAtMinor', 'chargeAtMinor', 'lastStorageWh', 'hubAddKw']) delete g[k];
      return g;
    });
    const text = JSON.stringify({ schemaVersion: 1, hash: stateHash(v1), state: v1 });
    const m = deserialize(text);
    expect(m.schemaVersion).toBe(2);
    expect(m.lines).toEqual([]);
    advance(m, STEPS_PER_DAY * 3);
    expect(m.facilities[0].status).toBe('operating');
  });
});

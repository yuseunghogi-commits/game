import { describe, expect, it } from 'vitest';
import { advance, availableCash, cancelRefund, createGame, issue, ledgerCash, pendingCash, step, type Facility } from '../src/sim/sim';
import { priceFactorPpm, priceMinor } from '../src/sim/market';
import { deserialize, serialize, stateHash, SaveError } from '../src/sim/save';
import { MARKET, specOf } from '../src/sim/data';
import { moneyFor, roundHalfEven, splitByWeights, STEPS_PER_DAY, STEPS_PER_DI } from '../src/sim/units';
import { heightAt, SEA_LEVEL } from '../src/world/terrain';

function gameWithPlants() {
  const s = createGame(42);
  issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'small' });
  issue(s, { kind: 'build', regionId: 1, type: 'thermal', size: 'small' });
  issue(s, { kind: 'build', regionId: 1, type: 'wind', size: 'small' });
  return s;
}

describe('단위·반올림', () => {
  it('half-even 반올림', () => {
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(79948.654)).toBe(79949);
  });
  it('AT-F1: 6,749 kWh × 118.46 CR/MWh = 79,949 minor', () => {
    expect(moneyFor(6_749_000, 11_846)).toBe(79_949);
  });
  it('AT-F2: 최대 잔여법 1:1:1', () => {
    expect(splitByWeights(100_000, [1, 1, 1])).toEqual([33_334, 33_333, 33_333]);
  });
});

describe('시장 가격 (M4)', () => {
  it('ρ 경계에서 연속', () => {
    for (const b of [500_000, 1_000_000, 2_000_000]) {
      expect(Math.abs(priceFactorPpm(b) - priceFactorPpm(b - 1))).toBeLessThanOrEqual(2);
    }
  });
  it('단조 비증가', () => {
    let prev = Infinity;
    for (let r = 0; r <= 3_000_000; r += 1_000) {
      const f = priceFactorPpm(r);
      expect(f).toBeLessThanOrEqual(prev);
      prev = f;
    }
  });
  it('AT-M1: ρ = 1/1.3 → 118.46', () => {
    expect(priceMinor(10_000, 1_000_000, 1_300_000)).toBe(11_846);
  });
  it('AT-M2: 수요 0이면 하한가, 오류 없음', () => {
    expect(priceMinor(10_000, 1_000, 0)).toBe(MARKET.floorMinor);
  });
  it('AT-M4: 가격은 플레이어 공급과 무관', () => {
    const a = createGame(7);
    const b = createGame(7);
    issue(b, { kind: 'build', regionId: 0, type: 'solar', size: 'small' });
    advance(a, STEPS_PER_DAY * 6);
    advance(b, STEPS_PER_DAY * 6);
    expect(b.regionState[0].priceMinor).toBe(a.regionState[0].priceMinor);
  });
});

describe('에너지·원장 불변식', () => {
  it('INV-1: 매 DI 발전 = 판매 + 출력 제한, 판매 ≤ 판매 한도', () => {
    const s = gameWithPlants();
    for (let i = 0; i < STEPS_PER_DAY * 14; i++) {
      step(s);
      if (s.step % STEPS_PER_DI === 0) {
        s.regionState.forEach((rs, ri) => {
          const fs = s.facilities.filter((f) => f.regionId === ri);
          const sold = fs.reduce((a, f) => a + f.lastSoldWh, 0);
          expect(sold).toBe(rs.soldWh);
          expect(rs.soldWh).toBeLessThanOrEqual(rs.capWh);
          for (const f of fs) expect(f.lastSoldWh).toBeLessThanOrEqual(f.lastGenWh);
        });
      }
    }
  });
  it('INV-6: 현금 = 원장 현금 + 미기록 당일분', () => {
    const s = gameWithPlants();
    for (let d = 0; d < 20; d++) {
      advance(s, STEPS_PER_DAY / 2 + 7);
      expect(s.cash).toBe(ledgerCash(s) + pendingCash(s));
    }
  });
  it('INV-7: 거래 ID 유일', () => {
    const s = gameWithPlants();
    advance(s, STEPS_PER_DAY * 15);
    const ids = s.ledger.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('모든 원장 거래는 양수 금액', () => {
    const s = gameWithPlants();
    advance(s, STEPS_PER_DAY * 15);
    for (const e of s.ledger) expect(e.amount).toBeGreaterThan(0);
  });
});

describe('건설', () => {
  it('Q3: 표준(열발전 중형) 30일, 소형 태양광 5일', () => {
    expect(specOf('thermal', 'medium').buildDays).toBe(30);
    expect(specOf('solar', 'small').buildDays).toBe(5);
  });
  it('준공까지 예약 → 단계별 청구, 완공 시 예약 0', () => {
    const s = createGame(3);
    const spec = specOf('solar', 'small');
    issue(s, { kind: 'build', regionId: 0, type: 'solar', size: 'small' });
    step(s);
    expect(s.reserved).toBeGreaterThan(0);
    advance(s, spec.buildDays * STEPS_PER_DAY + 10);
    expect(s.facilities[0].status).toBe('operating');
    expect(s.reserved).toBe(0);
    const capex = s.ledger.filter((e) => e.debit === 'capex').reduce((a, e) => a + e.amount, 0);
    expect(capex).toBe(spec.capexMinor);
  });
  it('자금 부족이면 거부', () => {
    const s = createGame(3);
    for (let i = 0; i < 5; i++) issue(s, { kind: 'build', regionId: 0, type: 'thermal', size: 'large' });
    step(s);
    expect(s.facilities.length).toBe(0);
    expect(availableCash(s)).toBe(s.cash);
  });
  it('AT-K2: 단계 1·2 완료, 단계 3 진행 40% 취소 → 현금 환불 25,800, 예약 해제 20,000', () => {
    const f = {
      stage: 2, stageStep: 40, stageSteps: [10, 10, 100, 10, 10, 10],
      stageCosts: [10_000, 35_000, 35_000, 10_000, 5_000, 5_000],
    } as unknown as Facility;
    expect(cancelRefund(f)).toEqual({ releaseReserve: 20_000, cashRefund: 25_800 });
  });
});

describe('결정론·저장', () => {
  it('INV-12: 같은 입력이면 진행 단위(배속)와 무관하게 같은 해시', () => {
    const a = gameWithPlants();
    const b = gameWithPlants();
    advance(a, STEPS_PER_DAY * 10);
    let left = STEPS_PER_DAY * 10;
    const chunks = [1, 2, 4, 8, 64, 7, 333];
    for (let i = 0; left > 0; i++) {
      const n = Math.min(left, chunks[i % chunks.length]);
      advance(b, n);
      left -= n;
    }
    expect(stateHash(b)).toBe(stateHash(a));
  });
  it('AT-P1: 저장 → 불러오기 → 진행 = 저장 없이 진행', () => {
    const a = gameWithPlants();
    advance(a, STEPS_PER_DAY * 3 + 123);
    const b = deserialize(serialize(a));
    advance(a, STEPS_PER_DAY * 5);
    advance(b, STEPS_PER_DAY * 5);
    expect(stateHash(b)).toBe(stateHash(a));
  });
  it('AT-P4: 미래 버전 세이브는 거부', () => {
    const text = JSON.stringify({ schemaVersion: 999, hash: 'x', state: {} });
    expect(() => deserialize(text)).toThrow(SaveError);
  });
  it('변조된 세이브는 거부', () => {
    const s = createGame(1);
    const text = serialize(s).replace('"cash":', '"cash":1');
    expect(() => deserialize(text)).toThrow(SaveError);
  });
});

describe('가상 행성', () => {
  it('지역은 모두 육지 위', () => {
    const s = createGame(20261101);
    for (const r of s.regions) expect(heightAt(r.lat, r.lon, s.seed, 4)).toBeGreaterThan(SEA_LEVEL);
  });
  it('육지 비율 20–50%', () => {
    let land = 0, n = 0;
    for (let lat = -80; lat <= 80; lat += 4) for (let lon = -180; lon < 180; lon += 4) {
      n++;
      if (heightAt(lat, lon, 20261101, 4) > SEA_LEVEL) land++;
    }
    const ratio = land / n;
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.5);
  });
});

describe('경제 기준점 (S-01 가정: 회수 ≈ 90일)', () => {
  it('열발전 소형이 운영되며 하루 순현금이 양수', () => {
    const s = createGame(42);
    issue(s, { kind: 'build', regionId: 1, type: 'thermal', size: 'small' });
    const days = specOf('thermal', 'small').buildDays + 3;
    advance(s, days * STEPS_PER_DAY);
    const last = s.history[s.history.length - 1];
    expect(last.netMinor).toBeGreaterThan(0);
  });
});

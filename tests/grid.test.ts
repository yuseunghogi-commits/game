import { describe, expect, it } from 'vitest';
import { allocate, type Edge, type Sink, type Unit } from '../src/sim/grid';

const sumUsed = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe('배분 알고리즘', () => {
  it('AT-G3: 손실 10% 선로, 정수 계산 — 송전 = 수전 + 손실', () => {
    const units: Unit[] = [{ key: 'g', node: 0, availWh: 25_000_000, cost: 4_000 }];
    const sinks: Sink[] = [{ key: 'm1', node: 1, capWh: 5_000_000, value: 12_000 }];
    const edges: Edge[] = [{ id: 1, a: 0, b: 1, capWh: 7_500_000, lossPpm: 100_000, usable: true }];
    const r = allocate(2, units, sinks, edges);
    const use = r.edgeUse.get(1)!;
    expect(r.sinkUsed.get('m1')).toBeLessThanOrEqual(5_000_000);
    expect(use.sentWh - use.lossWh).toBe(r.sinkUsed.get('m1'));
    expect(use.sentWh).toBeLessThanOrEqual(7_500_000);
    expect(r.sinkUsed.get('m1')).toBeGreaterThan(4_999_000);
  });

  it('선로 용량(송전단)을 넘지 않는다 — 공유 선로 이중 사용 없음 (감사 #2)', () => {
    const units: Unit[] = [{ key: 'g', node: 0, availWh: 100_000_000, cost: 0 }];
    const sinks: Sink[] = [
      { key: 'c1', node: 1, capWh: 10_000_000, value: 10_000 },
      { key: 'c2', node: 1, capWh: 10_000_000, value: 10_000 },
    ];
    const edges: Edge[] = [{ id: 1, a: 0, b: 1, capWh: 12_500_000, lossPpm: 0, usable: true }];
    const r = allocate(2, units, sinks, edges);
    expect(r.edgeUse.get(1)!.sentWh).toBe(12_500_000);
    expect(sumUsed(r.sinkUsed)).toBe(12_500_000);
  });

  it('가치가 높은 지역부터 판다 (경로 이득 반영)', () => {
    const units: Unit[] = [{ key: 'g', node: 0, availWh: 20_000_000, cost: 4_000 }];
    const sinks: Sink[] = [
      { key: 'local', node: 0, capWh: 12_500_000, value: 9_000 },
      { key: 'far', node: 1, capWh: 100_000_000, value: 12_000 },
    ];
    const edges: Edge[] = [{ id: 1, a: 0, b: 1, capWh: 7_500_000, lossPpm: 100_000, usable: true }];
    const r = allocate(2, units, sinks, edges);
    // 12,000 × 0.9 = 10,800 > 9,000 → 먼 지역이 먼저, 선로가 차면 지역 판매
    expect(r.edgeUse.get(1)!.sentWh).toBe(7_500_000);
    expect(r.sinkUsed.get('local')).toBe(12_500_000);
    expect(r.unitUsed.get('g')).toBe(20_000_000);
  });

  it('변동비가 가치보다 크면 팔지 않는다', () => {
    const r = allocate(1, [{ key: 'g', node: 0, availWh: 1000, cost: 9_000 }], [{ key: 'm', node: 0, capWh: 1000, value: 8_000 }], []);
    expect(r.flows.length).toBe(0);
  });

  it('고장 선로는 쓰지 않는다', () => {
    const r = allocate(2,
      [{ key: 'g', node: 0, availWh: 1_000_000, cost: 0 }],
      [{ key: 'm', node: 1, capWh: 1_000_000, value: 10_000 }],
      [{ id: 1, a: 0, b: 1, capWh: 1_000_000, lossPpm: 0, usable: false }]);
    expect(r.flows.length).toBe(0);
  });

  it('한 DI에 선로 방향은 하나 (역류 금지)', () => {
    const r = allocate(2,
      [{ key: 'a', node: 0, availWh: 1_000_000, cost: 0 }, { key: 'b', node: 1, availWh: 1_000_000, cost: 0 }],
      [{ key: 'ma', node: 0, capWh: 0, value: 10_000 }, { key: 'mb', node: 1, capWh: 0, value: 10_000 },
       { key: 'xa', node: 0, capWh: 500_000, value: 20_000 }, { key: 'xb', node: 1, capWh: 500_000, value: 20_000 }],
      [{ id: 1, a: 0, b: 1, capWh: 10_000_000, lossPpm: 0, usable: true }]);
    const dirs = new Set(r.flows.filter((f) => f.edges.length).map((f) => (f.unit === 'a' ? 1 : -1)));
    expect(dirs.size).toBeLessThanOrEqual(1);
  });

  it('localOnly 수요처(저장 충전)는 같은 노드에서만', () => {
    const r = allocate(2,
      [{ key: 'g', node: 0, availWh: 1_000_000, cost: 0 }],
      [{ key: 'chg', node: 1, capWh: 1_000_000, value: 10_000, localOnly: true }],
      [{ id: 1, a: 0, b: 1, capWh: 10_000_000, lossPpm: 0, usable: true }]);
    expect(r.flows.length).toBe(0);
  });

  it('다중 구간: 구간별 손실이 곱으로 적용 (10%, 5% → 85.5%)', () => {
    const r = allocate(3,
      [{ key: 'g', node: 0, availWh: 10_000_000, cost: 0 }],
      [{ key: 'm', node: 2, capWh: 100_000_000, value: 10_000 }],
      [{ id: 1, a: 0, b: 1, capWh: 100_000_000, lossPpm: 100_000, usable: true },
       { id: 2, a: 1, b: 2, capWh: 100_000_000, lossPpm: 50_000, usable: true }]);
    expect(r.sinkUsed.get('m')).toBe(8_550_000);
    const loss = r.edgeUse.get(1)!.lossWh + r.edgeUse.get(2)!.lossWh;
    expect(loss).toBe(1_450_000);
  });
});

describe('미세 흐름 방지', () => {
  it('수요처 잔량이 1 kWh 미만이면 보내지 않는다 (반올림 손실 반복 없음)', () => {
    const r = allocate(2,
      [{ key: 'g', node: 0, availWh: 10_000_000, cost: 0 }],
      [{ key: 'm', node: 1, capWh: 1_000_400, value: 10_000 }],
      [{ id: 1, a: 0, b: 1, capWh: 100_000_000, lossPpm: 200_000, usable: true }]);
    expect(r.flows.length).toBeLessThanOrEqual(2);
    const u = r.edgeUse.get(1)!;
    expect(Math.abs(u.lossWh - u.sentWh * 0.2)).toBeLessThanOrEqual(r.flows.length);
  });
});

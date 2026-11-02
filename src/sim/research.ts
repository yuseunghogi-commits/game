// 연구 (Baseline §19, Q18 핵심+자유 분기, Q19 투자+시간).
// 진행: 하루 투자액은 (총비용 / 최소 기간)을 넘지 못한다 → 돈만으로 기간을 줄일 수 없다 (§18.1).
// 효과: 곱셈형 수정자 + 불변식 클램프 (§19.4).

import { BASE_CONCURRENT_BUILDS, RESEARCH, RESEARCH_MAX_ACTIVE } from './data';
import { availableCash, discretionaryBlocked, notify, post } from './core';
import type { GameState } from './types';

export const has = (s: GameState, id: string) => s.research.done.includes(id);

export function mods(s: GameState) {
  return {
    fuel: has(s, 'gen1') ? 0.95 : 1,
    ramp: has(s, 'gen2') ? 1.5 : 1,
    minOutDeltaPpm: has(s, 'gen2') ? -100_000 : 0,
    lineLoss: has(s, 'tx1') ? 0.9 : 1,
    lineCap: has(s, 'tx2') ? 1.2 : 1,
    repair: has(s, 'tx3') ? 0.7 : 1,
    effAddPpm: has(s, 'sto1') ? 20_000 : 0,
    stoEnergy: has(s, 'sto2') ? 1.2 : 1,
    forecast: has(s, 'auto1'),
    autoOps: has(s, 'auto2'),
    env: has(s, 'env1') ? 0.85 : 1,
    capex: (has(s, 'con1') ? 0.95 : 1) * s.rules.m.capex,
    buildTime: has(s, 'con2') ? 0.9 : 1,
    concurrent: BASE_CONCURRENT_BUILDS + (has(s, 'con2') ? 1 : 0),
  };
}

export function researchCost(s: GameState, id: string): number {
  const n = RESEARCH.find((x) => x.id === id)!;
  return Math.round(n.costMinor * s.rules.m.research);
}

export function canStart(s: GameState, id: string): string | null {
  const n = RESEARCH.find((x) => x.id === id);
  if (!n) return '존재하지 않는 연구';
  if (has(s, id)) return '이미 완료';
  if (s.research.active.some((a) => a.id === id)) return '이미 진행 중';
  if (n.requires && !has(s, n.requires)) return '선행 연구 필요';
  if (s.research.active.length >= RESEARCH_MAX_ACTIVE) return `동시 연구는 ${RESEARCH_MAX_ACTIVE}개까지`;
  return discretionaryBlocked(s);
}

export function startResearch(s: GameState, id: string, dailyBudgetMinor: number) {
  const why = canStart(s, id);
  if (why) return notify(s, 'error', `연구 거부: ${why}`);
  s.research.active.push({ id, investedMinor: 0, days: 0, dailyBudgetMinor: Math.max(0, dailyBudgetMinor) });
  notify(s, 'info', `연구 시작: ${RESEARCH.find((x) => x.id === id)!.name}`);
}

/** 게임일 경계마다: 투자 → 진행 → 완료 */
export function researchDay(s: GameState, day: number) {
  for (const a of [...s.research.active]) {
    const n = RESEARCH.find((x) => x.id === a.id)!;
    const cost = researchCost(s, a.id);
    const perDayCap = Math.ceil(cost / n.minDays);
    let invest = Math.min(a.dailyBudgetMinor, perDayCap, cost - a.investedMinor);
    if (discretionaryBlocked(s) || availableCash(s) < invest) invest = 0;
    if (invest > 0) post(s, `R${day}:${a.id}`, 'research', 'cash', invest, `연구 ${n.name}`);
    a.investedMinor += invest;
    a.days += 1;
    if (a.investedMinor >= cost) {
      s.research.done.push(a.id);
      s.research.active = s.research.active.filter((x) => x.id !== a.id);
      notify(s, 'info', `연구 완료: ${n.name} — ${n.effect}`);
    }
  }
}

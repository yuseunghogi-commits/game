// 계약 (Baseline §14.5, §14.9, 결정 S-03·S-04).
// PPA: 지역 허브에 고정 물량 인도, 지역 판매 한도에 포함. 직접 공급: 별도 고객 부하, 소매 공급 사업권 필요.
// 위약금 = 부족량 × [max(시장가 − 계약가, 0) + λ × 계약가] → 계약 물량을 시장에 돌려 파는 것은 항상 손해.

import { CONTRACT, LICENSE, type RegionDef } from './data';
import { notify, rand, randInt } from './core';
import { localMinute } from './market';
import { licensesOf } from './rights';
import { PPM, STEPS_PER_DAY, STEPS_PER_DI, WH_PER_KW_PER_DI, moneyFor } from './units';
import type { Contract, ContractOffer, GameState } from './types';

const FLAT = Array(24).fill(PPM);
const DAYTIME = Array.from({ length: 24 }, (_, h) => (h >= 7 && h < 19 ? PPM : 0));
const COMMERCIAL = [0.5, 0.45, 0.45, 0.45, 0.5, 0.6, 0.75, 0.9, 1, 1, 1, 1, 1, 1, 1, 1, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.55, 0.5].map((v) => Math.round(v * PPM));

/** 계약 프로파일에 따른 이번 DI 의무량 (Wh) */
export function obligationWh(r: RegionDef, c: ContractOffer, step: number): number {
  const m = localMinute(r, step);
  return Math.floor((c.mwKw * c.shapePpm[Math.floor(m / 60)]) / PPM) * WH_PER_KW_PER_DI;
}

/** 게임일마다 지역별 제안 생성 (7일 간격), 만료된 제안 정리 */
export function offersDay(s: GameState, day: number) {
  s.offers = s.offers.filter((o) => o.expiresAt > s.step);
  if (day % CONTRACT.offerEveryDays !== 0) return;
  s.regions.forEach((r, ri) => {
    if (s.offers.filter((o) => o.regionId === ri).length >= CONTRACT.maxOpenOffersPerRegion) return;
    const isPpa = rand(s) < 0.55;
    const P = CONTRACT.ppa, D = CONTRACT.direct;
    let o: ContractOffer;
    if (isPpa) {
      const mw = randInt(s, P.mwMin / 5, P.mwMax / 5) * 5;
      const day = rand(s) < 0.4;
      o = {
        id: s.nextId++, kind: 'ppa', regionId: ri, mwKw: mw * 1000, shapePpm: day ? DAYTIME : FLAT,
        priceMinor: Math.round(r.pBaseMinor * (P.priceMin + rand(s) * (P.priceMax - P.priceMin)) * (day ? 1.05 : 1)),
        termDays: P.terms[randInt(s, 0, P.terms.length - 1)], critical: false, expiresAt: s.step + CONTRACT.offerExpireDays * STEPS_PER_DAY,
      };
    } else {
      const mw = randInt(s, D.mwMin / 2, D.mwMax / 2) * 2;
      const critical = rand(s) < D.criticalShare;
      const commercial = rand(s) < 0.5;
      o = {
        id: s.nextId++, kind: 'direct', regionId: ri, mwKw: mw * 1000, shapePpm: commercial ? COMMERCIAL : FLAT,
        priceMinor: Math.round(r.pBaseMinor * (D.priceMin + rand(s) * (D.priceMax - D.priceMin)) * (critical ? D.criticalPremium : 1)),
        termDays: D.terms[randInt(s, 0, D.terms.length - 1)], critical, expiresAt: s.step + CONTRACT.offerExpireDays * STEPS_PER_DAY,
      };
    }
    s.offers.push(o);
  });
}

/** 무리한 계약 경고용: 향후 공급 여력 (해당 지역 + 연결 지역의 가동 발전 정격 − 기존 계약) */
export function supplyHeadroomKw(s: GameState, regionId: number): number {
  const linked = new Set([regionId]);
  for (const l of s.lines) if (l.status === 'operating' && (l.a === regionId || l.b === regionId)) { linked.add(l.a); linked.add(l.b); }
  const cap = s.facilities.filter((f) => linked.has(f.regionId) && f.status === 'operating' && (f.type === 'thermal' || f.type === 'storage')).reduce((a, f) => a + f.capKw, 0)
    + s.facilities.filter((f) => linked.has(f.regionId) && f.status === 'operating' && (f.type === 'wind' || f.type === 'solar')).reduce((a, f) => a + f.capKw * 0.3, 0);
  const used = s.contracts.filter((c) => !c.done && linked.has(c.regionId)).reduce((a, c) => a + c.mwKw, 0);
  return Math.round(cap - used);
}

export function acceptOffer(s: GameState, offerId: number) {
  const o = s.offers.find((x) => x.id === offerId);
  if (!o) return notify(s, 'error', '계약 거부: 제안이 만료되었습니다');
  if (o.kind === 'direct' && licensesOf(s, o.regionId, 'RET').length === 0) return notify(s, 'error', '직접 공급 계약에는 이 지역의 소매 공급 사업권이 필요합니다');
  const start = Math.ceil((s.step + 1) / STEPS_PER_DI) * STEPS_PER_DI; // DI 경계 정렬 (시작은 올림)
  const c: Contract = {
    ...o, startStep: start, endStep: start + o.termDays * STEPS_PER_DAY,
    deliveredWh: 0, obligationWh: 0, penaltyMinor: 0, revenueMinor: 0, lastObligationWh: 0, lastDeliveredWh: 0, done: false,
  };
  s.offers = s.offers.filter((x) => x.id !== offerId);
  s.contracts.push(c);
  if (supplyHeadroomKw(s, o.regionId) < 0) notify(s, 'warn', `무리한 계약 경고: ${s.regions[o.regionId].name}의 공급 여력이 계약 물량보다 적습니다`);
  notify(s, 'info', `계약 체결: ${s.regions[o.regionId].name} ${o.kind === 'ppa' ? 'PPA' : o.critical ? '직접 공급(핵심 부하)' : '직접 공급'} ${o.mwKw / 1000} MW, ${o.termDays}일`);
}

export const activeContracts = (s: GameState) => s.contracts.filter((c) => !c.done && s.step >= c.startStep && s.step <= c.endStep);

/** DI 정산: 부족량 위약금. 수익은 배분 흐름에서 공급원별로 계산된다. 현금 영향은 돌려준다 (당일 누적). */
export function settleContract(c: Contract, obligation: number, delivered: number, marketPrice: number): { revenue: number; penalty: number } {
  const tol = Math.floor((obligation * CONTRACT.tolerancePpm) / PPM);
  const short = Math.max(0, obligation - delivered - tol);
  const lambda = c.kind === 'ppa' ? CONTRACT.lambdaPpm.ppa : c.critical ? CONTRACT.lambdaPpm.critical : CONTRACT.lambdaPpm.direct;
  const perMWh = Math.max(0, marketPrice - c.priceMinor) + Math.round((c.priceMinor * lambda) / PPM);
  const penalty = moneyFor(short, perMWh);
  const revenue = moneyFor(delivered, c.priceMinor);
  c.obligationWh += obligation;
  c.deliveredWh += delivered;
  c.revenueMinor += revenue;
  c.penaltyMinor += penalty;
  c.lastObligationWh = obligation;
  c.lastDeliveredWh = delivered;
  return { revenue, penalty };
}

export function contractsDay(s: GameState) {
  for (const c of s.contracts) {
    if (!c.done && s.step >= c.endStep) {
      c.done = true;
      s.completedContracts += 1;
      const rate = c.obligationWh ? (c.deliveredWh / c.obligationWh) * 100 : 100;
      notify(s, 'info', `계약 종료: ${s.regions[c.regionId].name} ${c.kind === 'ppa' ? 'PPA' : '직접 공급'} — 이행률 ${rate.toFixed(1)}%`);
    }
  }
  // 오래 끝난 계약은 목록에서 정리 (최근 20건만 보관)
  const done = s.contracts.filter((c) => c.done);
  if (done.length > 20) {
    const drop = new Set(done.slice(0, done.length - 20).map((c) => c.id));
    s.contracts = s.contracts.filter((c) => !drop.has(c.id));
  }
  void LICENSE;
}

/** 공급 신뢰도 (최근 30일, 계약·핵심 부하 기준) */
export function reliability(s: GameState): number | null {
  const o = s.reliability.obligation.reduce((a, b) => a + b, 0);
  if (o === 0) return null;
  return s.reliability.delivered.reduce((a, b) => a + b, 0) / o;
}

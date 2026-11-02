// 환경·규제·사건 (Baseline §22–24, Q21·Q26, S-22).
// 환경: 30일 이동 합계 지표 = 영향 / 지역 기준치. 1.0 초과 시 신규 열발전 금지 + 환경 비용 ×1.5.
// 규제: 통지 60일 후 시행 (갑작스러운 처벌 없음).
// 사건: 설비 고장(전조 → 고장 → 자동 복구), 연료 가격 변동, 수요 급변, 공급 충격(사전 예고).

import { ENV, EVENTS, FACILITY_TYPES, MARKET_EVENTS, REGULATION, type TypeId } from './data';
import { notify, post, rand, randInt } from './core';
import { mods } from './research';
import { PPM, STEPS_PER_DAY } from './units';
import type { Facility, GameState, Health, Line } from './types';

// ---------- 환경 ----------

export function envThreshold(s: GameState, ri: number): number {
  return (s.regions[ri].demandBaseKw / 1000) * ENV.thresholdPerMw;
}

export function envIndex(s: GameState, ri: number): number {
  const sum = s.regionDyn[ri].envDaily.reduce((a, b) => a + b, 0);
  return sum / envThreshold(s, ri);
}

/** DI마다: 발전량에 따른 환경 영향 누적 (단위 = ppm 정수 합계를 MWh 단위로) */
export function envAccumulate(s: GameState, f: Facility, genWh: number) {
  const imp = (genWh / 1_000_000) * (ENV.impactPpmPerMWh[f.type as TypeId] / PPM);
  if (imp <= 0) return;
  const d = s.regionDyn[f.regionId].envDaily;
  d[d.length - 1] += imp;
}

export function envPriceMinor(s: GameState, ri: number): number {
  const over = envIndex(s, ri) > 1 ? ENV.overMultiplier : 1;
  return Math.round(ENV.priceMinorPerUnit * s.regionDyn[ri].envPriceMult * s.rules.m.env * mods(s).env * over);
}

export function environmentDay(s: GameState, day: number) {
  s.regionDyn.forEach((dyn, ri) => {
    const today = dyn.envDaily[dyn.envDaily.length - 1];
    const cost = Math.round(today * envPriceMinor(s, ri));
    post(s, `D${day}:env:${ri}`, 'env', 'cash', cost, `${s.regions[ri].name} 환경 비용`);
    const before = envIndex(s, ri);
    dyn.envDaily.push(0);
    if (dyn.envDaily.length > ENV.windowDays) dyn.envDaily.shift();
    const after = envIndex(s, ri);
    if (before < ENV.warnLevelPpm / PPM && after >= ENV.warnLevelPpm / PPM) notify(s, 'warn', `${s.regions[ri].name} 환경 지표 ${after.toFixed(2)} — 1.0을 넘으면 신규 열발전이 금지되고 환경 비용이 오릅니다`);
    // 규제 시행
    if (dyn.pendingReg && s.step >= dyn.pendingReg.at) {
      dyn.envPriceMult = dyn.pendingReg.mult;
      dyn.pendingReg = null;
      notify(s, 'warn', `규제 시행: ${s.regions[ri].name} 환경 단가 ×${dyn.envPriceMult.toFixed(2)}`);
    }
  });
  if (s.step >= s.nextRegulationAt) {
    const ri = randInt(s, 0, s.regions.length - 1);
    const dyn = s.regionDyn[ri];
    if (!dyn.pendingReg) {
      dyn.pendingReg = { at: s.step + REGULATION.noticeDays * STEPS_PER_DAY, mult: Math.round(dyn.envPriceMult * REGULATION.envPriceStep * 100) / 100 };
      notify(s, 'warn', `규제 변경 예고: ${s.regions[ri].name} 환경 단가 ×${REGULATION.envPriceStep} — ${REGULATION.noticeDays}일 후 시행`);
    }
    const gap = randInt(s, REGULATION.everyDaysMin, REGULATION.everyDaysMax) / s.rules.m.regulation;
    s.nextRegulationAt = s.step + Math.round(gap * STEPS_PER_DAY);
  }
}

export function thermalBlocked(s: GameState, ri: number): boolean {
  return envIndex(s, ri) > 1;
}

// ---------- 시장 사건 ----------

export function marketEventsDay(s: GameState, day: number) {
  const E = MARKET_EVENTS;
  const vol = s.rules.m.volatility;
  if (day > 0 && day % E.fuelEveryDays === 0) {
    s.fuelMult = s.nextFuelMult;
    const step = 1 + (E.fuelStepMin + rand(s) * (E.fuelStepMax - E.fuelStepMin) - 1) * vol;
    s.nextFuelMult = Math.min(E.fuelMax, Math.max(E.fuelMin, Math.round(s.fuelMult * step * 1000) / 1000));
    notify(s, 'info', `연료 가격 조정: ×${s.fuelMult.toFixed(2)} (다음 달 예상 ×${s.nextFuelMult.toFixed(2)})`);
  }
  const perDay = s.rules.m.events / 120;
  s.regionDyn.forEach((dyn, ri) => {
    const name = s.regions[ri].name;
    // 내가 진출하지 않은 지역의 사건은 가격에만 반영하고 알리지 않는다 (알림 과부하 방지, Baseline §28.4)
    const mine = s.facilities.some((f) => f.regionId === ri) || s.contracts.some((c) => !c.done && c.regionId === ri) || s.lines.some((l) => l.a === ri || l.b === ri);
    const tell = (level: 'info' | 'warn', text: string) => { if (mine) notify(s, level, text); };
    if (dyn.demandShock && s.step >= dyn.demandShock.to) { dyn.demandShock = null; tell('info', `${name} 수요 정상화`); }
    if (dyn.supplyShock && s.step >= dyn.supplyShock.to) { dyn.supplyShock = null; tell('info', `${name} 공급 정상화`); }
    if (!dyn.demandShock && rand(s) < E.demandShockPerYear * perDay) {
      const mult = 1 + (E.demandShockMin + rand(s) * (E.demandShockMax - E.demandShockMin) - 1) * vol;
      const from = s.step + E.leadDays * STEPS_PER_DAY;
      dyn.demandShock = { from, to: from + randInt(s, ...E.demandShockDays) * STEPS_PER_DAY, mult };
      tell('warn', `${name} 수요 급변 예상 (${E.leadDays}일 후, ×${mult.toFixed(2)})`);
    }
    if (!dyn.supplyShock && rand(s) < E.supplyShockPerYear * perDay) {
      const mult = E.supplyShockMin + rand(s) * (E.supplyShockMax - E.supplyShockMin);
      const from = s.step + STEPS_PER_DAY;
      dyn.supplyShock = { from, to: from + randInt(s, ...E.supplyShockDays) * STEPS_PER_DAY, mult };
      tell('warn', `${name} 기존 전력망 공급 충격 예고 (내일부터, 공급 ×${mult.toFixed(2)}) — 가격 급등 예상`);
    }
  });
}

export const shockMult = (sh: { from: number; to: number; mult: number } | null, step: number) => (sh && step >= sh.from && step < sh.to ? sh.mult : 1);

// ---------- 고장 ----------

function repairCost(kind: 'facility' | 'line' | 'hub', capex: number): number {
  if (kind === 'hub') return EVENTS.hubRepairMinor;
  return Math.round((capex * EVENTS.repairPpm[kind]) / PPM);
}

export function inspectCost(kind: 'facility' | 'line' | 'hub', capex: number) {
  return Math.round(repairCost(kind, capex) * EVENTS.inspectionShare);
}

function progressHealth(s: GameState, h: Health, name: string, onFail: () => { days: number; cost: number }): Health {
  if (h.s === 'warning' && s.step >= h.failAt) {
    const { days, cost } = onFail();
    post(s, `repair:${name}:${s.step}`, 'repair', 'cash', cost, `고장 복구: ${name}`);
    notify(s, 'error', `고장: ${name} — 자동 복구 ${days}일, 비용 ${(cost / 100).toLocaleString()} CR`);
    return { s: 'failed', until: s.step + days * STEPS_PER_DAY };
  }
  if ((h.s === 'failed' || h.s === 'inspection') && s.step >= h.until) {
    notify(s, 'info', `${h.s === 'failed' ? '복구 완료' : '점검 완료'}: ${name}`);
    return { s: 'ok' };
  }
  return h;
}

const facName = (s: GameState, f: Facility) => `${s.regions[f.regionId].name} ${FACILITY_TYPES[f.type].name} #${f.id}`;
const lineName = (s: GameState, l: Line) => `${s.regions[l.a].name}–${s.regions[l.b].name} 송전선`;

/** DI마다 1회. 전조 판정 → 예정 시각 고장 → 자동 복구. 순서는 ID 순 (결정론). */
export function failuresDI(s: GameState) {
  const perDI = s.rules.m.events / (120 * 96);
  const rep = mods(s).repair;
  const days = (k: string) => Math.max(1, Math.round(randInt(s, ...(EVENTS.repairDays[k] as [number, number])) * rep));
  for (const f of s.facilities) {
    if (f.status !== 'operating') continue;
    if (f.health.s === 'ok' && rand(s) < EVENTS.facilityWarnPerYear * perDI) {
      const lead = randInt(s, ...EVENTS.warnLeadDays);
      f.health = { s: 'warning', failAt: s.step + lead * STEPS_PER_DAY };
      notify(s, 'warn', `점검 필요: ${facName(s, f)} — ${lead}일 안에 고장 예상`);
    }
    f.health = progressHealth(s, f.health, facName(s, f), () => ({ days: days('facility'), cost: repairCost('facility', f.capexMinor) }));
  }
  for (const l of s.lines) {
    if (l.status !== 'operating') continue;
    if (l.health.s === 'ok' && rand(s) < EVENTS.linePerYearPer1000Km * (l.lengthKm / 1000) * perDI) {
      const lead = randInt(s, ...EVENTS.warnLeadDays);
      l.health = { s: 'warning', failAt: s.step + lead * STEPS_PER_DAY };
      notify(s, 'warn', `점검 필요: ${lineName(s, l)} — ${lead}일 안에 고장 예상`);
    }
    l.health = progressHealth(s, l.health, lineName(s, l), () => ({ days: days('line'), cost: repairCost('line', l.capexMinor) }));
  }
  s.hubs.forEach((h, i) => {
    if (!s.facilities.some((f) => f.regionId === i && f.status === 'operating')) return;
    const name = `${s.regions[i].name} 접속점`;
    if (h.health.s === 'ok' && rand(s) < EVENTS.hubPerYear * perDI) {
      const lead = randInt(s, ...EVENTS.warnLeadDays);
      h.health = { s: 'warning', failAt: s.step + lead * STEPS_PER_DAY };
      notify(s, 'warn', `점검 필요: ${name} — ${lead}일 안에 고장 예상`);
    }
    h.health = progressHealth(s, h.health, name, () => ({ days: days('hub'), cost: repairCost('hub', 0) }));
  });
}

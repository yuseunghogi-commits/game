// 운영 확장: 모듈 확장(Q47), 긴급 복구(복구 우선순위), 계획 건설(Q32), 시설 실적.

import { FACILITY_TYPES, MODULES, RUSH_REPAIR, specOf } from './data';
import { availableCash, discretionaryBlocked, notify, post } from './core';
import { repairCost } from './environment';
import { facilitySpec } from './geo';
import { pointFree } from './hub';
import { mods } from './research';
import { canBuildRights } from './rights';
import { STEPS_PER_DAY } from './units';
import type { FacDay, FacStats, Facility, GameState } from './types';

// ---------- 시설 실적 ----------

export const emptyDay = (): FacDay => ({ genWh: 0, soldWh: 0, contractWh: 0, revMinor: 0, fuelMinor: 0, opexMinor: 0, upDI: 0, di: 0 });
export const emptyStats = (): FacStats => ({ cur: emptyDay(), days: [], life: { genWh: 0, revMinor: 0, costMinor: 0, days: 0 } });

/** 게임일 마감: 오늘 실적을 기록으로 옮긴다 (최근 30일) */
export function statsDay(s: GameState) {
  for (const f of s.facilities) {
    const st = f.stats;
    if (f.status === 'operating') st.cur.opexMinor += f.fixedMinorPerDay;
    if (f.status !== 'operating' && st.cur.di === 0) continue;
    st.days.push(st.cur);
    if (st.days.length > 30) st.days.shift();
    st.life.genWh += st.cur.genWh;
    st.life.revMinor += st.cur.revMinor;
    st.life.costMinor += st.cur.fuelMinor + st.cur.opexMinor;
    st.life.days += 1;
    st.cur = emptyDay();
  }
}

// ---------- 모듈 확장 ----------

export function expansionSpec(s: GameState, f: Facility) {
  const base = specOf(f.type, f.size);
  const spec = facilitySpec(s, f.type, f.size);
  return {
    addKw: Math.round(base.capKw * MODULES.capShare),
    addEnergyWh: Math.round(spec.energyWh * MODULES.capShare),
    addFixedMinor: Math.round(spec.fixedMinorPerDay * MODULES.fixedShare),
    costMinor: Math.round(spec.capexMinor * MODULES.costShare),
    days: Math.max(1, Math.round(spec.buildDays * MODULES.timeShare)),
  };
}

export const expansionsActive = (s: GameState) => s.facilities.filter((f) => f.expansion).length;

export function expandCheck(s: GameState, f: Facility): string | null {
  const kind = FACILITY_TYPES[f.type].kind;
  if (kind === 'substation') return '변전소는 확장할 수 없습니다';
  if (f.status !== 'operating') return '운영 중인 시설만 확장할 수 있습니다';
  if (f.expansion) return '이미 확장 공사 중입니다';
  if (f.modules >= MODULES.max) return `모듈은 시설당 ${MODULES.max}개까지입니다`;
  const sp = expansionSpec(s, f);
  const busy = s.facilities.filter((x) => x.status === 'construction').length + s.lines.filter((l) => l.status === 'construction').length + expansionsActive(s);
  return discretionaryBlocked(s)
    ?? (busy >= mods(s).concurrent ? `동시 건설은 ${mods(s).concurrent}건까지` : null)
    ?? canBuildRights(s, f.regionId, f.type, sp.addKw)
    ?? (pointFree(s, f.regionId, f.pointId) < sp.addKw ? '이 시설의 접속점 용량이 부족합니다' : null)
    ?? (availableCash(s) < sp.costMinor ? '사용 가능 자금 부족' : null);
}

export function startExpansion(s: GameState, f: Facility, who = '') {
  const why = expandCheck(s, f);
  if (why) return notify(s, 'error', `${who}모듈 확장 거부: ${why}`);
  const sp = expansionSpec(s, f);
  f.expansion = { addKw: sp.addKw, addEnergyWh: sp.addEnergyWh, addFixedMinor: sp.addFixedMinor, costMinor: sp.costMinor, startStep: s.step, until: s.step + sp.days * STEPS_PER_DAY };
  post(s, `expand:${f.id}:${f.modules + 1}`, 'capex', 'cash', sp.costMinor, `모듈 확장 #${f.id}`);
  notify(s, 'info', `${who}모듈 확장 시작: ${s.regions[f.regionId].name} ${FACILITY_TYPES[f.type].name} #${f.id} (+${sp.addKw / 1000} MW, ${sp.days}일)`);
}

/** 매 스텝: 확장 공사 완료 처리. 공사 중에도 기존 설비는 계속 운영한다. 권리가 없으면 공사가 멈춘다. */
export function advanceExpansions(s: GameState) {
  for (const f of s.facilities) {
    const e = f.expansion;
    if (!e) continue;
    if (!f.rightsOk) { e.until += 1; continue; }
    if (s.step < e.until) continue;
    f.capKw += e.addKw;
    f.energyWh += e.addEnergyWh;
    f.fixedMinorPerDay += e.addFixedMinor;
    f.capexMinor += e.costMinor;
    f.modules += 1;
    f.expansion = null;
    notify(s, 'info', `모듈 확장 준공: ${s.regions[f.regionId].name} ${FACILITY_TYPES[f.type].name} #${f.id} → ${f.capKw / 1000} MW`);
  }
}

// ---------- 긴급 복구 ----------

type Target = 'facility' | 'line' | 'hub';

function targetOf(s: GameState, target: Target, id: number) {
  if (target === 'hub') return s.hubs[id] ? { health: s.hubs[id].health, capex: 0, set: (h: typeof s.hubs[0]['health']) => { s.hubs[id].health = h; } } : null;
  const x = target === 'facility' ? s.facilities.find((f) => f.id === id) : s.lines.find((l) => l.id === id);
  return x ? { health: x.health, capex: x.capexMinor, set: (h: typeof x.health) => { x.health = h; } } : null;
}

export function rushCost(target: Target, capex: number) {
  return Math.round(repairCost(target, capex) * RUSH_REPAIR.costShare);
}

export function rushCheck(s: GameState, target: Target, id: number): string | null {
  const t = targetOf(s, target, id);
  if (!t) return '대상 없음';
  if (t.health.s !== 'failed') return '고장 상태가 아닙니다';
  if (t.health.rushed) return '이미 긴급 복구 중입니다';
  if (t.health.until - s.step < 2 * 15) return '곧 복구됩니다';
  return availableCash(s) < rushCost(target, t.capex) ? '사용 가능 자금 부족' : null;
}

/** 남은 복구 기간을 절반으로 줄인다 (추가 비용). 여러 고장이 겹칠 때 플레이어가 복구 순서를 정하는 수단. */
export function rushRepair(s: GameState, target: Target, id: number, who = '') {
  const why = rushCheck(s, target, id);
  if (why) return notify(s, 'error', `${who}긴급 복구 거부: ${why}`);
  const t = targetOf(s, target, id)!;
  const h = t.health as Extract<typeof t.health, { s: 'failed' }>;
  const cost = rushCost(target, t.capex);
  post(s, `rush:${target}:${id}:${s.step}`, 'repair', 'cash', cost, '긴급 복구');
  const left = h.until - s.step;
  t.set({ ...h, until: s.step + Math.ceil(left * RUSH_REPAIR.timeShare), rushed: true });
  notify(s, 'info', `${who}긴급 복구 투입: 남은 기간 ${(left / STEPS_PER_DAY).toFixed(1)}일 → ${((left * RUSH_REPAIR.timeShare) / STEPS_PER_DAY).toFixed(1)}일 (${(cost / 100).toLocaleString()} CR)`);
}

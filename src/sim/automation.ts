// 자동화 (Baseline §20, Q17, 결정 S-16).
// 기본은 추천. 정책을 켠 범위에서만 자동 실행한다. 자동 실행도 같은 명령·같은 검증을 거친다.
// 안전장치: 일일 예산, 일일 행동 수, 멱등 키(정책·대상·날짜), 같은 사유 3회 실패 시 정책 정지, 수동 고정 존중.

import { AUTOMATION, FACILITY_TYPES, LICENSE, LICENSE_NAMES, REQUIRED_LICENSE } from './data';
import { availableCash, issue, notify } from './core';
import { facilitySpec, lineSpec, neighbors } from './geo';
import { mods } from './research';
import { canRenew, licensesOf, quotaKw, quotaUsedKw, renewCost } from './rights';
import { creditLimit } from './finance';
import { bestPointFreeKw, hubUsedKw } from './hub';
import { rushCheck, rushCost } from './ops';
import { STEPS_PER_DAY } from './units';
import type { Command, GameState } from './types';

export function isLocked(s: GameState, key: string) {
  const until = s.automation.locks[key];
  return until !== undefined && (until < 0 || s.step < until);
}

function tryAuto(s: GameState, day: number, policy: string, target: string, cmd: Command, costMinor: number): boolean {
  const a = s.automation;
  const key = `${policy}:${target}:${day}`;
  if (a.keys.includes(key)) return false; // 멱등
  if ((a.failures[`${policy}:${target}`] ?? 0) >= AUTOMATION.retryLimit) return false;
  if (a.actionsToday >= AUTOMATION.dailyActionLimit) return false;
  if (a.spentTodayMinor + costMinor > a.dailyBudgetMinor || costMinor > availableCash(s)) {
    a.failures[`${policy}:${target}`] = (a.failures[`${policy}:${target}`] ?? 0) + 1;
    if (a.failures[`${policy}:${target}`] === AUTOMATION.retryLimit) notify(s, 'warn', `자동화 중단 (${policy}): 예산·자금 부족으로 ${AUTOMATION.retryLimit}회 실패 — 직접 처리하세요`);
    return false;
  }
  a.keys.push(key);
  if (a.keys.length > 300) a.keys.splice(0, a.keys.length - 300);
  a.actionsToday += 1;
  a.spentTodayMinor += costMinor;
  issue(s, cmd, policy);
  return true;
}

/** 게임일 경계에서 실행 (명령은 다음 스텝에 적용) */
export function automationDay(s: GameState, day: number) {
  const a = s.automation;
  a.spentTodayMinor = 0;
  a.actionsToday = 0;
  if (a.autoRenew) {
    for (const l of s.licenses) {
      if (!l.autoRenew || l.state === 'expired') continue;
      const left = (l.expiresAt - s.step) / STEPS_PER_DAY;
      if ((left <= 7 || l.state === 'grace') && canRenew(s, l)) tryAuto(s, day, '자동 갱신', `lic${l.id}`, { kind: 'renewLicense', licenseId: l.id }, renewCost(s, l));
    }
    for (const f of s.facilities) {
      if (f.land.mode !== 'lease' || f.land.state === 'expired') continue;
      const left = (f.land.expiresAt - s.step) / STEPS_PER_DAY;
      if (left <= 7 || f.land.state === 'grace') tryAuto(s, day, '자동 갱신', `land${f.id}`, { kind: 'renewLease', facilityId: f.id }, 0);
    }
  }
  if (a.autoInspect && mods(s).autoOps) {
    for (const f of s.facilities) if (f.health.s === 'warning' && !isLocked(s, `f${f.id}`)) tryAuto(s, day, '자동 점검', `f${f.id}`, { kind: 'inspect', target: 'facility', id: f.id }, 0);
    for (const l of s.lines) if (l.health.s === 'warning') tryAuto(s, day, '자동 점검', `l${l.id}`, { kind: 'inspect', target: 'line', id: l.id }, 0);
    s.hubs.forEach((h, i) => { if (h.health.s === 'warning') tryAuto(s, day, '자동 점검', `h${i}`, { kind: 'inspect', target: 'hub', id: i }, 0); });
  }
  if (a.autoStorage && mods(s).autoOps) {
    for (const f of s.facilities) {
      if (f.type !== 'storage' || f.status !== 'operating' || isLocked(s, `f${f.id}`)) continue;
      const samples = [...s.regionDyn[f.regionId].priceSamples].sort((x, y) => x - y);
      if (samples.length < 96) continue;
      const lo = samples[Math.floor(samples.length * 0.3)];
      const hi = samples[Math.floor(samples.length * 0.75)];
      if (hi > lo && (lo !== f.chargeAtMinor || hi !== f.dischargeAtMinor)) {
        tryAuto(s, day, '저장 자동 조정', `f${f.id}`, { kind: 'setStorage', facilityId: f.id, chargeAtMinor: lo, dischargeAtMinor: hi }, 0);
      }
    }
  }
}

// ---------- 추천 (읽기 전용, 설명 포함: Baseline §20.8) ----------

export interface Recommendation { id: string; title: string; reason: string; effect: string; costMinor: number; cmd: Command | null; priority: number; view?: string; region?: number }

export function recommendations(s: GameState): Recommendation[] {
  const out: Recommendation[] = [];
  for (const l of s.licenses) {
    if (l.state === 'expired') continue;
    const left = Math.ceil((l.expiresAt - s.step) / STEPS_PER_DAY);
    if (canRenew(s, l)) out.push({ id: `renew${l.id}`, title: `${s.regions[l.regionId].name} ${LICENSE_NAMES[l.type]} 갱신`, reason: l.state === 'grace' ? '만료됨 — 유예 중 (신규 건설 불가)' : `${left}일 후 만료`, effect: `${LICENSE.termDays}일 연장`, costMinor: renewCost(s, l), cmd: { kind: 'renewLicense', licenseId: l.id }, priority: l.state === 'grace' ? 95 : 70 });
  }
  for (const f of s.facilities) {
    if (f.health.s === 'warning') out.push({ id: `insp${f.id}`, title: `${s.regions[f.regionId].name} ${FACILITY_TYPES[f.type].name} 예방 점검`, reason: '고장 전조 발견', effect: '고장 방지 (1일 정지)', costMinor: 0, cmd: { kind: 'inspect', target: 'facility', id: f.id }, priority: 90 });
    if (f.land.mode === 'lease' && f.land.state !== 'active') out.push({ id: `lease${f.id}`, title: `시설 #${f.id} 토지 임대 갱신`, reason: '임대 만료 — 유예 중', effect: `${LICENSE.termDays}일 연장 (임대료 +10%)`, costMinor: 0, cmd: { kind: 'renewLease', facilityId: f.id }, priority: 94 });
  }
  // 복구 우선순위: 핵심 부하가 걸린 지역의 고장 시설은 긴급 복구를 추천
  const criticalRegions = new Set(s.contracts.filter((c) => !c.done && c.critical).map((c) => c.regionId));
  for (const f of s.facilities) {
    if (f.health.s !== 'failed' || rushCheck(s, 'facility', f.id)) continue;
    const crit = criticalRegions.has(f.regionId);
    out.push({ id: `rush${f.id}`, title: `${s.regions[f.regionId].name} ${FACILITY_TYPES[f.type].name} #${f.id} 긴급 복구`, reason: crit ? '핵심 부하 지역의 고장 — 위약금이 큼' : '고장으로 정지 중', effect: '남은 복구 기간 절반', costMinor: rushCost('facility', f.capexMinor), cmd: { kind: 'rushRepair', target: 'facility', id: f.id }, priority: crit ? 93 : 40 });
  }
  s.hubs.forEach((h, i) => {
    if (h.health.s === 'failed' && !rushCheck(s, 'hub', i)) out.push({ id: `rushh${i}`, title: `${s.regions[i].name} 수요 허브 긴급 복구`, reason: '허브 고장 — 지역 전체 정지', effect: '남은 복구 기간 절반', costMinor: rushCost('hub', 0), cmd: { kind: 'rushRepair', target: 'hub', id: i }, priority: 92 });
  });
  for (const l of s.lines) if (l.health.s === 'warning') out.push({ id: `inspl${l.id}`, title: `${s.regions[l.a].name}–${s.regions[l.b].name} 송전선 점검`, reason: '고장 전조 발견', effect: '고장 방지', costMinor: 0, cmd: { kind: 'inspect', target: 'line', id: l.id }, priority: 88 });
  s.regions.forEach((r, ri) => {
    const used = hubUsedKw(s, ri), free = bestPointFreeKw(s, ri);
    if (used > 0 && free < 20_000 && !s.facilities.some((f) => f.regionId === ri && f.type === 'substation' && f.status === 'construction')) out.push({ id: `sub${ri}`, title: `${r.name} 변전소 건설`, reason: `접속점 여유 최대 ${(free / 1000).toFixed(0)} MW`, effect: `접속 용량 +${(facilitySpec(s, 'substation', 'medium').hubAddKw / 1000).toFixed(0)} MW`, costMinor: facilitySpec(s, 'substation', 'medium').capexMinor, cmd: licensesOf(s, ri, 'TRN', ['active']).length ? { kind: 'build', regionId: ri, type: 'substation', size: 'medium' } : null, priority: 60 });
    for (const lt of ['GEN', 'STO'] as const) {
      const q = quotaKw(s, ri, lt);
      if (q > 0 && q - quotaUsedKw(s, ri, lt) < 5_000) out.push({ id: `quota${ri}${lt}`, title: `${r.name} ${LICENSE_NAMES[lt]} 추가`, reason: '사업권 한도가 거의 찼습니다', effect: '건설 한도 확대', costMinor: 0, cmd: { kind: 'acquireLicense', regionId: ri, type: lt, size: 'medium' }, priority: 50 });
    }
  });
  // 송전 기회: 내 발전이 있는 지역과 이웃 지역의 가격 차가 손실보다 클 때
  const nb = neighbors(s.regions);
  s.regions.forEach((_, ri) => {
    if (!s.facilities.some((f) => f.regionId === ri && f.status === 'operating' && REQUIRED_LICENSE[f.type] === 'GEN')) return;
    for (const j of nb[ri]) {
      if (s.lines.some((l) => (l.a === ri && l.b === j) || (l.a === j && l.b === ri))) continue;
      const spec = lineSpec(s, ri, j, 'small');
      const gain = s.regionState[j].priceMinor * (1 - spec.lossPpm / 1e6) - s.regionState[ri].priceMinor;
      if (gain > 0) out.push({ id: `line${ri}-${j}`, title: `${s.regions[ri].name} → ${s.regions[j].name} 송전선`, reason: `지금 이웃 가격이 손실(${(spec.lossPpm / 1e4).toFixed(1)}%)을 빼고도 ${(gain / 100).toFixed(1)} CR/MWh 높음`, effect: '시간대 차이를 이용한 판매', costMinor: spec.capexMinor, cmd: null, priority: 30, view: 'region', region: ri });
    }
  });
  if (s.insolvency === 'arrears' || s.insolvency === 'restructuring') {
    out.push({ id: 'loan', title: '대출로 유동성 확보', reason: '연체 상태', effect: `한도 ${(creditLimit(s) / 100).toLocaleString()} CR`, costMinor: 0, cmd: null, priority: 99, view: 'finance' });
  }
  return out.sort((a, b) => b.priority - a.priority);
}

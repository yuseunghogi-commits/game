// 명령 처리: UI·자동화 공통 진입점. 모든 명령은 같은 검증을 거친다 (Baseline §20.3).

import { FACILITY_TYPES, LICENSE_NAMES, REQUIRED_LICENSE, STAGES, STORAGE_EFF_PPM } from './data';
import { availableCash, discretionaryBlocked, notify, post } from './core';
import { acceptOffer } from './contracts';
import { inspectCost, thermalBlocked } from './environment';
import { bailout, disposeFacility, repayLoan, sellFacility, takeLoan } from './finance';
import { facilitySpec, lineSpec, neighbors } from './geo';
import { hubCapacityKw, hubUsedKw } from './hub';
import { mods, startResearch } from './research';
import { acquireLicense, buyLand, canBuildRights, licensesOf, newLease, renewLease, renewLicense, sellLand, updateRights } from './rights';
import { STEPS_PER_DAY, roundHalfEven, splitByWeights } from './units';
import type { Build, Command, Facility, GameState, Line } from './types';

function newBuild(capex: number, days: number): Build {
  return {
    stage: -1,
    stageStep: 0,
    stageSteps: splitByWeights(days * STEPS_PER_DAY, STAGES.map((x) => x.time)),
    stageCosts: splitByWeights(capex, STAGES.map((x) => x.cost)),
  };
}

/** 건설 취소 환불 (S-17): 미시작 단계는 예약 해제, 진행 중 단계 미진행분 80%, 완료 단계 20%. */
export function cancelRefund(f: Build): { releaseReserve: number; cashRefund: number } {
  let release = 0;
  let refund = 0;
  for (let i = 0; i < STAGES.length; i++) {
    const cost = f.stageCosts[i];
    if (i > f.stage) release += cost;
    else if (i === f.stage) refund += cost * (1 - f.stageStep / f.stageSteps[i]) * 0.8;
    else refund += cost * 0.2;
  }
  return { releaseReserve: release, cashRefund: roundHalfEven(refund) };
}

export function underConstruction(s: GameState) {
  return s.facilities.filter((f) => f.status === 'construction').length + s.lines.filter((l) => l.status === 'construction').length;
}

/** 건설 가능 여부와 거부 사유 (UI 미리보기와 실제 검증이 같은 함수를 쓴다) */
export function buildCheck(s: GameState, regionId: number, type: Facility['type'], size: Facility['size']): string | null {
  const spec = facilitySpec(s, type, size);
  const def = FACILITY_TYPES[type];
  return discretionaryBlocked(s)
    ?? (underConstruction(s) >= mods(s).concurrent ? `동시 건설은 ${mods(s).concurrent}건까지 (연구로 늘릴 수 있음)` : null)
    ?? (type === 'thermal' && thermalBlocked(s, regionId) ? '환경 규제: 이 지역은 환경 지표가 1.0을 넘어 신규 열발전이 금지됩니다' : null)
    ?? canBuildRights(s, regionId, type, def.kind === 'substation' ? 0 : spec.capKw)
    ?? (def.kind !== 'substation' && hubUsedKw(s, regionId) + spec.capKw > hubCapacityKw(s, regionId) ? '접속 용량 부족 — 변전소를 지으세요' : null)
    ?? (availableCash(s) < spec.capexMinor + newLease(s, regionId, type, spec.capKw).depositMinor ? '사용 가능 자금 부족' : null);
}

export function lineCheck(s: GameState, a: number, b: number, size: Facility['size']): string | null {
  const spec = lineSpec(s, a, b, size);
  return discretionaryBlocked(s)
    ?? (a === b || !neighbors(s.regions)[a]?.includes(b) ? '이웃 지역끼리만 연결할 수 있습니다' : null)
    ?? (s.lines.some((l) => (l.a === Math.min(a, b) && l.b === Math.max(a, b) && l.status === 'construction')) ? '같은 구간 선로가 이미 건설 중입니다' : null)
    ?? (underConstruction(s) >= mods(s).concurrent ? `동시 건설은 ${mods(s).concurrent}건까지` : null)
    ?? (licensesOf(s, a, 'TRN', ['active']).length === 0 || licensesOf(s, b, 'TRN', ['active']).length === 0 ? '양쪽 지역 모두 송전 사업권이 필요합니다' : null)
    ?? (availableCash(s) < spec.capexMinor ? '사용 가능 자금 부족' : null);
}

const fac = (s: GameState, id: number) => s.facilities.find((x) => x.id === id);

export function applyCommand(s: GameState, cmd: Command, auto?: string) {
  const who = auto ? `[${auto}] ` : '';
  switch (cmd.kind) {
    case 'build': {
      const region = s.regions[cmd.regionId];
      if (!region) return notify(s, 'error', '건설 거부: 존재하지 않는 지역');
      const why = buildCheck(s, cmd.regionId, cmd.type, cmd.size);
      if (why) return notify(s, 'error', `${who}건설 거부 (${region.name}): ${why}`);
      const def = FACILITY_TYPES[cmd.type];
      const spec = facilitySpec(s, cmd.type, cmd.size);
      const capKw = def.kind === 'substation' ? 0 : spec.capKw;
      const f: Facility = {
        id: s.nextId++, type: cmd.type, size: cmd.size, regionId: cmd.regionId, capKw,
        capexMinor: spec.capexMinor, fixedMinorPerDay: spec.fixedMinorPerDay, status: 'construction',
        ...newBuild(spec.capexMinor, spec.buildDays),
        online: true, outputKw: 0, startDelay: 0, lastGenWh: 0, lastSoldWh: 0, health: { s: 'ok' },
        energyWh: spec.energyWh, socWh: 0,
        dischargeAtMinor: Math.round(region.pBaseMinor * 1.1), chargeAtMinor: Math.round(region.pBaseMinor * 0.95),
        lastStorageWh: 0, hubAddKw: spec.hubAddKw, effPpm: STORAGE_EFF_PPM + mods(s).effAddPpm,
        land: newLease(s, cmd.regionId, cmd.type, spec.capKw), rightsOk: true,
      };
      s.facilities.push(f);
      s.reserved += spec.capexMinor;
      post(s, `deposit:${f.id}`, 'land_asset', 'cash', f.land.depositMinor, `토지 임대 보증금 #${f.id}`);
      updateRights(s);
      notify(s, 'info', `${who}건설 승인: ${region.name} ${def.name} (${spec.buildDays}일)`);
      return;
    }
    case 'buildLine': {
      const why = lineCheck(s, cmd.a, cmd.b, cmd.size);
      if (why) return notify(s, 'error', `${who}송전선 거부: ${why}`);
      const spec = lineSpec(s, cmd.a, cmd.b, cmd.size);
      const l: Line = {
        id: s.nextId++, a: Math.min(cmd.a, cmd.b), b: Math.max(cmd.a, cmd.b), size: cmd.size, capKw: spec.capKw,
        lengthKm: spec.lengthKm, lossPpm: spec.lossPpm, capexMinor: spec.capexMinor, status: 'construction',
        ...newBuild(spec.capexMinor, spec.buildDays), health: { s: 'ok' }, lastDir: 0, lastSentWh: 0, lastLossWh: 0, rightsOk: true,
      };
      s.lines.push(l);
      s.reserved += spec.capexMinor;
      notify(s, 'info', `${who}건설 승인: ${s.regions[l.a].name}–${s.regions[l.b].name} 송전선 (${spec.buildDays}일, 손실 ${(spec.lossPpm / 10_000).toFixed(1)}%)`);
      return;
    }
    case 'cancel':
    case 'cancelLine': {
      const target: (Build & { id: number; status: string }) | undefined = cmd.kind === 'cancel' ? fac(s, cmd.facilityId) : s.lines.find((x) => x.id === cmd.lineId);
      if (!target || target.status !== 'construction') return notify(s, 'error', '취소 거부: 건설 중인 대상이 아님');
      const r = cancelRefund(target);
      s.reserved -= r.releaseReserve;
      post(s, `cancel:${target.id}`, 'cash', 'refund', r.cashRefund, `건설 취소 환불 #${target.id}`);
      if (cmd.kind === 'cancel') {
        const f = target as Facility;
        post(s, `deposit-back:${f.id}:${s.step}`, 'cash', 'land_asset', f.land.depositMinor, `임대 보증금 반환 #${f.id}`);
        s.facilities = s.facilities.filter((x) => x.id !== target.id);
      } else s.lines = s.lines.filter((x) => x.id !== target.id);
      notify(s, 'info', `건설 취소: 환불 ${(r.cashRefund / 100).toLocaleString()} CR`);
      return;
    }
    case 'setOnline': {
      const f = fac(s, cmd.facilityId);
      if (!f) return notify(s, 'error', '명령 거부: 시설 없음');
      if (f.online === cmd.online) return;
      f.online = cmd.online;
      if (cmd.online) f.startDelay = FACILITY_TYPES[f.type].startDelayDI;
      else f.outputKw = 0;
      if (!auto) s.automation.locks[`f${f.id}`] = s.step + STEPS_PER_DAY;
      return;
    }
    case 'setStorage': {
      const f = fac(s, cmd.facilityId);
      if (!f || f.type !== 'storage') return notify(s, 'error', '명령 거부: 저장시설 없음');
      if (cmd.chargeAtMinor >= cmd.dischargeAtMinor) return notify(s, 'error', '거부: 충전 기준 가격은 방전 기준 가격보다 낮아야 합니다');
      f.dischargeAtMinor = Math.max(0, cmd.dischargeAtMinor);
      f.chargeAtMinor = Math.max(0, cmd.chargeAtMinor);
      if (!auto) s.automation.locks[`f${f.id}`] = s.step + STEPS_PER_DAY; // 수동 고정 (S-16 기본 1일)
      return;
    }
    case 'lock': {
      if (cmd.days === null) s.automation.locks[cmd.key] = -1;
      else if (cmd.days === 0) delete s.automation.locks[cmd.key];
      else s.automation.locks[cmd.key] = s.step + cmd.days * STEPS_PER_DAY;
      return;
    }
    case 'inspect': {
      const t = cmd.target === 'facility' ? fac(s, cmd.id) : cmd.target === 'line' ? s.lines.find((x) => x.id === cmd.id) : s.hubs[cmd.id];
      if (!t || t.health.s !== 'warning') return notify(s, 'error', '점검 거부: 점검이 필요한 상태가 아님');
      const capex = cmd.target === 'hub' ? 0 : (t as Facility | Line).capexMinor;
      const cost = inspectCost(cmd.target, capex);
      post(s, `inspect:${cmd.target}:${cmd.id}:${s.step}`, 'repair', 'cash', cost, '예방 점검');
      t.health = { s: 'inspection', until: s.step + STEPS_PER_DAY };
      notify(s, 'info', `${who}예방 점검 시작 (1일, ${(cost / 100).toLocaleString()} CR)`);
      return;
    }
    case 'acquireLicense': {
      const why = discretionaryBlocked(s);
      if (why) return notify(s, 'error', `${LICENSE_NAMES[cmd.type]} 취득 거부: ${why}`);
      acquireLicense(s, cmd.regionId, cmd.type, cmd.size);
      updateRights(s);
      return;
    }
    case 'renewLicense': {
      const l = s.licenses.find((x) => x.id === cmd.licenseId);
      if (!l) return notify(s, 'error', '갱신 거부: 사업권 없음');
      renewLicense(s, l);
      updateRights(s);
      return;
    }
    case 'setAutoRenew': {
      const l = s.licenses.find((x) => x.id === cmd.licenseId);
      if (l) l.autoRenew = cmd.on;
      return;
    }
    case 'renewLease': {
      const f = fac(s, cmd.facilityId);
      if (!f) return notify(s, 'error', '갱신 거부: 시설 없음');
      renewLease(s, f);
      updateRights(s);
      return;
    }
    case 'buyLand': {
      const f = fac(s, cmd.facilityId);
      const why = discretionaryBlocked(s);
      if (!f || why) return notify(s, 'error', `토지 매입 거부: ${why ?? '시설 없음'}`);
      buyLand(s, f);
      updateRights(s);
      return;
    }
    case 'sellLand': {
      const f = fac(s, cmd.facilityId);
      if (f) sellLand(s, f);
      return;
    }
    case 'sellFacility': {
      const f = fac(s, cmd.facilityId);
      if (f) sellFacility(s, f);
      return;
    }
    case 'disposeFacility': {
      const f = fac(s, cmd.facilityId);
      if (f) disposeFacility(s, f);
      return;
    }
    case 'takeLoan': return takeLoan(s, cmd.principalMinor, cmd.months);
    case 'repayLoan': return repayLoan(s, cmd.loanId);
    case 'acceptOffer': return acceptOffer(s, cmd.offerId);
    case 'startResearch': return startResearch(s, cmd.id, cmd.dailyBudgetMinor);
    case 'setAutomation': { s.automation[cmd.key] = cmd.on; s.automation.failures = {}; return; }
    case 'setAutomationBudget': { s.automation.dailyBudgetMinor = Math.max(0, cmd.dailyBudgetMinor); return; }
    case 'bailout': return bailout(s);
  }
}

export { REQUIRED_LICENSE };

// 사업권·토지 (Baseline §8–9, 결정 S-11·S-15·S-19).
// 상태: active → grace(30일: 운영 가능, 신규 건설 불가) → expired(시설 정지, 삭제하지 않음).
// 알림: 만료 30·7·1 게임일 전.

import { FACILITY_TYPES, LAND, LICENSE, LICENSE_NAMES, REQUIRED_LICENSE, type LicenseType, type SizeId, type TypeId } from './data';
import { notify, post, txId } from './core';
import { PPM, STEPS_PER_DAY } from './units';
import type { Facility, GameState, Land, License } from './types';

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** 지역 계수 M = clamp(M_수요 × M_자원 × M_접근성 × M_희소성) (§8.6) */
export function licenseMultiplier(s: GameState, regionId: number, type: LicenseType): number {
  const r = s.regions[regionId];
  const md = 0.75 + 0.75 * clamp((r.demandBaseKw - 300_000) / 1_200_000, 0, 1);
  const mr = type === 'GEN' ? 0.75 + 0.1875 * ((r.solar + r.wind) / 2 - 1) : 1;
  const ma = r.accessPpm / PPM;
  const issued = s.licenses.filter((l) => l.regionId === regionId && l.state !== 'expired').reduce((a, l) => a + l.quotaKw, 0);
  const ms = 1 + 0.5 * clamp(issued / r.demandBaseKw, 0, 2);
  return clamp(md * mr * ma * ms, LICENSE.multMin, LICENSE.multMax);
}

export function licensePrice(s: GameState, regionId: number, type: LicenseType, size: SizeId) {
  const t = LICENSE.tiers[type][size];
  const m = licenseMultiplier(s, regionId, type);
  // 금액은 1 CR 단위로 반올림해 표시가 깔끔하도록 한다
  const reg = s.rules.m.regulation;
  return {
    priceMinor: Math.round((t.price * m) / 100) * 100,
    feePerDayMinor: Math.round((t.fee * m * reg) / 100) * 100,
    perMwFeeMinor: Math.round(LICENSE.perMwFee[type] * m * reg),
    quotaKw: t.quotaKw,
  };
}

/** 지역·유형별 사용량 수수료 (일): 사용 MW × MW당 수수료 (현재 지역 계수 기준) */
export function usageFeePerDay(s: GameState, regionId: number, type: LicenseType): number {
  if (licensesOf(s, regionId, type).length === 0) return 0;
  const usedMw = quotaUsedKw(s, regionId, type) / 1000;
  return Math.round(usedMw * licensePrice(s, regionId, type, 'small').perMwFeeMinor);
}

export function licensesOf(s: GameState, regionId: number, type: LicenseType, states: License['state'][] = ['active', 'grace']) {
  return s.licenses.filter((l) => l.regionId === regionId && l.type === type && states.includes(l.state));
}

export function quotaKw(s: GameState, regionId: number, type: LicenseType, states: License['state'][] = ['active', 'grace']) {
  return licensesOf(s, regionId, type, states).reduce((a, l) => a + l.quotaKw, 0);
}

export function quotaUsedKw(s: GameState, regionId: number, type: LicenseType) {
  return s.facilities.filter((f) => f.regionId === regionId && REQUIRED_LICENSE[f.type] === type).reduce((a, f) => a + f.capKw, 0);
}

/** 신규 건설 가능 여부 (유예 중인 사업권으로는 신규 건설 불가) */
export function canBuildRights(s: GameState, regionId: number, type: TypeId, capKw: number): string | null {
  const lt = REQUIRED_LICENSE[type];
  const active = licensesOf(s, regionId, lt, ['active']);
  if (active.length === 0) return `${LICENSE_NAMES[lt]}이 없습니다 (유예 중인 사업권으로는 신규 건설 불가)`;
  if (lt === 'GEN' || lt === 'STO') {
    const free = quotaKw(s, regionId, lt, ['active']) - quotaUsedKw(s, regionId, lt);
    if (capKw > free) return `${LICENSE_NAMES[lt]} 한도 부족 (남은 한도 ${(free / 1000).toFixed(0)} MW)`;
  }
  return null;
}

export function acquireLicense(s: GameState, regionId: number, type: LicenseType, size: SizeId) {
  const p = licensePrice(s, regionId, type, size);
  if (s.cash - s.reserved < p.priceMinor) return notify(s, 'error', `${LICENSE_NAMES[type]} 취득 거부: 자금 부족`);
  if ((type === 'TRN' || type === 'RET') && licensesOf(s, regionId, type, ['active', 'grace']).length > 0) {
    return notify(s, 'error', `${LICENSE_NAMES[type]}은 지역당 하나면 충분합니다`);
  }
  const l: License = {
    id: s.nextId++, regionId, type, size, quotaKw: p.quotaKw, priceMinor: p.priceMinor, feePerDayMinor: p.feePerDayMinor,
    expiresAt: s.step + LICENSE.termDays * STEPS_PER_DAY, state: 'active', autoRenew: true,
  };
  post(s, `lic:${l.id}`, 'license', 'cash', p.priceMinor, `${s.regions[regionId].name} ${LICENSE_NAMES[type]} 취득`);
  s.licenses.push(l);
  notify(s, 'info', `${s.regions[regionId].name} ${LICENSE_NAMES[type]} 취득 (${(p.priceMinor / 100).toLocaleString()} CR)`);
}

export function renewCost(s: GameState, l: License) {
  return Math.round(licensePrice(s, l.regionId, l.type, l.size).priceMinor * LICENSE.renewShare);
}

export function canRenew(s: GameState, l: License): boolean {
  if (l.state === 'grace') return true;
  if (l.state === 'expired') return false;
  return l.expiresAt - s.step <= LICENSE.alertDays[0] * STEPS_PER_DAY;
}

export function renewLicense(s: GameState, l: License) {
  if (!canRenew(s, l)) return notify(s, 'error', l.state === 'expired' ? '만료된 사업권은 갱신할 수 없습니다 (재취득 필요)' : '갱신은 만료 30일 전부터 가능합니다');
  const cost = renewCost(s, l);
  if (s.cash - s.reserved < cost) return notify(s, 'error', '갱신 거부: 자금 부족');
  post(s, txId(s, `renew:${l.id}`), 'license', 'cash', cost, `${LICENSE_NAMES[l.type]} 갱신`);
  l.expiresAt = Math.max(s.step, l.expiresAt) + LICENSE.termDays * STEPS_PER_DAY;
  l.state = 'active';
  notify(s, 'info', `${s.regions[l.regionId].name} ${LICENSE_NAMES[l.type]} 갱신 (${(cost / 100).toLocaleString()} CR)`);
}

// ---------- 토지 ----------

export function siteRentPerDay(s: GameState, regionId: number, type: TypeId, capKw: number) {
  const fp = FACILITY_TYPES[type].kind === 'substation' ? LAND.substationFootprintKw : capKw;
  return Math.max(1, Math.round((s.regions[regionId].landRentPerMwDayMinor * fp) / 1000));
}

export function newLease(s: GameState, regionId: number, type: TypeId, capKw: number): Land {
  const rent = siteRentPerDay(s, regionId, type, capKw);
  return { mode: 'lease', rentPerDayMinor: rent, depositMinor: rent * LAND.depositDays, expiresAt: s.step + LAND.termDays * STEPS_PER_DAY, state: 'active', purchaseMinor: 0 };
}

export const landBuyPrice = (land: Land) => land.rentPerDayMinor * LICENSE.termDays * LAND.buyYears;

export function renewLease(s: GameState, f: Facility) {
  const land = f.land;
  if (land.mode === 'own') return notify(s, 'error', '소유한 토지입니다');
  if (land.state === 'expired') return notify(s, 'error', '만료된 임대는 갱신할 수 없습니다 (시설을 매각·폐기하거나 토지를 매입하세요)');
  if (land.state === 'active' && land.expiresAt - s.step > LICENSE.alertDays[0] * STEPS_PER_DAY) return notify(s, 'error', '임대 갱신은 만료 30일 전부터 가능합니다');
  land.rentPerDayMinor = Math.round((land.rentPerDayMinor * (PPM + LAND.renewIncreasePpm)) / PPM);
  land.expiresAt = Math.max(s.step, land.expiresAt) + LAND.termDays * STEPS_PER_DAY;
  land.state = 'active';
  notify(s, 'info', `토지 임대 갱신: ${s.regions[f.regionId].name} 시설 #${f.id} (임대료 +10%)`);
}

export function buyLand(s: GameState, f: Facility) {
  if (f.land.mode === 'own') return notify(s, 'error', '이미 소유한 토지입니다');
  const price = landBuyPrice(f.land);
  if (s.cash - s.reserved < price) return notify(s, 'error', '토지 매입 거부: 자금 부족');
  post(s, `buyland:${f.id}:${s.step}`, 'land_asset', 'cash', price, `토지 매입 #${f.id}`);
  if (f.land.depositMinor) post(s, `deposit-back:${f.id}:${s.step}`, 'cash', 'land_asset', f.land.depositMinor, `임대 보증금 반환 #${f.id}`);
  f.land = { ...f.land, mode: 'own', purchaseMinor: price, depositMinor: 0, state: 'active' };
  notify(s, 'info', `토지 매입: 시설 #${f.id} (${(price / 100).toLocaleString()} CR, 이후 임대료 없음)`);
}

export function sellLand(s: GameState, f: Facility) {
  if (f.land.mode !== 'own') return notify(s, 'error', '소유한 토지가 아닙니다');
  const proceeds = Math.round(f.land.purchaseMinor * LAND.resaleShare);
  post(s, `sellland:${f.id}:${s.step}`, 'cash', 'land_asset', proceeds, `토지 매각(재임대) #${f.id}`);
  const lease = newLease(s, f.regionId, f.type, f.capKw);
  post(s, `deposit:${f.id}:${s.step}`, 'land_asset', 'cash', lease.depositMinor, `임대 보증금 #${f.id}`);
  f.land = lease;
  notify(s, 'info', `토지 매각 후 재임대: 시설 #${f.id}`);
}

// ---------- 매일: 수수료·임대료, 상태 전이, 알림, 운영 가능 판정 ----------

function transition(s: GameState, expiresAt: number, state: License['state'], name: string, autoHandled = false): License['state'] {
  const daysLeft = Math.ceil((expiresAt - s.step) / STEPS_PER_DAY);
  if (state === 'active') {
    // 자동 갱신이 처리할 항목은 만료 예정 알림을 생략한다 (알림 과부하 방지)
    if (LICENSE.alertDays.includes(daysLeft) && !autoHandled) notify(s, 'warn', `${name} 만료 ${daysLeft}일 전`);
    if (s.step >= expiresAt) { notify(s, 'warn', `${name} 만료 — 유예 ${LICENSE.graceDays}일 (신규 건설 불가)`); return 'grace'; }
  } else if (state === 'grace' && s.step >= expiresAt + LICENSE.graceDays * STEPS_PER_DAY) {
    notify(s, 'error', `${name} 유예 종료 — 관련 시설이 정지됩니다 (시설은 삭제되지 않음)`);
    return 'expired';
  }
  return state;
}

export function rightsDay(s: GameState, day: number) {
  for (const l of s.licenses) {
    l.state = transition(s, l.expiresAt, l.state, `${s.regions[l.regionId].name} ${LICENSE_NAMES[l.type]}`, s.automation.autoRenew && l.autoRenew);
    if (l.state !== 'expired') post(s, `D${day}:fee:${l.id}`, 'license', 'cash', l.feePerDayMinor, `사업권 기본 수수료 #${l.id}`);
  }
  // 사용량 수수료: 지역·유형별로 실제 지은 정격 MW에 비례 (운영 가능한 사업권이 있을 때)
  s.regions.forEach((_, ri) => {
    for (const lt of ['GEN', 'STO'] as const) {
      const fee = usageFeePerDay(s, ri, lt);
      if (fee > 0) post(s, `D${day}:usefee:${ri}:${lt}`, 'license', 'cash', fee, `${s.regions[ri].name} ${LICENSE_NAMES[lt]} 사용 수수료`);
    }
  });
  for (const f of s.facilities) {
    if (f.land.mode === 'lease') {
      f.land.state = transition(s, f.land.expiresAt, f.land.state, `${s.regions[f.regionId].name} 시설 #${f.id} 토지 임대`, s.automation.autoRenew);
      if (f.land.state !== 'expired') post(s, `D${day}:rent:${f.id}`, 'land', 'cash', f.land.rentPerDayMinor, `토지 임대료 #${f.id}`);
    }
  }
  updateRights(s);
}

/** 시설·선로의 운영 가능 여부 (사업권 한도는 오래된 시설부터 채운다) */
export function updateRights(s: GameState) {
  const quotaLeft = new Map<string, number>();
  for (const f of [...s.facilities].sort((a, b) => a.id - b.id)) {
    const lt = REQUIRED_LICENSE[f.type];
    const key = `${f.regionId}:${lt}`;
    if (!quotaLeft.has(key)) quotaLeft.set(key, lt === 'GEN' || lt === 'STO' ? quotaKw(s, f.regionId, lt) : licensesOf(s, f.regionId, lt).length ? Infinity : 0);
    const left = quotaLeft.get(key)!;
    const need = lt === 'GEN' || lt === 'STO' ? f.capKw : 1;
    const licOk = left >= need;
    if (licOk) quotaLeft.set(key, left - need);
    const landOk = f.land.mode === 'own' || f.land.state !== 'expired';
    const ok = licOk && landOk;
    if (f.rightsOk && !ok && f.status === 'operating') notify(s, 'error', `권리 상실로 정지: ${s.regions[f.regionId].name} ${FACILITY_TYPES[f.type].name} #${f.id}`);
    f.rightsOk = ok;
  }
  for (const l of s.lines) {
    const ok = licensesOf(s, l.a, 'TRN').length > 0 && licensesOf(s, l.b, 'TRN').length > 0;
    if (l.rightsOk && !ok && l.status === 'operating') notify(s, 'error', `송전 사업권 상실로 선로 정지: #${l.id}`);
    l.rightsOk = ok;
  }
}

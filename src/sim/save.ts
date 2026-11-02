// 저장·불러오기 (Baseline §29, §29.4). 스텝 경계에서만 호출된다.
// 마이그레이션: 버전별 변환 함수 체인. 미래 버전은 읽기를 거부한다.

import { HUB_BASE_KW, REGION_COUNT } from './data';
import { SCHEMA_VERSION, type GameState } from './sim';

export function stateHash(s: unknown): string {
  const text = JSON.stringify(s);
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193 + 2);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function serialize(s: GameState): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, hash: stateHash(s), state: s });
}

export class SaveError extends Error {}

/* eslint-disable @typescript-eslint/no-explicit-any */
const MIGRATIONS: Record<number, (s: any) => any> = {
  // v1 (P0) → v2 (P1): 송전선, 허브, 저장·고장 필드, 난수 상태 추가
  1: (s) => ({
    ...s,
    schemaVersion: 2,
    hubs: s.regions.map(() => ({ capKw: HUB_BASE_KW, health: { s: 'ok' } })),
    lines: [],
    nextLineId: 1,
    rng: (s.seed ^ 0x9e3779b9) >>> 0,
    lastDI: { genWh: 0, dischargeWh: 0, deliveredWh: 0, lineLossWh: 0, chargeWh: 0, curtailWh: 0, storageLossWh: 0 },
    facilities: s.facilities.map((f: any) => ({
      ...f, health: { s: 'ok' }, energyWh: 0, socWh: 0, dischargeAtMinor: 0, chargeAtMinor: 0, lastStorageWh: 0, hubAddKw: 0,
    })),
  }),
  // v2 (P1) → v3 (P2): 사업권·토지·대출·계약·연구·자동화·환경. 기존 시설은 계속 운영되도록 사업권과 임대를 부여한다.
  2: (s) => {
    const day = 1440;
    const regions = s.regions.map((r: any) => ({ accessPpm: 1_000_000, landRentPerMwDayMinor: 60_00, ...r }));
    let nextId = Math.max(s.nextFacilityId ?? 1, s.nextLineId ?? 1);
    const licenses: any[] = [];
    regions.forEach((_: any, ri: number) => {
      const here = s.facilities.filter((f: any) => f.regionId === ri);
      const gen = here.filter((f: any) => ['thermal', 'solar', 'wind'].includes(f.type)).reduce((a: number, f: any) => a + f.capKw, 0);
      const sto = here.filter((f: any) => f.type === 'storage').reduce((a: number, f: any) => a + f.capKw, 0);
      const trn = here.some((f: any) => f.type === 'substation') || s.lines.some((l: any) => l.a === ri || l.b === ri);
      const mk = (type: string, quotaKw: number) => licenses.push({ id: nextId++, regionId: ri, type, size: 'medium', quotaKw, priceMinor: 0, feePerDayMinor: 2_000_00, expiresAt: s.step + 120 * day, state: 'active', autoRenew: true });
      if (gen > 0) mk('GEN', gen);
      if (sto > 0) mk('STO', sto);
      if (trn) mk('TRN', 0);
    });
    const dayAcc: Record<string, any> = {};
    for (const k of Object.keys(s.dayAcc ?? {})) dayAcc[`f${k}`] = { revenue: s.dayAcc[k].revenue, cost: s.dayAcc[k].fuel, kind: 'market' };
    return {
      ...s, schemaVersion: 3, regions, dayAcc,
      rules: { preset: 'standard', scenario: 'A', m: { startCash: 1, loanRate: 1, capex: 1, opex: 1, demandGrowth: 1, volatility: 1, events: 1, research: 1, env: 1, regulation: 1 }, insolvency: 'bailout', startCashMinor: 1_500_000_00 },
      regionDyn: regions.map(() => ({ envDaily: [0], envPriceMult: 1, pendingReg: null, demandShock: null, supplyShock: null, priceSamples: [] })),
      facilities: s.facilities.map((f: any) => ({ ...f, effPpm: 900_000, rightsOk: true,
        land: { mode: 'lease', rentPerDayMinor: Math.max(1, Math.round((60_00 * (f.type === 'substation' ? 10_000 : f.capKw)) / 1000)), depositMinor: 0, expiresAt: s.step + 120 * day, state: 'active', purchaseMinor: 0 } })),
      lines: s.lines.map((l: any) => ({ ...l, rightsOk: true })),
      licenses, loans: [], offers: [], contracts: [],
      research: { done: [], active: [] },
      automation: { autoRenew: true, autoInspect: false, autoStorage: false, dailyBudgetMinor: 300_000_00, spentTodayMinor: 0, actionsToday: 0, keys: [], failures: {}, locks: {} },
      nextId,
      history: (s.history ?? []).map((h: any) => ({ ...h, netWorth: h.cash })),
      lastDI: { contractWh: 0, ...s.lastDI },
      fuelMult: 1, nextFuelMult: 1, insolvency: 'normal', arrearsSince: 0, restructureUntil: 0, bailouts: 0, everBorrowed: false,
      reliability: { obligation: [0], delivered: [0] }, completedContracts: 0, objectivesDone: {}, nextRegulationAt: s.step + 90 * day,
    };
  },
  // v3 → v4: 접속점(S-08), 모듈 확장, 시설 실적, 계획 건설, 긴급 알림, 지도 크기
  3: (s) => {
    const used = new Map<string, number>();
    const subs = s.facilities.filter((f: any) => f.type === 'substation' && f.status === 'operating');
    const facilities = s.facilities.map((f: any) => {
      let pointId = 0;
      if (f.type !== 'substation') {
        // 기존 시설을 기본 접속점부터 채우고, 넘치면 변전점에 붙인다
        const pts = [{ id: 0, cap: s.hubs[f.regionId].capKw }, ...subs.filter((x: any) => x.regionId === f.regionId).map((x: any) => ({ id: x.id, cap: x.hubAddKw }))];
        const fit = pts.find((p) => (used.get(`${f.regionId}:${p.id}`) ?? 0) + f.capKw <= p.cap) ?? pts[0];
        pointId = fit.id;
        used.set(`${f.regionId}:${pointId}`, (used.get(`${f.regionId}:${pointId}`) ?? 0) + f.capKw);
      }
      return { ...f, pointId, modules: 0, expansion: null, stats: { cur: { genWh: 0, soldWh: 0, contractWh: 0, revMinor: 0, fuelMinor: 0, opexMinor: 0, upDI: 0, di: 0 }, days: [], life: { genWh: 0, revMinor: 0, costMinor: 0, days: 0 } } };
    });
    return {
      ...s, schemaVersion: 4, facilities,
      contracts: s.contracts.map((c: any) => ({ ...c, alertAt: -1 })),
      rules: { ...s.rules, regionCount: s.regions.length ?? REGION_COUNT },
      plan: [], planPaused: false, planBlocked: null, noticeSeq: s.notices.length,
    };
  },
};

export function deserialize(text: string): GameState {
  let data: { schemaVersion: number; hash: string; state: any };
  try {
    data = JSON.parse(text);
  } catch {
    throw new SaveError('세이브 파일을 읽을 수 없습니다 (형식 오류).');
  }
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion > SCHEMA_VERSION) {
    throw new SaveError('더 새로운 버전에서 만든 세이브입니다. 파일은 그대로 보존됩니다.');
  }
  if (stateHash(data.state) !== data.hash) throw new SaveError('세이브 무결성 검사 실패 (해시 불일치).');
  let st = data.state;
  for (let v = data.schemaVersion; v < SCHEMA_VERSION; v++) {
    const m = MIGRATIONS[v];
    if (!m) throw new SaveError(`버전 ${v} 세이브를 변환할 수 없습니다.`);
    st = m(st);
  }
  return st as GameState;
}

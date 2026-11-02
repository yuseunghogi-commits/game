// 시뮬레이션 코어 진입점: 게임 생성, 스텝 진행, 게임일 처리.
// P0 시간·시장·건설·원장 / P1 전력망·저장·고장 / P2 사업권·토지·대출·계약·연구·자동화·환경·규제·사건.
// 하위 시스템은 각 모듈에 있다. 이 파일은 처리 순서를 정한다 (Baseline §3.6).

import {
  DIFFICULTY, ENV, FACILITY_TYPES, HUB_BASE_KW, LICENSE, OBJECTIVES, RESEARCH, START_CASH_MINOR, STAGES,
  REGION_COUNT, generateRegions, type Multipliers, type ScenarioId,
} from './data';
import { notify, post, record } from './core';
import { applyCommand, planDI } from './commands';
import { advanceExpansions, emptyStats, statsDay } from './ops';
import { contractsDay, offersDay, reliability } from './contracts';
import { processDI } from './dispatch';
import { envIndex, environmentDay, failuresDI, marketEventsDay } from './environment';
import { insolvencyDay, loanBalance, loansDay, netWorth } from './finance';
import { facilitySpec } from './geo';
import { demandKw, priceMinor, refSupplyTargetKw } from './market';
import { researchDay } from './research';
import { automationDay } from './automation';
import { acquireLicense, newLease, rightsDay, updateRights } from './rights';
import { STEPS_PER_DAY, STEPS_PER_DI, dayOf } from './units';
import type { Build, Facility, GameState, Rules } from './types';

export const SCHEMA_VERSION = 4;

export interface NewGameOptions {
  seed?: number;
  preset?: Rules['preset'];
  scenario?: ScenarioId;
  multipliers?: Partial<Multipliers>;
  startCashMinor?: number;
  insolvency?: Rules['insolvency'];
  regionCount?: number;
}

export function makeRules(o: NewGameOptions = {}): Rules {
  const preset = o.preset ?? 'standard';
  const base = DIFFICULTY[preset === 'custom' ? 'standard' : preset].m;
  const m = { ...base, ...(o.multipliers ?? {}) };
  const startCashMinor = o.startCashMinor ?? Math.round(START_CASH_MINOR * m.startCash);
  return { preset: o.multipliers || o.startCashMinor !== undefined ? 'custom' : preset, scenario: o.scenario ?? 'A', m, insolvency: o.insolvency ?? 'bailout', startCashMinor, regionCount: o.regionCount ?? REGION_COUNT };
}

/** 기록 분류 (Q55 B): 프리셋 난이도 + 기본 시나리오 + 게임 중 규칙 변경 없음 = 표준 규칙 */
export function isStandardRecord(s: GameState): boolean {
  return s.rules.preset !== 'custom' && s.rules.scenario !== 'custom' && (s.rules.regionCount ?? REGION_COUNT) === REGION_COUNT;
}

export function createGame(seedOrOpts: number | NewGameOptions = 20261101): GameState {
  const o: NewGameOptions = typeof seedOrOpts === 'number' ? { seed: seedOrOpts } : seedOrOpts;
  const seed = o.seed ?? 20261101;
  const rules = makeRules(o);
  const regions = generateRegions(seed, rules.regionCount);
  const s: GameState = {
    schemaVersion: SCHEMA_VERSION, seed, step: 0, cash: 0, reserved: 0, rules, regions,
    regionState: regions.map((r) => {
      const d = demandKw(r, 0);
      const ref = refSupplyTargetKw(r);
      return { refSupplyKw: ref, demandKw: d, priceMinor: priceMinor(r.pBaseMinor, ref, d), soldWh: 0, capWh: 0 };
    }),
    regionDyn: regions.map(() => ({ envDaily: [0], envPriceMult: 1, pendingReg: null, demandShock: null, supplyShock: null, priceSamples: [] })),
    hubs: regions.map(() => ({ capKw: HUB_BASE_KW, health: { s: 'ok' } })),
    facilities: [], lines: [], licenses: [], loans: [], offers: [], contracts: [],
    research: { done: [], active: [] },
    automation: { autoRenew: true, autoInspect: false, autoStorage: false, dailyBudgetMinor: 300_000_00, spentTodayMinor: 0, actionsToday: 0, keys: [], failures: {}, locks: {} },
    nextId: 1, commandSeq: 0, pending: [], ledger: [], dayAcc: {}, lastPostedDay: -1, dayStartCash: 0, history: [], notices: [],
    rng: (seed ^ 0x9e3779b9) >>> 0,
    lastDI: { genWh: 0, dischargeWh: 0, deliveredWh: 0, contractWh: 0, lineLossWh: 0, chargeWh: 0, curtailWh: 0, storageLossWh: 0 },
    fuelMult: 1, nextFuelMult: 1, insolvency: 'normal', arrearsSince: 0, restructureUntil: 0, bailouts: 0, everBorrowed: false,
    reliability: { obligation: [0], delivered: [0] }, completedContracts: 0, objectivesDone: {},
    nextRegulationAt: 90 * STEPS_PER_DAY,
    plan: [], planPaused: false, planBlocked: null, noticeSeq: 0,
  };
  post(s, 'init:capital', 'cash', 'equity', rules.startCashMinor, '초기 자본');
  setupScenario(s);
  offersDay(s, 0);
  s.dayStartCash = s.cash;
  notify(s, 'info', '회사 설립. 지역을 골라 사업권을 얻고 첫 발전소를 지으세요.');
  return s;
}

/** 시나리오 B·C의 시작 지역: 자원이 좋고 수요가 큰 곳 */
export function scenarioRegion(s: GameState): number {
  let best = 0, score = -1;
  s.regions.forEach((r, i) => {
    const sc = r.solar + r.wind + r.demandBaseKw / 400_000;
    if (sc > score) { score = sc; best = i; }
  });
  return best;
}

/** 시작 시나리오 (Q52 D, Q53 A): 자산을 가지면 그 가치만큼 현금이 줄어 순자산이 비슷하다 */
function setupScenario(s: GameState) {
  const sc = s.rules.scenario;
  if (sc !== 'B' && sc !== 'C') return;
  const ri = scenarioRegion(s);
  acquireLicense(s, ri, 'GEN', 'small');
  if (sc === 'C') {
    const spec = facilitySpec(s, 'thermal', 'small');
    const f: Facility = {
      id: s.nextId++, type: 'thermal', size: 'small', regionId: ri, capKw: spec.capKw, capexMinor: spec.capexMinor, fixedMinorPerDay: spec.fixedMinorPerDay,
      status: 'operating', stage: STAGES.length - 1, stageStep: 0, stageSteps: [0, 0, 0, 0, 0, 0], stageCosts: [0, 0, 0, 0, 0, spec.capexMinor],
      online: true, outputKw: 0, startDelay: 0, lastGenWh: 0, lastSoldWh: 0, health: { s: 'ok' }, energyWh: 0, socWh: 0, dischargeAtMinor: 0, chargeAtMinor: 0,
      lastStorageWh: 0, hubAddKw: 0, effPpm: 0, land: newLease(s, ri, 'thermal', spec.capKw), rightsOk: true,
      pointId: 0, modules: 0, expansion: null, stats: emptyStats(),
    };
    s.facilities.push(f);
    post(s, `init:plant:${f.id}`, 'capex', 'cash', spec.capexMinor, '시작 시설 취득');
    post(s, `deposit:${f.id}`, 'land_asset', 'cash', f.land.depositMinor, `토지 임대 보증금 #${f.id}`);
  }
  updateRights(s);
}

// ---------- 건설 진행 ----------

function advanceBuild(s: GameState, b: Build & { id: number; status: 'construction' | 'operating' }, tag: string, name: string, onDone: () => void) {
  if (b.status !== 'construction') return;
  if (b.stage === -1 || b.stageStep >= b.stageSteps[b.stage]) {
    if (b.stage === STAGES.length - 1) {
      b.status = 'operating';
      onDone();
      notify(s, 'info', `준공: ${name}`);
      return;
    }
    b.stage += 1;
    b.stageStep = 0;
    const cost = b.stageCosts[b.stage];
    s.reserved -= cost;
    post(s, `capex:${tag}:${b.id}:${b.stage}`, 'capex', 'cash', cost, `건설 ${STAGES[b.stage].name} #${b.id}`);
  }
  // 권리가 없으면 공사 중단 (진행률 보존, Baseline §12.13)
  if ('rightsOk' in b && !(b as { rightsOk: boolean }).rightsOk) return;
  b.stageStep += 1;
}

function advanceConstruction(s: GameState) {
  for (const f of s.facilities) advanceBuild(s, f, 'f', `${s.regions[f.regionId].name} ${FACILITY_TYPES[f.type].name}`, () => { f.startDelay = FACILITY_TYPES[f.type].startDelayDI; });
  advanceExpansions(s);
  for (const l of s.lines) advanceBuild(s, l, 'l', `${s.regions[l.a].name}–${s.regions[l.b].name} 송전선`, () => {});
}

// ---------- 게임일 ----------

function closeDayLedger(s: GameState, day: number) {
  for (const key of Object.keys(s.dayAcc).sort()) {
    const a = s.dayAcc[key];
    const isContract = a.kind === 'contract';
    record(s, `D${day}:rev:${key}`, 'cash', isContract ? 'revenue_contract' : 'revenue_market', a.revenue, isContract ? `계약 수익 ${key}` : `시장 판매 ${key}`);
    record(s, `D${day}:cost:${key}`, isContract ? 'penalty' : 'fuel', 'cash', a.cost, isContract ? `계약 위약금 ${key}` : `연료 ${key}`);
  }
  s.dayAcc = {};
}

/** 오래된 원장 거래를 월별 합계로 압축 (세이브 크기 제한). 현금 합계는 그대로. */
function compactLedger(s: GameState) {
  const cutoff = s.step - 60 * STEPS_PER_DAY;
  const old = s.ledger.filter((e) => e.step < cutoff && !e.id.startsWith('S'));
  if (old.length < 2000) return;
  const keep = s.ledger.filter((e) => !(e.step < cutoff && !e.id.startsWith('S')));
  const sums = new Map<string, { step: number; debit: typeof old[0]['debit']; credit: typeof old[0]['credit']; amount: number }>();
  for (const e of old) {
    const month = Math.floor(dayOf(e.step) / 30);
    const k = `S${month}:${e.debit}:${e.credit}`;
    const cur = sums.get(k) ?? { step: month * 30 * STEPS_PER_DAY, debit: e.debit, credit: e.credit, amount: 0 };
    cur.amount += e.amount;
    sums.set(k, cur);
  }
  const merged = new Map<string, number>();
  for (const e of keep) if (e.id.startsWith('S')) merged.set(e.id, s.ledger.indexOf(e));
  const out = keep.slice();
  for (const [id, v] of sums) {
    const existing = out.find((e) => e.id === id);
    if (existing) existing.amount += v.amount;
    else out.push({ id, step: v.step, debit: v.debit, credit: v.credit, amount: v.amount, memo: '월 합계 (압축)' });
  }
  out.sort((a, b) => a.step - b.step);
  s.ledger = out;
}

function objectivesDay(s: GameState, day: number) {
  const done = (id: string, ok: boolean) => { if (ok && s.objectivesDone[id] === undefined) { s.objectivesDone[id] = day; notify(s, 'info', `목표 달성: ${OBJECTIVES.find((o) => o.id === id)!.name}`); } };
  const genCap = s.facilities.filter((f) => f.status === 'operating' && FACILITY_TYPES[f.type].kind === 'gen').reduce((a, f) => a + f.capKw, 0);
  done('cap100', genCap >= 100_000);
  done('regions6', new Set(s.facilities.filter((f) => f.status === 'operating').map((f) => f.regionId)).size >= 6);
  done('lines5', s.lines.filter((l) => l.status === 'operating').length >= 5);
  done('contracts5', s.completedContracts >= 5);
  const rel = reliability(s);
  done('reliability', rel !== null && rel >= 0.99 && s.reliability.obligation.length >= 30 && s.contracts.filter((c) => !c.done).length >= 3);
  const branches = new Set(RESEARCH.map((r) => r.branch));
  done('research', [...branches].some((b) => RESEARCH.filter((r) => r.branch === b).every((r) => s.research.done.includes(r.id))));
  done('green', genCap >= 100_000 && s.regions.every((_, i) => envIndex(s, i) < ENV.warnLevelPpm / 1e6));
  done('debt', s.everBorrowed && netWorth(s) > 0 && loanBalance(s) / Math.max(1, netWorth(s)) <= 0.3);
}

function processDayEnd(s: GameState) {
  const day = dayOf(s.step) - 1;
  if (day <= s.lastPostedDay) return; // 재처리 방지
  closeDayLedger(s, day);
  // 의무 비용 순서 (Baseline §17.6): 유지비 → (연료·위약금은 DI에서) → 임대료·수수료 → 대출 → 환경
  for (const f of s.facilities) if (f.status === 'operating') post(s, `D${day}:opex:${f.id}`, 'opex', 'cash', f.fixedMinorPerDay, `유지비 #${f.id}`);
  for (const l of s.lines) if (l.status === 'operating') post(s, `D${day}:opexL:${l.id}`, 'opex', 'cash', Math.round(l.capexMinor / 1000), `선로 유지비 #${l.id}`);
  rightsDay(s, day);
  loansDay(s, day);
  environmentDay(s, day);
  researchDay(s, day);
  contractsDay(s);
  offersDay(s, day + 1);
  marketEventsDay(s, day + 1);
  insolvencyDay(s);
  automationDay(s, day);
  objectivesDay(s, day);
  statsDay(s);
  const rel = s.reliability;
  rel.obligation.push(0); rel.delivered.push(0);
  if (rel.obligation.length > 30) { rel.obligation.shift(); rel.delivered.shift(); }
  s.lastPostedDay = day;
  s.history.push({ day, netMinor: s.cash - s.dayStartCash, cash: s.cash, netWorth: netWorth(s) });
  if (s.history.length > 120) s.history.shift();
  s.dayStartCash = s.cash;
  if ((day + 1) % 30 === 0) compactLedger(s);
  for (const k of Object.keys(s.automation.locks)) if (s.automation.locks[k] >= 0 && s.automation.locks[k] < s.step) delete s.automation.locks[k];
}

// ---------- 메인 스텝 ----------

/** 1 스텝(게임 1분). 순서: 명령 → 건설 → (DI) 배분·정산 → 사건 판정 → (일) 원장·비용·권리·대출·환경·연구·계약·자동화 */
export function step(s: GameState) {
  if (s.insolvency === 'liquidated') return; // 청산된 회사는 더 진행하지 않는다
  if (s.pending.length) {
    const cmds = s.pending.sort((a, b) => a.seq - b.seq);
    s.pending = [];
    for (const c of cmds) applyCommand(s, c.cmd, c.auto);
  }
  advanceConstruction(s);
  s.step += 1;
  if (s.step % STEPS_PER_DI === 0) {
    processDI(s);
    failuresDI(s); // 판정은 배분 뒤 → 효과는 다음 DI부터 (Baseline §3.6)
    planDI(s); // 계획 건설: 정산 뒤 자금 기준으로 승인
  }
  if (s.step % STEPS_PER_DAY === 0) processDayEnd(s);
}

/** 대기 중인 명령을 지금 스텝 경계에서 적용한다 (일시정지 중 UI 반응용).
 *  step()도 맨 앞에서 같은 일을 하므로, 미리 적용해도 결과는 같다. */
export function flushCommands(s: GameState) {
  if (!s.pending.length || s.insolvency === 'liquidated') return;
  const cmds = s.pending.sort((a, b) => a.seq - b.seq);
  s.pending = [];
  for (const c of cmds) applyCommand(s, c.cmd, c.auto);
}

export function advance(s: GameState, steps: number) {
  for (let i = 0; i < steps; i++) step(s);
}

void LICENSE;

// ---------- 다시 내보내기 (UI·테스트용) ----------
export { addCapital, availableCash, healthLabel, issue, ledgerCash, pendingCash } from './core';
export { cancelRefund, buildCheck, lineCheck, underConstruction, planCheck, planCost } from './commands';
export { expandCheck, expansionSpec, rushCheck, rushCost } from './ops';
export { connectionPoints, bestPointFreeKw } from './hub';
export { distanceKm, facilitySpec, lineSpec, neighbors } from './geo';
export { hubCapacityKw, hubUsedKw } from './hub';
export { solarPpm, windPpm } from './output';
export { netWorth, creditLimit, loanBalance, saleValue, disposeCost, upcomingObligations, annuityPayment, removalBlocked } from './finance';
export { licensePrice, licensesOf, quotaKw, quotaUsedKw, renewCost, canRenew, landBuyPrice, usageFeePerDay } from './rights';
export { reliability, supplyHeadroomKw, activeContracts } from './contracts';
export { envIndex, envPriceMinor } from './environment';
export { mods, researchCost, canStart, has as hasResearch } from './research';
export { recommendations } from './automation';
export type * from './types';

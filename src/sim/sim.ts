// 시뮬레이션 코어 (P0 + P1).
// P0: 시간, 지역 수요, 시장 가격, 발전, 판매 한도, 정산, 원장, 단계별 건설, 명령, 알림.
// P1: 지역 간 송전선·손실·병목, 접속 용량·변전소, 배터리 저장, 고장(전조 → 고장 → 자동 복구), 정전 알림.
// 범위 밖 (P2): 사업권·토지·대출·계약·자동화·연구.

import {
  COMMISSIONING_STAGE, EVENTS, FACILITY_TYPES, HUB_BASE_KW, LINE, MARKET, PLANET_RADIUS_KM, STAGES,
  START_CASH_MINOR, STORAGE_EFF_PPM, generateRegions, specOf,
  type RegionDef, type SizeId, type TypeId,
} from './data';
import { allocate, type Edge, type Sink, type Unit } from './grid';
import { demandKw, localMinute, priceMinor, refSupplyTargetKw, smoothToward } from './market';
import { PPM, STEPS_PER_DAY, STEPS_PER_DI, WH_PER_KW_PER_DI, dayOf, moneyFor, roundHalfEven, splitByWeights } from './units';

export const SCHEMA_VERSION = 2;

export type Account =
  | 'cash' | 'equity' | 'revenue_market' | 'fuel' | 'opex' | 'capex' | 'refund' | 'repair';

export interface LedgerEntry { id: string; step: number; debit: Account; credit: Account; amount: number; memo: string }

/** 고장 상태 (Baseline §24.3): 정상 → 점검 필요(고장 전조) → 고장(복구 중) / 점검 중 */
export type Health =
  | { s: 'ok' }
  | { s: 'warning'; failAt: number }
  | { s: 'failed'; until: number }
  | { s: 'inspection'; until: number };

export interface Build { stage: number; stageStep: number; stageSteps: number[]; stageCosts: number[] }

export interface Facility extends Build {
  id: number;
  type: TypeId;
  size: SizeId;
  regionId: number;
  capKw: number;
  capexMinor: number;
  fixedMinorPerDay: number;
  status: 'construction' | 'operating';
  online: boolean;
  outputKw: number;
  startDelay: number;
  lastGenWh: number;
  lastSoldWh: number;
  health: Health;
  /** 저장 전용 */
  energyWh: number;
  socWh: number;
  /** 저장: 이 가격 이상이면 방전, 이하이면 자기 발전으로 충전 (minor/MWh) */
  dischargeAtMinor: number;
  chargeAtMinor: number;
  lastStorageWh: number; // +충전 입력 / −방전 출력
  hubAddKw: number;
}

export interface Line extends Build {
  id: number;
  a: number;
  b: number;
  size: SizeId;
  capKw: number;
  lengthKm: number;
  lossPpm: number;
  capexMinor: number;
  status: 'construction' | 'operating';
  health: Health;
  lastDir: 0 | 1 | -1;
  lastSentWh: number;
  lastLossWh: number;
}

export interface Hub { capKw: number; health: Health }

export interface RegionState { refSupplyKw: number; demandKw: number; priceMinor: number; soldWh: number; capWh: number }

export type Command =
  | { kind: 'build'; regionId: number; type: TypeId; size: SizeId }
  | { kind: 'buildLine'; a: number; b: number; size: SizeId }
  | { kind: 'cancel'; facilityId: number }
  | { kind: 'cancelLine'; lineId: number }
  | { kind: 'setOnline'; facilityId: number; online: boolean }
  | { kind: 'inspect'; target: 'facility' | 'line' | 'hub'; id: number }
  | { kind: 'setStorage'; facilityId: number; dischargeAtMinor: number; chargeAtMinor: number };

export interface Notice { step: number; level: 'info' | 'warn' | 'error'; text: string }
export interface DayAcc { revenue: number; fuel: number; genWh: number; soldWh: number }

export interface DIStats { genWh: number; dischargeWh: number; deliveredWh: number; lineLossWh: number; chargeWh: number; curtailWh: number; storageLossWh: number }

export interface GameState {
  schemaVersion: number;
  seed: number;
  step: number;
  cash: number;
  reserved: number;
  regions: RegionDef[];
  regionState: RegionState[];
  hubs: Hub[];
  facilities: Facility[];
  lines: Line[];
  nextFacilityId: number;
  nextLineId: number;
  commandSeq: number;
  pending: { seq: number; cmd: Command }[];
  ledger: LedgerEntry[];
  dayAcc: Record<number, DayAcc>;
  lastPostedDay: number;
  dayStartCash: number;
  history: { day: number; netMinor: number; cash: number }[];
  notices: Notice[];
  rng: number;
  lastDI: DIStats;
}

// ---------- 지형 기반 파생 값 ----------

export function distanceKm(a: RegionDef, b: RegionDef): number {
  const r = Math.PI / 180;
  const c = Math.sin(a.lat * r) * Math.sin(b.lat * r) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.cos((a.lon - b.lon) * r);
  return Math.round(Math.acos(Math.min(1, Math.max(-1, c))) * PLANET_RADIUS_KM);
}

/** 이웃 지역 (가장 가까운 3곳, 대칭). 송전선은 이웃끼리만 (MVP). */
export function neighbors(regions: RegionDef[]): number[][] {
  const n = regions.map(() => new Set<number>());
  regions.forEach((r, i) => {
    regions.map((q, j) => ({ j, d: i === j ? Infinity : distanceKm(r, q) }))
      .sort((x, y) => x.d - y.d || x.j - y.j).slice(0, 3)
      .forEach(({ j }) => { n[i].add(j); n[j].add(i); });
  });
  return n.map((s) => [...s].sort((x, y) => x - y));
}

export function lineSpec(regions: RegionDef[], a: number, b: number, size: SizeId) {
  const lengthKm = distanceKm(regions[a], regions[b]);
  return {
    lengthKm,
    capKw: LINE.capKw[size],
    lossPpm: Math.min(LINE.lossMaxPpm, LINE.lossPpmPerKm * lengthKm),
    capexMinor: LINE.fixedCost + LINE.costPerKm[size] * lengthKm,
    buildDays: LINE.buildDays[size],
  };
}

// ---------- 생성 ----------

export function createGame(seed = 20261101): GameState {
  const regions = generateRegions(seed);
  const s: GameState = {
    schemaVersion: SCHEMA_VERSION,
    seed,
    step: 0,
    cash: 0,
    reserved: 0,
    regions,
    regionState: regions.map((r) => {
      const d = demandKw(r, 0);
      const ref = refSupplyTargetKw(r);
      return { refSupplyKw: ref, demandKw: d, priceMinor: priceMinor(r.pBaseMinor, ref, d), soldWh: 0, capWh: 0 };
    }),
    hubs: regions.map(() => ({ capKw: HUB_BASE_KW, health: { s: 'ok' } })),
    facilities: [],
    lines: [],
    nextFacilityId: 1,
    nextLineId: 1,
    commandSeq: 0,
    pending: [],
    ledger: [],
    dayAcc: {},
    lastPostedDay: -1,
    dayStartCash: 0,
    history: [],
    notices: [],
    rng: (seed ^ 0x9e3779b9) >>> 0,
    lastDI: { genWh: 0, dischargeWh: 0, deliveredWh: 0, lineLossWh: 0, chargeWh: 0, curtailWh: 0, storageLossWh: 0 },
  };
  post(s, 'init:capital', 'cash', 'equity', START_CASH_MINOR, '초기 자본');
  s.dayStartCash = s.cash;
  notify(s, 'info', '회사 설립. 지역을 골라 첫 발전소를 지으세요.');
  return s;
}

// ---------- 난수 (결정적, 세이브에 상태 저장) ----------

function rand(s: GameState): number {
  let t = (s.rng = (s.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randDays = (s: GameState, [lo, hi]: [number, number]) => lo + Math.floor(rand(s) * (hi - lo + 1));

// ---------- 원장 ----------

function post(s: GameState, id: string, debit: Account, credit: Account, amount: number, memo: string): boolean {
  if (amount === 0) return false;
  if (s.ledger.some((e) => e.id === id)) return false; // 중복 거래 방지
  s.ledger.push({ id, step: s.step, debit, credit, amount, memo });
  if (debit === 'cash') s.cash += amount;
  if (credit === 'cash') s.cash -= amount;
  return true;
}

/** 자본 투입 (샌드박스 사용자 지정 시작·테스트용). 원장에 기록된다. */
export function addCapital(s: GameState, amount: number, memo = '자본 투입') {
  post(s, `capital:${s.step}:${s.ledger.length}`, 'cash', 'equity', amount, memo);
}

export function ledgerCash(s: GameState): number {
  let c = 0;
  for (const e of s.ledger) {
    if (e.debit === 'cash') c += e.amount;
    if (e.credit === 'cash') c -= e.amount;
  }
  return c;
}

export function pendingCash(s: GameState): number {
  let c = 0;
  for (const k in s.dayAcc) c += s.dayAcc[k].revenue - s.dayAcc[k].fuel;
  return c;
}

function notify(s: GameState, level: Notice['level'], text: string) {
  s.notices.push({ step: s.step, level, text });
  if (s.notices.length > 80) s.notices.splice(0, s.notices.length - 80);
}

// ---------- 접속 용량 ----------

/** 지역 허브 접속 용량 (기본 + 운영 중 변전소) */
export function hubCapacityKw(s: GameState, regionId: number): number {
  return s.hubs[regionId].capKw + s.facilities
    .filter((f) => f.regionId === regionId && f.type === 'substation' && f.status === 'operating')
    .reduce((a, f) => a + f.hubAddKw, 0);
}

/** 접속 용량 사용량: 발전·저장 정격 합계 (건설 중 포함 — 접속 예약) */
export function hubUsedKw(s: GameState, regionId: number): number {
  return s.facilities
    .filter((f) => f.regionId === regionId && FACILITY_TYPES[f.type].kind !== 'substation')
    .reduce((a, f) => a + f.capKw, 0);
}

// ---------- 명령 ----------

export function issue(s: GameState, cmd: Command): number {
  s.commandSeq += 1;
  s.pending.push({ seq: s.commandSeq, cmd });
  return s.commandSeq;
}

export function availableCash(s: GameState): number {
  return s.cash - s.reserved;
}

function newBuild(capex: number, days: number): Build {
  return {
    stage: -1,
    stageStep: 0,
    stageSteps: splitByWeights(days * STEPS_PER_DAY, STAGES.map((x) => x.time)),
    stageCosts: splitByWeights(capex, STAGES.map((x) => x.cost)),
  };
}

function healthLabel(h: Health): string {
  return h.s === 'ok' ? '정상' : h.s === 'warning' ? '점검 필요' : h.s === 'failed' ? '고장' : '점검 중';
}

function lineName(s: GameState, l: Line) {
  return `${s.regions[l.a].name}–${s.regions[l.b].name} 송전선`;
}

function facName(s: GameState, f: Facility) {
  return `${s.regions[f.regionId].name} ${FACILITY_TYPES[f.type].name}`;
}

function repairCost(kind: 'facility' | 'line' | 'hub', capex: number): number {
  if (kind === 'hub') return EVENTS.hubRepairMinor;
  return Math.round((capex * EVENTS.repairPpm[kind]) / PPM);
}

function applyCommand(s: GameState, cmd: Command) {
  switch (cmd.kind) {
    case 'build': {
      const region = s.regions[cmd.regionId];
      if (!region) return notify(s, 'error', '건설 거부: 존재하지 않는 지역');
      const def = FACILITY_TYPES[cmd.type];
      const spec = specOf(cmd.type, cmd.size);
      if (availableCash(s) < spec.capexMinor) return notify(s, 'error', `건설 거부 (${region.name}): 사용 가능 자금 부족`);
      if (def.kind !== 'substation' && hubUsedKw(s, cmd.regionId) + spec.capKw > hubCapacityKw(s, cmd.regionId)) {
        return notify(s, 'error', `건설 거부 (${region.name}): 접속 용량 부족 — 변전소를 지으세요`);
      }
      const f: Facility = {
        id: s.nextFacilityId++,
        type: cmd.type,
        size: cmd.size,
        regionId: cmd.regionId,
        capKw: def.kind === 'substation' ? 0 : spec.capKw,
        capexMinor: spec.capexMinor,
        fixedMinorPerDay: spec.fixedMinorPerDay,
        status: 'construction',
        ...newBuild(spec.capexMinor, spec.buildDays),
        online: true,
        outputKw: 0,
        startDelay: 0,
        lastGenWh: 0,
        lastSoldWh: 0,
        health: { s: 'ok' },
        energyWh: spec.energyWh,
        socWh: 0,
        dischargeAtMinor: Math.round(region.pBaseMinor * 1.1),
        chargeAtMinor: Math.round(region.pBaseMinor * 0.95),
        lastStorageWh: 0,
        hubAddKw: spec.hubAddKw,
      };
      s.facilities.push(f);
      s.reserved += spec.capexMinor;
      notify(s, 'info', `건설 승인: ${region.name} ${def.name} (${spec.buildDays}일)`);
      return;
    }
    case 'buildLine': {
      const nb = neighbors(s.regions);
      if (cmd.a === cmd.b || !nb[cmd.a]?.includes(cmd.b)) return notify(s, 'error', '송전선 거부: 이웃 지역끼리만 연결할 수 있습니다');
      const spec = lineSpec(s.regions, cmd.a, cmd.b, cmd.size);
      if (availableCash(s) < spec.capexMinor) return notify(s, 'error', '송전선 거부: 사용 가능 자금 부족');
      const l: Line = {
        id: s.nextLineId++,
        a: Math.min(cmd.a, cmd.b),
        b: Math.max(cmd.a, cmd.b),
        size: cmd.size,
        capKw: spec.capKw,
        lengthKm: spec.lengthKm,
        lossPpm: spec.lossPpm,
        capexMinor: spec.capexMinor,
        status: 'construction',
        ...newBuild(spec.capexMinor, spec.buildDays),
        health: { s: 'ok' },
        lastDir: 0,
        lastSentWh: 0,
        lastLossWh: 0,
      };
      s.lines.push(l);
      s.reserved += spec.capexMinor;
      notify(s, 'info', `건설 승인: ${lineName(s, l)} (${spec.buildDays}일, 손실 ${(spec.lossPpm / 10_000).toFixed(1)}%)`);
      return;
    }
    case 'cancel':
    case 'cancelLine': {
      const target: (Build & { id: number; status: string }) | undefined =
        cmd.kind === 'cancel' ? s.facilities.find((x) => x.id === cmd.facilityId) : s.lines.find((x) => x.id === cmd.lineId);
      if (!target || target.status !== 'construction') return notify(s, 'error', '취소 거부: 건설 중인 대상이 아님');
      const r = cancelRefund(target);
      s.reserved -= r.releaseReserve;
      post(s, `cancel:${cmd.kind}:${target.id}`, 'cash', 'refund', r.cashRefund, `건설 취소 환불 #${target.id}`);
      if (cmd.kind === 'cancel') s.facilities = s.facilities.filter((x) => x.id !== target.id);
      else s.lines = s.lines.filter((x) => x.id !== target.id);
      notify(s, 'info', `건설 취소: 환불 ${(r.cashRefund / 100).toLocaleString()} CR`);
      return;
    }
    case 'setOnline': {
      const f = s.facilities.find((x) => x.id === cmd.facilityId);
      if (!f) return notify(s, 'error', '명령 거부: 시설 없음');
      if (f.online === cmd.online) return;
      f.online = cmd.online;
      if (cmd.online) f.startDelay = FACILITY_TYPES[f.type].startDelayDI;
      else f.outputKw = 0;
      return;
    }
    case 'setStorage': {
      const f = s.facilities.find((x) => x.id === cmd.facilityId && x.type === 'storage');
      if (!f) return notify(s, 'error', '명령 거부: 저장시설 없음');
      if (cmd.chargeAtMinor >= cmd.dischargeAtMinor) return notify(s, 'error', '거부: 충전 기준 가격은 방전 기준 가격보다 낮아야 합니다');
      f.dischargeAtMinor = Math.max(0, cmd.dischargeAtMinor);
      f.chargeAtMinor = Math.max(0, cmd.chargeAtMinor);
      return;
    }
    case 'inspect': {
      const t = cmd.target === 'facility' ? s.facilities.find((x) => x.id === cmd.id)
        : cmd.target === 'line' ? s.lines.find((x) => x.id === cmd.id)
        : s.hubs[cmd.id];
      if (!t || t.health.s !== 'warning') return notify(s, 'error', '점검 거부: 점검이 필요한 상태가 아님');
      const capex = cmd.target === 'hub' ? 0 : (t as Facility | Line).capexMinor;
      const cost = Math.round(repairCost(cmd.target, capex) * EVENTS.inspectionShare);
      post(s, `inspect:${cmd.target}:${cmd.id}:${s.step}`, 'repair', 'cash', cost, '예방 점검');
      t.health = { s: 'inspection', until: s.step + STEPS_PER_DAY };
      notify(s, 'info', `예방 점검 시작 (1일, ${(cost / 100).toLocaleString()} CR)`);
      return;
    }
  }
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
  b.stageStep += 1;
}

function advanceConstruction(s: GameState) {
  for (const f of s.facilities) {
    advanceBuild(s, f, 'f', facName(s, f), () => { f.startDelay = FACILITY_TYPES[f.type].startDelayDI; });
  }
  for (const l of s.lines) advanceBuild(s, l, 'l', lineName(s, l), () => {});
}

// ---------- 출력 계수 ----------

function hash2(a: number, b: number): number {
  let h = (Math.imul(a, 2654435761) ^ Math.imul(b, 1597334677)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967295;
}

export function solarPpm(r: RegionDef, step: number): number {
  const m = localMinute(r, step);
  const x = (m - 360) / 720;
  if (x <= 0 || x >= 1) return 0;
  const sun = Math.sin(Math.PI * x);
  const resource = 0.45 + 0.11 * r.solar;
  const latF = Math.cos((r.lat * Math.PI) / 180);
  return Math.floor(sun * resource * latF * PPM);
}

export function windPpm(r: RegionDef, seed: number, step: number): number {
  const knot = Math.floor(step / 360);
  const t = (step % 360) / 360;
  const a = hash2(knot, r.id * 7919 + seed);
  const b = hash2(knot + 1, r.id * 7919 + seed);
  const u = t * t * (3 - 2 * t);
  const v = a + (b - a) * u;
  const base = 0.08 + 0.09 * r.wind;
  return Math.floor(Math.min(1, v * base * 1.25) * PPM);
}

// ---------- 고장·복구 (Baseline §24.3, §25) ----------

const isUp = (h: Health) => h.s === 'ok' || h.s === 'warning';

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

/** DI마다 1회. 고장 전조 판정 → 예정 시각에 고장 → 자동 복구. 순서는 ID 순으로 고정 (결정론). */
function processEvents(s: GameState) {
  const perDI = 1 / (120 * 96);
  for (const f of s.facilities) {
    if (f.status !== 'operating') continue;
    if (f.health.s === 'ok' && rand(s) < EVENTS.facilityWarnPerYear * perDI) {
      const lead = randDays(s, EVENTS.warnLeadDays);
      f.health = { s: 'warning', failAt: s.step + lead * STEPS_PER_DAY };
      notify(s, 'warn', `점검 필요: ${facName(s, f)} — ${lead}일 안에 고장 예상`);
    }
    f.health = progressHealth(s, f.health, facName(s, f), () => ({ days: randDays(s, EVENTS.repairDays.facility as [number, number]), cost: repairCost('facility', f.capexMinor) }));
  }
  for (const l of s.lines) {
    if (l.status !== 'operating') continue;
    if (l.health.s === 'ok' && rand(s) < EVENTS.linePerYearPer1000Km * (l.lengthKm / 1000) * perDI) {
      const lead = randDays(s, EVENTS.warnLeadDays);
      l.health = { s: 'warning', failAt: s.step + lead * STEPS_PER_DAY };
      notify(s, 'warn', `점검 필요: ${lineName(s, l)} — ${lead}일 안에 고장 예상`);
    }
    l.health = progressHealth(s, l.health, lineName(s, l), () => ({ days: randDays(s, EVENTS.repairDays.line as [number, number]), cost: repairCost('line', l.capexMinor) }));
  }
  s.hubs.forEach((h, i) => {
    const active = s.facilities.some((f) => f.regionId === i && f.status === 'operating');
    if (!active) return;
    const name = `${s.regions[i].name} 접속점`;
    if (h.health.s === 'ok' && rand(s) < EVENTS.hubPerYear * perDI) {
      const lead = randDays(s, EVENTS.warnLeadDays);
      h.health = { s: 'warning', failAt: s.step + lead * STEPS_PER_DAY };
      notify(s, 'warn', `점검 필요: ${name} — ${lead}일 안에 고장 예상`);
    }
    h.health = progressHealth(s, h.health, name, () => ({ days: randDays(s, EVENTS.repairDays.hub as [number, number]), cost: repairCost('hub', 0) }));
  });
}

// ---------- 정산 구간 (DI) ----------

function processDI(s: GameState) {
  const effPpm = STORAGE_EFF_PPM;
  // 1 수요·가격
  s.regions.forEach((r, ri) => {
    const rs = s.regionState[ri];
    rs.refSupplyKw = smoothToward(rs.refSupplyKw, refSupplyTargetKw(r));
    rs.demandKw = demandKw(r, s.step);
    rs.priceMinor = priceMinor(r.pBaseMinor, rs.refSupplyKw, rs.demandKw);
    rs.capWh = s.hubs[ri].health.s === 'failed' ? 0 : Math.floor((rs.demandKw * MARKET.sigmaPpm) / PPM) * WH_PER_KW_PER_DI;
  });

  // 2 공급원 (발전 가용량, 저장 방전)과 수요처 (시장, 저장 충전)
  const units: Unit[] = [];
  const sinks: Sink[] = s.regions.map((_, ri) => ({ key: `m${ri}`, node: ri, capWh: s.regionState[ri].capWh, value: s.regionState[ri].priceMinor }));
  const mustRun = new Map<number, number>();
  const genAvail = new Map<number, number>();
  const hubUp = (ri: number) => s.hubs[ri].health.s !== 'failed';

  for (const f of s.facilities) {
    const def = FACILITY_TYPES[f.type];
    f.lastGenWh = 0; f.lastSoldWh = 0; f.lastStorageWh = 0;
    const producing = (f.status === 'operating' || f.stage === COMMISSIONING_STAGE) && def.kind !== 'substation';
    if (!producing) continue;
    const up = isUp(f.health) && hubUp(f.regionId) && f.online;
    if (!up) { f.outputKw = 0; continue; }
    if (f.startDelay > 0) { f.startDelay -= 1; f.outputKw = 0; continue; }
    const maxKw = f.status === 'construction' ? Math.floor(f.capKw / 2) : f.capKw;

    if (def.kind === 'storage') {
      if (f.status !== 'operating') continue;
      const price = s.regionState[f.regionId].priceMinor;
      const powerWh = maxKw * WH_PER_KW_PER_DI;
      if (price >= f.dischargeAtMinor) {
        const avail = Math.min(powerWh, Math.floor((f.socWh * effPpm) / PPM));
        if (avail > 0) units.push({ key: `d${f.id}`, node: f.regionId, availWh: avail, cost: f.dischargeAtMinor });
      } else {
        const room = Math.min(powerWh, Math.floor(((f.energyWh - f.socWh) * PPM) / effPpm));
        // 자기 발전(다른 지역에서 송전된 것 포함)으로만 충전한다. 시장에서 사서 충전하지 않는다.
        if (room > 0) sinks.push({ key: `c${f.id}`, node: f.regionId, capWh: room, value: f.chargeAtMinor });
      }
      continue;
    }

    let availKw: number;
    let minKw = 0;
    if (def.dispatchable) {
      const ramp = Math.floor((f.capKw * def.rampPpmPerDI) / PPM);
      const baseMin = Math.floor((maxKw * def.minOutputPpm) / PPM);
      const prev = f.outputKw === 0 ? baseMin : f.outputKw;
      availKw = Math.min(maxKw, prev + ramp);
      minKw = Math.max(baseMin, Math.min(availKw, prev - ramp));
    } else {
      const ppm = f.type === 'solar' ? solarPpm(s.regions[f.regionId], s.step - 1) : windPpm(s.regions[f.regionId], s.seed, s.step - 1);
      availKw = Math.floor((maxKw * ppm) / PPM);
    }
    const availWh = availKw * WH_PER_KW_PER_DI;
    genAvail.set(f.id, availWh);
    mustRun.set(f.id, minKw * WH_PER_KW_PER_DI);
    if (availWh > 0) units.push({ key: `g${f.id}`, node: f.regionId, availWh, cost: def.fuelMinorPerMWh });
  }
  units.sort((a, b) => a.cost - b.cost || (a.key < b.key ? -1 : 1));

  const edges: Edge[] = s.lines.filter((l) => l.status === 'operating').map((l) => ({
    id: l.id, a: l.a, b: l.b, capWh: l.capKw * WH_PER_KW_PER_DI, lossPpm: l.lossPpm,
    usable: isUp(l.health) && hubUp(l.a) && hubUp(l.b),
  }));

  // 3 배분
  const res = allocate(s.regions.length, units, sinks, edges);

  // 4 결과 반영
  const st: DIStats = { genWh: 0, dischargeWh: 0, deliveredWh: 0, lineLossWh: 0, chargeWh: 0, curtailWh: 0, storageLossWh: 0 };
  const surplus = new Map<number, number>(); // 지역별 판매되지 않은 발전 (저장 충전 또는 출력 제한)
  const fuelByFac = new Map<number, number>();
  for (const f of s.facilities) {
    const used = res.unitUsed.get(`g${f.id}`) ?? 0;
    const avail = genAvail.get(f.id);
    if (avail === undefined) continue;
    const def = FACILITY_TYPES[f.type];
    let gen: number;
    if (def.dispatchable) {
      gen = Math.max(used, mustRun.get(f.id) ?? 0); // 최소 출력은 반드시 발전
      f.outputKw = Math.floor(gen / WH_PER_KW_PER_DI);
    } else {
      gen = avail; // 재생에너지는 가용량 전부 발전, 못 판 양은 잉여
      f.outputKw = Math.floor(gen / WH_PER_KW_PER_DI);
    }
    f.lastGenWh = gen;
    st.genWh += gen;
    if (gen > used) surplus.set(f.regionId, (surplus.get(f.regionId) ?? 0) + (gen - used));
    fuelByFac.set(f.id, moneyFor(gen, def.fuelMinorPerMWh));
  }

  // 판매 수익: 흐름별로 수요처 가격 × 수전량 → 공급원에 귀속
  const revByUnit = new Map<string, number>();
  const soldByUnit = new Map<string, number>();
  for (const fl of res.flows) {
    if (fl.sink.startsWith('m')) {
      const ri = Number(fl.sink.slice(1));
      revByUnit.set(fl.unit, (revByUnit.get(fl.unit) ?? 0) + moneyFor(fl.deliveredWh, s.regionState[ri].priceMinor));
      soldByUnit.set(fl.unit, (soldByUnit.get(fl.unit) ?? 0) + fl.deliveredWh);
    }
  }
  s.regionState.forEach((rs, ri) => { rs.soldWh = res.sinkUsed.get(`m${ri}`) ?? 0; st.deliveredWh += rs.soldWh; });

  // 저장: 방전(공급원으로 쓰인 양), 충전(배분 + 지역 잉여)
  for (const f of s.facilities) {
    if (f.type !== 'storage' || f.status !== 'operating') continue;
    const out = res.unitUsed.get(`d${f.id}`) ?? 0;
    if (out > 0) {
      const drawn = Math.min(f.socWh, Math.ceil((out * PPM) / effPpm));
      f.socWh -= drawn;
      st.dischargeWh += out;
      st.storageLossWh += drawn - out;
      f.lastStorageWh = -out;
      f.outputKw = Math.floor(out / WH_PER_KW_PER_DI);
      continue;
    }
    const sinkKey = `c${f.id}`;
    let input = res.sinkUsed.get(sinkKey) ?? 0;
    const capIn = sinks.find((x) => x.key === sinkKey)?.capWh ?? 0;
    const extra = Math.min(capIn - input, surplus.get(f.regionId) ?? 0);
    if (extra > 0) { input += extra; surplus.set(f.regionId, (surplus.get(f.regionId) ?? 0) - extra); }
    if (input > 0) {
      const stored = Math.floor((input * effPpm) / PPM);
      f.socWh += stored;
      st.chargeWh += input;
      st.storageLossWh += input - stored;
      f.lastStorageWh = input;
      f.outputKw = 0;
    }
  }
  for (const v of surplus.values()) st.curtailWh += v;

  // 선로 결과
  for (const l of s.lines) {
    const u = res.edgeUse.get(l.id);
    l.lastDir = u ? u.dir : 0;
    l.lastSentWh = u ? u.sentWh : 0;
    l.lastLossWh = u ? u.lossWh : 0;
    st.lineLossWh += l.lastLossWh;
  }

  // 5 정산 (현금 즉시 반영, 원장은 게임일 경계에 기록)
  for (const f of s.facilities) {
    const keyG = `g${f.id}`, keyD = `d${f.id}`;
    const revenue = (revByUnit.get(keyG) ?? 0) + (revByUnit.get(keyD) ?? 0);
    const fuel = fuelByFac.get(f.id) ?? 0;
    const sold = (soldByUnit.get(keyG) ?? 0) + (soldByUnit.get(keyD) ?? 0);
    f.lastSoldWh = sold;
    if (!revenue && !fuel && !f.lastGenWh) continue;
    const acc = (s.dayAcc[f.id] ??= { revenue: 0, fuel: 0, genWh: 0, soldWh: 0 });
    acc.revenue += revenue;
    acc.fuel += fuel;
    acc.genWh += f.lastGenWh;
    acc.soldWh += sold;
    s.cash += revenue - fuel;
  }
  s.lastDI = st;
}

// ---------- 게임일 경계 ----------

function processDayEnd(s: GameState) {
  const day = dayOf(s.step) - 1;
  if (day <= s.lastPostedDay) return;
  for (const key of Object.keys(s.dayAcc).sort((a, b) => Number(a) - Number(b))) {
    const acc = s.dayAcc[Number(key)];
    if (acc.revenue) s.ledger.push({ id: `D${day}:rev:${key}`, step: s.step, debit: 'cash', credit: 'revenue_market', amount: acc.revenue, memo: `시장 판매 #${key}` });
    if (acc.fuel) s.ledger.push({ id: `D${day}:fuel:${key}`, step: s.step, debit: 'fuel', credit: 'cash', amount: acc.fuel, memo: `연료 #${key}` });
  }
  s.dayAcc = {};
  for (const f of s.facilities) {
    if (f.status === 'operating') post(s, `D${day}:opex:${f.id}`, 'opex', 'cash', f.fixedMinorPerDay, `유지비 #${f.id}`);
  }
  for (const l of s.lines) {
    if (l.status === 'operating') post(s, `D${day}:opexL:${l.id}`, 'opex', 'cash', Math.round((l.capexMinor * LINE.fixedPpmPerDay) / PPM), `선로 유지비 #${l.id}`);
  }
  s.lastPostedDay = day;
  s.history.push({ day, netMinor: s.cash - s.dayStartCash, cash: s.cash });
  s.dayStartCash = s.cash;
  if (s.history.length > 120) s.history.shift();
  if (s.cash < 0) notify(s, 'warn', '현금이 음수입니다. 지출을 줄이거나 시설을 정지하세요.');
}

// ---------- 메인 스텝 ----------

/** 1 스텝(게임 1분). 순서: 명령 → 건설 → (DI) 사건 효과 → 수요·가격 → 배분 → 정산 → (일) 원장·유지비 */
export function step(s: GameState) {
  if (s.pending.length) {
    const cmds = s.pending.sort((a, b) => a.seq - b.seq);
    s.pending = [];
    for (const c of cmds) applyCommand(s, c.cmd);
  }
  advanceConstruction(s);
  s.step += 1;
  if (s.step % STEPS_PER_DI === 0) {
    processDI(s);
    processEvents(s); // 판정은 배분 뒤 → 효과는 다음 DI부터 (Baseline §3.6)
  }
  if (s.step % STEPS_PER_DAY === 0) processDayEnd(s);
}

export function advance(s: GameState, steps: number) {
  for (let i = 0; i < steps; i++) step(s);
}

export { healthLabel };

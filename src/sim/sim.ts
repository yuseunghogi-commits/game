// 시뮬레이션 코어 (P0 수직 단면).
// 범위: 시간, 지역 수요, 시장 가격, 발전, 판매 한도, 정산, 원장, 단계별 건설, 명령, 알림.
// 범위 밖 (후속 단계): 지역 간 선로·손실(P1), 저장(P1), 사업권·토지·대출·계약(P2).

import {
  COMMISSIONING_STAGE, FACILITY_TYPES, MARKET, STAGES, START_CASH_MINOR,
  generateRegions, specOf, type RegionDef, type SizeId, type TypeId,
} from './data';
import { demandKw, localMinute, priceMinor, refSupplyTargetKw, smoothToward } from './market';
import {
  PPM, STEPS_PER_DAY, STEPS_PER_DI, WH_PER_KW_PER_DI,
  dayOf, moneyFor, roundHalfEven, splitByWeights,
} from './units';

export const SCHEMA_VERSION = 1;

export type Account =
  | 'cash' | 'equity' | 'revenue_market' | 'fuel' | 'opex' | 'capex' | 'refund';

export interface LedgerEntry {
  id: string;
  step: number;
  debit: Account;
  credit: Account;
  amount: number;
  memo: string;
}

export type FacilityStatus = 'construction' | 'operating';

export interface Facility {
  id: number;
  type: TypeId;
  size: SizeId;
  regionId: number;
  capKw: number;
  capexMinor: number;
  fixedMinorPerDay: number;
  status: FacilityStatus;
  stage: number;
  stageStep: number;
  stageSteps: number[];
  stageCosts: number[];
  online: boolean;
  outputKw: number;
  startDelay: number;
  lastGenWh: number;
  lastSoldWh: number;
}

export interface RegionState {
  refSupplyKw: number;
  demandKw: number;
  priceMinor: number;
  soldWh: number;
  capWh: number;
}

export type Command =
  | { kind: 'build'; regionId: number; type: TypeId; size: SizeId }
  | { kind: 'cancel'; facilityId: number }
  | { kind: 'setOnline'; facilityId: number; online: boolean };

export interface Notice { step: number; level: 'info' | 'warn' | 'error'; text: string }

export interface DayAcc { revenue: number; fuel: number; genWh: number; soldWh: number }

export interface GameState {
  schemaVersion: number;
  seed: number;
  step: number;
  cash: number;
  reserved: number;
  regions: RegionDef[];
  regionState: RegionState[];
  facilities: Facility[];
  nextFacilityId: number;
  commandSeq: number;
  pending: { seq: number; cmd: Command }[];
  ledger: LedgerEntry[];
  /** 원장에 아직 기록되지 않은 오늘의 에너지 거래 (게임일 경계에 기록) */
  dayAcc: Record<number, DayAcc>;
  lastPostedDay: number;
  dayStartCash: number;
  history: { day: number; netMinor: number; cash: number }[];
  notices: Notice[];
}

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
    facilities: [],
    nextFacilityId: 1,
    commandSeq: 0,
    pending: [],
    ledger: [],
    dayAcc: {},
    lastPostedDay: -1,
    dayStartCash: 0,
    history: [],
    notices: [],
  };
  post(s, 'init:capital', 'cash', 'equity', START_CASH_MINOR, '초기 자본');
  s.dayStartCash = s.cash;
  notify(s, 'info', '회사 설립. 지역을 골라 첫 발전소를 지으세요.');
  return s;
}

// ---------- 원장 ----------

function post(s: GameState, id: string, debit: Account, credit: Account, amount: number, memo: string): boolean {
  if (amount === 0) return false;
  if (s.ledger.some((e) => e.id === id)) return false; // 중복 거래 방지
  s.ledger.push({ id, step: s.step, debit, credit, amount, memo });
  if (debit === 'cash') s.cash += amount;
  if (credit === 'cash') s.cash -= amount;
  return true;
}

/** 원장 기준 현금 잔액 */
export function ledgerCash(s: GameState): number {
  let c = 0;
  for (const e of s.ledger) {
    if (e.debit === 'cash') c += e.amount;
    if (e.credit === 'cash') c -= e.amount;
  }
  return c;
}

/** 아직 원장에 기록되지 않은 오늘의 현금 변동 */
export function pendingCash(s: GameState): number {
  let c = 0;
  for (const k in s.dayAcc) c += s.dayAcc[k].revenue - s.dayAcc[k].fuel;
  return c;
}

function notify(s: GameState, level: Notice['level'], text: string) {
  s.notices.push({ step: s.step, level, text });
  if (s.notices.length > 60) s.notices.splice(0, s.notices.length - 60);
}

// ---------- 명령 ----------

/** UI·자동화 공통 진입점. 다음 스텝 시작 시 순서대로 적용된다. */
export function issue(s: GameState, cmd: Command): number {
  s.commandSeq += 1;
  s.pending.push({ seq: s.commandSeq, cmd });
  return s.commandSeq;
}

export function availableCash(s: GameState): number {
  return s.cash - s.reserved;
}

function applyCommand(s: GameState, cmd: Command) {
  switch (cmd.kind) {
    case 'build': {
      const region = s.regions[cmd.regionId];
      if (!region) return notify(s, 'error', '건설 거부: 존재하지 않는 지역');
      const spec = specOf(cmd.type, cmd.size);
      if (availableCash(s) < spec.capexMinor) {
        return notify(s, 'error', `건설 거부 (${region.name}): 사용 가능 자금 부족`);
      }
      const totalSteps = spec.buildDays * STEPS_PER_DAY;
      const f: Facility = {
        id: s.nextFacilityId++,
        type: cmd.type,
        size: cmd.size,
        regionId: cmd.regionId,
        capKw: spec.capKw,
        capexMinor: spec.capexMinor,
        fixedMinorPerDay: spec.fixedMinorPerDay,
        status: 'construction',
        stage: -1,
        stageStep: 0,
        stageSteps: splitByWeights(totalSteps, STAGES.map((x) => x.time)),
        stageCosts: splitByWeights(spec.capexMinor, STAGES.map((x) => x.cost)),
        online: true,
        outputKw: 0,
        startDelay: 0,
        lastGenWh: 0,
        lastSoldWh: 0,
      };
      s.facilities.push(f);
      s.reserved += spec.capexMinor;
      notify(s, 'info', `건설 승인: ${region.name} ${FACILITY_TYPES[cmd.type].name} (${spec.buildDays}일)`);
      return;
    }
    case 'cancel': {
      const f = s.facilities.find((x) => x.id === cmd.facilityId);
      if (!f || f.status !== 'construction') return notify(s, 'error', '취소 거부: 건설 중인 시설이 아님');
      const r = cancelRefund(f);
      s.reserved -= r.releaseReserve;
      post(s, `cancel:${f.id}`, 'cash', 'refund', r.cashRefund, `건설 취소 환불 #${f.id}`);
      s.facilities = s.facilities.filter((x) => x.id !== f.id);
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
  }
}

/** 건설 취소 환불 (S-17): 미시작 단계는 예약 해제, 진행 중 단계 미진행분 80%, 완료 단계 20%. */
export function cancelRefund(f: Facility): { releaseReserve: number; cashRefund: number } {
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

function advanceConstruction(s: GameState) {
  for (const f of s.facilities) {
    if (f.status !== 'construction') continue;
    if (f.stage === -1 || f.stageStep >= f.stageSteps[f.stage]) {
      if (f.stage === STAGES.length - 1) {
        f.status = 'operating';
        f.startDelay = FACILITY_TYPES[f.type].startDelayDI;
        notify(s, 'info', `준공: ${s.regions[f.regionId].name} ${FACILITY_TYPES[f.type].name}`);
        continue;
      }
      f.stage += 1;
      f.stageStep = 0;
      const cost = f.stageCosts[f.stage];
      s.reserved -= cost;
      post(s, `capex:${f.id}:${f.stage}`, 'capex', 'cash', cost, `건설 ${STAGES[f.stage].name} #${f.id}`);
    }
    f.stageStep += 1;
  }
}

// ---------- 발전량 ----------

function hash2(a: number, b: number): number {
  let h = (Math.imul(a, 2654435761) ^ Math.imul(b, 1597334677)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967295;
}

/** 태양광 출력 계수 (ppm). 6–18시 사인 곡선 × 지역 자원 × 위도. */
export function solarPpm(r: RegionDef, step: number): number {
  const m = localMinute(r, step);
  const x = (m - 360) / 720;
  if (x <= 0 || x >= 1) return 0;
  const sun = Math.sin(Math.PI * x);
  const resource = 0.45 + 0.11 * r.solar;
  const latF = Math.cos((r.lat * Math.PI) / 180);
  return Math.floor(sun * resource * latF * PPM);
}

/** 풍력 출력 계수 (ppm). 6시간 간격 결정적 값 사이를 부드럽게 보간 (시드·지역별). */
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

// ---------- 정산 구간 (DI) ----------

/** 직전 15분을 정산한다. 배분 순서: 변동비가 낮은 순(메리트 오더), 판매 한도까지. */
function processDI(s: GameState) {
  s.regions.forEach((r, ri) => {
    const rs = s.regionState[ri];
    rs.refSupplyKw = smoothToward(rs.refSupplyKw, refSupplyTargetKw(r));
    rs.demandKw = demandKw(r, s.step);
    rs.priceMinor = priceMinor(r.pBaseMinor, rs.refSupplyKw, rs.demandKw);
    const capWh = Math.floor((rs.demandKw * MARKET.sigmaPpm) / PPM) * WH_PER_KW_PER_DI;
    let remain = capWh;
    let sold = 0;

    const here = s.facilities
      .filter((f) => f.regionId === ri && (f.status === 'operating' || f.stage === COMMISSIONING_STAGE))
      .sort((a, b) => FACILITY_TYPES[a.type].fuelMinorPerMWh - FACILITY_TYPES[b.type].fuelMinorPerMWh || a.id - b.id);

    for (const f of here) {
      const def = FACILITY_TYPES[f.type];
      const commissioning = f.status === 'construction';
      const maxKw = commissioning ? Math.floor(f.capKw / 2) : f.capKw;
      let outKw = 0;
      if (!f.online) {
        outKw = 0;
      } else if (f.startDelay > 0) {
        f.startDelay -= 1;
        outKw = 0;
      } else if (def.dispatchable) {
        const minKw = Math.floor((maxKw * def.minOutputPpm) / PPM);
        const remainKw = Math.floor(remain / WH_PER_KW_PER_DI);
        const economic = rs.priceMinor >= def.fuelMinorPerMWh;
        let target = economic ? Math.min(maxKw, Math.max(minKw, remainKw)) : minKw;
        const ramp = Math.floor((f.capKw * def.rampPpmPerDI) / PPM);
        const prev = f.outputKw === 0 ? minKw : f.outputKw;
        target = Math.max(prev - ramp, Math.min(prev + ramp, target));
        outKw = Math.max(minKw, Math.min(maxKw, target));
      } else {
        const ppm = f.type === 'solar' ? solarPpm(r, s.step - 1) : windPpm(r, s.seed, s.step - 1);
        outKw = Math.floor((maxKw * ppm) / PPM);
      }
      f.outputKw = outKw;
      const genWh = outKw * WH_PER_KW_PER_DI;
      const soldWh = Math.min(genWh, remain);
      remain -= soldWh;
      sold += soldWh;
      f.lastGenWh = genWh;
      f.lastSoldWh = soldWh;

      const revenue = moneyFor(soldWh, rs.priceMinor);
      const fuel = moneyFor(genWh, def.fuelMinorPerMWh);
      const acc = (s.dayAcc[f.id] ??= { revenue: 0, fuel: 0, genWh: 0, soldWh: 0 });
      acc.revenue += revenue;
      acc.fuel += fuel;
      acc.genWh += genWh;
      acc.soldWh += soldWh;
      s.cash += revenue - fuel;
    }
    rs.soldWh = sold;
    rs.capWh = capWh;
  });
}

// ---------- 게임일 경계 ----------

function processDayEnd(s: GameState) {
  const day = dayOf(s.step) - 1;
  if (day <= s.lastPostedDay) return; // 재처리 방지
  // 오늘 누적된 에너지 거래를 원장에 기록 (현금은 이미 반영됨 → 이중 반영 없이 기록만)
  for (const key of Object.keys(s.dayAcc).sort((a, b) => Number(a) - Number(b))) {
    const acc = s.dayAcc[Number(key)];
    if (acc.revenue) s.ledger.push({ id: `D${day}:rev:${key}`, step: s.step, debit: 'cash', credit: 'revenue_market', amount: acc.revenue, memo: `시장 판매 #${key}` });
    if (acc.fuel) s.ledger.push({ id: `D${day}:fuel:${key}`, step: s.step, debit: 'fuel', credit: 'cash', amount: acc.fuel, memo: `연료 #${key}` });
  }
  s.dayAcc = {};
  // 고정 유지비 (Q34: 단순 유지보수 비용) — 운영 중 시설만
  for (const f of s.facilities) {
    if (f.status === 'operating') post(s, `D${day}:opex:${f.id}`, 'opex', 'cash', f.fixedMinorPerDay, `유지비 #${f.id}`);
  }
  s.lastPostedDay = day;
  s.history.push({ day, netMinor: s.cash - s.dayStartCash, cash: s.cash });
  s.dayStartCash = s.cash;
  if (s.history.length > 120) s.history.shift();
  if (s.cash < 0) notify(s, 'warn', '현금이 음수입니다. 지출을 줄이거나 시설을 정지하세요.');
}

// ---------- 메인 스텝 ----------

/** 1 스텝(게임 1분)을 진행한다. 처리 순서는 Baseline §3.6 보완 순서를 따른다. */
export function step(s: GameState) {
  // 1–2 명령 수집·검증·적용 (발행 순서)
  if (s.pending.length) {
    const cmds = s.pending.sort((a, b) => a.seq - b.seq);
    s.pending = [];
    for (const c of cmds) applyCommand(s, c.cmd);
  }
  // 3 건설
  advanceConstruction(s);
  s.step += 1;
  // DI 경계: 수요 → 가격 → 배분 → 정산
  if (s.step % STEPS_PER_DI === 0) processDI(s);
  // 게임일 경계
  if (s.step % STEPS_PER_DAY === 0) processDayEnd(s);
}

export function advance(s: GameState, steps: number) {
  for (let i = 0; i < steps; i++) step(s);
}


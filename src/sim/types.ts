// 게임 상태 타입. 세이브 파일에 그대로 저장되는 정규 상태다 (Baseline §29.4).

import type { LicenseType, Multipliers, RegionDef, ScenarioId, SizeId, TypeId } from './data';

export type Account =
  | 'cash' | 'equity' | 'revenue_market' | 'revenue_contract' | 'fuel' | 'opex' | 'capex' | 'refund' | 'repair'
  | 'license' | 'land' | 'land_asset' | 'loan' | 'interest' | 'penalty' | 'research' | 'env' | 'sale' | 'disposal' | 'bailout';

export interface LedgerEntry { id: string; step: number; debit: Account; credit: Account; amount: number; memo: string }

/** 고장 상태 (Baseline §24.3) */
export type Health =
  | { s: 'ok' }
  | { s: 'warning'; failAt: number }
  | { s: 'failed'; until: number; rushed?: boolean; cost?: number }
  | { s: 'inspection'; until: number };

export interface Build { stage: number; stageStep: number; stageSteps: number[]; stageCosts: number[] }

/** 권리 상태 (사업권·임대 공통, 결정 S-11: '만료 예정'은 상태가 아닌 표시) */
export type RightState = 'active' | 'grace' | 'expired';

export interface Land {
  mode: 'lease' | 'own';
  rentPerDayMinor: number;
  depositMinor: number;
  expiresAt: number;
  state: RightState;
  purchaseMinor: number;
}

/** 시설 실적 하루치 (화면의 시설 상세용) */
export interface FacDay { genWh: number; soldWh: number; contractWh: number; revMinor: number; fuelMinor: number; opexMinor: number; upDI: number; di: number }
export interface FacStats { cur: FacDay; days: FacDay[]; life: { genWh: number; revMinor: number; costMinor: number; days: number } }

/** 모듈 확장 공사 (Q47) */
export interface Expansion { addKw: number; addEnergyWh: number; addFixedMinor: number; costMinor: number; startStep: number; until: number }

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
  energyWh: number;
  socWh: number;
  dischargeAtMinor: number;
  chargeAtMinor: number;
  lastStorageWh: number;
  hubAddKw: number;
  effPpm: number;
  land: Land;
  /** 권리(사업권·토지) 문제로 운영 불가 */
  rightsOk: boolean;
  /** 접속점 (S-08): 0 = 지역 허브 기본 접속점, 그 외 = 변전소 시설 ID. 변전소 자신은 0 */
  pointId: number;
  modules: number;
  expansion: Expansion | null;
  stats: FacStats;
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
  rightsOk: boolean;
}

export interface Hub { capKw: number; health: Health }

export interface License {
  id: number;
  regionId: number;
  type: LicenseType;
  size: SizeId;
  quotaKw: number;
  priceMinor: number;
  feePerDayMinor: number;
  expiresAt: number;
  state: RightState;
  autoRenew: boolean;
}

export interface Loan {
  id: number;
  principalMinor: number;
  balanceMinor: number;
  ratePpmPerYear: number;
  months: number;
  paidMonths: number;
  paymentMinor: number;
  nextDueStep: number;
  arrearsMinor: number;
}

export type InsolvencyState = 'normal' | 'warning' | 'arrears' | 'restructuring' | 'insolvent' | 'liquidated';

export interface ContractOffer {
  id: number;
  kind: 'ppa' | 'direct';
  regionId: number;
  mwKw: number;
  /** 24점 프로파일 (ppm) — PPA: 평탄/주간, 직접 공급: 고객 부하 곡선 */
  shapePpm: number[];
  priceMinor: number;
  termDays: number;
  critical: boolean;
  expiresAt: number;
}

export interface Contract extends ContractOffer {
  startStep: number;
  endStep: number;
  deliveredWh: number;
  obligationWh: number;
  penaltyMinor: number;
  revenueMinor: number;
  lastObligationWh: number;
  lastDeliveredWh: number;
  done: boolean;
  /** 핵심 부하 정전 긴급 알림 마지막 시각 (중복 방지) */
  alertAt: number;
}

export interface ResearchState { done: string[]; active: { id: string; investedMinor: number; days: number; dailyBudgetMinor: number }[] }

export interface Automation {
  autoRenew: boolean;
  autoInspect: boolean;
  autoStorage: boolean;
  dailyBudgetMinor: number;
  spentTodayMinor: number;
  actionsToday: number;
  keys: string[];
  failures: Record<string, number>;
  /** 수동 고정 (결정 S-16): 대상 키 → 해제 스텝 */
  locks: Record<string, number>;
}

export interface RegionDyn {
  /** 30일 환경 영향 (일별) */
  envDaily: number[];
  envPriceMult: number;
  pendingReg: { at: number; mult: number } | null;
  demandShock: { from: number; to: number; mult: number } | null;
  supplyShock: { from: number; to: number; mult: number } | null;
  /** 최근 7일 가격 기록 (DI 샘플, 자동 저장 기준용) */
  priceSamples: number[];
}

export interface Rules {
  preset: 'easy' | 'standard' | 'hard' | 'custom';
  scenario: ScenarioId;
  m: Multipliers;
  insolvency: 'bailout' | 'liquidation' | 'none';
  startCashMinor: number;
  regionCount: number;
}

export interface RegionState { refSupplyKw: number; demandKw: number; priceMinor: number; soldWh: number; capWh: number }

export type Command =
  | { kind: 'build'; regionId: number; type: TypeId; size: SizeId }
  | { kind: 'buildLine'; a: number; b: number; size: SizeId }
  | { kind: 'cancel'; facilityId: number }
  | { kind: 'cancelLine'; lineId: number }
  | { kind: 'setOnline'; facilityId: number; online: boolean }
  | { kind: 'inspect'; target: 'facility' | 'line' | 'hub'; id: number }
  | { kind: 'setStorage'; facilityId: number; dischargeAtMinor: number; chargeAtMinor: number }
  | { kind: 'acquireLicense'; regionId: number; type: LicenseType; size: SizeId }
  | { kind: 'renewLicense'; licenseId: number }
  | { kind: 'setAutoRenew'; licenseId: number; on: boolean }
  | { kind: 'renewLease'; facilityId: number }
  | { kind: 'buyLand'; facilityId: number }
  | { kind: 'sellLand'; facilityId: number }
  | { kind: 'sellFacility'; facilityId: number }
  | { kind: 'disposeFacility'; facilityId: number }
  | { kind: 'takeLoan'; principalMinor: number; months: number }
  | { kind: 'repayLoan'; loanId: number }
  | { kind: 'acceptOffer'; offerId: number }
  | { kind: 'startResearch'; id: string; dailyBudgetMinor: number }
  | { kind: 'setAutomation'; key: 'autoRenew' | 'autoInspect' | 'autoStorage'; on: boolean }
  | { kind: 'setAutomationBudget'; dailyBudgetMinor: number }
  | { kind: 'bailout' }
  | { kind: 'lock'; key: string; days: number | null }
  | { kind: 'expand'; facilityId: number }
  | { kind: 'rushRepair'; target: 'facility' | 'line' | 'hub'; id: number }
  | { kind: 'planAdd'; item: PlanCmd }
  | { kind: 'planRemove'; id: number }
  | { kind: 'planMove'; id: number; dir: -1 | 1 }
  | { kind: 'planClear' }
  | { kind: 'planPause'; paused: boolean };

/** 계획 건설 (Q32 C): 조건이 맞는 순서대로 자동 승인되는 건설 대기열 */
export type PlanCmd = Extract<Command, { kind: 'build' }> | Extract<Command, { kind: 'buildLine' }>;
export interface PlanItem { id: number; cmd: PlanCmd }

/** urgent: 긴급 등급 (S-21: 핵심 부하 정전·대출 연체·사업권 정지·회생불능) → 자동 일시정지 대상 */
export interface Notice { step: number; level: 'info' | 'warn' | 'error'; text: string; urgent?: boolean }
export interface DayAcc { revenue: number; cost: number; kind: 'market' | 'contract' }
export interface DIStats { genWh: number; dischargeWh: number; deliveredWh: number; contractWh: number; lineLossWh: number; chargeWh: number; curtailWh: number; storageLossWh: number }

export interface GameState {
  schemaVersion: number;
  seed: number;
  step: number;
  cash: number;
  reserved: number;
  rules: Rules;
  regions: RegionDef[];
  regionState: RegionState[];
  regionDyn: RegionDyn[];
  hubs: Hub[];
  facilities: Facility[];
  lines: Line[];
  licenses: License[];
  loans: Loan[];
  offers: ContractOffer[];
  contracts: Contract[];
  research: ResearchState;
  automation: Automation;
  nextId: number;
  commandSeq: number;
  pending: { seq: number; cmd: Command; auto?: string }[];
  ledger: LedgerEntry[];
  dayAcc: Record<string, DayAcc>;
  lastPostedDay: number;
  dayStartCash: number;
  history: { day: number; netMinor: number; cash: number; netWorth: number }[];
  notices: Notice[];
  rng: number;
  lastDI: DIStats;
  fuelMult: number;
  nextFuelMult: number;
  insolvency: InsolvencyState;
  arrearsSince: number;
  restructureUntil: number;
  bailouts: number;
  everBorrowed: boolean;
  reliability: { obligation: number[]; delivered: number[] };
  completedContracts: number;
  objectivesDone: Record<string, number>;
  nextRegulationAt: number;
  plan: PlanItem[];
  planPaused: boolean;
  /** 계획 맨 앞 항목이 막힌 이유 (표시용) */
  planBlocked: string | null;
  /** 지금까지 생긴 알림 수 (화면이 새 알림을 찾는 기준) */
  noticeSeq: number;
}

// 정적 콘텐츠 데이터. 모든 수치는 [추후 밸런싱] 기준값이다.
// 밸런스 기준점: 표준 발전소 단순 회수 ≈ 90 게임일 (S-01 작업 가정).

import { heightAt, moistureAt, SEA_LEVEL } from '../world/terrain';
import { PPM } from './units';

export type TypeId = 'thermal' | 'solar' | 'wind' | 'storage' | 'substation';
export type GenTypeId = 'thermal' | 'solar' | 'wind';
export type SizeId = 'small' | 'medium' | 'large';

export interface FacilityTypeDef {
  id: TypeId;
  name: string;
  /** 중형 기준 정격 kW */
  baseCapKw: number;
  /** 중형 기준 건설비 (minor) */
  capexMinor: number;
  /** 중형 기준 고정 유지비 (minor / 게임일) */
  fixedMinorPerDay: number;
  /** 연료 변동비 (minor / MWh) */
  fuelMinorPerMWh: number;
  /** 최소 출력 비율 (ppm) — 가동 중일 때 */
  minOutputPpm: number;
  /** DI당 출력 변화 한도 (정격 대비 ppm) */
  rampPpmPerDI: number;
  /** 정지 → 가동 기동 지연 (DI) */
  startDelayDI: number;
  /** 건설기간 유형 계수 (S-09) */
  buildFactor: number;
  dispatchable: boolean;
  /** 'gen' 발전, 'storage' 저장, 'substation' 변전소(접속 용량 증설) */
  kind: 'gen' | 'storage' | 'substation';
  /** 저장: 중형 기준 에너지 용량 (Wh) */
  energyWh?: number;
  /** 변전소: 중형 기준 접속 용량 증설 (kW) */
  hubAddKw?: number;
}

export const FACILITY_TYPES: Record<TypeId, FacilityTypeDef> = {
  thermal: {
    id: 'thermal', name: '열발전소', baseCapKw: 20_000, capexMinor: 2_200_000_00,
    fixedMinorPerDay: 4_000_00, fuelMinorPerMWh: 40_00, minOutputPpm: 300_000,
    rampPpmPerDI: 125_000, startDelayDI: 2, buildFactor: 1.0, dispatchable: true, kind: 'gen',
  },
  wind: {
    id: 'wind', name: '풍력 발전단지', baseCapKw: 20_000, capexMinor: 1_300_000_00,
    fixedMinorPerDay: 2_400_00, fuelMinorPerMWh: 0, minOutputPpm: 0,
    rampPpmPerDI: PPM, startDelayDI: 0, buildFactor: 0.7, dispatchable: false, kind: 'gen',
  },
  solar: {
    id: 'solar', name: '태양광 발전소', baseCapKw: 20_000, capexMinor: 520_000_00,
    fixedMinorPerDay: 1_600_00, fuelMinorPerMWh: 0, minOutputPpm: 0,
    rampPpmPerDI: PPM, startDelayDI: 0, buildFactor: 0.5, dispatchable: false, kind: 'gen',
  },
  storage: {
    id: 'storage', name: '배터리 저장시설', baseCapKw: 20_000, capexMinor: 700_000_00,
    fixedMinorPerDay: 1_200_00, fuelMinorPerMWh: 0, minOutputPpm: 0,
    rampPpmPerDI: PPM, startDelayDI: 0, buildFactor: 0.4, dispatchable: true, kind: 'storage',
    energyWh: 80_000_000,
  },
  substation: {
    id: 'substation', name: '변전소', baseCapKw: 0, capexMinor: 400_000_00,
    fixedMinorPerDay: 800_00, fuelMinorPerMWh: 0, minOutputPpm: 0,
    rampPpmPerDI: PPM, startDelayDI: 0, buildFactor: 0.4, dispatchable: false, kind: 'substation',
    hubAddKw: 150_000,
  },
};

/** 저장 효율 (Baseline §11.4): 충전·방전 각 0.9 → 왕복 0.81 */
export const STORAGE_EFF_PPM = 900_000;
/** 지역 허브 기본 접속 용량 (S-08, Baseline §10.9) */
export const HUB_BASE_KW = 80_000;

export type LineSizeId = SizeId;
/** 송전선 (지역 간). 용량은 송전단 기준. 손실 l = min(l_max, λ × 길이) */
export const LINE = {
  capKw: { small: 50_000, medium: 150_000, large: 400_000 } as Record<SizeId, number>,
  costPerKm: { small: 60_00, medium: 120_00, large: 240_00 } as Record<SizeId, number>,
  fixedCost: 50_000_00,
  buildDays: { small: 8, medium: 16, large: 30 } as Record<SizeId, number>,
  lossPpmPerKm: 18,
  lossMaxPpm: 200_000,
  /** 유지비: 건설비의 0.1% / 게임일 */
  fixedPpmPerDay: 1_000,
};
export const PLANET_RADIUS_KM = 6_000;

/** 사건 (S-22: 예측 가능한 위험 + 제한적 사건). 비율은 게임년(120일)당 발생 수. */
export const EVENTS = {
  facilityWarnPerYear: 1.5,
  linePerYearPer1000Km: 0.6,
  hubPerYear: 0.3,
  warnLeadDays: [3, 10] as [number, number],
  repairDays: { facility: [2, 5], line: [1, 3], hub: [1, 2] } as Record<string, [number, number]>,
  /** 복구비: 건설비 대비 ppm (허브는 고정액) */
  repairPpm: { facility: 15_000, line: 20_000 },
  hubRepairMinor: 50_000_00,
  inspectionShare: 0.2,
};

/** 규모 계수 (Baseline §12.12, S-09). 대형은 MW당 건설비 ×0.9. */
export const SIZES: Record<SizeId, { name: string; cap: number; cost: number; fixed: number; time: number }> = {
  small: { name: '소형', cap: 0.25, cost: 0.25, fixed: 0.25, time: 1 / 3 },
  medium: { name: '중형', cap: 1, cost: 1, fixed: 1, time: 1 },
  large: { name: '대형', cap: 3, cost: 2.7, fixed: 2.7, time: 2 },
};

/** 표준(열발전 중형) 건설기간 30 게임일 — 사용자 확정 Q3. */
export const STANDARD_BUILD_DAYS = 30;

/** 단계별 건설 (Baseline §12.13): 비용 비중 / 기간 비중 (%) */
export const STAGES = [
  { name: '준비 및 기초', cost: 10, time: 15 },
  { name: '주요 구조', cost: 35, time: 35 },
  { name: '장비 설치', cost: 35, time: 25 },
  { name: '전력망 접속', cost: 10, time: 10 },
  { name: '검사', cost: 5, time: 5 },
  { name: '시운전', cost: 5, time: 10 },
] as const;
export const COMMISSIONING_STAGE = 5;

export function specOf(type: TypeId, size: SizeId) {
  const t = FACILITY_TYPES[type];
  const s = SIZES[size];
  return {
    capKw: Math.round(t.baseCapKw * s.cap),
    capexMinor: Math.round(t.capexMinor * s.cost),
    fixedMinorPerDay: Math.round(t.fixedMinorPerDay * s.fixed),
    buildDays: Math.max(1, Math.round(STANDARD_BUILD_DAYS * t.buildFactor * s.time)),
    energyWh: Math.round((t.energyWh ?? 0) * s.cap),
    hubAddKw: Math.round((t.hubAddKw ?? 0) * s.cap),
  };
}

export interface RegionDef {
  id: number;
  name: string;
  lat: number;
  lon: number;
  demandBaseKw: number;
  /** 24점 일주기 (ppm, 평균 ≈ 1e6) */
  shapePpm: number[];
  /** 외생 기준 공급 / 기준 수요 (ppm) */
  refSupplyPpm: number;
  /** 기준가 (minor / MWh) */
  pBaseMinor: number;
  /** 자원 0..5 */
  solar: number;
  wind: number;
  growthPpmPerYear: number;
}

const REGION_NAMES = ['아우렐', '바스티온', '세룰레아', '드라바', '에스커', '펜마크'];

const BASE_SHAPE = [
  0.72, 0.68, 0.66, 0.65, 0.67, 0.74, 0.86, 0.98, 1.06, 1.1, 1.12, 1.13,
  1.12, 1.1, 1.08, 1.08, 1.12, 1.2, 1.28, 1.26, 1.18, 1.04, 0.9, 0.79,
];

function lcg(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 시드에서 지역을 결정적으로 만든다. 육지 위의 서로 떨어진 지점을 고른다. */
export function generateRegions(seed: number, count = 6): RegionDef[] {
  const rnd = lcg(seed * 7919 + 17);
  const candidates: { lat: number; lon: number; h: number }[] = [];
  const N = 1500;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const lat = (Math.asin(y) * 180) / Math.PI;
    if (Math.abs(lat) > 58) continue;
    const lon = ((((i * golden * 180) / Math.PI) % 360) + 360) % 360 - 180;
    const h = heightAt(lat, lon, seed, 4);
    if (h > SEA_LEVEL + 0.02) candidates.push({ lat, lon, h });
  }
  const picked: { lat: number; lon: number }[] = [];
  const angDist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
    const r = Math.PI / 180;
    const c =
      Math.sin(a.lat * r) * Math.sin(b.lat * r) +
      Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.cos((a.lon - b.lon) * r);
    return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
  };
  // 최원점 샘플링: 시작점은 시드로, 이후는 기존 점들과 가장 먼 후보.
  if (candidates.length === 0) throw new Error('육지가 없는 시드');
  picked.push(candidates[Math.floor(rnd() * candidates.length)]);
  while (picked.length < count) {
    let best = candidates[0], bestD = -1;
    for (const c of candidates) {
      const d = Math.min(...picked.map((p) => angDist(p, c)));
      if (d > bestD) { bestD = d; best = c; }
    }
    picked.push(best);
  }
  return picked.map((p, id) => {
    const moist = moistureAt(p.lat, p.lon, seed);
    const tilt = rnd() * 0.08 - 0.04;
    return {
      id,
      name: REGION_NAMES[id % REGION_NAMES.length],
      lat: Math.round(p.lat * 100) / 100,
      lon: Math.round(p.lon * 100) / 100,
      demandBaseKw: 300_000 + Math.floor(rnd() * 12) * 100_000,
      shapePpm: BASE_SHAPE.map((v, h) => Math.round((v + tilt * Math.sin((h / 24) * Math.PI * 2)) * PPM)),
      refSupplyPpm: 950_000 + Math.floor(rnd() * 15) * 10_000,
      pBaseMinor: (90 + Math.floor(rnd() * 26)) * 100,
      solar: Math.max(1, Math.min(5, Math.round(5 - Math.abs(p.lat) / 15 - moist * 1.5))),
      wind: Math.max(1, Math.min(5, Math.round(1 + Math.abs(p.lat) / 15 + rnd() * 2))),
      growthPpmPerYear: 20_000 + Math.floor(rnd() * 4) * 10_000,
    };
  });
}

export const START_CASH_MINOR = 1_500_000_00;
export const MARKET = {
  floorMinor: 30_00,
  capMinor: 500_00,
  /** 판매 한도 σ (S-05) */
  sigmaPpm: PPM,
  /** 외생 입력 평활화 (S-06): DI당 0.25 */
  alphaPpm: 250_000,
};

// 시장 가격 (M4 가격 수용자, 사용자 확정 Q2).
// 가격은 외생 기준 공급과 지역 수요로만 정해지며 플레이어 행동과 무관하다 (S-02).
// 연속 가격 함수 + 부족 가산 (S-07). 정산은 이 순시가로 한다 (S-06).

import { MARKET, type RegionDef } from './data';
import { PPM, STEPS_PER_DAY, DAYS_PER_YEAR } from './units';

/** f(ρ) — ppm 정수. ρ < 0.5 부족 가산, 0.5–1 상승, 1–2 하락, ≥ 2 하한. 모든 경계에서 연속. */
export function priceFactorPpm(rhoPpm: number): number {
  if (rhoPpm < 500_000) return 1_400_000 + 2 * (500_000 - rhoPpm);
  if (rhoPpm < PPM) return PPM + Math.floor((8 * (PPM - rhoPpm)) / 10);
  if (rhoPpm < 2 * PPM) return PPM - Math.floor((3 * (rhoPpm - PPM)) / 10);
  return 700_000;
}

export function priceMinor(pBaseMinor: number, refSupplyKw: number, demandKw: number): number {
  if (demandKw <= 0) return MARKET.floorMinor;
  const rho = Math.floor((refSupplyKw * PPM) / demandKw);
  const p = Math.round((pBaseMinor * priceFactorPpm(rho)) / PPM);
  return Math.min(MARKET.capMinor, Math.max(MARKET.floorMinor, p));
}

/** 지역 현지 시각 (분). 경도 1° = 4분. 화면의 낮·밤과 발전·수요가 같은 시각을 쓴다. */
export function localMinute(r: RegionDef, step: number): number {
  return (((step + Math.round(r.lon * 4)) % STEPS_PER_DAY) + STEPS_PER_DAY) % STEPS_PER_DAY;
}

/** 지역 수요 (kW). 24점 일주기를 분 단위로 선형 보간 (계단 변화 제거) + 연 성장. */
export function demandKw(r: RegionDef, step: number): number {
  const m = localMinute(r, step);
  const h = Math.floor(m / 60);
  const frac = (m % 60) / 60;
  const a = r.shapePpm[h];
  const b = r.shapePpm[(h + 1) % 24];
  const shape = a + (b - a) * frac;
  const years = step / STEPS_PER_DAY / DAYS_PER_YEAR;
  const growth = Math.pow(1 + r.growthPpmPerYear / PPM, years);
  return Math.floor((r.demandBaseKw * shape * growth) / PPM);
}

/** 외생 기준 공급 목표 (kW). P0에서는 상수이며 사건 시스템(P1+)이 바꾼다. */
export function refSupplyTargetKw(r: RegionDef): number {
  return Math.floor((r.demandBaseKw * r.refSupplyPpm) / PPM);
}

/** 외생 입력 평활화 (S-06): 다음 값 = 이전 + α(목표 − 이전) */
export function smoothToward(prev: number, target: number): number {
  return prev + Math.round(((target - prev) * MARKET.alphaPpm) / PPM);
}

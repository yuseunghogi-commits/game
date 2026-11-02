// 지역 허브 접속 용량 (Baseline §10.9, S-08)

import { FACILITY_TYPES } from './data';
import type { GameState } from './types';

export function hubCapacityKw(s: GameState, regionId: number): number {
  return s.hubs[regionId].capKw + s.facilities
    .filter((f) => f.regionId === regionId && f.type === 'substation' && f.status === 'operating')
    .reduce((a, f) => a + f.hubAddKw, 0);
}

/** 발전·저장 정격 합계 (건설 중 포함 — 접속 예약) */
export function hubUsedKw(s: GameState, regionId: number): number {
  return s.facilities
    .filter((f) => f.regionId === regionId && FACILITY_TYPES[f.type].kind !== 'substation')
    .reduce((a, f) => a + f.capKw, 0);
}

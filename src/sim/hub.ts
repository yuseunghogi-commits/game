// 지역 허브·접속점 (Baseline §10.9, 결정 S-08 (b)).
// 지역마다 수요 허브 1개(기본 접속점 포함)와 변전점 0개 이상. 시설마다 접속점이 있다.
// 수요 허브 고장 → 지역 전체 정지. 변전점 고장 → 그 변전점에 접속한 시설만 정지.

import { FACILITY_TYPES } from './data';
import { isUp } from './core';
import type { Facility, GameState } from './types';

export interface ConnPoint { id: number; name: string; capKw: number; usedKw: number; up: boolean; operating: boolean }

/** 접속 용량을 쓰는 정격 (확장 공사 중인 추가분 포함 — 접속 예약) */
export const connKw = (f: Facility) => (FACILITY_TYPES[f.type].kind === 'substation' ? 0 : f.capKw + (f.expansion?.addKw ?? 0));

export function connectionPoints(s: GameState, regionId: number): ConnPoint[] {
  const here = s.facilities.filter((f) => f.regionId === regionId);
  const used = (pid: number) => here.filter((f) => f.pointId === pid).reduce((a, f) => a + connKw(f), 0);
  const hub = s.hubs[regionId];
  const pts: ConnPoint[] = [{ id: 0, name: '허브 기본 접속점', capKw: hub.capKw, usedKw: used(0), up: hub.health.s !== 'failed', operating: true }];
  for (const f of here) {
    if (f.type !== 'substation') continue;
    pts.push({ id: f.id, name: `변전점 #${f.id}`, capKw: f.hubAddKw, usedKw: used(f.id), up: f.status === 'operating' && isUp(f.health) && f.rightsOk, operating: f.status === 'operating' });
  }
  return pts;
}

/** 새 시설을 붙일 접속점: 운영 중이고 여유가 있는 첫 접속점 (기본 접속점 → 변전점 ID 순) */
export function pickPoint(s: GameState, regionId: number, capKw: number): number | null {
  for (const p of connectionPoints(s, regionId)) if (p.operating && p.capKw - p.usedKw >= capKw) return p.id;
  return null;
}

export function pointFree(s: GameState, regionId: number, pointId: number): number {
  const p = connectionPoints(s, regionId).find((x) => x.id === pointId);
  return p ? p.capKw - p.usedKw : 0;
}

/** 시설의 접속점이 살아 있는가 (수요 허브는 별도로 본다) */
export function pointUp(s: GameState, f: Facility): boolean {
  if (f.pointId === 0) return true;
  const sub = s.facilities.find((x) => x.id === f.pointId);
  return !!sub && sub.status === 'operating' && isUp(sub.health) && sub.rightsOk;
}

export function hubCapacityKw(s: GameState, regionId: number): number {
  return s.hubs[regionId].capKw + s.facilities
    .filter((f) => f.regionId === regionId && f.type === 'substation' && f.status === 'operating')
    .reduce((a, f) => a + f.hubAddKw, 0);
}

/** 발전·저장 정격 합계 (건설 중·확장 중 포함 — 접속 예약) */
export function hubUsedKw(s: GameState, regionId: number): number {
  return s.facilities.filter((f) => f.regionId === regionId).reduce((a, f) => a + connKw(f), 0);
}

/** 가장 여유가 큰 접속점의 남은 용량 (건설 가능 판단용) */
export function bestPointFreeKw(s: GameState, regionId: number): number {
  return Math.max(0, ...connectionPoints(s, regionId).filter((p) => p.operating).map((p) => p.capKw - p.usedKw));
}

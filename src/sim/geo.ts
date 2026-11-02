// 지역 간 거리·이웃·선로 사양, 시설 사양 (연구·난이도 반영).

import { LINE, PLANET_RADIUS_KM, specOf, type RegionDef, type SizeId, type TypeId } from './data';
import { mods } from './research';
import type { GameState } from './types';

export function distanceKm(a: RegionDef, b: RegionDef): number {
  const r = Math.PI / 180;
  const c = Math.sin(a.lat * r) * Math.sin(b.lat * r) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.cos((a.lon - b.lon) * r);
  return Math.round(Math.acos(Math.min(1, Math.max(-1, c))) * PLANET_RADIUS_KM);
}

const nbCache = new WeakMap<RegionDef[], number[][]>();
/** 이웃 지역 (가장 가까운 3곳, 대칭). 송전선은 이웃끼리만 (MVP). */
export function neighbors(regions: RegionDef[]): number[][] {
  const hit = nbCache.get(regions);
  if (hit) return hit;
  const n = regions.map(() => new Set<number>());
  regions.forEach((r, i) => {
    regions.map((q, j) => ({ j, d: i === j ? Infinity : distanceKm(r, q) }))
      .sort((x, y) => x.d - y.d || x.j - y.j).slice(0, 3)
      .forEach(({ j }) => { n[i].add(j); n[j].add(i); });
  });
  const out = n.map((s) => [...s].sort((x, y) => x - y));
  nbCache.set(regions, out);
  return out;
}

export function lineSpec(s: GameState, a: number, b: number, size: SizeId) {
  const m = mods(s);
  const lengthKm = distanceKm(s.regions[a], s.regions[b]);
  return {
    lengthKm,
    capKw: Math.round(LINE.capKw[size] * m.lineCap),
    lossPpm: Math.round(Math.min(LINE.lossMaxPpm, LINE.lossPpmPerKm * lengthKm) * m.lineLoss),
    capexMinor: Math.round((LINE.fixedCost + LINE.costPerKm[size] * lengthKm) * m.capex),
    buildDays: Math.max(1, Math.round(LINE.buildDays[size] * m.buildTime)),
  };
}

export function facilitySpec(s: GameState, type: TypeId, size: SizeId) {
  const m = mods(s);
  const b = specOf(type, size);
  return {
    ...b,
    capexMinor: Math.round(b.capexMinor * m.capex),
    fixedMinorPerDay: Math.round(b.fixedMinorPerDay * s.rules.m.opex),
    buildDays: Math.max(1, Math.round(b.buildDays * m.buildTime)),
    energyWh: Math.round(b.energyWh * m.stoEnergy),
  };
}

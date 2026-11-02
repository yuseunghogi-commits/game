// 정산 구간(DI) 처리: 수요·가격 → 우선순위 배분 → 저장 → 정산 (Baseline §3.6, §10.7, Q15·Q16).
// 계층: ① 핵심 부하(직접 공급 핵심 고객) → ② 계약(PPA·직접 공급) → ③ 시장 판매·저장 충전 → ④ 잉여 저장 → 출력 제한.
// 같은 계층은 이행률이 고르게 오르도록 라운드로 나눠 배분한다 (최대–최소 공정).

import { COMMISSIONING_STAGE, CONTRACT, FACILITY_TYPES, MARKET, STORAGE_EFF_PPM } from './data';
import { isUp, notify } from './core';
import { pointUp } from './hub';
import { activeContracts, obligationWh, settleContract } from './contracts';
import { envAccumulate, shockMult } from './environment';
import { Allocator, type Edge, type Sink, type Unit } from './grid';
import { demandKw, priceMinor, refSupplyTargetKw, smoothToward } from './market';
import { mods } from './research';
import { PPM, STEPS_PER_DAY, WH_PER_KW_PER_DI, moneyFor } from './units';
import { solarPpm, windPpm } from './output';
import type { DIStats, GameState } from './types';

const BIG = 10_000_000; // 계약 수요처 가치: 시장보다 항상 먼저

function acc(s: GameState, key: string, kind: 'market' | 'contract') {
  return (s.dayAcc[key] ??= { revenue: 0, cost: 0, kind });
}

export function processDI(s: GameState) {
  const m = mods(s);
  // 1 수요·가격 (외생 입력 평활화, 사건 반영)
  s.regions.forEach((r, ri) => {
    const rs = s.regionState[ri];
    const dyn = s.regionDyn[ri];
    rs.refSupplyKw = smoothToward(rs.refSupplyKw, Math.round(refSupplyTargetKw(r) * shockMult(dyn.supplyShock, s.step)));
    rs.demandKw = Math.round(demandKw(r, s.step, s.rules.m.demandGrowth) * shockMult(dyn.demandShock, s.step));
    rs.priceMinor = priceMinor(r.pBaseMinor, rs.refSupplyKw, rs.demandKw);
    rs.capWh = s.hubs[ri].health.s === 'failed' ? 0 : Math.floor((rs.demandKw * MARKET.sigmaPpm) / PPM) * WH_PER_KW_PER_DI;
    dyn.priceSamples.push(rs.priceMinor);
    if (dyn.priceSamples.length > 96 * 7) dyn.priceSamples.shift();
  });
  const hubUp = (ri: number) => s.hubs[ri].health.s !== 'failed';

  // 2 공급원
  const units: Unit[] = [];
  const mustRun = new Map<number, number>();
  const genAvail = new Map<number, number>();
  const chargeSinks: Sink[] = [];
  const fuelPrice = (fuel: number) => Math.round(fuel * s.fuelMult * m.fuel);
  for (const f of s.facilities) {
    const def = FACILITY_TYPES[f.type];
    f.lastGenWh = 0; f.lastSoldWh = 0; f.lastStorageWh = 0;
    const producing = (f.status === 'operating' || f.stage === COMMISSIONING_STAGE) && def.kind !== 'substation';
    if (!producing) continue;
    const up = isUp(f.health) && hubUp(f.regionId) && pointUp(s, f) && f.online && f.rightsOk;
    f.stats.cur.di += 1;
    if (up) f.stats.cur.upDI += 1;
    if (!up) { f.outputKw = 0; continue; }
    if (f.startDelay > 0) { f.startDelay -= 1; f.outputKw = 0; continue; }
    const maxKw = f.status === 'construction' ? Math.floor(f.capKw / 2) : f.capKw;
    if (def.kind === 'storage') {
      if (f.status !== 'operating') continue;
      const eff = f.effPpm || STORAGE_EFF_PPM;
      const powerWh = maxKw * WH_PER_KW_PER_DI;
      const avail = Math.min(powerWh, Math.floor((f.socWh * eff) / PPM));
      if (avail > 0) units.push({ key: `d${f.id}`, node: f.regionId, availWh: avail, cost: f.dischargeAtMinor });
      const room = Math.min(powerWh, Math.floor(((f.energyWh - f.socWh) * PPM) / eff));
      if (room > 0 && s.regionState[f.regionId].priceMinor < f.dischargeAtMinor) chargeSinks.push({ key: `c${f.id}`, node: f.regionId, capWh: room, value: f.chargeAtMinor });
      continue;
    }
    let availKw: number;
    let minKw = 0;
    if (def.dispatchable) {
      const ramp = Math.floor((f.capKw * def.rampPpmPerDI * m.ramp) / PPM);
      const baseMin = Math.floor((maxKw * Math.max(0, def.minOutputPpm + m.minOutDeltaPpm)) / PPM);
      const prev = f.outputKw === 0 ? baseMin : f.outputKw;
      availKw = Math.min(maxKw, prev + ramp);
      minKw = Math.max(baseMin, Math.min(availKw, prev - ramp));
    } else {
      const r = s.regions[f.regionId];
      availKw = Math.floor((maxKw * (f.type === 'solar' ? solarPpm(r, s.step - 1) : windPpm(r, s.seed, s.step - 1))) / PPM);
    }
    const availWh = availKw * WH_PER_KW_PER_DI;
    genAvail.set(f.id, availWh);
    mustRun.set(f.id, minKw * WH_PER_KW_PER_DI);
    if (availWh > 0) units.push({ key: `g${f.id}`, node: f.regionId, availWh, cost: fuelPrice(def.fuelMinorPerMWh) });
  }

  const edges: Edge[] = s.lines.filter((l) => l.status === 'operating').map((l) => ({
    id: l.id, a: l.a, b: l.b, capWh: l.capKw * WH_PER_KW_PER_DI, lossPpm: l.lossPpm,
    usable: isUp(l.health) && hubUp(l.a) && hubUp(l.b) && l.rightsOk,
  }));
  const alloc = new Allocator(s.regions.length, units, edges);

  // 3 계층 배분
  const contracts = activeContracts(s);
  const obligation = new Map<number, number>();
  for (const c of contracts) obligation.set(c.id, obligationWh(s.regions[c.regionId], c, s.step - 1));
  const mkSink = (c: (typeof contracts)[number]): Sink => ({ key: `k${c.id}`, node: c.regionId, capWh: obligation.get(c.id)!, value: BIG });
  const delivered = new Map<string, number>();
  for (const tier of [contracts.filter((c) => c.critical), contracts.filter((c) => !c.critical)]) {
    const got = alloc.runFair(tier.map(mkSink).filter((x) => x.capWh > 0));
    for (const [k, v] of got) delivered.set(k, (delivered.get(k) ?? 0) + v);
  }
  // 저장: 계약 보호로 방전했다면 이번 DI는 충전하지 않음. 시장에는 방전 기준 가격 이상일 때만 판다.
  const dischargedForContract = new Set<number>();
  for (const f of s.facilities) {
    if (f.type !== 'storage') continue;
    if ((alloc.out.unitUsed.get(`d${f.id}`) ?? 0) > 0) dischargedForContract.add(f.id);
    if (s.regionState[f.regionId].priceMinor < f.dischargeAtMinor) alloc.removeUnit(`d${f.id}`);
  }
  const ppaDelivered = new Map<number, number>();
  for (const c of contracts) if (c.kind === 'ppa') ppaDelivered.set(c.regionId, (ppaDelivered.get(c.regionId) ?? 0) + (delivered.get(`k${c.id}`) ?? 0));
  const marketSinks: Sink[] = s.regions.map((_, ri) => ({ key: `m${ri}`, node: ri, capWh: Math.max(0, s.regionState[ri].capWh - (ppaDelivered.get(ri) ?? 0)), value: s.regionState[ri].priceMinor }));
  alloc.run([...marketSinks, ...chargeSinks.filter((c) => !dischargedForContract.has(Number(c.key.slice(1))))]);
  const res = alloc.out;

  // 4 결과
  const st: DIStats = { genWh: 0, dischargeWh: 0, deliveredWh: 0, contractWh: 0, lineLossWh: 0, chargeWh: 0, curtailWh: 0, storageLossWh: 0 };
  const surplus = new Map<number, number>();
  for (const f of s.facilities) {
    const avail = genAvail.get(f.id);
    if (avail === undefined) continue;
    const used = res.unitUsed.get(`g${f.id}`) ?? 0;
    const def = FACILITY_TYPES[f.type];
    const gen = def.dispatchable ? Math.max(used, mustRun.get(f.id) ?? 0) : avail;
    f.outputKw = Math.floor(gen / WH_PER_KW_PER_DI);
    f.lastGenWh = gen;
    f.stats.cur.genWh += gen;
    st.genWh += gen;
    if (gen > used) surplus.set(f.regionId, (surplus.get(f.regionId) ?? 0) + (gen - used));
    const fuel = moneyFor(gen, fuelPrice(def.fuelMinorPerMWh));
    if (fuel) { acc(s, `f${f.id}`, 'market').cost += fuel; s.cash -= fuel; f.stats.cur.fuelMinor += fuel; }
    envAccumulate(s, f, gen);
  }
  // 시장 수익: 흐름별 수전량 × 수요처 지역 가격 → 공급원 시설에 귀속
  const facById = new Map(s.facilities.map((f) => [f.id, f]));
  const contractById = new Map(contracts.map((c) => [c.id, c]));
  for (const fl of res.flows) {
    const fid = Number(fl.unit.slice(1));
    const f = facById.get(fid);
    if (fl.sink[0] === 'k') {
      // 계약 인도분: 현금은 계약 정산에서 생기고, 시설 실적에는 계약 단가로 귀속해 보여준다
      const c = contractById.get(Number(fl.sink.slice(1)));
      if (f && c) { f.stats.cur.contractWh += fl.deliveredWh; f.stats.cur.revMinor += moneyFor(fl.deliveredWh, c.priceMinor); }
      continue;
    }
    if (fl.sink[0] !== 'm') continue;
    const ri = Number(fl.sink.slice(1));
    const revenue = moneyFor(fl.deliveredWh, s.regionState[ri].priceMinor);
    acc(s, `f${fid}`, 'market').revenue += revenue;
    s.cash += revenue;
    if (f) { f.lastSoldWh += fl.deliveredWh; f.stats.cur.soldWh += fl.deliveredWh; f.stats.cur.revMinor += revenue; }
  }
  s.regionState.forEach((rs, ri) => { rs.soldWh = res.sinkUsed.get(`m${ri}`) ?? 0; st.deliveredWh += rs.soldWh; });
  // 계약 정산
  const rel = s.reliability;
  for (const c of contracts) {
    const ob = obligation.get(c.id)!;
    const got = delivered.get(`k${c.id}`) ?? 0;
    st.contractWh += got;
    const { revenue, penalty } = settleContract(c, ob, got, s.regionState[c.regionId].priceMinor);
    const a = acc(s, `k${c.id}`, 'contract');
    a.revenue += revenue;
    a.cost += penalty;
    s.cash += revenue - penalty;
    rel.obligation[rel.obligation.length - 1] += ob;
    rel.delivered[rel.delivered.length - 1] += Math.min(ob, got);
    // 핵심 부하 정전 (S-21 긴급 등급): 허용 오차를 넘는 부족이면 하루 한 번 긴급 알림
    if (c.critical && ob > 0 && ob - got > Math.floor((ob * CONTRACT.tolerancePpm) / PPM) && (c.alertAt < 0 || s.step - c.alertAt >= STEPS_PER_DAY)) {
      c.alertAt = s.step;
      notify(s, 'error', `핵심 부하 정전: ${s.regions[c.regionId].name} 직접 공급 — 이행 ${((got / ob) * 100).toFixed(0)}% (위약금 큼)`, true);
    }
  }
  // 저장 결과
  for (const f of s.facilities) {
    if (f.type !== 'storage' || f.status !== 'operating') continue;
    const eff = f.effPpm || STORAGE_EFF_PPM;
    const out = res.unitUsed.get(`d${f.id}`) ?? 0;
    if (out > 0) {
      const drawn = Math.min(f.socWh, Math.ceil((out * PPM) / eff));
      f.socWh -= drawn;
      st.dischargeWh += out;
      st.storageLossWh += drawn - out;
      f.lastStorageWh = -out;
      f.stats.cur.genWh += out;
      f.outputKw = Math.floor(out / WH_PER_KW_PER_DI);
      continue;
    }
    const key = `c${f.id}`;
    let input = res.sinkUsed.get(key) ?? 0;
    const capIn = chargeSinks.find((x) => x.key === key)?.capWh ?? 0;
    const extra = Math.min(capIn - input, surplus.get(f.regionId) ?? 0);
    if (extra > 0) { input += extra; surplus.set(f.regionId, (surplus.get(f.regionId) ?? 0) - extra); }
    if (input > 0) {
      const stored = Math.floor((input * eff) / PPM);
      f.socWh += stored;
      st.chargeWh += input;
      st.storageLossWh += input - stored;
      f.lastStorageWh = input;
      f.outputKw = 0;
    }
  }
  for (const v of surplus.values()) st.curtailWh += v;
  for (const l of s.lines) {
    const u = res.edgeUse.get(l.id);
    l.lastDir = u ? u.dir : 0;
    l.lastSentWh = u ? u.sentWh : 0;
    l.lastLossWh = u ? u.lossWh : 0;
    st.lineLossWh += l.lastLossWh;
  }
  s.lastDI = st;
}

// 화면 렌더링 (HTML 문자열). 상태를 읽기만 한다. 버튼은 data-* 속성으로 main.ts의 이벤트 위임에 연결된다.

import {
  buildCheck, canRenew, canStart, creditLimit, disposeCost, envIndex, envPriceMinor, facilitySpec, hubCapacityKw, hubUsedKw,
  isStandardRecord, landBuyPrice, licensePrice, licensesOf, lineCheck, lineSpec, loanBalance, mods, neighbors, netWorth,
  quotaKw, quotaUsedKw, recommendations, usageFeePerDay, reliability, renewCost, researchCost, saleValue, solarPpm, supplyHeadroomKw, windPpm,
  annuityPayment, upcomingObligations, type ContractOffer, type Facility, type GameState, type Health, type Line,
} from '../sim/sim';
import {
  CONTRACT, DIFFICULTY, FACILITY_TYPES, LICENSE, LICENSE_NAMES, LOAN, OBJECTIVES, RESEARCH, SCENARIOS, SIZES, STAGES,
  type LicenseType, type SizeId, type TypeId,
} from '../sim/data';
import { demandKw, priceMinor, refSupplyTargetKw } from '../sim/market';
import { clockOf, formatCR, STEPS_PER_DAY } from '../sim/units';

export type View = 'region' | 'contracts' | 'finance' | 'research' | 'automation' | 'goals';
export type Tab = 'gen' | 'storage' | 'substation' | 'line';

export interface UiState {
  view: View;
  selected: number | null;
  tab: Tab;
  genType: TypeId;
  buildSize: SizeId;
  lineTarget: number | null;
  loanAmount: number;
  loanMonths: number;
  offerFilter: 'all' | 'mine';
  speed: number;
  speeds: number[];
}

// ---------- 형식 ----------
export const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const mw = (kw: number) => (kw / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 });
export const mwh = (wh: number) => (wh / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 });
export const cr = (minor: number) => formatCR(minor).replace(' CR', '');
export const price = (minor: number) => (minor / 100).toFixed(2);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const daysLeft = (s: GameState, at: number) => Math.max(0, Math.ceil((at - s.step) / STEPS_PER_DAY));
const pips = (n: number) => `<span class="pips">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;

export function clockText(step: number) {
  const c = clockOf(step);
  return `${c.year}년 ${c.day}일 ${String(c.hh).padStart(2, '0')}:${String(c.mm).padStart(2, '0')}`;
}

// ---------- 아이콘·이미지 ----------
const SOLAR_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="46" cy="16" r="7" fill="none" stroke="#e6c34a" stroke-width="2"/><g stroke="#e6c34a" stroke-width="2"><path d="M46 3v4M46 25v4M33 16h4M55 16h4"/></g><path d="M8 50l10-20h30l-10 20z" fill="#1d2a38" stroke="#4fd1e0" stroke-width="1.5"/><path d="M15 40h31M21 30l-6 20M31 30l-6 20M41 30l-6 20" stroke="#4fd1e0" stroke-width="1" opacity=".6"/><path d="M26 50v6M20 56h12" stroke="#8b95a1" stroke-width="2"/></svg>`;
const LINE_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14 56L22 10h4l8 46M50 56L42 10h-4l-8 46" fill="none" stroke="#8b95a1" stroke-width="2"/><path d="M14 18h16M34 18h16M16 30h12M36 30h12" stroke="#8b95a1" stroke-width="2"/><path d="M4 22q14 10 26-4t30 4" fill="none" stroke="#4fd1e0" stroke-width="1.6"/></svg>`;
const CARD_IMG: Record<TypeId, string | null> = {
  thermal: './assets/card_thermal.webp', wind: './assets/card_wind.webp', solar: null, nuclear: null,
  storage: './assets/card_storage.webp', substation: './assets/card_line.webp',
};
export const img = (t: TypeId) => (CARD_IMG[t] ? `<img src="${CARD_IMG[t]}" alt="">` : `<div class="ph">${SOLAR_SVG}</div>`);

function healthBadge(s: GameState, h: Health): string {
  if (h.s === 'ok') return '';
  const left = daysLeft(s, h.s === 'warning' ? h.failAt : h.until);
  const cls = h.s === 'failed' ? 'bad' : h.s === 'warning' ? 'warn' : 'info';
  const text = h.s === 'warning' ? `점검 필요 · ${left}일 내 고장 예상` : h.s === 'failed' ? `고장 · 복구 ${left}일` : `점검 중 · ${left}일`;
  return `<span class="badge ${cls}">${text}</span>`;
}

function stateBadge(state: 'active' | 'grace' | 'expired', expiresIn: number, warnDays = 30): string {
  if (state === 'grace') return '<span class="badge warn">유예 중</span>';
  if (state === 'expired') return '<span class="badge bad">만료</span>';
  if (expiresIn <= warnDays) return `<span class="badge warn">만료 예정 · ${expiresIn}일</span>`;
  return '';
}

function buildProgress(b: { stage: number; stageStep: number; stageSteps: number[] }) {
  const st = Math.max(0, b.stage);
  const done = b.stageSteps.slice(0, st).reduce((a, x) => a + x, 0) + (b.stage >= 0 ? b.stageStep : 0);
  const total = b.stageSteps.reduce((a, x) => a + x, 0);
  return { stageName: STAGES[st].name, daysLeft: Math.ceil((total - done) / STEPS_PER_DAY), pct: (done / total) * 100 };
}

// ---------- 상단 바 ----------
const NAV: [View, string][] = [['region', '지역'], ['contracts', '계약'], ['finance', '재무'], ['research', '연구'], ['automation', '자동화'], ['goals', '목표']];
const INSOLVENCY_LABEL: Record<string, string> = { normal: '', warning: '유동성 경고', arrears: '연체', restructuring: '구조조정', insolvent: '회생불능', liquidated: '청산' };

export function topBar(s: GameState, ui: UiState): string {
  const last = s.history[s.history.length - 1];
  const net = last ? last.netMinor : 0;
  const rel = reliability(s);
  const recs = recommendations(s).filter((r) => r.priority >= 85).length;
  const ins = INSOLVENCY_LABEL[s.insolvency];
  return `
    <div class="brand">PLANETARY <b>GRID</b></div>
    <div class="sep"></div>
    <div class="stat"><span class="k">게임 시각</span><span class="v num">${clockText(s.step)}</span></div>
    <div class="speed">${ui.speeds.map((v) => `<button data-speed="${v}" class="${v === ui.speed ? 'on' : ''}" title="${v === 0 ? '일시정지 (Space)' : v + '배속'}">${v === 0 ? '❚❚' : v + '×'}</button>`).join('')}</div>
    <nav class="nav">${NAV.map(([k, n]) => `<button data-view="${k}" class="${ui.view === k ? 'on' : ''}">${n}${k === 'automation' && recs ? ` <span class="count">${recs}</span>` : ''}${k === 'contracts' && s.offers.length ? ` <span class="count dim">${s.offers.length}</span>` : ''}</button>`).join('')}</nav>
    <div class="spacer"></div>
    ${ins ? `<span class="badge ${s.insolvency === 'warning' ? 'warn' : 'bad'} big">${ins}</span>` : ''}
    <div class="stat" title="최근 30일 계약 인도량 / 의무량"><span class="k">신뢰도</span><span class="v num">${rel === null ? '—' : pct(rel)}</span></div>
    <div class="stat" title="순자산 ${cr(netWorth(s))} CR"><span class="k">현금</span><span class="v num ${s.cash < 0 ? 'neg' : ''}">${cr(s.cash)}</span></div>
    <div class="stat"><span class="k">어제</span><span class="v num ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${cr(net)}</span></div>
    <div class="sep"></div>
    <div class="menu-btns"><button class="btn ghost small" data-act="save" title="저장">저장</button><button class="btn ghost small" data-act="load" title="불러오기">불러오기</button><button class="btn ghost small" data-act="newgame" title="새 게임">새 게임</button></div>`;
}

// ---------- 지역 목록 ----------
export function regionList(s: GameState, ui: UiState): string {
  return `<h2>지역 시장 <span class="h-note">CR/MWh</span></h2>` + s.regions.map((r, i) => {
    const rs = s.regionState[i];
    const mine = s.facilities.filter((f) => f.regionId === i && f.status === 'operating' && FACILITY_TYPES[f.type].kind === 'gen').reduce((a, f) => a + f.capKw, 0);
    const warn = s.hubs[i].health.s !== 'ok' || s.facilities.some((f) => f.regionId === i && (f.health.s !== 'ok' || !f.rightsOk));
    const lic = s.licenses.some((l) => l.regionId === i && l.state !== 'expired');
    const shock = s.regionDyn[i].supplyShock && s.step >= s.regionDyn[i].supplyShock!.from;
    return `<button class="region-row ${ui.selected === i ? 'selected' : ''}" data-region="${i}">
      <span class="name">${esc(r.name)}${lic ? ' <span class="dot-lic" title="사업권 보유">◆</span>' : ''}${warn ? ' <span class="dot-warn" title="주의 필요">●</span>' : ''}</span><span class="price ${shock ? 'neg' : ''}">${price(rs.priceMinor)}</span>
      <span class="sub"><span>수요 ${mw(rs.demandKw)} MW</span><span>내 발전 ${mw(mine)} MW</span></span>
    </button>`;
  }).join('') + `<div class="note">◆ 사업권 보유 · ● 주의 필요. 가격은 지역 수요와 기존 전력망으로 정해지며 내 발전량은 가격을 바꾸지 않습니다.</div>`;
}

// ---------- 지역 상세 ----------
function facilityRow(s: GameState, f: Facility): string {
  const d = FACILITY_TYPES[f.type];
  let status: string;
  let extra = '';
  if (f.status === 'construction') {
    const p = buildProgress(f);
    status = `건설 중 · ${p.stageName} · ${p.daysLeft}일 남음${f.rightsOk ? '' : ' · <b class="neg">권리 없음 — 공사 중단</b>'}`;
    extra = `<div class="progress"><span style="width:${p.pct}%"></span></div>`;
  } else if (!f.rightsOk) {
    status = '<b class="neg">권리 상실로 정지</b> — 사업권 또는 토지를 확보하세요';
  } else if (d.kind === 'substation') {
    status = `접속 용량 +${mw(f.hubAddKw)} MW`;
  } else if (d.kind === 'storage') {
    const p = f.energyWh ? (f.socWh / f.energyWh) * 100 : 0;
    const mode = f.lastStorageWh > 0 ? `충전 ${mw(f.lastStorageWh / 250)} MW` : f.lastStorageWh < 0 ? `방전 ${mw(-f.lastStorageWh / 250)} MW` : '대기';
    status = `${mode} · 저장량 ${mwh(f.socWh)} / ${mwh(f.energyWh)} MWh`;
    extra = `<div class="progress soc"><span style="width:${p}%"></span></div>
      <div class="thr"><span>충전 ≤ <b class="num">${price(f.chargeAtMinor)}</b></span><button class="btn tiny" data-thr="${f.id}:c:-500">−</button><button class="btn tiny" data-thr="${f.id}:c:500">+</button>
        <span>방전 ≥ <b class="num">${price(f.dischargeAtMinor)}</b></span><button class="btn tiny" data-thr="${f.id}:d:-500">−</button><button class="btn tiny" data-thr="${f.id}:d:500">+</button>
        ${s.automation.locks[`f${f.id}`] !== undefined ? '<span class="badge info">수동 고정</span>' : ''}</div>`;
  } else {
    status = f.online ? `가동 · ${mw(f.outputKw)} / ${mw(f.capKw)} MW` : '정지';
  }
  const land = f.land.mode === 'own' ? '토지 소유' : `임대 ${cr(f.land.rentPerDayMinor)} CR/일 · ${daysLeft(s, f.land.expiresAt)}일 ${stateBadge(f.land.state, daysLeft(s, f.land.expiresAt))}`;
  let acts = '';
  if (f.status === 'construction') acts = `<button class="btn small danger" data-cancel="${f.id}">취소</button>`;
  else {
    if (d.kind === 'gen') acts += `<button class="btn small" data-toggle="${f.id}">${f.online ? '정지' : '가동'}</button>`;
    acts += `<details class="more"><summary class="btn small">⋯</summary><div class="menu">
      ${f.land.mode === 'lease' ? `<button class="btn small" data-landbuy="${f.id}">토지 매입 ${cr(landBuyPrice(f.land))}</button>` : ''}
      ${f.land.mode === 'lease' && f.land.state !== 'expired' ? `<button class="btn small" data-leaserenew="${f.id}">임대 갱신 (+10%)</button>` : ''}
      <button class="btn small" data-sell="${f.id}">매각 +${cr(saleValue(f))}</button>
      <button class="btn small danger" data-dispose="${f.id}">폐기 −${cr(disposeCost(f))}</button></div></details>`;
  }
  if (f.health.s === 'warning') acts = `<button class="btn small warn" data-inspect="facility:${f.id}">점검</button>` + acts;
  return `<div class="fac">${img(f.type)}<div><div class="t">${SIZES[f.size].name} ${d.name} ${healthBadge(s, f.health)}</div><div class="s">${status}</div><div class="s faint">${land}</div>${extra}</div><div class="acts">${acts}</div></div>`;
}

function lineRow(s: GameState, l: Line, here: number): string {
  const other = l.a === here ? l.b : l.a;
  let status: string;
  let extra = '';
  if (l.status === 'construction') {
    const p = buildProgress(l);
    status = `건설 중 · ${p.stageName} · ${p.daysLeft}일 남음`;
    extra = `<div class="progress"><span style="width:${p.pct}%"></span></div>`;
  } else if (!l.rightsOk) {
    status = '<b class="neg">송전 사업권 없음 — 정지</b>';
  } else {
    const util = (l.lastSentWh / (l.capKw * 250)) * 100;
    const outward = (l.lastDir === 1 && l.a === here) || (l.lastDir === -1 && l.b === here);
    const dir = l.lastSentWh === 0 ? '흐름 없음' : outward ? `→ 송전 ${mw(l.lastSentWh / 250)} MW` : `← 수전 ${mw((l.lastSentWh - l.lastLossWh) / 250)} MW`;
    status = `${dir} · 이용률 ${util.toFixed(0)}%`;
    extra = `<div class="progress line"><span style="width:${Math.min(100, util)}%"></span></div>`;
  }
  let acts = l.status === 'construction' ? `<button class="btn small danger" data-cancelline="${l.id}">취소</button>` : '';
  if (l.health.s === 'warning') acts = `<button class="btn small warn" data-inspect="line:${l.id}">점검</button>`;
  return `<div class="fac"><div class="ph">${LINE_SVG}</div><div><div class="t">${esc(s.regions[other].name)} 연결 · ${SIZES[l.size].name} ${healthBadge(s, l.health)}</div>
    <div class="s">${mw(l.capKw)} MW · ${l.lengthKm.toLocaleString()} km · 손실 ${(l.lossPpm / 10_000).toFixed(1)}% · ${status}</div>${extra}</div><div class="acts">${acts}</div></div>`;
}

function licenseSection(s: GameState, ri: number): string {
  const rows = (['GEN', 'STO', 'TRN', 'RET'] as LicenseType[]).map((t) => {
    const ls = licensesOf(s, ri, t, ['active', 'grace', 'expired']).filter((l) => l.state !== 'expired' || l.expiresAt + (LICENSE.termDays + LICENSE.graceDays) * STEPS_PER_DAY > s.step);
    const quota = t === 'GEN' || t === 'STO' ? `${mw(quotaUsedKw(s, ri, t))} / ${mw(quotaKw(s, ri, t))} MW` : ls.some((l) => l.state !== 'expired') ? '보유' : '없음';
    const own = ls.map((l) => {
      const left = daysLeft(s, l.expiresAt);
      return `<div class="lic-item">${SIZES[l.size].name}${t === 'GEN' || t === 'STO' ? ` ${mw(l.quotaKw)} MW` : ''} · ${l.state === 'active' ? `${left}일` : ''} ${stateBadge(l.state, left)}
        · 기본 수수료 ${cr(l.feePerDayMinor)}/일 ${canRenew(s, l) ? `<button class="btn tiny" data-renew="${l.id}">갱신 ${cr(renewCost(s, l))}</button>` : ''}</div>`;
    }).join('');
    const buy = (t === 'GEN' || t === 'STO' ? (['small', 'medium', 'large'] as SizeId[]) : (['small'] as SizeId[])).map((z) => {
      const p = licensePrice(s, ri, t, z);
      const label = t === 'GEN' || t === 'STO' ? `${SIZES[z].name} ${mw(p.quotaKw)}MW` : '취득';
      return `<button class="btn tiny" data-lic="${ri}:${t}:${z}" title="취득가 ${cr(p.priceMinor)} CR · 기본 수수료 ${cr(p.feePerDayMinor)} CR/일${p.perMwFeeMinor ? ` + 지은 MW당 ${cr(p.perMwFeeMinor)} CR/일` : ''} · 기간 ${LICENSE.termDays}일">${label} ${cr(p.priceMinor)}</button>`;
    }).join('');
    const showBuy = t === 'GEN' || t === 'STO' || !ls.some((l) => l.state !== 'expired');
    const useFee = t === 'GEN' || t === 'STO' ? usageFeePerDay(s, ri, t) : 0;
    return `<div class="lic"><div class="lic-head"><b>${LICENSE_NAMES[t]}</b><span class="num">${quota}</span></div>${own}${useFee ? `<div class="lic-item">사용 수수료 ${cr(useFee)}/일 (지은 MW × ${cr(licensePrice(s, ri, t, 'small').perMwFeeMinor)})</div>` : ''}${showBuy ? `<div class="lic-buy">${buy}</div>` : ''}</div>`;
  }).join('');
  return `<div class="section"><h3>사업권 <span class="h-note">기간 ${LICENSE.termDays}일 · 유예 ${LICENSE.graceDays}일</span></h3>${rows}
    <div class="note">발전·저장 사업권은 지을 수 있는 정격 용량 한도를 줍니다. 송전 사업권은 변전소와 송전선(양쪽 지역)에, 소매 공급 사업권은 직접 공급 계약에 필요합니다.</div></div>`;
}

function forecastChart(s: GameState, ri: number): string {
  const r = s.regions[ri];
  const pts: number[] = [];
  for (let h = 0; h < 24; h++) {
    const st = s.step + h * 60;
    pts.push(priceMinor(r.pBaseMinor, refSupplyTargetKw(r), demandKw(r, st, s.rules.m.demandGrowth)));
  }
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const W = 340, H = 56;
  const xy = pts.map((p, i) => `${(i / 23) * W},${H - 6 - ((p - lo) / Math.max(1, hi - lo)) * (H - 14)}`).join(' ');
  return `<div class="forecast"><div class="bar-row"><span>24시간 가격 예측 (수요 예측 연구)</span><span class="num">${price(lo)} – ${price(hi)}</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${xy}" fill="none" stroke="var(--amber)" stroke-width="2"/></svg></div>`;
}

function buildSection(s: GameState, ui: UiState, ri: number): string {
  const tabs: [Tab, string][] = [['gen', '발전'], ['storage', '저장'], ['substation', '변전소'], ['line', '송전선']];
  const head = `<div class="seg tabs">${tabs.map(([k, n]) => `<button data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  const sizes = `<div class="seg">${(['small', 'medium', 'large'] as SizeId[]).map((z) => `<button data-size="${z}" class="${z === ui.buildSize ? 'on' : ''}">${SIZES[z].name}</button>`).join('')}</div>`;
  if (ui.tab === 'line') {
    const nb = neighbors(s.regions)[ri];
    const target = ui.lineTarget !== null && nb.includes(ui.lineTarget) ? ui.lineTarget : nb[0];
    const spec = lineSpec(s, ri, target, ui.buildSize);
    const why = lineCheck(s, ri, target, ui.buildSize);
    return head + `<div class="targets">${nb.map((j) => `<button class="target ${j === target ? 'on' : ''}" data-target="${j}"><span>${esc(s.regions[j].name)}</span><span class="num">${price(s.regionState[j].priceMinor)}</span></button>`).join('')}</div>` + sizes + `
      <div class="quote">
        <span class="k">연결</span><span class="v">${esc(s.regions[ri].name)} ↔ ${esc(s.regions[target].name)}</span>
        <span class="k">용량 (송전단)</span><span class="v">${mw(spec.capKw)} MW</span>
        <span class="k">길이 · 손실률</span><span class="v">${spec.lengthKm.toLocaleString()} km · ${(spec.lossPpm / 10_000).toFixed(1)}%</span>
        <span class="k">건설비 · 공사</span><span class="v">${cr(spec.capexMinor)} CR · ${spec.buildDays}일</span>
      </div>
      <button class="btn primary wide" data-act="buildline" data-line="${target}" ${why ? 'disabled' : ''}>${why ?? '송전선 건설 승인'}</button>
      <div class="note">이웃 지역끼리만 연결합니다. 전력은 손실을 빼고도 더 비싸게 팔리는 곳으로 자동 배분됩니다. 지역마다 시간대가 달라 저녁 피크 지역에 팔 수 있습니다.</div>`;
  }
  const type: TypeId = ui.tab === 'gen' ? ui.genType : ui.tab;
  const def = FACILITY_TYPES[type];
  const spec = facilitySpec(s, type, ui.buildSize);
  const why = buildCheck(s, ri, type, ui.buildSize);
  const cards = ui.tab === 'gen'
    ? `<div class="cards">${(['solar', 'wind', 'thermal'] as TypeId[]).map((t) => `<button class="card ${t === ui.genType ? 'on' : ''}" data-gentype="${t}">${img(t)}<div class="cn">${FACILITY_TYPES[t].name}</div></button>`).join('')}</div>`
    : `<div class="cards one"><div class="card on">${img(type)}<div class="cn">${def.name}</div></div></div>`;
  const rows: [string, string][] = [];
  rows.push(def.kind === 'substation' ? ['접속 용량 증설', `+${mw(spec.hubAddKw)} MW`] : ['정격 출력', `${mw(spec.capKw)} MW`]);
  if (def.kind === 'storage') rows.push(['저장 용량', `${mwh(spec.energyWh)} MWh`], ['왕복 효율', `${(((0.9 + mods(s).effAddPpm / 1e6) ** 2) * 100).toFixed(0)}%`]);
  rows.push(['건설비 · 공사', `${cr(spec.capexMinor)} CR · ${spec.buildDays}일`], ['유지비', `${cr(spec.fixedMinorPerDay)} CR/일`]);
  if (def.kind === 'gen') rows.push(['연료비', def.fuelMinorPerMWh ? `${((def.fuelMinorPerMWh * s.fuelMult * mods(s).fuel) / 100).toFixed(1)} CR/MWh` : '없음'], ['출력 특성', def.dispatchable ? '조절 가능' : type === 'solar' ? '낮에만' : '바람에 따라']);
  if (type === 'thermal') rows.push(['환경 영향', `높음 (지표 ${envIndex(s, ri).toFixed(2)})`]);
  const notes: Record<string, string> = {
    gen: '승인 시 건설비가 예약되고 6단계마다 청구됩니다. 부지는 자동으로 임대됩니다(보증금 30일분). 시운전 단계부터 출력 50%로 판매합니다.',
    storage: '가격이 충전 기준 이하일 때 내 발전으로 충전하고, 방전 기준 이상이거나 계약 공급이 부족할 때 방전합니다.',
    substation: '변전소는 이 지역의 접속 용량을 늘립니다. 송전 사업권이 필요합니다.',
  };
  return head + cards + sizes + `<div class="quote">${rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('')}</div>
    <button class="btn primary wide" data-act="build" ${why ? 'disabled' : ''}>${why ?? '건설 승인'}</button>
    <div class="note">${notes[ui.tab]}</div>`;
}

export function regionView(s: GameState, ui: UiState): string {
  if (ui.selected === null) {
    return `<h2>시작하기</h2>
      <ol class="steps"><li>왼쪽 목록이나 행성 위에서 <b>지역</b>을 고릅니다.</li><li><b>발전 사업권</b>(소형)을 취득합니다.</li><li>짧은 공기의 <b>소형 태양광(5일)</b>이나 <b>소형 열발전(10일)</b>을 짓습니다.</li><li>계약 화면에서 <b>PPA</b>를 맺으면 안정적인 수익이 생깁니다.</li><li>이웃 지역과 <b>송전선</b>을 이어 저녁 피크에 비싸게 팝니다.</li></ol>
      <p class="note">공간: 일시정지 · 숫자 1–4: 배속 · 행성은 끌어서 돌리고 휠로 확대합니다.</p>`;
  }
  const ri = ui.selected;
  const r = s.regions[ri];
  const rs = s.regionState[ri];
  const dyn = s.regionDyn[ri];
  const usePct = rs.capWh ? Math.min(100, (rs.soldWh / rs.capWh) * 100) : 0;
  const facs = s.facilities.filter((f) => f.regionId === ri);
  const lines = s.lines.filter((l) => l.a === ri || l.b === ri);
  const hubCap = hubCapacityKw(s, ri);
  const hubUsed = hubUsedKw(s, ri);
  const env = envIndex(s, ri);
  const events = [
    dyn.supplyShock ? `<span class="badge ${s.step >= dyn.supplyShock.from ? 'bad' : 'warn'}">공급 충격 ×${dyn.supplyShock.mult.toFixed(2)} ${s.step >= dyn.supplyShock.from ? `· ${daysLeft(s, dyn.supplyShock.to)}일` : '예고'}</span>` : '',
    dyn.demandShock ? `<span class="badge warn">수요 ×${dyn.demandShock.mult.toFixed(2)} ${s.step >= dyn.demandShock.from ? `· ${daysLeft(s, dyn.demandShock.to)}일` : '예고'}</span>` : '',
    dyn.pendingReg ? `<span class="badge warn">규제 예고: 환경 단가 ×${(dyn.pendingReg.mult / dyn.envPriceMult).toFixed(2)} · ${daysLeft(s, dyn.pendingReg.at)}일 후</span>` : '',
  ].join('');
  return `
    <div class="detail-title"><h1>${esc(r.name)}</h1><span class="coord">${r.lat.toFixed(1)}°, ${r.lon.toFixed(1)}° · 현지 ${String(Math.floor(((s.step + Math.round(r.lon * 4)) % 1440 + 1440) % 1440 / 60)).padStart(2, '0')}시</span></div>
    ${events ? `<div class="events">${events}</div>` : ''}
    <div class="kv">
      <div><div class="k">시장 가격</div><div class="v num" style="color:var(--amber)">${price(rs.priceMinor)}</div></div>
      <div><div class="k">수요</div><div class="v num">${mw(rs.demandKw)} MW</div></div>
      <div><div class="k">기준가</div><div class="v num">${(r.pBaseMinor / 100).toFixed(0)}</div></div>
    </div>
    <div class="res"><span>일사 ${pips(r.solar)} <b class="num">${Math.round(solarPpm(r, s.step) / 10_000)}%</b></span><span>풍황 ${pips(r.wind)} <b class="num">${Math.round(windPpm(r, s.seed, s.step) / 10_000)}%</b></span><span>토지 ${cr(r.landRentPerMwDayMinor)} CR/MW·일</span></div>
    ${mods(s).forecast ? forecastChart(s, ri) : ''}
    <div class="bar-row"><span>접속 용량 ${healthBadge(s, s.hubs[ri].health)}</span><span class="num">${mw(hubUsed)} / ${mw(hubCap)} MW</span></div>
    <div class="meter"><span style="width:${Math.min(100, (hubUsed / hubCap) * 100)}%;background:var(--safety)"></span></div>
    ${s.hubs[ri].health.s === 'warning' ? `<button class="btn small warn" style="margin-top:6px" data-inspect="hub:${ri}">접속점 점검</button>` : ''}
    <div class="bar-row"><span>이 지역 판매 / 판매 한도 (σ = 1.0)</span><span class="num">${usePct.toFixed(1)}%</span></div>
    <div class="meter"><span style="width:${usePct}%"></span></div>
    <div class="bar-row"><span>환경 지표 (30일) · 단가 ${price(envPriceMinor(s, ri))} CR/단위</span><span class="num ${env > 1 ? 'neg' : env > 0.8 ? 'warn-t' : ''}">${env.toFixed(2)}</span></div>
    <div class="meter"><span style="width:${Math.min(100, env * 100)}%;background:${env > 1 ? 'var(--negative)' : env > 0.8 ? 'var(--amber)' : 'var(--positive)'}"></span></div>
    ${licenseSection(s, ri)}
    <div class="section"><h3>내 시설 (${facs.length})</h3>${facs.length === 0 ? '<div class="note">아직 시설이 없습니다.</div>' : facs.map((f) => facilityRow(s, f)).join('')}</div>
    <div class="section"><h3>송전선 (${lines.length})</h3>${lines.length === 0 ? '<div class="note">연결된 송전선이 없습니다.</div>' : lines.map((l) => lineRow(s, l, ri)).join('')}</div>
    <div class="section"><h3>건설</h3>${buildSection(s, ui, ri)}</div>`;
}

// ---------- 계약 ----------
const PROFILE_NAME = (o: ContractOffer) => (o.kind === 'ppa' ? (o.shapePpm[0] === 0 ? '주간(07–19시)' : '24시간 평탄') : o.shapePpm[0] < 1_000_000 ? '상업 부하(주간 중심)' : '산업 부하(평탄)');

export function contractsView(s: GameState, ui: UiState): string {
  const rel = reliability(s);
  const active = s.contracts.filter((c) => !c.done);
  const doneList = s.contracts.filter((c) => c.done).slice(-6).reverse();
  const myRegions = new Set([...s.facilities.map((f) => f.regionId), ...s.licenses.map((l) => l.regionId)]);
  const offers = s.offers.filter((o) => ui.offerFilter === 'all' || myRegions.has(o.regionId)).sort((a, b) => a.regionId - b.regionId || a.id - b.id);
  const lambda = (o: ContractOffer) => (o.kind === 'ppa' ? CONTRACT.lambdaPpm.ppa : o.critical ? CONTRACT.lambdaPpm.critical : CONTRACT.lambdaPpm.direct) / 1e6;
  return `<h2>계약</h2>
    <div class="kv"><div><div class="k">공급 신뢰도 (30일)</div><div class="v num">${rel === null ? '—' : pct(rel)}</div></div>
      <div><div class="k">진행 중</div><div class="v num">${active.length}건</div></div><div><div class="k">완료</div><div class="v num">${s.completedContracts}건</div></div></div>
    <div class="section"><h3>진행 중인 계약</h3>${active.length === 0 ? '<div class="note">계약이 없습니다. 아래 제안을 수락하세요.</div>' : active.map((c) => {
      const prog = Math.min(1, Math.max(0, (s.step - c.startStep) / (c.endStep - c.startStep)));
      const rate = c.obligationWh ? c.deliveredWh / c.obligationWh : 1;
      const last = c.lastObligationWh ? c.lastDeliveredWh / c.lastObligationWh : 1;
      return `<div class="contract ${c.critical ? 'critical' : ''}"><div class="c-head"><b>${esc(s.regions[c.regionId].name)}</b> <span class="badge ${c.kind === 'ppa' ? 'info' : 'warn'}">${c.kind === 'ppa' ? 'PPA' : c.critical ? '직접 공급 · 핵심 부하' : '직접 공급'}</span><span class="num right">${mw(c.mwKw)} MW · ${price(c.priceMinor)}</span></div>
        <div class="s">${PROFILE_NAME(c)} · 남은 ${daysLeft(s, c.endStep)}일 · 이행률 <b class="${rate < 0.98 ? 'neg' : 'pos'}">${pct(rate)}</b> · 지금 ${pct(last)} · 수익 ${cr(c.revenueMinor)} · 위약금 <span class="${c.penaltyMinor ? 'neg' : ''}">${cr(c.penaltyMinor)}</span></div>
        <div class="progress"><span style="width:${prog * 100}%"></span></div></div>`;
    }).join('')}</div>
    <div class="section"><h3>제안 <span class="h-note">${CONTRACT.offerEveryDays}일마다 새 제안 · ${CONTRACT.offerExpireDays}일 후 만료</span></h3>
      <div class="seg small-seg"><button data-offerfilter="all" class="${ui.offerFilter === 'all' ? 'on' : ''}">전체 (${s.offers.length})</button><button data-offerfilter="mine" class="${ui.offerFilter === 'mine' ? 'on' : ''}">내 지역</button></div>
      ${offers.length === 0 ? '<div class="note">해당하는 제안이 없습니다.</div>' : offers.map((o) => {
        const needRet = o.kind === 'direct' && licensesOf(s, o.regionId, 'RET').length === 0;
        const head = supplyHeadroomKw(s, o.regionId);
        const risky = head < o.mwKw;
        const vsBase = o.priceMinor / s.regions[o.regionId].pBaseMinor;
        return `<div class="contract offer"><div class="c-head"><b>${esc(s.regions[o.regionId].name)}</b> <span class="badge ${o.kind === 'ppa' ? 'info' : 'warn'}">${o.kind === 'ppa' ? 'PPA' : o.critical ? '직접 공급 · 핵심 부하' : '직접 공급'}</span><span class="num right">${mw(o.mwKw)} MW · ${price(o.priceMinor)} (기준가 ×${vsBase.toFixed(2)})</span></div>
          <div class="s">${PROFILE_NAME(o)} · ${o.termDays}일 · 부족 시 위약금 λ = ${lambda(o)} · 제안 만료 ${daysLeft(s, o.expiresAt)}일</div>
          ${risky ? `<div class="s warn-t">무리한 계약 경고: 이 지역과 연결 지역의 공급 여력 ${mw(Math.max(0, head))} MW</div>` : ''}
          <div class="c-acts"><button class="btn small primary" data-accept="${o.id}" ${risky ? 'data-risky="1"' : ''} ${needRet ? 'disabled' : ''}>${needRet ? '소매 공급 사업권 필요' : '수락'}</button></div></div>`;
      }).join('')}</div>
    ${doneList.length ? `<div class="section"><h3>최근 완료</h3>${doneList.map((c) => `<div class="s">${esc(s.regions[c.regionId].name)} ${c.kind === 'ppa' ? 'PPA' : '직접 공급'} ${mw(c.mwKw)} MW — 이행률 ${pct(c.obligationWh ? c.deliveredWh / c.obligationWh : 1)}, 수익 ${cr(c.revenueMinor)}, 위약금 ${cr(c.penaltyMinor)}</div>`).join('')}</div>` : ''}
    <div class="note">계약 물량은 시장 판매보다 먼저 공급됩니다(핵심 부하 → 계약 → 시장). 부족분 위약금 = 부족량 × [max(시장가 − 계약가, 0) + λ × 계약가] 이므로, 계약 물량을 시장에 돌려 팔아도 이득이 없습니다.</div>`;
}

// ---------- 재무 ----------
const ACCOUNT_NAME: Record<string, string> = {
  revenue_market: '시장 판매', revenue_contract: '계약 수익', fuel: '연료', opex: '유지비', license: '사업권', land: '토지 임대료',
  interest: '이자', penalty: '위약금', research: '연구', env: '환경 비용', repair: '수리·점검', capex: '건설', land_asset: '토지·보증금',
  loan: '대출 원금', sale: '시설 매각', disposal: '폐기', refund: '취소 환불', equity: '자본', bailout: '구제',
};

function sparkline(values: number[], color: string): string {
  if (values.length < 2) return '';
  const lo = Math.min(...values), hi = Math.max(...values);
  const W = 460, H = 70;
  const xy = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 4 - ((v - lo) / Math.max(1, hi - lo)) * (H - 10)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark"><polyline points="${xy}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
}

export function financeView(s: GameState, ui: UiState): string {
  const since = s.step - 30 * STEPS_PER_DAY;
  const flows = new Map<string, number>();
  for (const e of s.ledger) {
    if (e.step < since) continue;
    if (e.debit === 'cash') flows.set(e.credit, (flows.get(e.credit) ?? 0) + e.amount);
    else if (e.credit === 'cash') flows.set(e.debit, (flows.get(e.debit) ?? 0) - e.amount);
  }
  const rows = [...flows].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
  const limit = creditLimit(s);
  const amount = Math.min(ui.loanAmount, Math.max(0, limit));
  const pay = amount > 0 ? annuityPayment(amount, Math.round(LOAN.baseRatePpmPerYear * s.rules.m.loanRate), ui.loanMonths) : 0;
  const ins = s.insolvency;
  const salePlan = ins === 'arrears' || ins === 'restructuring' || ins === 'insolvent'
    ? `<div class="section"><h3>구조조정 계획 (매각 후보)</h3>${s.facilities.filter((f) => f.status === 'operating').map((f) => ({ f, v: saleValue(f), daily: f.fixedMinorPerDay })).sort((a, b) => b.v - a.v).slice(0, 5).map(({ f, v }) => `<div class="s">${esc(s.regions[f.regionId].name)} ${FACILITY_TYPES[f.type].name} #${f.id} — 매각 +${cr(v)} CR <button class="btn tiny" data-sell="${f.id}">매각</button></div>`).join('') || '<div class="note">매각할 시설이 없습니다.</div>'}</div>` : '';
  return `<h2>재무</h2>
    <div class="kv">
      <div><div class="k">현금</div><div class="v num ${s.cash < 0 ? 'neg' : ''}">${cr(s.cash)}</div></div>
      <div><div class="k">순자산</div><div class="v num">${cr(netWorth(s))}</div></div>
      <div><div class="k">부채</div><div class="v num">${cr(loanBalance(s))}</div></div>
    </div>
    <div class="kv">
      <div><div class="k">7일 의무 지출</div><div class="v num">${cr(upcomingObligations(s))}</div></div>
      <div><div class="k">대출 한도</div><div class="v num">${cr(limit)}</div></div>
      <div><div class="k">상태</div><div class="v">${INSOLVENCY_LABEL[ins] || '정상'}</div></div>
    </div>
    ${ins === 'insolvent' && s.rules.insolvency === 'bailout' ? `<div class="alert bad">회생불능입니다. 구제를 신청하면 부채가 60개월 저리 대출로 재조정되고 현금이 0이 됩니다 (기록에 남음). <button class="btn small primary" data-act="bailout">구제 신청</button></div>` : ''}
    ${ins === 'restructuring' ? `<div class="alert bad">구조조정 중 — ${daysLeft(s, s.restructureUntil)}일 안에 연체와 음수 현금을 해소하세요.</div>` : ''}
    ${salePlan}
    <div class="section"><h3>순자산·현금 추이 (최근 ${s.history.length}일)</h3>${sparkline(s.history.map((h) => h.netWorth), 'var(--energy)')}${sparkline(s.history.map((h) => h.cash), 'var(--amber)')}
      <div class="legend"><span class="lg energy">순자산</span><span class="lg amber">현금</span></div></div>
    <div class="section"><h3>최근 30일 현금 흐름</h3><div class="pl">${rows.map(([k, v]) => `<span>${ACCOUNT_NAME[k] ?? k}</span><span class="num ${v < 0 ? 'neg' : 'pos'}">${v > 0 ? '+' : ''}${cr(v)}</span>`).join('')}</div></div>
    <div class="section"><h3>대출 (${s.loans.length})</h3>${s.loans.map((l) => `<div class="fac nogrid"><div><div class="t">#${l.id} · 잔액 ${cr(l.balanceMinor)} CR ${l.arrearsMinor ? `<span class="badge bad">연체 ${cr(l.arrearsMinor)}</span>` : ''}</div>
        <div class="s">월 ${cr(l.paymentMinor)} · 연 ${(l.ratePpmPerYear / 1e4).toFixed(1)}% · ${l.paidMonths}/${l.months}회 · 다음 상환 ${daysLeft(s, l.nextDueStep)}일 후</div></div><div class="acts"><button class="btn small" data-repay="${l.id}">조기 상환</button></div></div>`).join('') || '<div class="note">대출이 없습니다.</div>'}
      <div class="loan-form"><div class="seg">${[100_000_00, 300_000_00, 1_000_000_00, 3_000_000_00].map((v) => `<button data-loanamt="${v}" class="${ui.loanAmount === v ? 'on' : ''}">${cr(v)}</button>`).join('')}</div>
        <div class="seg">${LOAN.terms.map((m) => `<button data-loanmonths="${m}" class="${ui.loanMonths === m ? 'on' : ''}">${m}개월</button>`).join('')}</div>
        <div class="quote"><span class="k">금액</span><span class="v">${cr(amount)} CR</span><span class="k">월 상환 (원리금 균등)</span><span class="v">${cr(pay)} CR</span><span class="k">연이율 (게임년 120일)</span><span class="v">${((LOAN.baseRatePpmPerYear * s.rules.m.loanRate) / 1e4).toFixed(1)}%</span></div>
        <button class="btn primary wide" data-act="loan" ${amount <= 0 ? 'disabled' : ''}>${amount <= 0 ? '대출 한도 없음' : '대출 실행'}</button></div>
      <div class="note">한도 = 기본 신용 ${cr(LOAN.baseCreditMinor)} + 운영 시설 장부가 50% + 소유 토지 70% − 대출 잔액. 상환에 실패하면 연체 → 30일 후 구조조정으로 넘어가며, 즉시 게임오버는 없습니다.</div></div>`;
}

// ---------- 연구 ----------
export function researchView(s: GameState): string {
  const branches = [...new Set(RESEARCH.map((r) => r.branch))];
  return `<h2>연구 <span class="h-note">동시 2개 · 하루 투자는 (비용 ÷ 최소 기간)까지</span></h2>
    <div class="research">${branches.map((b) => `<div class="branch"><h3>${b}</h3>${RESEARCH.filter((r) => r.branch === b).map((n) => {
      const done = s.research.done.includes(n.id);
      const act = s.research.active.find((a) => a.id === n.id);
      const cost = researchCost(s, n.id);
      const why = canStart(s, n.id);
      const perDay = Math.ceil(cost / n.minDays);
      let body: string;
      if (done) body = '<span class="badge info">완료</span>';
      else if (act) body = `<div class="progress"><span style="width:${(act.investedMinor / cost) * 100}%"></span></div><div class="s">${cr(act.investedMinor)} / ${cr(cost)} · 하루 ${cr(Math.min(act.dailyBudgetMinor, perDay))}</div>`;
      else body = `<button class="btn tiny ${why ? '' : 'primary'}" data-research="${n.id}:${perDay}" ${why ? 'disabled' : ''}>${why ?? `시작 (하루 ${cr(perDay)})`}</button>`;
      return `<div class="node ${done ? 'done' : act ? 'active' : why ? 'locked' : ''}"><div class="t">${n.name} <span class="tier">${'Ⅰ Ⅱ Ⅲ'.split(' ')[n.tier - 1]}</span></div><div class="s">${n.effect}</div><div class="s faint">${cr(cost)} CR · 최소 ${n.minDays}일</div>${body}</div>`;
    }).join('')}</div>`).join('')}</div>
    <div class="note">효과는 신규 건설에 적용됩니다(연료비·복구 기간·환경 비용·자동화는 즉시 전체 적용). 모든 효과는 상한이 있어 손실률은 0 미만, 효율은 100%를 넘지 않습니다.</div>`;
}

// ---------- 자동화 ----------
export function automationView(s: GameState): string {
  const a = s.automation;
  const ops = mods(s).autoOps;
  const recs = recommendations(s);
  const pol = (key: 'autoRenew' | 'autoInspect' | 'autoStorage', name: string, desc: string, needs?: string) => `
    <div class="policy ${needs ? 'locked' : ''}"><div><div class="t">${name}</div><div class="s">${desc}${needs ? ` <span class="badge warn">${needs}</span>` : ''}</div></div>
      <button class="switch ${a[key] ? 'on' : ''}" data-policy="${key}" ${needs ? 'disabled' : ''}><span></span></button></div>`;
  return `<h2>자동화 <span class="h-note">기본은 추천 · 켠 정책만 자동 실행</span></h2>
    ${pol('autoRenew', '사업권·토지 자동 갱신', '만료 7일 전(또는 유예 중)에 갱신합니다. 일일 예산 안에서만.')}
    ${pol('autoInspect', '예방 점검 자동 실행', '고장 전조(점검 필요)가 보이면 바로 점검합니다.', ops ? undefined : '연구 "자동 운영" 필요')}
    ${pol('autoStorage', '저장 기준 가격 자동 조정', '최근 7일 지역 가격의 하위 30%에서 충전, 상위 25%에서 방전하도록 매일 조정합니다. 수동으로 바꾼 시설은 1일 동안 건드리지 않습니다.', ops ? undefined : '연구 "자동 운영" 필요')}
    <div class="quote"><span class="k">자동화 일일 예산</span><span class="v">${cr(a.dailyBudgetMinor)} CR <button class="btn tiny" data-budget="-100000">−</button><button class="btn tiny" data-budget="100000">+</button></span>
      <span class="k">오늘 사용 · 행동 수</span><span class="v">${cr(a.spentTodayMinor)} CR · ${a.actionsToday}회</span></div>
    <div class="section"><h3>추천 (${recs.length})</h3>${recs.length === 0 ? '<div class="note">지금은 추천할 일이 없습니다.</div>' : recs.map((r) => `
      <div class="rec p${r.priority >= 85 ? 'hi' : r.priority >= 60 ? 'mid' : 'lo'}"><div><div class="t">${esc(r.title)}</div><div class="s">근거: ${esc(r.reason)} · 효과: ${esc(r.effect)}${r.costMinor ? ` · 비용 ${cr(r.costMinor)} CR` : ''}</div></div>
        ${r.cmd ? `<button class="btn small" data-rec="${esc(r.id)}">실행</button>` : r.view ? `<button class="btn small" data-view="${r.view}"${r.region !== undefined ? ` data-goto="${r.region}"` : ''}>열기</button>` : '<span class="s faint">직접 판단</span>'}</div>`).join('')}</div>
    <div class="note">자동 실행도 직접 내린 명령과 같은 검증을 거칩니다. 같은 대상에 하루 한 번만 실행하고, 같은 이유로 3번 실패하면 멈추고 알립니다.</div>`;
}

// ---------- 목표·기록 ----------
export function goalsView(s: GameState): string {
  const standard = isStandardRecord(s);
  const preset = s.rules.preset === 'custom' ? '사용자 지정' : DIFFICULTY[s.rules.preset].name;
  const scen = s.rules.scenario === 'custom' ? '사용자 지정' : SCENARIOS[s.rules.scenario].name;
  return `<h2>목표 <span class="h-note">선택 목표 · 달성해도 게임은 계속됩니다</span></h2>
    <div class="goals">${OBJECTIVES.map((o) => {
      const d = s.objectivesDone[o.id];
      return `<div class="goal ${d !== undefined ? 'done' : ''}"><span class="mark">${d !== undefined ? '✓' : '○'}</span><span>${o.name}</span><span class="s faint">${d !== undefined ? `${d + 1}일차 달성` : ''}</span></div>`;
    }).join('')}</div>
    <div class="section"><h3>기록</h3><div class="quote">
      <span class="k">기록 분류</span><span class="v">${standard ? '표준 규칙' : '사용자 지정 규칙'}</span>
      <span class="k">난이도 · 시작</span><span class="v">${preset} · ${scen}</span>
      <span class="k">진행</span><span class="v">${Math.floor(s.step / STEPS_PER_DAY)}일</span>
      <span class="k">순자산</span><span class="v">${cr(netWorth(s))} CR</span>
      <span class="k">발전 설비</span><span class="v">${mw(s.facilities.filter((f) => f.status === 'operating' && FACILITY_TYPES[f.type].kind === 'gen').reduce((a, f) => a + f.capKw, 0))} MW</span>
      <span class="k">구제</span><span class="v">${s.bailouts}회</span>
      <span class="k">시드</span><span class="v">${s.seed}</span>
    </div></div>`;
}

// ---------- 새 게임 ----------
export interface NewGameForm { scenario: 'A' | 'B' | 'C' | 'custom'; preset: 'easy' | 'standard' | 'hard'; seed: number; cash: number; insolvency: 'bailout' | 'liquidation' | 'none'; hasSave: boolean }

export function newGameView(f: NewGameForm): string {
  const scen = (['A', 'B', 'C'] as const).map((k) => `<button class="scenario ${f.scenario === k ? 'on' : ''}" data-ng-scenario="${k}"><b>${k}. ${SCENARIOS[k].name}</b><span>${SCENARIOS[k].desc}</span></button>`).join('')
    + `<button class="scenario ${f.scenario === 'custom' ? 'on' : ''}" data-ng-scenario="custom"><b>사용자 지정</b><span>시작 자금을 직접 정합니다. 기록은 "사용자 지정 규칙"으로 분류됩니다.</span></button>`;
  return `<div class="ng">
    <div class="ng-title">PLANETARY <b>GRID</b></div>
    <div class="ng-sub">작은 전력회사에서 시작해 행성 전체의 에너지 흐름을 설계하고 운영하세요.</div>
    <div class="ng-sec"><h3>시작 시나리오</h3><div class="scenarios">${scen}</div></div>
    <div class="ng-row">
      <div class="ng-sec"><h3>난이도</h3><div class="seg">${(['easy', 'standard', 'hard'] as const).map((k) => `<button data-ng-preset="${k}" class="${f.preset === k ? 'on' : ''}">${DIFFICULTY[k].name}</button>`).join('')}</div></div>
      <div class="ng-sec"><h3>회생불능 시</h3><div class="seg"><button data-ng-ins="bailout" class="${f.insolvency === 'bailout' ? 'on' : ''}">구제 허용</button><button data-ng-ins="liquidation" class="${f.insolvency === 'liquidation' ? 'on' : ''}">청산</button><button data-ng-ins="none" class="${f.insolvency === 'none' ? 'on' : ''}">없음</button></div></div>
    </div>
    ${f.scenario === 'custom' ? `<div class="ng-sec"><h3>시작 자금</h3><div class="seg">${[500_000_00, 1_500_000_00, 5_000_000_00, 50_000_000_00].map((v) => `<button data-ng-cash="${v}" class="${f.cash === v ? 'on' : ''}">${cr(v)} CR</button>`).join('')}</div>
      ${f.cash >= 50_000_000_00 ? '<div class="note warn-t">경고: 사실상 무제한 자금입니다. 진행은 가능하지만 사업권·접속 용량·연구 기간 같은 제약은 그대로 적용됩니다.</div>' : f.cash <= 500_000_00 ? '<div class="note warn-t">경고: 첫 시설을 짓기 빠듯한 자금입니다.</div>' : ''}</div>` : ''}
    <div class="ng-row"><div class="ng-sec"><h3>행성 시드</h3><div class="seg"><button data-ng-seed="20261101" class="${f.seed === 20261101 ? 'on' : ''}">기본 행성</button><button data-ng-seed="random" class="${f.seed !== 20261101 ? 'on' : ''}">${f.seed !== 20261101 ? `무작위 (${f.seed})` : '무작위'}</button></div></div></div>
    <div class="ng-acts">${f.hasSave ? '<button class="btn" data-act="continue">이어하기</button>' : ''}<button class="btn primary big" data-act="start">시작</button></div>
  </div>`;
}

export { LICENSE };

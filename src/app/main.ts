// 앱 진입점: 시뮬레이션 루프 + HUD. UI는 명령만 발행한다 (Baseline §20.3, §30.4).

import { createGlobe } from './globe';
import { morph } from './morph';
import {
  advance, availableCash, createGame, hubCapacityKw, hubUsedKw, issue, lineSpec, neighbors,
  solarPpm, windPpm, type Facility, type GameState, type Health, type Line,
} from '../sim/sim';
import { FACILITY_TYPES, SIZES, STAGES, specOf, type SizeId, type TypeId } from '../sim/data';
import { deserialize, serialize, SaveError } from '../sim/save';
import { clockOf, formatCR, STEPS_PER_DAY } from '../sim/units';

const params = new URLSearchParams(location.search);
const DEV = params.has('dev');
// 사용자 확정 Q1: 1× = 실시간 1초당 게임 1분. 개발 모드에서만 고속 배속을 연다.
const SPEEDS = DEV ? [0, 1, 2, 4, 8, 60, 600] : [0, 1, 2, 4, 8];
const SAVE_KEY = 'planetary-grid.save.1';

const CARD_IMG: Record<TypeId, string | null> = {
  thermal: './assets/card_thermal.webp',
  wind: './assets/card_wind.webp',
  solar: null, // 태양광 카드 이미지는 파일로 받지 못해 임시 아이콘
  storage: './assets/card_storage.webp',
  substation: './assets/card_line.webp',
};

type Tab = 'gen' | 'storage' | 'substation' | 'line';

let state: GameState = createGame(Number(params.get('seed')) || 20261101);
let speed = 1;
let selected: number | null = params.has('region') ? Number(params.get('region')) : null;
let tab: Tab = 'gen';
let genType: TypeId = 'solar';
let buildSize: SizeId = 'small';
let lineTarget: number | null = null;
let carry = 0;
let pointerDown = false;
document.addEventListener('pointerdown', () => (pointerDown = true));
document.addEventListener('pointerup', () => setTimeout(() => (pointerDown = false), 0));

const $ = (id: string) => document.getElementById(id)!;
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const mw = (kw: number) => (kw / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 });
const mwh = (wh: number) => (wh / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 });
const cr = (minor: number) => formatCR(minor).replace(' CR', '');
const price = (minor: number) => (minor / 100).toFixed(2);
const pips = (n: number) => `<span class="pips">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
const SOLAR_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="46" cy="16" r="7" fill="none" stroke="#e6c34a" stroke-width="2"/><g stroke="#e6c34a" stroke-width="2"><path d="M46 3v4M46 25v4M33 16h4M55 16h4"/></g><path d="M8 50l10-20h30l-10 20z" fill="#1d2a38" stroke="#4fd1e0" stroke-width="1.5"/><path d="M15 40h31M21 30l-6 20M31 30l-6 20M41 30l-6 20" stroke="#4fd1e0" stroke-width="1" opacity=".6"/><path d="M26 50v6M20 56h12" stroke="#8b95a1" stroke-width="2"/></svg>`;
const LINE_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14 56L22 10h4l8 46M50 56L42 10h-4l-8 46" fill="none" stroke="#8b95a1" stroke-width="2"/><path d="M14 18h16M34 18h16M16 30h12M36 30h12" stroke="#8b95a1" stroke-width="2"/><path d="M4 22q14 10 26-4t30 4" fill="none" stroke="#4fd1e0" stroke-width="1.6"/></svg>`;
const img = (t: TypeId) => (CARD_IMG[t] ? `<img src="${CARD_IMG[t]}" alt="">` : `<div class="ph">${SOLAR_SVG}</div>`);

function clockText(step: number) {
  const c = clockOf(step);
  return `${c.year}년 ${c.day}일 ${String(c.hh).padStart(2, '0')}:${String(c.mm).padStart(2, '0')}`;
}

function healthBadge(h: Health): string {
  if (h.s === 'ok') return '';
  const days = h.s === 'warning' ? h.failAt : h.until;
  const left = Math.max(0, Math.ceil((days - state.step) / STEPS_PER_DAY));
  const cls = h.s === 'failed' ? 'bad' : h.s === 'warning' ? 'warn' : 'info';
  const text = h.s === 'warning' ? `점검 필요 · ${left}일 내 고장 예상` : h.s === 'failed' ? `고장 · 복구 ${left}일` : `점검 중 · ${left}일`;
  return `<span class="badge ${cls}">${text}</span>`;
}

function buildProgress(b: { stage: number; stageStep: number; stageSteps: number[] }) {
  const st = Math.max(0, b.stage);
  const done = b.stageSteps.slice(0, st).reduce((a, x) => a + x, 0) + (b.stage >= 0 ? b.stageStep : 0);
  const total = b.stageSteps.reduce((a, x) => a + x, 0);
  return { stageName: STAGES[st].name, daysLeft: Math.ceil((total - done) / STEPS_PER_DAY), pct: (done / total) * 100 };
}

function renderTop() {
  const last = state.history[state.history.length - 1];
  const net = last ? last.netMinor : 0;
  const d = state.lastDI;
  const lossPct = d.genWh + d.dischargeWh > 0 ? (d.lineLossWh / (d.genWh + d.dischargeWh)) * 100 : 0;
  const alerts = state.facilities.filter((f) => f.health.s === 'failed').length + state.lines.filter((l) => l.health.s === 'failed').length + state.hubs.filter((h) => h.health.s === 'failed').length;
  morph($('topbar'), `
    <div class="brand">PLANETARY <b>GRID</b></div>
    <div class="sep"></div>
    <div class="stat"><span class="k">게임 시각</span><span class="v num">${clockText(state.step)}</span></div>
    <div class="speed">${SPEEDS.map((v) => `<button data-speed="${v}" class="${v === speed ? 'on' : ''}" title="${v === 0 ? '일시정지 (Space)' : v + '배속'}">${v === 0 ? '❚❚' : v + '×'}</button>`).join('')}</div>
    <div class="spacer"></div>
    <div class="stat"><span class="k">발전 (15분)</span><span class="v num">${mwh(d.genWh + d.dischargeWh)} MWh</span></div>
    <div class="stat"><span class="k">송전 손실</span><span class="v num">${lossPct.toFixed(1)}%</span></div>
    <div class="stat"><span class="k">고장</span><span class="v num ${alerts ? 'neg' : ''}">${alerts}</span></div>
    <div class="sep"></div>
    <div class="stat"><span class="k">현금</span><span class="v num ${state.cash < 0 ? 'neg' : ''}">${cr(state.cash)} CR</span></div>
    <div class="stat"><span class="k">사용 가능</span><span class="v num">${cr(availableCash(state))}</span></div>
    <div class="stat"><span class="k">어제 순현금</span><span class="v num ${net >= 0 ? 'pos' : 'neg'}">${net >= 0 ? '+' : ''}${cr(net)}</span></div>
    <div class="sep"></div>
    <button class="btn ghost small" data-act="save">저장</button>
    <button class="btn ghost small" data-act="load">불러오기</button>`);
}

function renderRegions() {
  morph($('regions'), `<h2>지역 시장</h2>` + state.regions.map((r, i) => {
    const rs = state.regionState[i];
    const mine = state.facilities.filter((f) => f.regionId === i && f.status === 'operating' && FACILITY_TYPES[f.type].kind === 'gen').reduce((a, f) => a + f.capKw, 0);
    const warn = state.hubs[i].health.s !== 'ok' || state.facilities.some((f) => f.regionId === i && f.health.s !== 'ok');
    return `<button class="region-row ${selected === i ? 'selected' : ''}" data-region="${i}">
      <span class="name">${esc(r.name)}${warn ? ' <span class="dot-warn">●</span>' : ''}</span><span class="price">${price(rs.priceMinor)}</span>
      <span class="sub"><span>수요 ${mw(rs.demandKw)} MW</span><span>내 발전 ${mw(mine)} MW</span></span>
    </button>`;
  }).join('') + `<div class="note">가격 단위: CR/MWh. 가격은 지역 수요와 기존 전력망 공급으로 정해지며, 내 발전량은 가격을 바꾸지 않습니다. 송전선으로 비싼 지역에 팔 수 있습니다.</div>`);
}

function facilityRow(f: Facility): string {
  const d = FACILITY_TYPES[f.type];
  let status: string;
  let extra = '';
  if (f.status === 'construction') {
    const p = buildProgress(f);
    status = `건설 중 · ${p.stageName} · ${p.daysLeft}일 남음`;
    extra = `<div class="progress"><span style="width:${p.pct}%"></span></div>`;
  } else if (d.kind === 'substation') {
    status = `접속 용량 +${mw(f.hubAddKw)} MW`;
  } else if (d.kind === 'storage') {
    const pct = f.energyWh ? (f.socWh / f.energyWh) * 100 : 0;
    const mode = f.lastStorageWh > 0 ? `충전 ${mw(f.lastStorageWh / 250)} MW` : f.lastStorageWh < 0 ? `방전 ${mw(-f.lastStorageWh / 250)} MW` : '대기';
    status = `${mode} · 저장량 ${mwh(f.socWh)} / ${mwh(f.energyWh)} MWh`;
    extra = `<div class="progress soc"><span style="width:${pct}%"></span></div>
      <div class="thr"><span>충전 ≤ <b class="num">${price(f.chargeAtMinor)}</b></span>
        <button class="btn tiny" data-thr="${f.id}:c:-500">−</button><button class="btn tiny" data-thr="${f.id}:c:500">+</button>
        <span>방전 ≥ <b class="num">${price(f.dischargeAtMinor)}</b></span>
        <button class="btn tiny" data-thr="${f.id}:d:-500">−</button><button class="btn tiny" data-thr="${f.id}:d:500">+</button></div>`;
  } else {
    status = f.online ? `가동 · ${mw(f.outputKw)} / ${mw(f.capKw)} MW` : '정지';
  }
  let acts = '';
  if (f.status === 'construction') acts = `<button class="btn small danger" data-cancel="${f.id}">취소</button>`;
  else if (d.kind === 'gen') acts = `<button class="btn small" data-toggle="${f.id}">${f.online ? '정지' : '가동'}</button>`;
  if (f.health.s === 'warning') acts = `<button class="btn small warn" data-inspect="facility:${f.id}">점검</button>` + acts;
  return `<div class="fac">${img(f.type)}<div><div class="t">${SIZES[f.size].name} ${d.name} ${healthBadge(f.health)}</div><div class="s">${status}</div>${extra}</div><div class="acts">${acts}</div></div>`;
}

function lineRow(l: Line, here: number): string {
  const other = l.a === here ? l.b : l.a;
  let status: string;
  let extra = '';
  if (l.status === 'construction') {
    const p = buildProgress(l);
    status = `건설 중 · ${p.stageName} · ${p.daysLeft}일 남음`;
    extra = `<div class="progress"><span style="width:${p.pct}%"></span></div>`;
  } else {
    const util = (l.lastSentWh / (l.capKw * 250)) * 100;
    const outward = (l.lastDir === 1 && l.a === here) || (l.lastDir === -1 && l.b === here);
    const dir = l.lastSentWh === 0 ? '흐름 없음' : outward ? `→ 송전 ${mw(l.lastSentWh / 250)} MW` : `← 수전 ${mw((l.lastSentWh - l.lastLossWh) / 250)} MW`;
    status = `${dir} · 이용률 ${util.toFixed(0)}%`;
    extra = `<div class="progress line"><span style="width:${Math.min(100, util)}%"></span></div>`;
  }
  let acts = l.status === 'construction' ? `<button class="btn small danger" data-cancelline="${l.id}">취소</button>` : '';
  if (l.health.s === 'warning') acts = `<button class="btn small warn" data-inspect="line:${l.id}">점검</button>`;
  return `<div class="fac"><div class="ph">${LINE_SVG}</div><div><div class="t">${esc(state.regions[other].name)} 연결 · ${SIZES[l.size].name} ${healthBadge(l.health)}</div>
    <div class="s">${mw(l.capKw)} MW · ${l.lengthKm.toLocaleString()} km · 손실 ${(l.lossPpm / 10_000).toFixed(1)}% · ${status}</div>${extra}</div><div class="acts">${acts}</div></div>`;
}

function buildSection(ri: number): string {
  const tabs: [Tab, string][] = [['gen', '발전'], ['storage', '저장'], ['substation', '변전소'], ['line', '송전선']];
  const head = `<div class="seg tabs">${tabs.map(([k, n]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  const sizes = `<div class="seg">${(['small', 'medium', 'large'] as SizeId[]).map((z) => `<button data-size="${z}" class="${z === buildSize ? 'on' : ''}">${SIZES[z].name}</button>`).join('')}</div>`;

  if (tab === 'line') {
    const nb = neighbors(state.regions)[ri];
    if (lineTarget === null || !nb.includes(lineTarget)) lineTarget = nb[0];
    const spec = lineSpec(state.regions, ri, lineTarget, buildSize);
    const ok = availableCash(state) >= spec.capexMinor;
    const pr = state.regionState[lineTarget].priceMinor;
    return head + `<div class="targets">${nb.map((j) => `<button class="target ${j === lineTarget ? 'on' : ''}" data-target="${j}">
        <span>${esc(state.regions[j].name)}</span><span class="num">${price(state.regionState[j].priceMinor)}</span></button>`).join('')}</div>` + sizes + `
      <div class="quote">
        <span class="k">연결</span><span class="v">${esc(state.regions[ri].name)} ↔ ${esc(state.regions[lineTarget].name)}</span>
        <span class="k">용량 (송전단)</span><span class="v">${mw(spec.capKw)} MW</span>
        <span class="k">길이</span><span class="v">${spec.lengthKm.toLocaleString()} km</span>
        <span class="k">손실률</span><span class="v">${(spec.lossPpm / 10_000).toFixed(1)}%</span>
        <span class="k">건설비</span><span class="v">${cr(spec.capexMinor)} CR</span>
        <span class="k">공사 기간</span><span class="v">${spec.buildDays} 게임일</span>
        <span class="k">상대 지역 가격</span><span class="v">${price(pr)}</span>
      </div>
      <button class="btn primary" style="width:100%" data-act="buildline" ${ok ? '' : 'disabled'}>${ok ? '송전선 건설 승인' : '자금 부족'}</button>
      <div class="note">송전선은 이웃 지역끼리만 연결합니다. 전력은 손실을 빼고도 더 비싸게 팔리는 지역으로 자동 배분됩니다.</div>`;
  }

  const type: TypeId = tab === 'gen' ? genType : tab;
  const def = FACILITY_TYPES[type];
  const spec = specOf(type, buildSize);
  const hubFree = hubCapacityKw(state, ri) - hubUsedKw(state, ri);
  const needHub = def.kind !== 'substation' && spec.capKw > hubFree;
  const ok = availableCash(state) >= spec.capexMinor && !needHub;
  const cards = tab === 'gen'
    ? `<div class="cards">${(['solar', 'wind', 'thermal'] as TypeId[]).map((t) => `<button class="card ${t === genType ? 'on' : ''}" data-gentype="${t}">${img(t)}<div class="cn">${FACILITY_TYPES[t].name}</div></button>`).join('')}</div>`
    : `<div class="cards one"><div class="card on">${img(type)}<div class="cn">${def.name}</div></div></div>`;
  const rows: [string, string][] = [];
  if (def.kind === 'substation') rows.push(['접속 용량 증설', `+${mw(spec.hubAddKw)} MW`]);
  else rows.push(['정격 출력', `${mw(spec.capKw)} MW`]);
  if (def.kind === 'storage') rows.push(['저장 용량', `${mwh(spec.energyWh)} MWh`], ['왕복 효율', '81%']);
  rows.push(['건설비', `${cr(spec.capexMinor)} CR`], ['공사 기간', `${spec.buildDays} 게임일`], ['유지비', `${cr(spec.fixedMinorPerDay)} CR/일`]);
  if (def.kind === 'gen') rows.push(['연료비', def.fuelMinorPerMWh ? `${def.fuelMinorPerMWh / 100} CR/MWh` : '없음'], ['출력 특성', def.dispatchable ? '조절 가능' : type === 'solar' ? '낮에만' : '바람에 따라']);
  const label = needHub ? '접속 용량 부족' : availableCash(state) < spec.capexMinor ? '자금 부족' : '건설 승인';
  const notes: Record<string, string> = {
    gen: '건설비는 승인 시 예약되고 6단계(기초 → 시운전)가 시작될 때마다 청구됩니다. 시운전 단계부터 출력 50%로 판매합니다.',
    storage: '가격이 충전 기준 이하일 때 내 발전으로 충전하고, 방전 기준 이상일 때 방전합니다. 시장에서 사서 충전하지 않습니다.',
    substation: '변전소는 이 지역에 연결할 수 있는 발전·저장 설비 용량을 늘립니다.',
  };
  return head + cards + sizes + `<div class="quote">${rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('')}</div>
    <button class="btn primary" style="width:100%" data-act="build" ${ok ? '' : 'disabled'}>${label}</button>
    <div class="note">${notes[tab]}</div>`;
}

function renderDetail() {
  const el = $('detail');
  if (selected === null) {
    el.className = 'panel empty';
    morph(el, `<h2>시작하기</h2><p>왼쪽 목록이나 행성 위 지역 이름을 눌러 지역을 고르세요.</p><p class="note">처음에는 짧은 공기로 지을 수 있는 소형 태양광(5일)이나 소형 열발전(10일)을 권합니다. 송전선으로 이웃 지역의 비싼 시장에 팔 수 있습니다.</p>`);
    return;
  }
  el.className = 'panel';
  const ri = selected;
  const r = state.regions[ri];
  const rs = state.regionState[ri];
  const usePct = rs.capWh ? Math.min(100, (rs.soldWh / rs.capWh) * 100) : 0;
  const facs = state.facilities.filter((f) => f.regionId === ri);
  const lines = state.lines.filter((l) => l.a === ri || l.b === ri);
  const hubCap = hubCapacityKw(state, ri);
  const hubUsed = hubUsedKw(state, ri);
  const hub = state.hubs[ri];
  const sun = Math.round(solarPpm(r, state.step) / 10_000);
  const wind = Math.round(windPpm(r, state.seed, state.step) / 10_000);

  morph(el, `
    <div class="detail-title"><h1>${esc(r.name)}</h1><span class="coord">${r.lat.toFixed(1)}°, ${r.lon.toFixed(1)}°</span></div>
    <div class="kv">
      <div><div class="k">시장 가격</div><div class="v num" style="color:var(--amber)">${price(rs.priceMinor)}</div></div>
      <div><div class="k">수요</div><div class="v num">${mw(rs.demandKw)} MW</div></div>
      <div><div class="k">기준가</div><div class="v num">${(r.pBaseMinor / 100).toFixed(0)}</div></div>
    </div>
    <div class="res"><span>일사 ${pips(r.solar)} <b class="num">${sun}%</b></span><span>풍황 ${pips(r.wind)} <b class="num">${wind}%</b></span></div>
    <div class="bar-row"><span>접속 용량 ${healthBadge(hub.health)}</span><span class="num">${mw(hubUsed)} / ${mw(hubCap)} MW</span></div>
    <div class="meter"><span style="width:${Math.min(100, (hubUsed / hubCap) * 100)}%;background:var(--safety)"></span></div>
    ${hub.health.s === 'warning' ? `<button class="btn small warn" style="margin-top:6px" data-inspect="hub:${ri}">접속점 점검</button>` : ''}
    <div class="bar-row"><span>이 지역 판매 / 판매 한도 (σ = 1.0)</span><span class="num">${usePct.toFixed(1)}%</span></div>
    <div class="meter"><span style="width:${usePct}%"></span></div>

    <div class="section"><h3>내 시설 (${facs.length})</h3>
      ${facs.length === 0 ? '<div class="note">아직 시설이 없습니다.</div>' : facs.map(facilityRow).join('')}
    </div>
    <div class="section"><h3>송전선 (${lines.length})</h3>
      ${lines.length === 0 ? '<div class="note">연결된 송전선이 없습니다.</div>' : lines.map((l) => lineRow(l, ri)).join('')}
    </div>
    <div class="section"><h3>건설</h3>${buildSection(ri)}</div>`);
}

function renderNotices() {
  morph($('notices'), `<h2>알림</h2>` + state.notices.slice().reverse().slice(0, 30).map((n) =>
    `<div class="notice ${n.level}"><span class="when">${clockText(n.step).replace(/^\d+년 /, '')}</span><span class="msg">${esc(n.text)}</span></div>`).join(''));
}

function renderAll() {
  renderTop();
  renderRegions();
  renderDetail();
  renderNotices();
}

// ---- 입력 (이벤트 위임) ----
const SELECTOR = '[data-speed],[data-region],[data-tab],[data-gentype],[data-size],[data-target],[data-act],[data-toggle],[data-cancel],[data-cancelline],[data-inspect],[data-thr]';
document.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest(SELECTOR) as HTMLElement | null;
  if (!t) return;
  const d = t.dataset;
  if (d.speed !== undefined) speed = Number(d.speed);
  else if (d.region !== undefined) pick(Number(d.region));
  else if (d.tab) tab = d.tab as Tab;
  else if (d.gentype) genType = d.gentype as TypeId;
  else if (d.size) buildSize = d.size as SizeId;
  else if (d.target) lineTarget = Number(d.target);
  else if (d.toggle) {
    const f = state.facilities.find((x) => x.id === Number(d.toggle));
    if (f) issue(state, { kind: 'setOnline', facilityId: f.id, online: !f.online });
  } else if (d.cancel) issue(state, { kind: 'cancel', facilityId: Number(d.cancel) });
  else if (d.cancelline) issue(state, { kind: 'cancelLine', lineId: Number(d.cancelline) });
  else if (d.inspect) {
    const [target, id] = d.inspect.split(':');
    issue(state, { kind: 'inspect', target: target as 'facility' | 'line' | 'hub', id: Number(id) });
  } else if (d.thr) {
    const [id, which, delta] = d.thr.split(':');
    const f = state.facilities.find((x) => x.id === Number(id));
    if (f) {
      const c = f.chargeAtMinor + (which === 'c' ? Number(delta) : 0);
      const dis = f.dischargeAtMinor + (which === 'd' ? Number(delta) : 0);
      issue(state, { kind: 'setStorage', facilityId: f.id, chargeAtMinor: c, dischargeAtMinor: dis });
    }
  } else if (d.act === 'build' && selected !== null) {
    issue(state, { kind: 'build', regionId: selected, type: tab === 'gen' ? genType : (tab as TypeId), size: buildSize });
  } else if (d.act === 'buildline' && selected !== null && lineTarget !== null) {
    issue(state, { kind: 'buildLine', a: selected, b: lineTarget, size: buildSize });
  } else if (d.act === 'save') {
    try { localStorage.setItem(SAVE_KEY, serialize(state)); state.notices.push({ step: state.step, level: 'info', text: '저장했습니다.' }); }
    catch { state.notices.push({ step: state.step, level: 'error', text: '저장 실패 (브라우저 저장소를 쓸 수 없음).' }); }
  } else if (d.act === 'load') {
    try {
      const text = localStorage.getItem(SAVE_KEY);
      if (!text) throw new SaveError('저장된 게임이 없습니다.');
      state = deserialize(text);
      state.notices.push({ step: state.step, level: 'info', text: '불러왔습니다.' });
    } catch (e) {
      state.notices.push({ step: state.step, level: 'error', text: e instanceof SaveError ? e.message : '불러오기 실패.' });
    }
  }
  renderAll();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { speed = speed === 0 ? 1 : 0; renderAll(); e.preventDefault(); }
  const n = Number(e.key);
  if (n >= 1 && n <= SPEEDS.length - 1) { speed = SPEEDS[n]; renderAll(); }
});

let globeApi: Awaited<ReturnType<typeof createGlobe>> | null = null;
function pick(id: number) {
  selected = id;
  lineTarget = null;
  const r = state.regions[id];
  globeApi?.focus(r.lat, r.lon);
  renderAll();
}

// ---- 시작 ----
async function main() {
  renderAll();
  const bar = document.querySelector('.loading-bar span') as HTMLElement;
  globeApi = await createGlobe($('globe'), state, (p) => (bar.style.width = `${Math.round(p * 100)}%`), pick);
  $('loading').classList.add('hide');
  if (selected !== null) pick(selected);

  // 개발 확인용: ?build=solar,small&line=2,medium&skip=20
  if (DEV && selected !== null) {
    for (const spec of params.getAll('build')) {
      const [t, z] = spec.split(',') as [TypeId, SizeId];
      issue(state, { kind: 'build', regionId: selected, type: t, size: z });
    }
    for (const spec of params.getAll('line')) {
      const [b, z] = spec.split(',');
      issue(state, { kind: 'buildLine', a: selected, b: Number(b), size: z as SizeId });
    }
    if (params.get('tab')) tab = params.get('tab') as Tab;
    if (params.get('skip')) advance(state, Number(params.get('skip')) * STEPS_PER_DAY);
  }
  if (DEV && params.get('minutes')) advance(state, Number(params.get('minutes')));

  let last = performance.now();
  let lastUi = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    carry += dt * speed;
    const n = Math.min(5000, Math.floor(carry));
    if (n > 0) { advance(state, n); carry -= n; }
    globeApi!.update(state, selected);
    if (now - lastUi > 250 && !pointerDown) { renderAll(); lastUi = now; }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main();

// 앱 진입점: 시뮬레이션 루프 + HUD. UI는 명령만 발행한다 (Baseline §20.3, §30.4).

import { createGlobe } from './globe';
import { morph } from './morph';
import { advance, availableCash, createGame, issue, type GameState } from '../sim/sim';
import { FACILITY_TYPES, SIZES, STAGES, specOf, type SizeId, type TypeId } from '../sim/data';
import { deserialize, serialize, SaveError } from '../sim/save';
import { clockOf, formatCR, STEPS_PER_DAY } from '../sim/units';
import { solarPpm, windPpm } from '../sim/sim';

const params = new URLSearchParams(location.search);
const DEV = params.has('dev');
// 사용자 확정 Q1: 1× = 실시간 1초당 게임 1분. 개발 모드에서만 고속 배속을 연다.
const SPEEDS = DEV ? [0, 1, 2, 4, 8, 60, 600] : [0, 1, 2, 4, 8];
const SAVE_KEY = 'planetary-grid.save.1';

const CARD_IMG: Record<TypeId, string | null> = {
  thermal: './assets/card_thermal.webp',
  wind: './assets/card_wind.webp',
  solar: null, // 태양광 카드 이미지는 파일로 받지 못해 임시 표시
};

let state: GameState = createGame(Number(params.get('seed')) || 20261101);
let speed = 1;
let selected: number | null = params.has('region') ? Number(params.get('region')) : null;
let buildType: TypeId = 'solar';
let buildSize: SizeId = 'small';
let carry = 0;
let pointerDown = false;
document.addEventListener('pointerdown', () => (pointerDown = true));
document.addEventListener('pointerup', () => setTimeout(() => (pointerDown = false), 0));

const $ = (id: string) => document.getElementById(id)!;
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const mw = (kw: number) => (kw / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 });
const cr = (minor: number) => formatCR(minor).replace(' CR', '');
const pips = (n: number) => `<span class="pips">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
// 임시 아이콘 (카드 이미지가 없을 때): 태양광 패널 도식
const SOLAR_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="46" cy="16" r="7" fill="none" stroke="#e6c34a" stroke-width="2"/><g stroke="#e6c34a" stroke-width="2"><path d="M46 3v4M46 25v4M33 16h4M55 16h4"/></g><path d="M8 50l10-20h30l-10 20z" fill="#1d2a38" stroke="#4fd1e0" stroke-width="1.5"/><path d="M15 40h31M21 30l-6 20M31 30l-6 20M41 30l-6 20" stroke="#4fd1e0" stroke-width="1" opacity=".6"/><path d="M26 50v6M20 56h12" stroke="#8b95a1" stroke-width="2"/></svg>`;
const img = (t: TypeId, cls = '') => (CARD_IMG[t] ? `<img class="${cls}" src="${CARD_IMG[t]}" alt="">` : `<div class="ph ${cls}">${SOLAR_SVG}</div>`);

function clockText(step: number) {
  const c = clockOf(step);
  return `${c.year}년 ${c.day}일 ${String(c.hh).padStart(2, '0')}:${String(c.mm).padStart(2, '0')}`;
}

function renderTop() {
  const last = state.history[state.history.length - 1];
  const net = last ? last.netMinor : 0;
  morph($('topbar'), `
    <div class="brand">PLANETARY <b>GRID</b></div>
    <div class="sep"></div>
    <div class="stat"><span class="k">게임 시각</span><span class="v num">${clockText(state.step)}</span></div>
    <div class="speed">${SPEEDS.map((v) => `<button data-speed="${v}" class="${v === speed ? 'on' : ''}" title="${v === 0 ? '일시정지' : v + '배속'}">${v === 0 ? '❚❚' : v + '×'}</button>`).join('')}</div>
    <div class="spacer"></div>
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
    const mine = state.facilities.filter((f) => f.regionId === i && f.status === 'operating').reduce((a, f) => a + f.capKw, 0);
    return `<button class="region-row ${selected === i ? 'selected' : ''}" data-region="${i}">
      <span class="name">${esc(r.name)}</span><span class="price">${(rs.priceMinor / 100).toFixed(2)}</span>
      <span class="sub"><span>수요 ${mw(rs.demandKw)} MW</span><span>내 설비 ${mw(mine)} MW</span></span>
    </button>`;
  }).join('') + `<div class="note">가격 단위: CR/MWh. 가격은 지역 수요와 기존 전력망 공급으로 정해지며, 내 발전량은 가격을 바꾸지 않습니다.</div>`);
}

function renderDetail() {
  const el = $('detail');
  if (selected === null) {
    el.className = 'panel empty';
    morph(el, `<h2>시작하기</h2><p>왼쪽 목록이나 행성 위 지역 이름을 눌러 지역을 고르세요.</p><p class="note">처음에는 짧은 공기로 지을 수 있는 소형 태양광(5일)이나 소형 열발전(10일)을 권합니다.</p>`);
    return;
  }
  el.className = 'panel';
  const r = state.regions[selected];
  const rs = state.regionState[selected];
  const usePct = rs.capWh ? Math.min(100, (rs.soldWh / rs.capWh) * 100) : 0;
  const facs = state.facilities.filter((f) => f.regionId === selected);
  const spec = specOf(buildType, buildSize);
  const def = FACILITY_TYPES[buildType];
  const canBuild = availableCash(state) >= spec.capexMinor;
  const sun = Math.round(solarPpm(r, state.step) / 10_000);
  const wind = Math.round(windPpm(r, state.seed, state.step) / 10_000);

  morph(el, `
    <div class="detail-title"><h1>${esc(r.name)}</h1><span class="coord">${r.lat.toFixed(1)}°, ${r.lon.toFixed(1)}°</span></div>
    <div class="kv">
      <div><div class="k">시장 가격</div><div class="v num" style="color:var(--amber)">${(rs.priceMinor / 100).toFixed(2)}</div></div>
      <div><div class="k">수요</div><div class="v num">${mw(rs.demandKw)} MW</div></div>
      <div><div class="k">기준가</div><div class="v num">${(r.pBaseMinor / 100).toFixed(0)}</div></div>
    </div>
    <div class="res"><span>일사 ${pips(r.solar)}</span><span>풍황 ${pips(r.wind)}</span></div>
    <div class="res"><span>현재 일사 <b class="num">${sun}%</b></span><span>현재 풍력 <b class="num">${wind}%</b></span></div>
    <div><div class="res" style="margin-bottom:4px"><span>내 판매 / 판매 한도 (σ = 1.0)</span><span class="num" style="margin-left:auto">${usePct.toFixed(1)}%</span></div><div class="meter"><span style="width:${usePct}%"></span></div></div>

    <div class="section"><h3>내 시설 (${facs.length})</h3>
      ${facs.length === 0 ? '<div class="note">아직 시설이 없습니다.</div>' : facs.map((f) => {
        const d = FACILITY_TYPES[f.type];
        let status: string;
        let bar = '';
        if (f.status === 'construction') {
          const st = Math.max(0, f.stage);
          const done = f.stageSteps.slice(0, st).reduce((a, b) => a + b, 0) + (f.stage >= 0 ? f.stageStep : 0);
          const total = f.stageSteps.reduce((a, b) => a + b, 0);
          const daysLeft = Math.ceil((total - done) / STEPS_PER_DAY);
          status = `건설 중 · ${STAGES[st].name} · ${daysLeft}일 남음`;
          bar = `<div class="progress"><span style="width:${(done / total) * 100}%"></span></div>`;
        } else {
          status = f.online ? `가동 · ${mw(f.outputKw)} / ${mw(f.capKw)} MW` : '정지';
        }
        const acts = f.status === 'construction'
          ? `<button class="btn small danger" data-cancel="${f.id}">취소</button>`
          : `<button class="btn small" data-toggle="${f.id}">${f.online ? '정지' : '가동'}</button>`;
        return `<div class="fac">${img(f.type)}<div><div class="t">${SIZES[f.size].name} ${d.name}</div><div class="s">${status}</div>${bar}</div><div class="acts">${acts}</div></div>`;
      }).join('')}
    </div>

    <div class="section"><h3>건설</h3>
      <div class="cards">${(['solar', 'wind', 'thermal'] as TypeId[]).map((t) => `
        <button class="card ${t === buildType ? 'on' : ''}" data-type="${t}">${img(t)}<div class="cn">${FACILITY_TYPES[t].name}</div></button>`).join('')}
      </div>
      <div class="seg">${(['small', 'medium', 'large'] as SizeId[]).map((z) => `<button data-size="${z}" class="${z === buildSize ? 'on' : ''}">${SIZES[z].name}</button>`).join('')}</div>
      <div class="quote">
        <span class="k">정격 출력</span><span class="v">${mw(spec.capKw)} MW</span>
        <span class="k">건설비</span><span class="v">${cr(spec.capexMinor)} CR</span>
        <span class="k">공사 기간</span><span class="v">${spec.buildDays} 게임일</span>
        <span class="k">유지비</span><span class="v">${cr(spec.fixedMinorPerDay)} CR/일</span>
        <span class="k">연료비</span><span class="v">${def.fuelMinorPerMWh ? (def.fuelMinorPerMWh / 100).toFixed(0) + ' CR/MWh' : '없음'}</span>
        <span class="k">출력 특성</span><span class="v">${def.dispatchable ? '조절 가능' : buildType === 'solar' ? '낮에만' : '바람에 따라'}</span>
      </div>
      <button class="btn primary" style="width:100%" data-act="build" ${canBuild ? '' : 'disabled'}>${canBuild ? '건설 승인' : '자금 부족'}</button>
      <div class="note">건설비는 승인 시 예약되고, 6단계(기초 → 시운전)가 시작될 때마다 청구됩니다. 시운전 단계부터 출력 50%로 판매합니다.</div>
    </div>`);
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
document.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest('[data-speed],[data-region],[data-type],[data-size],[data-act],[data-toggle],[data-cancel]') as HTMLElement | null;
  if (!t) return;
  if (t.dataset.speed !== undefined) speed = Number(t.dataset.speed);
  else if (t.dataset.region !== undefined) pick(Number(t.dataset.region));
  else if (t.dataset.type) buildType = t.dataset.type as TypeId;
  else if (t.dataset.size) buildSize = t.dataset.size as SizeId;
  else if (t.dataset.toggle) {
    const f = state.facilities.find((x) => x.id === Number(t.dataset.toggle));
    if (f) issue(state, { kind: 'setOnline', facilityId: f.id, online: !f.online });
  } else if (t.dataset.cancel) issue(state, { kind: 'cancel', facilityId: Number(t.dataset.cancel) });
  else if (t.dataset.act === 'build' && selected !== null) issue(state, { kind: 'build', regionId: selected, type: buildType, size: buildSize });
  else if (t.dataset.act === 'save') {
    try { localStorage.setItem(SAVE_KEY, serialize(state)); state.notices.push({ step: state.step, level: 'info', text: '저장했습니다.' }); }
    catch { state.notices.push({ step: state.step, level: 'error', text: '저장 실패 (브라우저 저장소를 쓸 수 없음).' }); }
  } else if (t.dataset.act === 'load') {
    try {
      const text = localStorage.getItem(SAVE_KEY);
      if (!text) throw new SaveError('저장된 게임이 없습니다.');
      state = deserialize(text);
      state.notices.push({ step: state.step, level: 'info', text: '불러왔습니다.' });
    } catch (e) {
      state.notices.push({ step: state.step, level: 'error', text: e instanceof SaveError ? e.message : '불러오기 실패.' });
    }
  }
  // 명령은 다음 스텝에 적용된다. 일시정지 중이면 즉시 1스텝 진행하지 않고 재개 시 적용.
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

  // 개발 확인용: ?build=solar,small 처럼 시작 시 명령을 넣을 수 있다
  if (DEV && params.get('build') && selected !== null) {
    for (const spec of params.getAll('build')) {
      const [t, z] = spec.split(',') as [TypeId, SizeId];
      issue(state, { kind: 'build', regionId: selected, type: t, size: z });
    }
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

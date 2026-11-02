// 앱 진입점: 시뮬레이션 루프 + 화면. UI는 명령만 발행한다 (Baseline §20.3, §30.4).

import { createGlobe, type Overlay } from './globe';
import { morph } from './morph';
import {
  automationView, clockText, contractsView, esc, financeView, goalsView, newGameView, regionList, regionView, researchView, topBar,
  type NewGameForm, type Tab, type UiState, type View,
} from './views';
import { advance, createGame, issue, recommendations, type GameState } from '../sim/sim';
import { type LicenseType, type SizeId, type TypeId } from '../sim/data';
import { deserialize, serialize, SaveError } from '../sim/save';
import { STEPS_PER_DAY } from '../sim/units';

const params = new URLSearchParams(location.search);
const DEV = params.has('dev');
// 사용자 확정 Q1: 1× = 실시간 1초당 게임 1분. 개발 모드에서만 고속 배속을 연다.
const SPEEDS = DEV ? [0, 1, 2, 4, 8, 60, 600] : [0, 1, 2, 4, 8];
const SAVE_KEY = 'planetary-grid.save.1';

function hasSave(): boolean {
  try { return !!localStorage.getItem(SAVE_KEY); } catch { return false; }
}

let state: GameState = createGame(Number(params.get('seed')) || 20261101);
const ui: UiState = {
  view: (params.get('view') as View) ?? 'region', selected: params.has('region') ? Number(params.get('region')) : null,
  tab: 'gen', genType: 'solar', buildSize: 'small', lineTarget: null, loanAmount: 300_000_00, loanMonths: 12,
  offerFilter: 'all', speed: 1, speeds: SPEEDS,
};
const ng: NewGameForm = { scenario: 'A', preset: 'standard', seed: 20261101, cash: 1_500_000_00, insolvency: 'bailout', hasSave: hasSave() };
let showNewGame = !DEV || params.has('newgame');
let carry = 0;
let overlay: Overlay = 'none';
let pointerDown = false;
document.addEventListener('pointerdown', () => (pointerDown = true));
document.addEventListener('pointerup', () => setTimeout(() => (pointerDown = false), 0));

const $ = (id: string) => document.getElementById(id)!;

function renderNotices() {
  morph($('notices'), `<h2>알림</h2>` + state.notices.slice().reverse().slice(0, 40).map((n) =>
    `<div class="notice ${n.level}"><span class="when">${clockText(n.step).replace(/^\d+년 /, '')}</span><span class="msg">${esc(n.text)}</span></div>`).join(''));
}

function renderAll() {
  morph($('topbar'), topBar(state, ui));
  morph($('regions'), regionList(state, ui));
  const d = $('detail');
  d.classList.toggle('wide', ui.view !== 'region');
  const html = ui.view === 'region' ? regionView(state, ui)
    : ui.view === 'contracts' ? contractsView(state, ui)
    : ui.view === 'finance' ? financeView(state, ui)
    : ui.view === 'research' ? researchView(state)
    : ui.view === 'automation' ? automationView(state)
    : goalsView(state);
  morph(d, html);
  renderNotices();
  morph($('overlay'), `<span class="k">지도</span>${(['none', 'price', 'env', 'mine'] as Overlay[]).map((o) => `<button data-overlay="${o}" class="${overlay === o ? 'on' : ''}">${{ none: '기본', price: '가격', env: '환경', mine: '내 설비' }[o]}</button>`).join('')}`);
  const modal = $('modal');
  modal.classList.toggle('show', showNewGame);
  if (showNewGame) morph(modal, newGameView(ng));
}

function say(level: 'info' | 'error', text: string) {
  state.notices.push({ step: state.step, level, text });
}

// ---- 입력 (이벤트 위임) ----
document.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest('button, [data-act]') as HTMLElement | null;
  if (!t || (t as HTMLButtonElement).disabled) return;
  const d = t.dataset;
  const num = (v?: string) => Number(v);
  if (d.speed !== undefined) ui.speed = num(d.speed);
  else if (d.overlay) overlay = d.overlay as Overlay;
  else if (d.view) { ui.view = d.view as View; if (d.goto !== undefined) { pick(num(d.goto)); } }
  else if (d.region !== undefined) pick(num(d.region));
  else if (d.tab) ui.tab = d.tab as Tab;
  else if (d.gentype) ui.genType = d.gentype as TypeId;
  else if (d.size) ui.buildSize = d.size as SizeId;
  else if (d.target) ui.lineTarget = num(d.target);
  else if (d.toggle) {
    const f = state.facilities.find((x) => x.id === num(d.toggle));
    if (f) issue(state, { kind: 'setOnline', facilityId: f.id, online: !f.online });
  } else if (d.cancel) issue(state, { kind: 'cancel', facilityId: num(d.cancel) });
  else if (d.cancelline) issue(state, { kind: 'cancelLine', lineId: num(d.cancelline) });
  else if (d.inspect) {
    const [target, id] = d.inspect.split(':');
    issue(state, { kind: 'inspect', target: target as 'facility' | 'line' | 'hub', id: num(id) });
  } else if (d.thr) {
    const [id, which, delta] = d.thr.split(':');
    const f = state.facilities.find((x) => x.id === num(id));
    if (f) issue(state, { kind: 'setStorage', facilityId: f.id, chargeAtMinor: f.chargeAtMinor + (which === 'c' ? num(delta) : 0), dischargeAtMinor: f.dischargeAtMinor + (which === 'd' ? num(delta) : 0) });
  } else if (d.lic) {
    const [r, type, size] = d.lic.split(':');
    issue(state, { kind: 'acquireLicense', regionId: num(r), type: type as LicenseType, size: size as SizeId });
  } else if (d.renew) issue(state, { kind: 'renewLicense', licenseId: num(d.renew) });
  else if (d.landbuy) issue(state, { kind: 'buyLand', facilityId: num(d.landbuy) });
  else if (d.leaserenew) issue(state, { kind: 'renewLease', facilityId: num(d.leaserenew) });
  else if (d.sell) { if (confirm('이 시설을 매각할까요? 기존 계약 의무는 그대로 남습니다.')) issue(state, { kind: 'sellFacility', facilityId: num(d.sell) }); }
  else if (d.dispose) { if (confirm('이 시설을 폐기할까요? 폐기 비용이 듭니다.')) issue(state, { kind: 'disposeFacility', facilityId: num(d.dispose) }); }
  else if (d.accept) { if (!d.risky || confirm('공급 여력보다 큰 계약입니다. 공급하지 못하면 위약금이 쌓입니다. 그래도 수락할까요?')) issue(state, { kind: 'acceptOffer', offerId: num(d.accept) }); }
  else if (d.offerfilter) ui.offerFilter = d.offerfilter as 'all' | 'mine';
  else if (d.repay) issue(state, { kind: 'repayLoan', loanId: num(d.repay) });
  else if (d.loanamt) ui.loanAmount = num(d.loanamt);
  else if (d.loanmonths) ui.loanMonths = num(d.loanmonths);
  else if (d.research) { const [id, perDay] = d.research.split(':'); issue(state, { kind: 'startResearch', id, dailyBudgetMinor: num(perDay) }); }
  else if (d.policy) { const key = d.policy as 'autoRenew' | 'autoInspect' | 'autoStorage'; issue(state, { kind: 'setAutomation', key, on: !state.automation[key] }); }
  else if (d.budget) issue(state, { kind: 'setAutomationBudget', dailyBudgetMinor: state.automation.dailyBudgetMinor + num(d.budget) * 100 });
  else if (d.rec) { const r = recommendations(state).find((x) => x.id === d.rec); if (r?.cmd) issue(state, r.cmd); }
  else if (d.ngScenario) ng.scenario = d.ngScenario as NewGameForm['scenario'];
  else if (d.ngPreset) ng.preset = d.ngPreset as NewGameForm['preset'];
  else if (d.ngIns) ng.insolvency = d.ngIns as NewGameForm['insolvency'];
  else if (d.ngCash) ng.cash = num(d.ngCash);
  else if (d.ngSeed) ng.seed = d.ngSeed === 'random' ? 1 + Math.floor(Math.random() * 99_999_999) : num(d.ngSeed);
  else if (d.act) { void act(d.act, t); return; }
  renderAll();
});

async function act(name: string, el: HTMLElement) {
  if (name === 'build' && ui.selected !== null) issue(state, { kind: 'build', regionId: ui.selected, type: ui.tab === 'gen' ? ui.genType : (ui.tab as TypeId), size: ui.buildSize });
  else if (name === 'buildline' && ui.selected !== null) issue(state, { kind: 'buildLine', a: ui.selected, b: Number(el.dataset.line), size: ui.buildSize });
  else if (name === 'loan') issue(state, { kind: 'takeLoan', principalMinor: ui.loanAmount, months: ui.loanMonths });
  else if (name === 'bailout') issue(state, { kind: 'bailout' });
  else if (name === 'save') {
    try { localStorage.setItem(SAVE_KEY, serialize(state)); say('info', '저장했습니다.'); ng.hasSave = true; } catch { say('error', '저장 실패 (브라우저 저장소를 쓸 수 없음).'); }
  } else if (name === 'load' || name === 'continue') {
    try {
      const text = localStorage.getItem(SAVE_KEY);
      if (!text) throw new SaveError('저장된 게임이 없습니다.');
      await swapState(deserialize(text));
      say('info', '불러왔습니다.');
      showNewGame = false;
    } catch (e) { say('error', e instanceof SaveError ? e.message : '불러오기 실패.'); }
  } else if (name === 'newgame') { showNewGame = true; ui.speed = 0; }
  else if (name === 'start') {
    const custom = ng.scenario === 'custom';
    await swapState(createGame({ seed: ng.seed, preset: ng.preset, scenario: ng.scenario, insolvency: ng.insolvency, ...(custom ? { startCashMinor: ng.cash } : {}) }));
    showNewGame = false;
    ui.speed = 1;
    ui.view = 'region';
    ui.selected = null;
    const r = state.licenses[0]?.regionId;
    if (r !== undefined) pick(r);
  }
  renderAll();
}

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' || showNewGame) return;
  if (e.code === 'Space') { ui.speed = ui.speed === 0 ? 1 : 0; renderAll(); e.preventDefault(); }
  const n = Number(e.key);
  if (n >= 1 && n <= SPEEDS.length - 1) { ui.speed = SPEEDS[n]; renderAll(); }
});

let globeApi: Awaited<ReturnType<typeof createGlobe>> | null = null;

/** 상태 교체 (새 게임·불러오기). 행성 시드가 바뀌면 행성을 다시 만든다. */
async function swapState(next: GameState) {
  state = next;
  await buildGlobe(); // 시설·선로 표식이 이전 게임 것과 섞이지 않도록 항상 다시 만든다
}

async function buildGlobe() {
  const host = $('globe');
  host.innerHTML = '';
  $('loading').classList.remove('hide');
  const bar = document.querySelector('.loading-bar span') as HTMLElement;
  globeApi?.dispose();
  globeApi = await createGlobe(host, state, (p) => (bar.style.width = `${Math.round(p * 100)}%`), pick);
  $('loading').classList.add('hide');
}

function pick(id: number) {
  ui.selected = id;
  ui.lineTarget = null;
  ui.view = 'region';
  const r = state.regions[id];
  globeApi?.focus(r.lat, r.lon);
  renderAll();
}

// ---- 시작 ----
async function main() {
  renderAll();
  await buildGlobe();
  // 개발 확인용: ?dev&region=1&lic=GEN,small&build=solar,small&line=2,small&skip=20&minutes=600
  if (DEV) {
    if (params.get('scenario')) await swapState(createGame({ seed: state.seed, scenario: params.get('scenario') as 'A' | 'B' | 'C' }));
    if (params.get('cash')) issue(state, { kind: 'takeLoan', principalMinor: Number(params.get('cash')) * 100, months: 36 });
    if (ui.selected !== null) {
      for (const spec of params.getAll('lic')) { const [t, z] = spec.split(','); issue(state, { kind: 'acquireLicense', regionId: ui.selected, type: t as LicenseType, size: z as SizeId }); }
      for (const spec of params.getAll('build')) { const [t, z] = spec.split(','); issue(state, { kind: 'build', regionId: ui.selected, type: t as TypeId, size: z as SizeId }); }
      for (const spec of params.getAll('line')) { const [b, z] = spec.split(','); issue(state, { kind: 'buildLine', a: ui.selected, b: Number(b), size: z as SizeId }); }
    }
    for (const spec of params.getAll('licat')) { const [r, t, z] = spec.split(','); issue(state, { kind: 'acquireLicense', regionId: Number(r), type: t as LicenseType, size: z as SizeId }); }
    if (params.get('accept')) { advance(state, 1); const o = state.offers.find((x) => x.regionId === ui.selected && x.kind === 'ppa') ?? state.offers.find((x) => x.kind === 'ppa'); if (o) issue(state, { kind: 'acceptOffer', offerId: o.id }); }
    if (params.get('research')) issue(state, { kind: 'startResearch', id: params.get('research')!, dailyBudgetMinor: 100_000_00 });
    if (params.get('skip')) advance(state, Number(params.get('skip')) * STEPS_PER_DAY);
    if (params.get('minutes')) advance(state, Number(params.get('minutes')));
    if (params.get('tab')) ui.tab = params.get('tab') as Tab;
    if (params.get('speed')) ui.speed = Number(params.get('speed'));
  }
  if (ui.selected !== null) pick(ui.selected);

  let last = performance.now();
  let lastUi = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (!showNewGame) {
      carry += dt * ui.speed;
      const n = Math.min(5000, Math.floor(carry));
      if (n > 0) { advance(state, n); carry -= n; }
    }
    globeApi?.update(state, ui.selected, overlay);
    if (now - lastUi > 250 && !pointerDown) { renderAll(); lastUi = now; }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main();

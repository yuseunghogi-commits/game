// 앱 진입점: 시뮬레이션 루프 + 화면. UI는 명령만 발행한다 (Baseline §20.3, §30.4).

import { createGlobe, type Overlay } from './globe';
import { morph } from './morph';
import {
  automationView, clockText, contractsView, esc, financeView, goalsView, helpView, newGameView, planView, regionList, regionView, researchView,
  savesView, settingsView, topBar, type Modal, type NewGameForm, type Tab, type UiState, type View,
} from './views';
import { addCapital, advance, createGame, flushCommands, issue, recommendations, type GameState, type PlanCmd } from '../sim/sim';
import { notify } from '../sim/core';
import { type LicenseType, type SizeId, type TypeId } from '../sim/data';
import { SaveError } from '../sim/save';
import { STEPS_PER_DAY, dayOf } from '../sim/units';
import { loadSettings, saveSettings, type Settings } from './settings';
import { autosave, deleteSlot, exportText, importText, latestSlot, listSlots, loadFrom, migrateLegacy, saveTo, type SlotId } from './saves';
import { sound } from './audio';
import { STEPS, advanceTutorial, highlight, tutorialHtml } from './tutorial';
import { translate } from './i18n';

const params = new URLSearchParams(location.search);
const DEV = params.has('dev');
// 사용자 확정 Q1: 1× = 실시간 1초당 게임 1분. 개발 모드에서만 고속 배속을 연다.
const SPEEDS = DEV ? [0, 1, 2, 4, 8, 60, 600] : [0, 1, 2, 4, 8];

const settings: Settings = loadSettings();
if (params.has('lang')) settings.lang = params.get('lang') === 'en' ? 'en' : 'ko';
if (DEV && !params.has('tutorial')) settings.tutorial = false;
sound.setVolumes(settings);

let state: GameState = createGame(Number(params.get('seed')) || 20261101);
const ui: UiState = {
  view: (params.get('view') as View) ?? 'region', selected: params.has('region') ? Number(params.get('region')) : null,
  tab: 'gen', genType: 'solar', buildSize: 'small', lineTarget: null, loanAmount: 300_000_00, loanMonths: 12,
  offerFilter: 'all', speed: 1, speeds: SPEEDS, facility: null, modal: (params.get('modal') as Modal) ?? 'none',
};
const ng: NewGameForm = { scenario: 'A', preset: 'standard', seed: 20261101, cash: 1_500_000_00, insolvency: 'bailout', hasSave: false, regionCount: 12 };
let showNewGame = !DEV || params.has('newgame');
let carry = 0;
let overlay: Overlay = 'none';
let pointerDown = false;
let seenSeq = 0;
let lastAutoDay = 0;
let saving = false;
let toast: { text: string; until: number; level: string } | null = null;
document.addEventListener('pointerdown', () => { pointerDown = true; sound.unlock(); });
document.addEventListener('pointerup', () => setTimeout(() => (pointerDown = false), 0));

const $ = (id: string) => document.getElementById(id)!;
const tr = (html: string) => (settings.lang === 'en' ? translate(html, state) : html);
const put = (el: HTMLElement, html: string) => morph(el, tr(html));

function renderNotices() {
  put($('notices'), `<h2>알림</h2>` + state.notices.slice().reverse().slice(0, 40).map((n) =>
    `<div class="notice ${n.level} ${n.urgent ? 'urgent' : ''}"><span class="when">${clockText(n.step).replace(/^\d+년 /, '')}</span><span class="msg">${esc(n.text)}</span></div>`).join(''));
}

function tutorialStep(): number | null {
  if (!settings.tutorial || showNewGame) return null;
  const next = advanceTutorial(settings.tutorialStep, state, ui);
  if (next !== settings.tutorialStep) {
    settings.tutorialStep = next;
    saveSettings(settings);
    sound.play('money');
  }
  return next;
}

function renderAll() {
  document.documentElement.lang = settings.lang;
  put($('topbar'), topBar(state, ui));
  put($('regions'), regionList(state, ui));
  const d = $('detail');
  d.classList.toggle('wide', ui.view !== 'region');
  const html = ui.view === 'region' ? regionView(state, ui)
    : ui.view === 'contracts' ? contractsView(state, ui)
    : ui.view === 'finance' ? financeView(state, ui)
    : ui.view === 'research' ? researchView(state)
    : ui.view === 'automation' ? automationView(state)
    : ui.view === 'plan' ? planView(state)
    : goalsView(state);
  put(d, html);
  renderNotices();
  put($('overlay'), `<span class="k">지도</span>${(['none', 'price', 'env', 'mine'] as Overlay[]).map((o) => `<button data-overlay="${o}" class="${overlay === o ? 'on' : ''}">${{ none: '기본', price: '가격', env: '환경', mine: '내 설비' }[o]}</button>`).join('')}`);
  const modal = $('modal');
  modal.classList.toggle('show', showNewGame);
  if (showNewGame) put(modal, newGameView(ng));
  const m2 = $('modal2');
  m2.classList.toggle('show', ui.modal !== 'none');
  if (ui.modal === 'settings') put(m2, settingsView(settings));
  else if (ui.modal === 'saves') put(m2, savesView(listSlots(), !showNewGame));
  else if (ui.modal === 'help') put(m2, helpView());
  const step = tutorialStep();
  const tut = $('tutorial');
  tut.classList.toggle('show', step !== null);
  if (step !== null) put(tut, tutorialHtml(step));
  highlight(step !== null && ui.modal === 'none' ? step : null);
  const t = $('toast');
  const showToast = toast && performance.now() < toast.until;
  t.classList.toggle('show', !!showToast);
  if (showToast) put(t, `<span class="badge ${toast!.level}">긴급</span> ${esc(toast!.text)} <button class="btn tiny ghost" data-toast="close">확인</button>`);
}

function say(level: 'info' | 'warn' | 'error', text: string) {
  notify(state, level, text);
}

// ---- 저장 ----
async function saveSlot(slot: SlotId) {
  if (saving) return;
  saving = true;
  try { await saveTo(slot, state); say('info', `저장했습니다 (수동 ${slot.slice(1)}).`); sound.play('done'); }
  catch { say('error', '저장 실패: 저장소 용량이 부족하거나 쓸 수 없습니다. 오래된 칸을 지우거나 파일로 내보내세요.'); sound.play('error'); }
  finally { saving = false; renderAll(); }
}

async function loadSlot(slot: SlotId) {
  try {
    const next = await loadFrom(slot);
    await swapState(next);
    showNewGame = false;
    ui.modal = 'none';
    ui.speed = 0;
    say('info', `불러왔습니다 (${slot.startsWith('m') ? '수동' : '자동'} ${slot.slice(1)}). 일시정지 상태입니다.`);
  } catch (e) { say('error', e instanceof SaveError || e instanceof Error ? e.message : '불러오기 실패.'); sound.play('error'); }
  renderAll();
}

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function pickFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.pgsave,.json,application/json';
    inp.onchange = () => { const f = inp.files?.[0]; if (!f) return resolve(null); void f.text().then(resolve); };
    inp.click();
  });
}

// ---- 설정 ----
async function applySetting(key: string, value: string) {
  const prevQuality = settings.quality;
  if (key === 'master' || key === 'sfx' || key === 'ambient') { settings[key] = Number(value); sound.setVolumes(settings); }
  else if (key === 'quality') settings.quality = value as Settings['quality'];
  else if (key === 'lang') settings.lang = value as Settings['lang'];
  else if (key === 'autoPause') settings.autoPause = value === '1';
  else if (key === 'autosaveDays') settings.autosaveDays = Number(value);
  else if (key === 'tutorial') { settings.tutorial = true; settings.tutorialStep = 0; ui.modal = 'none'; }
  saveSettings(settings);
  if (settings.quality !== prevQuality) await buildGlobe();
}

// ---- 입력 (이벤트 위임) ----
document.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest('button, [data-act]') as HTMLElement | null;
  if (!t || (t as HTMLButtonElement).disabled) return;
  if (t.tagName === 'SUMMARY') return;
  sound.play('click');
  const d = t.dataset;
  const num = (v?: string) => Number(v);
  if (d.speed !== undefined) ui.speed = num(d.speed);
  else if (d.overlay) overlay = d.overlay as Overlay;
  else if (d.modal) ui.modal = d.modal as Modal;
  else if (d.view) { ui.view = d.view as View; ui.facility = null; if (d.goto !== undefined) { pick(num(d.goto)); } }
  else if (d.region !== undefined) pick(num(d.region));
  else if (d.fac) ui.facility = d.fac === 'close' ? null : num(d.fac);
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
  } else if (d.rush) {
    const [target, id] = d.rush.split(':');
    issue(state, { kind: 'rushRepair', target: target as 'facility' | 'line' | 'hub', id: num(id) });
  } else if (d.expand) { issue(state, { kind: 'expand', facilityId: num(d.expand) }); sound.play('build'); }
  else if (d.thr) {
    const [id, which, delta] = d.thr.split(':');
    const f = state.facilities.find((x) => x.id === num(id));
    if (f) issue(state, { kind: 'setStorage', facilityId: f.id, chargeAtMinor: f.chargeAtMinor + (which === 'c' ? num(delta) : 0), dischargeAtMinor: f.dischargeAtMinor + (which === 'd' ? num(delta) : 0) });
  } else if (d.lic) {
    const [r, type, size] = d.lic.split(':');
    issue(state, { kind: 'acquireLicense', regionId: num(r), type: type as LicenseType, size: size as SizeId });
  } else if (d.renew) issue(state, { kind: 'renewLicense', licenseId: num(d.renew) });
  else if (d.landbuy) issue(state, { kind: 'buyLand', facilityId: num(d.landbuy) });
  else if (d.leaserenew) issue(state, { kind: 'renewLease', facilityId: num(d.leaserenew) });
  else if (d.sell) { if (confirm(tr('이 시설을 매각할까요? 기존 계약 의무는 그대로 남습니다.'))) { issue(state, { kind: 'sellFacility', facilityId: num(d.sell) }); ui.facility = null; } }
  else if (d.dispose) { if (confirm(tr('이 시설을 폐기할까요? 폐기 비용이 듭니다.'))) { issue(state, { kind: 'disposeFacility', facilityId: num(d.dispose) }); ui.facility = null; } }
  else if (d.accept) { if (!d.risky || confirm(tr('공급 여력보다 큰 계약입니다. 공급하지 못하면 위약금이 쌓입니다. 그래도 수락할까요?'))) issue(state, { kind: 'acceptOffer', offerId: num(d.accept) }); }
  else if (d.offerfilter) ui.offerFilter = d.offerfilter as 'all' | 'mine';
  else if (d.repay) issue(state, { kind: 'repayLoan', loanId: num(d.repay) });
  else if (d.loanamt) ui.loanAmount = num(d.loanamt);
  else if (d.loanmonths) ui.loanMonths = num(d.loanmonths);
  else if (d.research) { const [id, perDay] = d.research.split(':'); issue(state, { kind: 'startResearch', id, dailyBudgetMinor: num(perDay) }); }
  else if (d.policy) { const key = d.policy as 'autoRenew' | 'autoInspect' | 'autoStorage'; issue(state, { kind: 'setAutomation', key, on: !state.automation[key] }); }
  else if (d.budget) issue(state, { kind: 'setAutomationBudget', dailyBudgetMinor: state.automation.dailyBudgetMinor + num(d.budget) * 100 });
  else if (d.rec) { const r = recommendations(state).find((x) => x.id === d.rec); if (r?.cmd) issue(state, r.cmd); }
  else if (d.planpause !== undefined) issue(state, { kind: 'planPause', paused: d.planpause === '1' });
  else if (d.planclear) { if (confirm(tr('계획을 모두 비울까요?'))) issue(state, { kind: 'planClear' }); }
  else if (d.planmove) { const [id, dir] = d.planmove.split(':'); issue(state, { kind: 'planMove', id: num(id), dir: num(dir) as -1 | 1 }); }
  else if (d.planremove) issue(state, { kind: 'planRemove', id: num(d.planremove) });
  else if (d.set) { const [k, v] = d.set.split(':'); void applySetting(k, v).then(renderAll); }
  else if (d.slotsave) { void saveSlot(d.slotsave as SlotId); return; }
  else if (d.slotload) { void loadSlot(d.slotload as SlotId); return; }
  else if (d.slotdel) { if (confirm(tr('이 세이브를 지울까요?'))) deleteSlot(d.slotdel as SlotId); }
  else if (d.tut) { if (d.tut === 'close') settings.tutorial = false; else settings.tutorialStep = Math.min(STEPS.length - 1, settings.tutorialStep + 1); saveSettings(settings); }
  else if (d.toast) toast = null;
  else if (d.ngScenario) ng.scenario = d.ngScenario as NewGameForm['scenario'];
  else if (d.ngPreset) ng.preset = d.ngPreset as NewGameForm['preset'];
  else if (d.ngIns) ng.insolvency = d.ngIns as NewGameForm['insolvency'];
  else if (d.ngCash) ng.cash = num(d.ngCash);
  else if (d.ngRegions) ng.regionCount = num(d.ngRegions);
  else if (d.ngSeed) ng.seed = d.ngSeed === 'random' ? 1 + Math.floor(Math.random() * 99_999_999) : num(d.ngSeed);
  else if (d.act) { void act(d.act, t); return; }
  renderAll();
});

function addPlan(item: PlanCmd) {
  issue(state, { kind: 'planAdd', item });
  say('info', '계획에 추가했습니다 — 계획 탭에서 순서를 바꿀 수 있습니다.');
}

async function act(name: string, el: HTMLElement) {
  const buildType = (): TypeId => (ui.tab === 'gen' ? ui.genType : (ui.tab as TypeId));
  if (name === 'build' && ui.selected !== null) { issue(state, { kind: 'build', regionId: ui.selected, type: buildType(), size: ui.buildSize }); sound.play('build'); }
  else if (name === 'plan' && ui.selected !== null) addPlan({ kind: 'build', regionId: ui.selected, type: buildType(), size: ui.buildSize });
  else if (name === 'buildline' && ui.selected !== null) { issue(state, { kind: 'buildLine', a: ui.selected, b: Number(el.dataset.line), size: ui.buildSize }); sound.play('build'); }
  else if (name === 'planline' && ui.selected !== null) addPlan({ kind: 'buildLine', a: ui.selected, b: Number(el.dataset.line), size: ui.buildSize });
  else if (name === 'loan') issue(state, { kind: 'takeLoan', principalMinor: ui.loanAmount, months: ui.loanMonths });
  else if (name === 'bailout') issue(state, { kind: 'bailout' });
  else if (name === 'quicksave') { await saveSlot('m1'); return; }
  else if (name === 'continue') { const slot = latestSlot(); if (slot) { await loadSlot(slot); return; } }
  else if (name === 'export') download(`planetary-grid-day${dayOf(state.step) + 1}.pgsave`, exportText(state));
  else if (name === 'import') {
    const text = await pickFile();
    if (text) {
      try { await swapState(importText(text)); showNewGame = false; ui.modal = 'none'; ui.speed = 0; say('info', '파일에서 불러왔습니다. 일시정지 상태입니다.'); }
      catch (e) { say('error', e instanceof Error ? e.message : '가져오기 실패.'); }
    }
  } else if (name === 'newgame') { showNewGame = true; ui.speed = 0; ui.modal = 'none'; ng.hasSave = latestSlot() !== null; }
  else if (name === 'start') {
    const custom = ng.scenario === 'custom';
    await swapState(createGame({ seed: ng.seed, preset: ng.preset, scenario: ng.scenario, insolvency: ng.insolvency, regionCount: ng.regionCount, ...(custom ? { startCashMinor: ng.cash } : {}) }));
    showNewGame = false;
    ui.speed = 1;
    ui.view = 'region';
    ui.selected = null;
    ui.facility = null;
    if (settings.tutorial) { settings.tutorialStep = 0; saveSettings(settings); }
    const r = state.licenses[0]?.regionId;
    if (r !== undefined) pick(r);
  }
  renderAll();
}

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === 'F5') { e.preventDefault(); if (!showNewGame) void saveSlot('m1'); return; }
  if (e.key === 'F1') { e.preventDefault(); ui.modal = ui.modal === 'help' ? 'none' : 'help'; renderAll(); return; }
  if (e.key === 'Escape') { if (ui.modal !== 'none') ui.modal = 'none'; else if (ui.facility !== null) ui.facility = null; renderAll(); return; }
  if (showNewGame || ui.modal !== 'none') return;
  if (e.code === 'Space') { ui.speed = ui.speed === 0 ? 1 : 0; renderAll(); e.preventDefault(); }
  const n = Number(e.key);
  if (n >= 1 && n <= SPEEDS.length - 1) { ui.speed = SPEEDS[n]; renderAll(); }
});

let globeApi: Awaited<ReturnType<typeof createGlobe>> | null = null;

/** 상태 교체 (새 게임·불러오기). 행성 시드가 바뀌면 행성을 다시 만든다. */
async function swapState(next: GameState) {
  state = next;
  seenSeq = state.noticeSeq ?? 0;
  lastAutoDay = dayOf(state.step);
  toast = null;
  await buildGlobe(); // 시설·선로 표식이 이전 게임 것과 섞이지 않도록 항상 다시 만든다
}

async function buildGlobe() {
  const host = $('globe');
  host.innerHTML = '';
  $('loading').classList.remove('hide');
  const bar = document.querySelector('.loading-bar span') as HTMLElement;
  globeApi?.dispose();
  globeApi = await createGlobe(host, state, (p) => (bar.style.width = `${Math.round(p * 100)}%`), pick, {
    quality: settings.quality,
    onPickFacility: (id) => {
      const f = state.facilities.find((x) => x.id === id);
      if (!f) return;
      pick(f.regionId);
      ui.facility = id;
      renderAll();
    },
  });
  $('loading').classList.add('hide');
}

function pick(id: number) {
  ui.selected = id;
  ui.lineTarget = null;
  ui.view = 'region';
  ui.facility = null;
  const r = state.regions[id];
  globeApi?.focus(r.lat, r.lon);
  renderAll();
}

/** 새 알림 처리: 소리, 긴급 등급 자동 일시정지 (S-21) */
function handleNotices() {
  const seq = state.noticeSeq ?? 0;
  if (seq === seenSeq) return;
  const fresh = state.notices.slice(-Math.min(state.notices.length, seq - seenSeq));
  seenSeq = seq;
  const urgent = fresh.filter((n) => n.urgent);
  if (urgent.length) {
    sound.play('alarm');
    const n = urgent[urgent.length - 1];
    toast = { text: n.text, until: performance.now() + 12_000, level: 'bad' };
    if (settings.autoPause && ui.speed > 0) {
      ui.speed = 0;
      carry = 0;
      toast.text += ' — 자동 일시정지';
    }
    return;
  }
  if (fresh.some((n) => n.level === 'error')) sound.play('warn');
  else if (fresh.some((n) => /^(\[.+\] )?(준공|모듈 확장 준공|연구 완료|목표 달성)/.test(n.text))) sound.play('done');
  else if (fresh.some((n) => n.level === 'warn')) sound.play('warn');
}

async function maybeAutosave() {
  if (saving || settings.autosaveDays <= 0 || showNewGame) return;
  const day = dayOf(state.step);
  if (day - lastAutoDay < settings.autosaveDays) return;
  lastAutoDay = day;
  saving = true;
  try { await autosave(state); } catch { say('warn', '자동 저장 실패 (저장소 용량 부족). 오래된 세이브를 지우세요.'); }
  finally { saving = false; }
}

// ---- 시작 ----
if (DEV) (window as unknown as { __pg: unknown }).__pg = { state: () => state, ui, notify: (t: string) => notify(state, 'error', t, true) };

async function main() {
  await migrateLegacy();
  ng.hasSave = latestSlot() !== null;
  renderAll();
  await buildGlobe();
  // 개발 확인용: ?dev&region=1&lic=GEN,small&build=solar,small&line=2,small&skip=20&minutes=600
  if (DEV) {
    if (params.get('scenario') || params.get('regions')) await swapState(createGame({ seed: state.seed, scenario: (params.get('scenario') as 'A' | 'B' | 'C') ?? 'A', regionCount: Number(params.get('regions')) || 12 }));
    if (params.get('capital')) addCapital(state, Number(params.get('capital')) * 100, '개발용 자본');
    if (params.get('cash')) issue(state, { kind: 'takeLoan', principalMinor: Number(params.get('cash')) * 100, months: 36 });
    if (ui.selected !== null) {
      for (const spec of params.getAll('lic')) { const [t, z] = spec.split(','); issue(state, { kind: 'acquireLicense', regionId: ui.selected, type: t as LicenseType, size: z as SizeId }); }
      for (const spec of params.getAll('build')) { const [t, z] = spec.split(','); issue(state, { kind: 'build', regionId: ui.selected, type: t as TypeId, size: z as SizeId }); }
      for (const spec of params.getAll('line')) { const [b, z] = spec.split(','); issue(state, { kind: 'buildLine', a: ui.selected, b: Number(b), size: z as SizeId }); }
      for (const spec of params.getAll('plan')) { const [t, z] = spec.split(','); issue(state, { kind: 'planAdd', item: { kind: 'build', regionId: ui.selected, type: t as TypeId, size: z as SizeId } }); }
    }
    for (const spec of params.getAll('licat')) { const [r, t, z] = spec.split(','); issue(state, { kind: 'acquireLicense', regionId: Number(r), type: t as LicenseType, size: z as SizeId }); }
    if (params.get('accept')) { advance(state, 1); const o = state.offers.find((x) => x.regionId === ui.selected && x.kind === 'ppa') ?? state.offers.find((x) => x.kind === 'ppa'); if (o) issue(state, { kind: 'acceptOffer', offerId: o.id }); }
    for (const id of params.getAll('done')) state.research.done.push(id);
    if (params.get('research')) issue(state, { kind: 'startResearch', id: params.get('research')!, dailyBudgetMinor: 100_000_00 });
    if (params.get('skip')) advance(state, Number(params.get('skip')) * STEPS_PER_DAY);
    if (params.get('minutes')) advance(state, Number(params.get('minutes')));
    if (params.get('expand')) { const f = state.facilities.find((x) => x.status === 'operating'); if (f) { issue(state, { kind: 'expand', facilityId: f.id }); advance(state, Number(params.get('expand')) * STEPS_PER_DAY); } }
    if (params.get('tab')) ui.tab = params.get('tab') as Tab;
    if (params.get('gentype')) ui.genType = params.get('gentype') as TypeId;
    if (params.get('speed')) ui.speed = Number(params.get('speed'));
    seenSeq = state.noticeSeq;
    lastAutoDay = dayOf(state.step);
  }
  if (ui.selected !== null) pick(ui.selected);
  if (DEV && params.get('fac')) { const f = state.facilities[Number(params.get('fac')) - 1]; if (f) ui.facility = f.id; }

  let last = performance.now();
  let lastUi = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (!showNewGame && ui.modal === 'none') {
      carry += dt * ui.speed;
      const n = Math.min(5000, Math.floor(carry));
      if (n > 0) { advance(state, n); carry -= n; }
      flushCommands(state);
      handleNotices();
      void maybeAutosave();
    }
    globeApi?.update(state, ui.selected, overlay, ui.facility);
    if (now - lastUi > 250 && !pointerDown) { renderAll(); lastUi = now; }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main();

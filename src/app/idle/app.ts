// 간편 모드 화면: 성장형 타이쿤. 지역 칸에 발전소를 짓고 레벨업해 수익을 키운다.
// 행성 화면(globe.ts)은 상세 모드와 같은 것을 쓰고, 상태는 간단한 변환으로 넘긴다.

import { createGlobe } from '../globe';
import { morph } from '../morph';
import { sound } from '../audio';
import { loadSettings, saveSettings, type Settings } from '../settings';
import { esc } from '../views';
import * as C from '../../idle/core';
import type { GameState } from '../../sim/sim';

const KEY = 'planetary-grid.idle';
const params = new URLSearchParams(location.search);
const DEV = params.has('dev');

const IMG: Record<C.BType, string | null> = {
  solar: null, wind: './assets/card_wind.webp', thermal: './assets/card_thermal.webp', hydro: null, nuclear: null, fusion: null,
};
const ICON: Record<C.BType, string> = { solar: '☀️', wind: '🌬️', thermal: '🔥', hydro: '💧', nuclear: '⚛️', fusion: '✴️' };
const COLOR: Record<C.BType, string> = { solar: '#f2c94c', wind: '#9ad7e8', thermal: '#f2994a', hydro: '#4fa3e0', nuclear: '#7ed37a', fusion: '#c08cff' };
const art = (t: C.BType) => (IMG[t] ? `<img src="${IMG[t]}" alt="">` : `<div class="ph" style="--c:${COLOR[t]}"><span>${ICON[t]}</span></div>`);

type Tab = 'region' | 'research' | 'prestige';
interface Ui { tab: Tab; region: number; buy: 1 | 10 | 'max'; picking: number | null; modal: 'none' | 'title' | 'offline' | 'settings' | 'prestige'; offline: { money: number; seconds: number } | null }

const settings: Settings = loadSettings();
sound.setVolumes(settings);
let s: C.IdleState = load() ?? C.newIdle();
const ui: Ui = { tab: 'region', region: s.order[0], buy: 1, picking: null, modal: DEV ? 'none' : 'title', offline: null };
let globe: Awaited<ReturnType<typeof createGlobe>> | null = null;
let pointerDown = false;
const $ = (id: string) => document.getElementById(id)!;
const name = (ri: number) => C.regionDefs(s.seed)[ri].name;

function load(): C.IdleState | null {
  try { const t = localStorage.getItem(KEY); return t ? C.deserializeIdle(t) : null; } catch { return null; }
}
function save() {
  try { localStorage.setItem(KEY, C.serializeIdle(s)); } catch { /* 저장소 없음 */ }
}

// ---------- 화면 ----------

function topBar(): string {
  const inc = C.income(s);
  const boostOn = s.time < s.boostUntil;
  const ready = s.time >= s.boostReadyAt;
  const boostLabel = boostOn ? `부스트 ×2 · ${Math.ceil(s.boostUntil - s.time)}초` : ready ? '⚡ 부스트 ×2' : `충전 중 ${Math.ceil(s.boostReadyAt - s.time)}초`;
  return `<div class="brand">PLANETARY <b>GRID</b></div>
    <div class="money"><span class="coin">CR</span><span class="num big">${C.fmt(s.money)}</span><span class="num rate">+${C.fmt(inc)}/초</span></div>
    ${s.stars ? `<div class="stars" title="명성 하나당 모든 수익 +10%">★ ${s.stars}</div>` : ''}
    <button class="boost ${boostOn ? 'on' : ''}" data-act="boost" ${ready ? '' : 'disabled'}>${boostLabel}</button>
    <nav class="nav">${([['region', '발전소'], ['research', '연구'], ['prestige', '상장']] as [Tab, string][]).map(([k, n]) => `<button data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${n}${k === 'research' && C.RESEARCH.some((r) => C.researchState(s, r.id) === 'open' && r.cost <= s.money) ? ' <span class="count">!</span>' : ''}${k === 'prestige' && C.starsFor(s.earned) > 0 ? ' <span class="count">★</span>' : ''}</button>`).join('')}</nav>
    <div class="spacer"></div>
    <div class="seg buy">${([1, 10, 'max'] as const).map((b) => `<button data-buy="${b}" class="${ui.buy === b ? 'on' : ''}">${b === 'max' ? '최대' : '×' + b}</button>`).join('')}</div>
    <button class="btn ghost small icon" data-modal="settings" title="설정">⚙</button>`;
}

function regionList(): string {
  const rows = s.order.filter((i) => s.regions[i].unlocked).map((i) => {
    const b = C.regionBonus(s.seed, i);
    const surge = s.time < s.regions[i].surgeUntil;
    return `<button class="region-row ${ui.region === i ? 'selected' : ''}" data-region="${i}">
      <span class="name">${esc(name(i))}${surge ? ' <span class="badge warn">수요 급증 ×2</span>' : ''}</span><span class="price">+${C.fmt(C.regionIncome(s, i))}</span>
      <span class="sub"><span>☀ ×${b.sun.toFixed(1)}</span><span>🌬 ×${b.wind.toFixed(1)}</span><span>💲 ×${b.price.toFixed(2)}</span></span></button>`;
  }).join('');
  const next = C.nextRegion(s);
  const cost = C.regionCost(s);
  const lock = next === null ? '' : `<div class="unlock"><div><b>${esc(name(next))}</b> <span class="faint">다음 지역</span><div class="sub">☀ ×${C.regionBonus(s.seed, next).sun.toFixed(1)} · 🌬 ×${C.regionBonus(s.seed, next).wind.toFixed(1)} · 💲 ×${C.regionBonus(s.seed, next).price.toFixed(2)}</div></div>
    <button class="btn primary" data-act="unlock" ${s.money >= cost ? '' : 'disabled'}>열기 ${C.fmt(cost)}</button></div>`;
  return `<h2>내 지역 <span class="h-note">${C.unlockedCount(s)} / ${s.regions.length}</span></h2>${rows}${lock}`;
}

function buyInfo(sl: C.Slot): { n: number; cost: number } {
  const t = sl.type!;
  if (ui.buy === 'max') { const n = Math.max(1, C.maxAffordable(t, sl.level, s.money)); return { n, cost: C.bulkCost(t, sl.level, n) }; }
  return { n: ui.buy, cost: C.bulkCost(t, sl.level, ui.buy) };
}

function slotCard(ri: number, si: number): string {
  const sl = s.regions[ri].slots[si];
  if (!sl.type) {
    if (ui.picking === si) {
      return `<div class="slot pick"><div class="pick-head">무엇을 지을까요? <button class="btn tiny ghost" data-pick="close">✕</button></div>${C.BUILDINGS.map((b) => {
        const ok = C.canBuild(s, b.id);
        const cost = C.levelCost(b.id, 0);
        return `<button class="pick-row" data-build="${si}:${b.id}" ${ok && s.money >= cost ? '' : 'disabled'} title="${esc(b.desc)}"><span class="ic" style="--c:${COLOR[b.id]}">${ICON[b.id]}</span><span>${b.name}${ok ? '' : ' 🔒'}</span><span class="num">${ok ? C.fmt(cost) : '연구 필요'}</span></button>`;
      }).join('')}</div>`;
    }
    const cheapest = C.BUILDINGS.filter((b) => C.canBuild(s, b.id)).some((b) => s.money >= C.levelCost(b.id, 0));
    return `<button class="slot empty ${cheapest ? 'can' : ''}" data-pick="${si}"><span class="plus">＋</span><span>건설</span></button>`;
  }
  const d = C.BMAP[sl.type];
  const out = C.slotOutput(s, ri, sl) * C.regionPrice(s, ri) * C.globalMult(s);
  const next = C.nextMilestone(sl.level);
  const prev = [...C.MILESTONES].reverse().find((m) => sl.level >= m) ?? 0;
  const prog = next ? ((sl.level - prev) / (next - prev)) * 100 : 100;
  const b = buyInfo(sl);
  const can = s.money >= b.cost;
  return `<div class="slot" style="--c:${COLOR[sl.type]}">${art(sl.type)}
    <div class="slot-body"><div class="t">${d.name} <span class="lv">Lv ${sl.level}</span></div>
      <div class="out num">+${C.fmt(out)}/초</div>
      <div class="ms" title="${next ? `레벨 ${next}에서 출력 2배` : '최대 이정표'}"><span style="width:${prog}%"></span><i>${next ? `Lv${next} ×2` : 'MAX'}</i></div></div>
    <button class="lvbtn ${can ? '' : 'off'}" data-level="${si}" ${can ? '' : 'disabled'}><span>레벨업 ${ui.buy === 'max' ? `+${b.n}` : '×' + b.n}</span><span class="num">${C.fmt(b.cost)}</span></button>
    <button class="del" data-demolish="${si}" title="철거 (다른 발전으로 바꿀 때, 환불 없음)">✕</button></div>`;
}

function regionView(): string {
  const ri = ui.region;
  const r = s.regions[ri];
  const b = C.regionBonus(s.seed, ri);
  const d = C.localDay(s, ri);
  const hh = Math.floor(d * 24);
  const surge = s.time < r.surgeUntil;
  const slots = r.slots.map((_, si) => slotCard(ri, si)).join('');
  const expand = r.slots.length < C.MAX_SLOTS
    ? `<button class="slot empty expand ${s.money >= C.slotCost(s, ri) ? 'can' : ''}" data-act="expand" ${s.money >= C.slotCost(s, ri) ? '' : 'disabled'}><span class="plus">⬚</span><span>부지 확장</span><span class="num">${C.fmt(C.slotCost(s, ri))}</span></button>` : '';
  return `<div class="detail-title"><h1>${esc(name(ri))}</h1><span class="coord">현지 ${String(hh).padStart(2, '0')}시 ${hh >= 6 && hh < 18 ? '☀' : '🌙'}</span></div>
    <div class="chips"><span class="chip">☀ 일사 ×${b.sun.toFixed(1)}</span><span class="chip">🌬 바람 ×${(b.wind * C.windFactor(s, ri)).toFixed(2)}</span><span class="chip ${surge ? 'hot' : ''}">💲 가격 ×${C.regionPrice(s, ri).toFixed(2)}${surge ? ` 급증 ${Math.ceil(r.surgeUntil - s.time)}초` : ''}</span></div>
    <div class="big-inc"><span class="k">이 지역 수익</span><span class="num">+${C.fmt(C.regionIncome(s, ri))}/초</span></div>
    <div class="slots">${slots}${expand}</div>
    <div class="note">레벨 10·25·50·100…에 도달하면 그 시설 출력이 2배가 됩니다. 태양광은 낮에만, 풍력은 바람 따라 출렁입니다.</div>`;
}

function researchView(): string {
  const list = C.RESEARCH.slice().sort((a, b) => a.cost - b.cost);
  return `<h2>연구 <span class="h-note">돈을 투자해 영구 강화</span></h2><div class="rgrid">${list.map((r) => {
    const st = C.researchState(s, r.id);
    const can = st === 'open' && s.money >= r.cost;
    return `<div class="rcard ${st}"><div class="t">${r.name}</div><div class="s">${r.desc}</div>
      ${st === 'done' ? '<span class="badge info">완료</span>' : st === 'locked' ? `<span class="s faint">선행: ${C.RESEARCH.find((x) => x.id === r.requires)!.name}</span>` : `<button class="btn small ${can ? 'primary' : ''}" data-research="${r.id}" ${can ? '' : 'disabled'}>${C.fmt(r.cost)}</button>`}</div>`;
  }).join('')}</div>`;
}

function prestigeView(): string {
  const gain = C.starsFor(s.earned);
  return `<h2>상장 <span class="h-note">회사를 팔고 더 큰 회사로 다시 시작</span></h2>
    <div class="kv"><div><div class="k">보유 명성</div><div class="v num">★ ${s.stars}</div></div><div><div class="k">지금 상장하면</div><div class="v num">+★ ${gain}</div></div><div><div class="k">이번 회사 수익</div><div class="v num">${C.fmt(s.earned)}</div></div></div>
    <p class="s">명성 ★ 하나당 <b>모든 수익 +10%</b>가 영구히 붙습니다. 상장하면 돈·지역·시설·연구가 처음으로 돌아가지만, 명성 덕분에 훨씬 빨리 성장합니다.</p>
    <p class="s faint">이번 회사에서 ${C.fmt(C.PRESTIGE_MIN)} CR 이상 벌면 명성을 얻을 수 있고, 많이 벌수록 더 많이 얻습니다. 지금까지 상장 ${s.prestiges}회.</p>
    <button class="btn primary wide" data-modal="prestige" ${gain > 0 ? '' : 'disabled'}>${gain > 0 ? `상장하고 ★ ${gain} 받기` : `${C.fmt(C.PRESTIGE_MIN - s.earned)} CR 더 벌면 가능`}</button>`;
}

function questCard(): string {
  const q = C.currentQuest(s);
  if (!q) return `<h2>목표</h2><div class="quest done">모든 목표를 달성했습니다! 상장으로 더 큰 회사를 노려 보세요.</div>`;
  const ok = q.done(s);
  return `<h2>목표 <span class="h-note">${s.quest + 1} / ${C.QUESTS.length}</span></h2>
    <div class="quest ${ok ? 'ready' : ''}"><div class="qt">${q.text}</div><div class="qr">보상 <b class="num">${C.fmt(q.reward)} CR</b></div>
    <button class="btn ${ok ? 'primary' : ''}" data-act="claim" ${ok ? '' : 'disabled'}>${ok ? '보상 받기' : '진행 중'}</button></div>`;
}

function modalView(): string {
  if (ui.modal === 'title') {
    const fresh = s.builds === 0 && s.prestiges === 0;
    return `<div class="ng title-card"><div class="ng-title">PLANETARY <b>GRID</b></div>
      <div class="ng-sub">발전소를 짓고, 키우고, 행성 전체로 뻗어 나가세요.</div>
      <div class="ng-acts col"><button class="btn primary big" data-act="play">${fresh ? '시작하기' : '이어하기'}</button>
        ${fresh ? '' : '<button class="btn ghost" data-act="reset">처음부터 다시</button>'}
        <button class="btn ghost small" data-act="deep">상세 경영 모드 (복잡한 규칙)</button></div></div>`;
  }
  if (ui.modal === 'offline' && ui.offline) {
    const h = Math.floor(ui.offline.seconds / 3600), m = Math.floor((ui.offline.seconds % 3600) / 60);
    return `<div class="ng dialog center"><h2>다시 오셨군요!</h2><p>자리를 비운 ${h ? `${h}시간 ` : ''}${m}분 동안 발전소가 일했습니다.</p><div class="reward num">+${C.fmt(ui.offline.money)} CR</div>
      <p class="s faint">${C.has(s, 'offline2') ? '' : '자리를 비운 동안은 수익의 50%만 들어옵니다 (연구로 늘릴 수 있음).'}</p><button class="btn primary big" data-modal="none">받기</button></div>`;
  }
  if (ui.modal === 'prestige') {
    return `<div class="ng dialog center"><h2>상장할까요?</h2><p>돈·지역·시설·연구가 처음으로 돌아가고, <b>★ ${C.starsFor(s.earned)}</b>를 받습니다 (모든 수익 +${C.starsFor(s.earned) * 10}% 영구).</p>
      <div class="ng-acts"><button class="btn ghost" data-modal="none">취소</button><button class="btn primary" data-act="prestige">상장</button></div></div>`;
  }
  if (ui.modal === 'settings') {
    const VOL = [0, 0.25, 0.5, 0.75, 1];
    const vol = (key: 'master' | 'sfx' | 'ambient', label: string) => `<div class="set-row"><span>${label}</span><div class="seg">${VOL.map((v) => `<button data-set="${key}:${v}" class="${Math.abs(settings[key] - v) < 0.01 ? 'on' : ''}">${v === 0 ? '끔' : Math.round(v * 100)}</button>`).join('')}</div></div>`;
    return `<div class="ng dialog"><div class="dlg-head"><h2>설정</h2><button class="btn small ghost" data-modal="none">닫기</button></div>
      <div class="ng-sec">${vol('master', '전체 음량')}${vol('sfx', '효과음')}${vol('ambient', '배경음')}
        <div class="set-row"><span>그래픽 품질</span><div class="seg">${(['low', 'medium', 'high'] as const).map((q) => `<button data-set="quality:${q}" class="${settings.quality === q ? 'on' : ''}">${{ low: '낮음', medium: '보통', high: '높음' }[q]}</button>`).join('')}</div></div></div>
      <div class="ng-sec"><h3>저장</h3><div class="acts-row"><button class="btn small" data-act="export">파일로 내보내기</button><button class="btn small" data-act="import">파일에서 가져오기</button><button class="btn small danger" data-act="reset">처음부터 다시</button></div>
        <div class="note">진행은 10초마다 자동 저장됩니다. 꺼 두어도 발전소는 계속 일합니다(오프라인 수익).</div></div>
      <div class="ng-sec"><h3>모드</h3><button class="btn small" data-act="deep">상세 경영 모드로 전환</button><div class="note">사업권·토지·계약·대출·송전 손실까지 다루는 복잡한 경영 시뮬레이션입니다. 진행은 따로 저장됩니다.</div></div></div>`;
  }
  return '';
}

function renderAll() {
  morph($('topbar'), topBar());
  morph($('regions'), regionList());
  const d = $('detail');
  d.classList.toggle('wide', ui.tab !== 'region');
  morph(d, ui.tab === 'region' ? regionView() : ui.tab === 'research' ? researchView() : prestigeView());
  morph($('notices'), questCard());
  const m = $('modal');
  m.classList.toggle('show', ui.modal !== 'none');
  document.body.classList.toggle('title', ui.modal === 'title');
  morph(m, modalView());
}

// ---------- 행성 ----------

/** 간편 모드 상태 → 행성 화면이 읽는 최소한의 형태 */
function globeState(): GameState {
  const facilities: unknown[] = [];
  s.regions.forEach((r, ri) => r.unlocked && r.slots.forEach((sl, si) => {
    if (!sl.type) return;
    facilities.push({
      id: ri * 100 + si + 1, type: sl.type, size: sl.level < 10 ? 'small' : sl.level < 50 ? 'medium' : 'large', regionId: ri,
      status: 'operating', online: true, rightsOk: true, health: { s: 'ok' }, modules: 0,
      capKw: 1, outputKw: sl.type === 'solar' ? C.sunFactor(s, ri) : sl.type === 'wind' ? C.windFactor(s, ri) : 1,
    });
  }));
  const frac = ((s.time / C.DAY_SECONDS) % 1 + 1) % 1;
  return {
    seed: s.seed, step: Math.floor(frac * 1440), regions: C.regionDefs(s.seed), facilities, lines: [],
    licenses: s.regions.map((r, i) => (r.unlocked ? { regionId: i } : null)).filter(Boolean),
    regionState: C.regionDefs(s.seed).map((_, i) => ({ priceMinor: C.regionPrice(s, i) * 10000 })),
  } as unknown as GameState;
}

async function buildGlobe() {
  $('loading').classList.remove('hide');
  const bar = document.querySelector('.loading-bar span') as HTMLElement;
  globe?.dispose();
  $('globe').innerHTML = '';
  globe = await createGlobe($('globe'), globeState(), (p) => (bar.style.width = `${Math.round(p * 100)}%`), (ri) => {
    if (s.regions[ri].unlocked) { ui.region = ri; ui.tab = 'region'; ui.picking = null; renderAll(); globe?.focus(C.regionDefs(s.seed)[ri].lat, C.regionDefs(s.seed)[ri].lon); }
  }, { quality: settings.quality, onPickFacility: (id) => { ui.region = Math.floor((id - 1) / 100); ui.tab = 'region'; renderAll(); } });
  // 잠긴 지역 이름표는 흐리게
  globe.labels.querySelectorAll('.region-label').forEach((el, i) => el.classList.toggle('locked', !s.regions[i].unlocked));
  $('loading').classList.add('hide');
}

/** 떠오르는 수익 숫자 */
let lastFloat = 0;
function floaters(now: number) {
  if (now - lastFloat < 1600 || !globe || ui.modal !== 'none') return;
  lastFloat = now;
  const layer = $('floaters');
  s.regions.forEach((r, ri) => {
    if (!r.unlocked) return;
    const inc = C.regionIncome(s, ri);
    if (inc <= 0) return;
    const def = C.regionDefs(s.seed)[ri];
    const p = globe!.project(def.lat, def.lon);
    if (!p) return;
    const el = document.createElement('div');
    el.className = 'floater' + (s.time < r.surgeUntil ? ' hot' : '');
    el.textContent = `+${C.fmt(inc * 1.6)}`;
    el.style.left = `${p.x + (Math.random() * 30 - 15)}px`;
    el.style.top = `${p.y - 10}px`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  });
}

// ---------- 입력 ----------

function flash(text: string) {
  const t = $('toast');
  t.innerHTML = `<span>${esc(text)}</span>`;
  t.classList.add('show', 'info');
  clearTimeout((flash as unknown as { h: number }).h);
  (flash as unknown as { h: number }).h = window.setTimeout(() => t.classList.remove('show'), 1800);
}

function result(r: C.Result, okSound: 'build' | 'click' | 'done' | 'money' = 'click') {
  if (r) { flash(r); sound.play('error'); } else sound.play(okSound);
}

document.addEventListener('pointerdown', () => { pointerDown = true; sound.unlock(); });
document.addEventListener('pointerup', () => setTimeout(() => (pointerDown = false), 0));

document.addEventListener('click', (ev) => {
  const t = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!t || t.disabled) return;
  const d = t.dataset;
  const ri = ui.region;
  if (d.tab) { ui.tab = d.tab as Tab; sound.play('click'); }
  else if (d.region !== undefined) { ui.region = Number(d.region); ui.picking = null; ui.tab = 'region'; const r = C.regionDefs(s.seed)[ui.region]; globe?.focus(r.lat, r.lon); sound.play('click'); }
  else if (d.buy) { ui.buy = d.buy === 'max' ? 'max' : (Number(d.buy) as 1 | 10); sound.play('click'); }
  else if (d.pick) { ui.picking = d.pick === 'close' ? null : Number(d.pick); sound.play('click'); }
  else if (d.build) { const [si, type] = d.build.split(':'); result(C.build(s, ri, Number(si), type as C.BType), 'build'); ui.picking = null; }
  else if (d.level) {
    const si = Number(d.level);
    const sl = s.regions[ri].slots[si];
    const before = C.milestoneCount(sl.level);
    const r = C.levelUp(s, ri, si, ui.buy);
    result(r, 'click');
    if (!r && C.milestoneCount(sl.level) > before) { sound.play('done'); flash(`${C.BMAP[sl.type!].name} Lv ${sl.level} — 출력 2배!`); }
  } else if (d.demolish) { if (confirm('이 시설을 철거할까요? 레벨과 투자금은 돌아오지 않습니다.')) result(C.demolish(s, ri, Number(d.demolish))); }
  else if (d.research) { const r = C.doResearch(s, d.research); result(r, 'done'); if (!r) { const n = C.RESEARCH.find((x) => x.id === d.research)!; flash(`연구 완료: ${n.name} — ${n.desc}`); } }
  else if (d.modal) { ui.modal = d.modal as Ui['modal']; sound.play('click'); }
  else if (d.set) {
    const [k, v] = d.set.split(':');
    const prevQ = settings.quality;
    if (k === 'quality') settings.quality = v as Settings['quality'];
    else (settings as unknown as Record<string, number>)[k] = Number(v);
    sound.setVolumes(settings);
    saveSettings(settings);
    if (settings.quality !== prevQ) void buildGlobe();
  } else if (d.act) { void act(d.act); return; }
  renderAll();
});

async function act(a: string) {
  if (a === 'boost') result(C.boost(s), 'money');
  else if (a === 'unlock') {
    const next = C.nextRegion(s);
    const r = C.unlockRegion(s);
    result(r, 'done');
    if (!r && next !== null) {
      ui.region = next; ui.tab = 'region';
      globe?.labels.querySelectorAll('.region-label')[next]?.classList.remove('locked');
      const def = C.regionDefs(s.seed)[next];
      globe?.focus(def.lat, def.lon);
      flash(`새 지역: ${def.name}`);
    }
  } else if (a === 'expand') result(C.expandSlots(s, ui.region), 'build');
  else if (a === 'claim') { const q = C.currentQuest(s); const r = C.claimQuest(s); result(r, 'money'); if (!r && q) flash(`목표 달성! +${C.fmt(q.reward)} CR`); }
  else if (a === 'prestige') {
    const r = C.prestige(s);
    result(r, 'done');
    if (!r) { ui.modal = 'none'; ui.tab = 'region'; ui.region = s.order[0]; save(); await buildGlobe(); flash(`상장 완료 — ★ ${s.stars}`); }
  } else if (a === 'play') { ui.modal = 'none'; sound.unlock(); }
  else if (a === 'reset') {
    if (confirm('정말 처음부터 다시 시작할까요? 지금 진행(명성 포함)이 지워집니다.')) { s = C.newIdle(); save(); ui.modal = 'none'; ui.region = s.order[0]; await buildGlobe(); }
  } else if (a === 'deep') {
    save();
    try { localStorage.setItem('planetary-grid.mode', 'deep'); } catch { /* 무시 */ }
    location.reload();
  } else if (a === 'export') {
    const blob = new Blob([C.serializeIdle(s)], { type: 'application/json' });
    const el = document.createElement('a');
    el.href = URL.createObjectURL(blob);
    el.download = 'planetary-grid-casual.pgsave';
    el.click();
  } else if (a === 'import') {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.pgsave,.json';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try { s = C.deserializeIdle(await f.text()); ui.region = s.order[0]; ui.modal = 'none'; save(); await buildGlobe(); flash('불러왔습니다'); }
      catch (e) { flash(e instanceof Error ? e.message : '불러오기 실패'); }
      renderAll();
    };
    inp.click();
  }
  renderAll();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { ui.modal = ui.modal === 'title' ? 'title' : 'none'; ui.picking = null; renderAll(); }
  if (e.code === 'Space' && ui.modal === 'none') { e.preventDefault(); void act('boost'); }
});
window.addEventListener('beforeunload', save);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); else applyAway(); });

function applyAway() {
  const r = C.applyOffline(s);
  if (r.money > 0) { ui.offline = r; if (ui.modal === 'none') ui.modal = 'offline'; sound.play('money'); }
}

// ---------- 시작 ----------

async function main() {
  document.body.classList.add('casual');
  if (DEV) {
    if (params.has('fresh')) s = C.newIdle();
    if (params.get('money')) s.money = Number(params.get('money'));
    if (params.get('res') === 'all') s.research = C.RESEARCH.map((r) => r.id);
    if (params.get('regions')) { const n = Number(params.get('regions')); for (let k = 1; k < n; k++) s.regions[s.order[k]].unlocked = true; }
    if (params.get('fill')) {
      const types = params.get('fill')!.split(',') as C.BType[];
      s.regions.forEach((r, ri) => r.unlocked && r.slots.forEach((sl, si) => { sl.type = types[(si + ri) % types.length]; sl.level = 5 + ((si * 17 + ri * 7) % 60); }));
    }
    if (params.get('modal')) ui.modal = params.get('modal') as Ui['modal'];
  }
  applyAway();
  renderAll();
  await buildGlobe();
  const r0 = C.regionDefs(s.seed)[ui.region];
  globe?.focus(r0.lat, r0.lon);
  let last = performance.now();
  let lastUi = 0, lastSave = 0, lastMgr = 0;
  const loop = (now: number) => {
    const dt = Math.min(1, (now - last) / 1000);
    last = now;
    if (ui.modal !== 'title') {
      const ev = C.tick(s, dt);
      if (ev.surge !== undefined) { flash(`${name(ev.surge)} 수요 급증! 가격 ×2 (30초)`); sound.play('money'); }
      if (now - lastMgr > 2000) { C.managerStep(s); lastMgr = now; }
      floaters(now);
    }
    globe?.update(globeState(), ui.region, 'none', null);
    globe?.setIdle(ui.modal === 'title');
    if (now - lastUi > 200 && !pointerDown) { renderAll(); lastUi = now; }
    if (now - lastSave > 10_000) { save(); lastSave = now; }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

void main();

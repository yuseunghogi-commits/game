// 간편 모드(성장형 타이쿤) 코어. DOM 없음 — 테스트 가능.
// 흐름: 지역 칸에 발전소 건설 → 레벨업 → 이정표마다 출력 2배 → 연구로 배수 → 새 지역 → 오프라인 수익 → 상장(명성)으로 재시작.
// 사업권·대출·계약·송전 손실 같은 상세 규칙은 상세 경영 모드(src/sim)에만 있다.

import { generateRegions, type RegionDef } from '../sim/data';

export type BType = 'solar' | 'wind' | 'thermal' | 'hydro' | 'nuclear' | 'fusion';
export interface BDef { id: BType; name: string; cost: number; out: number; growth: number; unlock?: string; desc: string }

export const BUILDINGS: BDef[] = [
  { id: 'solar', name: '태양광', cost: 5, out: 1, growth: 1.15, desc: '낮에만 발전 · 일사가 좋은 지역에서 강함' },
  { id: 'wind', name: '풍력', cost: 80, out: 5, growth: 1.16, desc: '바람에 따라 출렁임 · 풍황이 좋은 지역에서 강함' },
  { id: 'thermal', name: '열발전', cost: 1_500, out: 25, growth: 1.17, desc: '밤낮 없이 일정한 출력' },
  { id: 'hydro', name: '수력', cost: 40_000, out: 170, growth: 1.18, unlock: 'hydro', desc: '일정한 출력 · 연구로 해금' },
  { id: 'nuclear', name: '핵분열', cost: 2_000_000, out: 2_200, growth: 1.19, unlock: 'nuclear', desc: '강력한 기저 출력 · 연구로 해금' },
  { id: 'fusion', name: '핵융합', cost: 150_000_000, out: 42_000, growth: 1.2, unlock: 'fusion', desc: '최종 발전 · 연구로 해금' },
];
export const BMAP = Object.fromEntries(BUILDINGS.map((b) => [b.id, b])) as Record<BType, BDef>;

/** 레벨 이정표: 도달할 때마다 그 시설 출력 ×2 */
export const MILESTONES = [10, 25, 50, 100, 150, 200, 300, 400, 500];

export interface ResearchDef { id: string; name: string; cost: number; requires?: string; desc: string }
export const RESEARCH: ResearchDef[] = [
  { id: 'solar1', name: '고효율 패널', cost: 1_000, desc: '태양광 ×2' },
  { id: 'wind1', name: '대형 날개', cost: 8_000, desc: '풍력 ×2' },
  { id: 'grid1', name: '스마트 그리드', cost: 120_000, desc: '모든 수익 ×1.5' },
  { id: 'hydro', name: '수력 발전', cost: 60_000, desc: '수력 발전소 해금' },
  { id: 'thermal1', name: '복합 화력', cost: 300_000, desc: '열발전 ×2' },
  { id: 'storage', name: '야간 저장', cost: 800_000, requires: 'solar1', desc: '태양광이 밤에도 50% 발전' },
  { id: 'offline1', name: '원격 관제', cost: 1_500_000, desc: '자리를 비운 동안 수익 최대 8시간 (기본 2시간)' },
  { id: 'nuclear', name: '핵분열 발전', cost: 4_000_000, requires: 'hydro', desc: '핵분열 발전소 해금' },
  { id: 'manager', name: '운영 매니저', cost: 6_000_000, desc: '열린 지역마다 가장 싼 레벨업을 자동으로 구매' },
  { id: 'land', name: '부지 개발', cost: 15_000_000, desc: '부지 확장 비용 절반' },
  { id: 'solar2', name: '양면 패널', cost: 30_000_000, requires: 'solar1', desc: '태양광 ×3' },
  { id: 'wind2', name: '해상 풍력', cost: 60_000_000, requires: 'wind1', desc: '풍력 ×3' },
  { id: 'hydro1', name: '양수 발전', cost: 120_000_000, requires: 'hydro', desc: '수력 ×2' },
  { id: 'boost1', name: '수요 반응', cost: 200_000, desc: '부스트 지속 시간 3배' },
  { id: 'grid2', name: '초고압 송전망', cost: 500_000_000, requires: 'grid1', desc: '모든 수익 ×2' },
  { id: 'fusion', name: '핵융합 발전', cost: 300_000_000, requires: 'nuclear', desc: '핵융합 발전소 해금' },
  { id: 'thermal2', name: '탄소 포집 화력', cost: 2_000_000_000, requires: 'thermal1', desc: '열발전 ×3' },
  { id: 'nuclear1', name: '소형 모듈 원자로', cost: 8_000_000_000, requires: 'nuclear', desc: '핵분열 ×2' },
  { id: 'offline2', name: '완전 자동 운영', cost: 20_000_000_000, requires: 'offline1', desc: '자리를 비운 동안 수익 100% (기본 50%)' },
  { id: 'grid3', name: '행성 송전망', cost: 100_000_000_000, requires: 'grid2', desc: '모든 수익 ×3' },
  { id: 'fusion1', name: '고온 초전도', cost: 1_000_000_000_000, requires: 'fusion', desc: '핵융합 ×3' },
];

export interface Slot { type: BType | null; level: number }
export interface RegionS { unlocked: boolean; slots: Slot[]; surgeUntil: number }
export interface Quest { id: string; text: string; reward: number; done: (s: IdleState) => boolean }

export interface IdleState {
  v: 1;
  seed: number;
  money: number;
  /** 이번 회사(상장 전)에서 번 돈 — 명성 계산 */
  earned: number;
  /** 지금까지 번 돈 전체 */
  lifetime: number;
  stars: number;
  prestiges: number;
  /** 게임 시간(초). 낮·밤과 사건 기준 */
  time: number;
  regions: RegionS[];
  order: number[];
  research: string[];
  quest: number;
  boostUntil: number;
  boostReadyAt: number;
  nextSurgeAt: number;
  rng: number;
  savedAt: number;
  builds: number;
  levelups: number;
}

export const DAY_SECONDS = 360; // 게임 하루 = 실제 6분
export const START_SLOTS = 3;
export const MAX_SLOTS = 8;
export const BOOST = { mult: 2, seconds: 60, cooldown: 300 };
export const SURGE = { mult: 2, seconds: 30, gapMin: 90, gapMax: 180 };
export const OFFLINE = { baseCapH: 2, upCapH: 8, baseEff: 0.5 };
export const PRESTIGE_MIN = 1e9;

// ---------- 지역 ----------

const regionCache = new Map<number, RegionDef[]>();
export function regionDefs(seed: number): RegionDef[] {
  let r = regionCache.get(seed);
  if (!r) { r = generateRegions(seed, 12); regionCache.set(seed, r); }
  return r;
}

export function regionBonus(seed: number, i: number) {
  const r = regionDefs(seed)[i];
  return {
    sun: 0.6 + r.solar * 0.2,
    wind: 0.6 + r.wind * 0.2,
    price: Math.round((0.8 + ((r.pBaseMinor - 9000) / 2600) * 0.6) * 100) / 100,
  };
}

/** 지역을 여는 순서: 시작 지역에서 가까운 순 */
function unlockOrder(seed: number): number[] {
  const defs = regionDefs(seed);
  const scores = defs.map((r, i) => ({ i, s: (r.solar + r.wind) * 10 + r.pBaseMinor / 1000 }));
  const start = scores.sort((a, b) => b.s - a.s)[0].i;
  const d = (a: RegionDef, b: RegionDef) => Math.acos(Math.min(1, Math.sin(a.lat * 0.01745) * Math.sin(b.lat * 0.01745) + Math.cos(a.lat * 0.01745) * Math.cos(b.lat * 0.01745) * Math.cos((a.lon - b.lon) * 0.01745)));
  return defs.map((_, i) => i).sort((a, b) => (a === start ? -1 : b === start ? 1 : d(defs[start], defs[a]) - d(defs[start], defs[b])));
}

export function newIdle(seed = 20261101, now = Date.now()): IdleState {
  const order = unlockOrder(seed);
  const regions: RegionS[] = regionDefs(seed).map(() => ({ unlocked: false, slots: Array.from({ length: START_SLOTS }, () => ({ type: null, level: 0 })), surgeUntil: 0 }));
  regions[order[0]].unlocked = true;
  return {
    v: 1, seed, money: 15, earned: 0, lifetime: 0, stars: 0, prestiges: 0, time: DAY_SECONDS * 0.3, regions, order, research: [], quest: 0,
    boostUntil: 0, boostReadyAt: 0, nextSurgeAt: 120, rng: (seed ^ 0x2545f491) >>> 0, savedAt: now, builds: 0, levelups: 0,
  };
}

function rand(s: IdleState): number {
  let t = (s.rng = (s.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const has = (s: IdleState, id: string) => s.research.includes(id);
export const unlockedCount = (s: IdleState) => s.regions.filter((r) => r.unlocked).length;

/** n번째로 여는 지역 비용 (n = 지금 열린 수) */
export function regionCost(s: IdleState): number {
  const n = unlockedCount(s);
  return Math.round(800 * Math.pow(20, n - 1));
}

export function nextRegion(s: IdleState): number | null {
  return s.order.find((i) => !s.regions[i].unlocked) ?? null;
}

/** 지역의 기준 가격대 (지역을 연 순서가 늦을수록 비싼 부지) */
function regionTier(s: IdleState, ri: number): number {
  return Math.max(0, s.order.indexOf(ri));
}

export function slotCost(s: IdleState, ri: number): number {
  const cap = s.regions[ri].slots.length;
  const base = 250 * Math.pow(20, regionTier(s, ri));
  return Math.round(base * Math.pow(7, cap - START_SLOTS) * (has(s, 'land') ? 0.5 : 1));
}

// ---------- 생산 ----------

export function milestoneCount(level: number): number {
  return MILESTONES.filter((m) => level >= m).length;
}

export function nextMilestone(level: number): number | null {
  return MILESTONES.find((m) => level < m) ?? null;
}

/** 레벨 L → L+1 비용. L = 0이면 건설비 */
export function levelCost(type: BType, level: number): number {
  const d = BMAP[type];
  return d.cost * Math.pow(d.growth, level);
}

/** 레벨 level에서 n개 레벨을 올리는 비용 (등비수열 합) */
export function bulkCost(type: BType, level: number, n: number): number {
  const d = BMAP[type];
  return d.cost * Math.pow(d.growth, level) * (Math.pow(d.growth, n) - 1) / (d.growth - 1);
}

/** 가진 돈으로 올릴 수 있는 최대 레벨 수 */
export function maxAffordable(type: BType, level: number, money: number): number {
  const d = BMAP[type];
  const first = d.cost * Math.pow(d.growth, level);
  if (money < first) return 0;
  return Math.floor(Math.log((money * (d.growth - 1)) / first + 1) / Math.log(d.growth));
}

function typeMult(s: IdleState, t: BType): number {
  const m: Record<BType, number> = {
    solar: (has(s, 'solar1') ? 2 : 1) * (has(s, 'solar2') ? 3 : 1),
    wind: (has(s, 'wind1') ? 2 : 1) * (has(s, 'wind2') ? 3 : 1),
    thermal: (has(s, 'thermal1') ? 2 : 1) * (has(s, 'thermal2') ? 3 : 1),
    hydro: has(s, 'hydro1') ? 2 : 1,
    nuclear: has(s, 'nuclear1') ? 2 : 1,
    fusion: has(s, 'fusion1') ? 3 : 1,
  };
  return m[t];
}

export function globalMult(s: IdleState, withBoost = true): number {
  return (has(s, 'grid1') ? 1.5 : 1) * (has(s, 'grid2') ? 2 : 1) * (has(s, 'grid3') ? 3 : 1) * (1 + 0.1 * s.stars) * (withBoost && s.time < s.boostUntil ? BOOST.mult : 1);
}

/** 지역 현지 시각 (0..1, 0.5 = 정오). 행성 화면의 태양과 같은 기준 */
export function localDay(s: IdleState, ri: number, t = s.time): number {
  const lon = regionDefs(s.seed)[ri].lon;
  return (((t / DAY_SECONDS + lon / 360) % 1) + 1) % 1;
}

export function sunFactor(s: IdleState, ri: number, t = s.time): number {
  const d = localDay(s, ri, t);
  const sun = Math.max(0, Math.sin((d - 0.25) * Math.PI * 2));
  return Math.max(sun, has(s, 'storage') ? 0.5 : 0);
}

export function windFactor(s: IdleState, ri: number, t = s.time): number {
  const ph = ri * 1.7;
  return 0.75 + 0.25 * Math.sin(t / 47 + ph) * Math.cos(t / 113 + ph * 0.6);
}

/** 시설 하나의 초당 생산 (배수·날씨 포함, 지역 가격·전역 배수 제외) */
export function slotOutput(s: IdleState, ri: number, slot: Slot, t = s.time, average = false): number {
  if (!slot.type || slot.level <= 0) return 0;
  const d = BMAP[slot.type];
  const b = regionBonus(s.seed, ri);
  let f = 1;
  if (slot.type === 'solar') f = b.sun * (average ? (has(s, 'storage') ? 0.66 : 0.32) : sunFactor(s, ri, t));
  else if (slot.type === 'wind') f = b.wind * (average ? 0.75 : windFactor(s, ri, t));
  return d.out * slot.level * Math.pow(2, milestoneCount(slot.level)) * typeMult(s, slot.type) * f;
}

export function regionPrice(s: IdleState, ri: number, t = s.time): number {
  return regionBonus(s.seed, ri).price * (t < s.regions[ri].surgeUntil ? SURGE.mult : 1);
}

/** 지역의 초당 수익 */
export function regionIncome(s: IdleState, ri: number, t = s.time, average = false): number {
  const r = s.regions[ri];
  if (!r.unlocked) return 0;
  const sum = r.slots.reduce((a, sl) => a + slotOutput(s, ri, sl, t, average), 0);
  return sum * (average ? regionBonus(s.seed, ri).price : regionPrice(s, ri, t)) * globalMult(s, !average);
}

export function income(s: IdleState, t = s.time, average = false): number {
  let sum = 0;
  for (let i = 0; i < s.regions.length; i++) sum += regionIncome(s, i, t, average);
  return sum;
}

// ---------- 행동 ----------

export type Result = string | null; // null = 성공, 문자열 = 거부 사유

function pay(s: IdleState, cost: number): boolean {
  if (s.money + 1e-9 < cost) return false;
  s.money -= cost;
  return true;
}

export function canBuild(s: IdleState, t: BType): boolean {
  const u = BMAP[t].unlock;
  return !u || has(s, u);
}

export function build(s: IdleState, ri: number, si: number, t: BType): Result {
  const r = s.regions[ri];
  const slot = r?.slots[si];
  if (!r?.unlocked || !slot) return '지역이 열려 있지 않습니다';
  if (slot.type) return '이미 시설이 있습니다';
  if (!canBuild(s, t)) return '연구가 필요합니다';
  if (!pay(s, levelCost(t, 0))) return '돈이 부족합니다';
  slot.type = t;
  slot.level = 1;
  s.builds += 1;
  return null;
}

/** n = 'max'면 가능한 만큼 */
export function levelUp(s: IdleState, ri: number, si: number, n: number | 'max'): Result {
  const slot = s.regions[ri]?.slots[si];
  if (!slot?.type) return '시설이 없습니다';
  const k = n === 'max' ? maxAffordable(slot.type, slot.level, s.money) : n;
  if (k <= 0) return '돈이 부족합니다';
  if (!pay(s, bulkCost(slot.type, slot.level, k))) return '돈이 부족합니다';
  slot.level += k;
  s.levelups += k;
  return null;
}

/** 시설 교체: 지금 시설을 없애고 다른 종류로 (환불 없음). 상위 발전으로 바꿀 때 쓴다 */
export function demolish(s: IdleState, ri: number, si: number): Result {
  const slot = s.regions[ri]?.slots[si];
  if (!slot?.type) return '시설이 없습니다';
  slot.type = null;
  slot.level = 0;
  return null;
}

export function expandSlots(s: IdleState, ri: number): Result {
  const r = s.regions[ri];
  if (!r?.unlocked) return '지역이 열려 있지 않습니다';
  if (r.slots.length >= MAX_SLOTS) return '부지를 더 넓힐 수 없습니다';
  if (!pay(s, slotCost(s, ri))) return '돈이 부족합니다';
  r.slots.push({ type: null, level: 0 });
  return null;
}

export function unlockRegion(s: IdleState): Result {
  const ri = nextRegion(s);
  if (ri === null) return '모든 지역을 열었습니다';
  if (!pay(s, regionCost(s))) return '돈이 부족합니다';
  s.regions[ri].unlocked = true;
  return null;
}

export function researchState(s: IdleState, id: string): 'done' | 'locked' | 'open' {
  if (has(s, id)) return 'done';
  const d = RESEARCH.find((x) => x.id === id)!;
  return d.requires && !has(s, d.requires) ? 'locked' : 'open';
}

export function doResearch(s: IdleState, id: string): Result {
  const d = RESEARCH.find((x) => x.id === id);
  if (!d) return '없는 연구';
  const st = researchState(s, id);
  if (st === 'done') return '이미 완료';
  if (st === 'locked') return '선행 연구 필요';
  if (!pay(s, d.cost)) return '돈이 부족합니다';
  s.research.push(id);
  return null;
}

export function boostSeconds(s: IdleState) {
  return BOOST.seconds * (has(s, 'boost1') ? 3 : 1);
}

export function boost(s: IdleState): Result {
  if (s.time < s.boostReadyAt) return '아직 준비 중';
  s.boostUntil = s.time + boostSeconds(s);
  s.boostReadyAt = s.time + boostSeconds(s) + BOOST.cooldown;
  return null;
}

// ---------- 명성 (상장) ----------

export function starsFor(earned: number): number {
  return earned < PRESTIGE_MIN ? 0 : Math.floor(Math.sqrt(earned / PRESTIGE_MIN) * 2);
}

/** 상장: 회사를 새로 시작하되 명성(★ 하나당 모든 수익 +10%)을 영구히 얻는다 */
export function prestige(s: IdleState): Result {
  const gain = starsFor(s.earned);
  if (gain <= 0) return `이번 회사에서 ${fmt(PRESTIGE_MIN)} CR 이상 벌어야 합니다`;
  const keep = { stars: s.stars + gain, prestiges: s.prestiges + 1, lifetime: s.lifetime, quest: s.quest, seed: s.seed };
  const fresh = newIdle(s.seed, s.savedAt);
  Object.assign(s, fresh, keep, { money: 50 });
  return null;
}

// ---------- 목표 ----------

const anySlot = (s: IdleState, f: (sl: Slot) => boolean) => s.regions.some((r) => r.unlocked && r.slots.some(f));
export const QUESTS: Quest[] = [
  { id: 'b1', text: '태양광 발전소 짓기', reward: 10, done: (s) => anySlot(s, (x) => x.type === 'solar') },
  { id: 'l5', text: '태양광을 레벨 5까지', reward: 25, done: (s) => anySlot(s, (x) => x.type === 'solar' && x.level >= 5) },
  { id: 'w1', text: '풍력 발전소 짓기', reward: 60, done: (s) => anySlot(s, (x) => x.type === 'wind') },
  { id: 'r1', text: '연구 하나 완료', reward: 150, done: (s) => s.research.length >= 1 },
  { id: 'l10', text: '아무 시설이나 레벨 10 (출력 2배!)', reward: 300, done: (s) => anySlot(s, (x) => x.level >= 10) },
  { id: 'reg2', text: '두 번째 지역 열기', reward: 600, done: (s) => unlockedCount(s) >= 2 },
  { id: 't1', text: '열발전소 짓기', reward: 1_500, done: (s) => anySlot(s, (x) => x.type === 'thermal') },
  { id: 'i100', text: '초당 수익 100 CR', reward: 4_000, done: (s) => income(s, s.time, true) >= 100 },
  { id: 'slot', text: '부지 확장 한 번', reward: 8_000, done: (s) => s.regions.some((r) => r.slots.length > START_SLOTS) },
  { id: 'hyd', text: '수력 발전소 짓기', reward: 30_000, done: (s) => anySlot(s, (x) => x.type === 'hydro') },
  { id: 'reg4', text: '지역 4곳 열기', reward: 120_000, done: (s) => unlockedCount(s) >= 4 },
  { id: 'l50', text: '아무 시설이나 레벨 50', reward: 300_000, done: (s) => anySlot(s, (x) => x.level >= 50) },
  { id: 'nuc', text: '핵분열 발전소 짓기', reward: 1_000_000, done: (s) => anySlot(s, (x) => x.type === 'nuclear') },
  { id: 'mgr', text: '운영 매니저 연구', reward: 1_500_000, done: (s) => has(s, 'manager') },
  { id: 'i1m', text: '초당 수익 1M CR', reward: 20_000_000, done: (s) => income(s, s.time, true) >= 1e6 },
  { id: 'reg8', text: '지역 8곳 열기', reward: 60_000_000, done: (s) => unlockedCount(s) >= 8 },
  { id: 'fus', text: '핵융합 발전소 짓기', reward: 300_000_000, done: (s) => anySlot(s, (x) => x.type === 'fusion') },
  { id: 'star', text: '첫 상장으로 명성 얻기', reward: 1_000, done: (s) => s.prestiges >= 1 },
  { id: 'reg12', text: '행성 전체(12지역) 진출', reward: 5e9, done: (s) => unlockedCount(s) >= 12 },
];

export function currentQuest(s: IdleState): Quest | null {
  return QUESTS[s.quest] ?? null;
}

export function claimQuest(s: IdleState): Result {
  const q = currentQuest(s);
  if (!q) return '모든 목표 완료';
  if (!q.done(s)) return '아직 달성하지 못했습니다';
  s.money += q.reward;
  s.quest += 1;
  return null;
}

// ---------- 진행 ----------

/** 매니저: 지역마다 가장 싼 레벨업 하나 (호출 쪽이 주기를 정한다) */
export function managerStep(s: IdleState) {
  if (!has(s, 'manager')) return;
  s.regions.forEach((r, ri) => {
    if (!r.unlocked) return;
    let best = -1, bc = Infinity;
    r.slots.forEach((sl, si) => { if (sl.type) { const c = levelCost(sl.type, sl.level); if (c < bc) { bc = c; best = si; } } });
    // 매니저는 가진 돈의 절반까지만 쓴다 (플레이어가 쓸 돈을 남김)
    if (best >= 0 && bc <= s.money * 0.5) levelUp(s, ri, best, 1);
  });
}

export interface TickEvents { surge?: number }

/** dt초 진행. 1초 단위로 나눠 계산한다 (낮·밤 변화 반영) */
export function tick(s: IdleState, dt: number): TickEvents {
  const ev: TickEvents = {};
  let left = dt;
  while (left > 0) {
    const h = Math.min(1, left);
    const earn = income(s, s.time + h / 2) * h;
    s.money += earn;
    s.earned += earn;
    s.lifetime += earn;
    s.time += h;
    left -= h;
    if (s.time >= s.nextSurgeAt) {
      const open = s.regions.map((r, i) => (r.unlocked ? i : -1)).filter((i) => i >= 0);
      const ri = open[Math.floor(rand(s) * open.length)];
      s.regions[ri].surgeUntil = s.time + SURGE.seconds;
      s.nextSurgeAt = s.time + SURGE.gapMin + rand(s) * (SURGE.gapMax - SURGE.gapMin);
      ev.surge = ri;
    }
  }
  return ev;
}

/** 자리를 비운 동안의 수익 (평균 출력 기준). 반환 = 번 돈, 인정된 초 */
export function offlineEarnings(s: IdleState, seconds: number): { money: number; seconds: number } {
  const cap = (has(s, 'offline1') ? OFFLINE.upCapH : OFFLINE.baseCapH) * 3600;
  const sec = Math.max(0, Math.min(seconds, cap));
  const eff = has(s, 'offline2') ? 1 : OFFLINE.baseEff;
  return { money: income(s, s.time, true) * sec * eff, seconds: sec };
}

export function applyOffline(s: IdleState, now = Date.now()): { money: number; seconds: number } {
  const away = (now - s.savedAt) / 1000;
  if (away < 60) return { money: 0, seconds: 0 };
  const r = offlineEarnings(s, away);
  s.money += r.money;
  s.earned += r.money;
  s.lifetime += r.money;
  s.time += r.seconds;
  return r;
}

// ---------- 표시 ----------

const UNITS = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
export function fmt(n: number): string {
  if (!isFinite(n)) return '∞';
  if (n < 0) return '-' + fmt(-n);
  if (n < 1000) return n < 10 && n % 1 ? n.toFixed(1) : Math.floor(n).toString();
  let e = Math.floor(Math.log10(n) / 3 + 1e-9);
  const digits = (m: number) => (m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2));
  let str = digits(n / Math.pow(10, 3 * e));
  if (parseFloat(str) >= 1000) { e += 1; str = digits(n / Math.pow(10, 3 * e)); }
  if (e < UNITS.length) return str + UNITS[e];
  const k = e - UNITS.length; // 단위를 넘어가면 aa, ab, ...
  return str + String.fromCharCode(97 + Math.floor(k / 26)) + String.fromCharCode(97 + (k % 26));
}

// ---------- 저장 ----------

export function serializeIdle(s: IdleState, now = Date.now()): string {
  return JSON.stringify({ ...s, savedAt: now });
}

export function deserializeIdle(text: string): IdleState {
  const s = JSON.parse(text) as IdleState;
  if (s.v !== 1 || !Array.isArray(s.regions)) throw new Error('간편 모드 세이브가 아닙니다');
  return s;
}

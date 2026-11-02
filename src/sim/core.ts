// 공통 도우미: 원장, 알림, 난수, 명령 큐. 모든 하위 시스템이 이 모듈만 통해 현금을 바꾼다.

import type { Account, Command, GameState, Health, Notice } from './types';

// 거래 ID 집합 캐시 (상태에는 원장 배열만 저장, 불러오면 다시 만든다)
const idCache = new WeakMap<object, Set<string>>();
function ids(s: GameState): Set<string> {
  let set = idCache.get(s.ledger);
  if (!set) { set = new Set(s.ledger.map((e) => e.id)); idCache.set(s.ledger, set); }
  return set;
}

export function post(s: GameState, id: string, debit: Account, credit: Account, amount: number, memo: string): boolean {
  if (amount === 0) return false;
  if (amount < 0) return post(s, id, credit, debit, -amount, memo);
  const set = ids(s);
  if (set.has(id)) return false; // 중복 거래 방지 (멱등)
  set.add(id);
  s.ledger.push({ id, step: s.step, debit, credit, amount, memo });
  if (debit === 'cash') s.cash += amount;
  if (credit === 'cash') s.cash -= amount;
  return true;
}

/** 같은 스텝에 여러 번 생기는 거래용 고유 ID (원장 길이로 결정적) */
export function txId(s: GameState, tag: string): string {
  return `${tag}:${s.step}:${s.ledger.length}`;
}

export function ledgerCash(s: GameState): number {
  let c = 0;
  for (const e of s.ledger) {
    if (e.debit === 'cash') c += e.amount;
    if (e.credit === 'cash') c -= e.amount;
  }
  return c;
}

export function pendingCash(s: GameState): number {
  let c = 0;
  for (const k in s.dayAcc) c += s.dayAcc[k].revenue - s.dayAcc[k].cost;
  return c;
}

export function addCapital(s: GameState, amount: number, memo = '자본 투입') {
  post(s, txId(s, 'capital'), 'cash', 'equity', amount, memo);
}

export function notify(s: GameState, level: Notice['level'], text: string) {
  s.notices.push({ step: s.step, level, text });
  if (s.notices.length > 100) s.notices.splice(0, s.notices.length - 100);
}

export function rand(s: GameState): number {
  let t = (s.rng = (s.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const randInt = (s: GameState, lo: number, hi: number) => lo + Math.floor(rand(s) * (hi - lo + 1));

export function issue(s: GameState, cmd: Command, auto?: string): number {
  s.commandSeq += 1;
  s.pending.push({ seq: s.commandSeq, cmd, auto });
  return s.commandSeq;
}

export function availableCash(s: GameState): number {
  return s.cash - s.reserved;
}

export const isUp = (h: Health) => h.s === 'ok' || h.s === 'warning';

export function healthLabel(h: Health): string {
  return h.s === 'ok' ? '정상' : h.s === 'warning' ? '점검 필요' : h.s === 'failed' ? '고장' : '점검 중';
}

/** 재량 지출 차단 (연체·구조조정·회생불능 중, Baseline §17.6) */
export function discretionaryBlocked(s: GameState): string | null {
  if (s.insolvency === 'arrears') return '연체 중에는 신규 투자를 할 수 없습니다';
  if (s.insolvency === 'restructuring') return '구조조정 중에는 신규 투자를 할 수 없습니다';
  if (s.insolvency === 'insolvent' || s.insolvency === 'liquidated') return '회생불능 상태입니다';
  return null;
}

/** 현금은 이미 반영된 거래를 원장에만 기록 (당일 누적분 마감용) */
export function record(s: GameState, id: string, debit: Account, credit: Account, amount: number, memo: string) {
  if (amount <= 0) return;
  const set = ids(s);
  if (set.has(id)) return;
  set.add(id);
  s.ledger.push({ id, step: s.step, debit, credit, amount, memo });
}

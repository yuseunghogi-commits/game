// 금융·지급불능 (Baseline §16–17, 결정 S-12·S-13·S-18).
// 대출: 원리금 균등, 월(30일) 상환, 연이율(게임년 120일). 한도 = 기본 신용 + 담보 장부가 × 인정률 − 잔액.
// 지급불능: 정상 → 유동성 경고 → 연체 → 구조조정 → 회생불능. 즉시 게임오버 없음.

import { DISPOSAL, INSOLVENCY, LAND, LOAN, LICENSE, type TypeId } from './data';
import { discretionaryBlocked, notify, post, txId } from './core';
import { landBuyPrice } from './rights';
import { PPM, STEPS_PER_DAY, roundHalfEven } from './units';
import type { Facility, GameState, Loan } from './types';

export function monthlyRatePpm(annualPpm: number): number {
  return Math.round((annualPpm * LOAN.monthDays) / LICENSE.termDays);
}

export function annuityPayment(principal: number, annualPpm: number, months: number): number {
  const r = monthlyRatePpm(annualPpm) / PPM;
  if (r === 0) return Math.ceil(principal / months);
  return roundHalfEven((principal * r) / (1 - Math.pow(1 + r, -months)));
}

/** 장부가 (결정 S-13: 감가상각 없음 = 취득 원가) */
export function bookValue(f: Facility): number {
  if (f.status === 'operating') return f.capexMinor;
  return f.stageCosts.slice(0, Math.max(0, f.stage + 1)).reduce((a, b) => a + b, 0);
}

export function loanBalance(s: GameState): number {
  return s.loans.reduce((a, l) => a + l.balanceMinor + l.arrearsMinor, 0);
}

export function creditLimit(s: GameState): number {
  const fac = s.facilities.filter((f) => f.status === 'operating').reduce((a, f) => a + f.capexMinor, 0);
  const land = s.facilities.filter((f) => f.land.mode === 'own').reduce((a, f) => a + f.land.purchaseMinor, 0);
  const lim = LOAN.baseCreditMinor + (fac * LOAN.facilityLtvPpm) / PPM + (land * LOAN.landLtvPpm) / PPM;
  return Math.max(0, Math.round(lim) - loanBalance(s));
}

export function netWorth(s: GameState): number {
  const fac = s.facilities.reduce((a, f) => a + bookValue(f), 0);
  const lines = s.lines.reduce((a, l) => a + (l.status === 'operating' ? l.capexMinor : l.stageCosts.slice(0, Math.max(0, l.stage + 1)).reduce((x, y) => x + y, 0)), 0);
  const land = s.facilities.reduce((a, f) => a + (f.land.mode === 'own' ? f.land.purchaseMinor : f.land.depositMinor), 0);
  // 사업권 장부가 = 취득가 × 남은 기간 비율 (Baseline §16.5.1)
  const term = LICENSE.termDays * STEPS_PER_DAY;
  const lic = s.licenses.reduce((a, l) => a + (l.state === 'active' ? Math.round((l.priceMinor * Math.max(0, Math.min(term, l.expiresAt - s.step))) / term) : 0), 0);
  return s.cash + fac + lines + land + lic - loanBalance(s);
}

export function takeLoan(s: GameState, principalMinor: number, months: number) {
  const block = s.insolvency === 'restructuring' || s.insolvency === 'insolvent' || s.insolvency === 'liquidated';
  if (block) return notify(s, 'error', '대출 거부: 구조조정·회생불능 중에는 신규 대출을 받을 수 없습니다');
  if (!LOAN.terms.includes(months)) return notify(s, 'error', '대출 거부: 지원하지 않는 기간');
  if (principalMinor <= 0 || principalMinor > creditLimit(s)) return notify(s, 'error', '대출 거부: 한도 초과');
  const rate = Math.round(LOAN.baseRatePpmPerYear * s.rules.m.loanRate);
  const loan: Loan = {
    id: s.nextId++, principalMinor, balanceMinor: principalMinor, ratePpmPerYear: rate, months, paidMonths: 0,
    paymentMinor: annuityPayment(principalMinor, rate, months), nextDueStep: s.step + LOAN.monthDays * STEPS_PER_DAY, arrearsMinor: 0,
  };
  s.loans.push(loan);
  s.everBorrowed = true;
  post(s, `loan:${loan.id}`, 'cash', 'loan', principalMinor, `대출 실행 #${loan.id}`);
  notify(s, 'info', `대출 실행: ${(principalMinor / 100).toLocaleString()} CR, ${months}개월, 월 ${(loan.paymentMinor / 100).toLocaleString()} CR`);
}

export function repayLoan(s: GameState, loanId: number) {
  const l = s.loans.find((x) => x.id === loanId);
  if (!l) return notify(s, 'error', '상환 거부: 대출 없음');
  const fee = Math.round((l.balanceMinor * LOAN.prepayFeePpm) / PPM);
  const total = l.balanceMinor + l.arrearsMinor + fee;
  if (s.cash < total) return notify(s, 'error', '조기 상환 거부: 현금 부족');
  post(s, txId(s, `repay:${l.id}`), 'loan', 'cash', l.balanceMinor + l.arrearsMinor, `조기 상환 #${l.id}`);
  post(s, txId(s, `prepayfee:${l.id}`), 'interest', 'cash', fee, `조기 상환 수수료 #${l.id}`);
  s.loans = s.loans.filter((x) => x.id !== l.id);
  notify(s, 'info', `대출 #${l.id} 조기 상환`);
}

/** 게임일 경계: 연체분 우선 상환 → 만기 회차 상환 */
export function loansDay(s: GameState, day: number) {
  for (const l of [...s.loans]) {
    if (l.arrearsMinor > 0) {
      const penalty = Math.round((l.arrearsMinor * LOAN.penaltyRatePpm) / PPM / LICENSE.termDays);
      post(s, `D${day}:latefee:${l.id}`, 'interest', 'cash', penalty, `연체 이자 #${l.id}`);
      const pay = Math.min(l.arrearsMinor, Math.max(0, s.cash));
      if (pay > 0) { post(s, `D${day}:arrears:${l.id}`, 'loan', 'cash', pay, `연체분 상환 #${l.id}`); l.arrearsMinor -= pay; }
    }
    if (s.step < l.nextDueStep) continue;
    const r = monthlyRatePpm(l.ratePpmPerYear) / PPM;
    const interest = roundHalfEven(l.balanceMinor * r);
    const last = l.paidMonths + 1 >= l.months;
    const principal = last ? l.balanceMinor : Math.min(l.balanceMinor, l.paymentMinor - interest);
    post(s, `D${day}:int:${l.id}`, 'interest', 'cash', interest, `대출 이자 #${l.id}`);
    l.balanceMinor -= principal;
    l.paidMonths += 1;
    l.nextDueStep += LOAN.monthDays * STEPS_PER_DAY;
    if (s.cash >= principal) post(s, `D${day}:prin:${l.id}`, 'loan', 'cash', principal, `원금 상환 #${l.id}`);
    else { l.arrearsMinor += principal; notify(s, 'error', `대출 #${l.id} 상환 실패 — 연체 ${(principal / 100).toLocaleString()} CR`); }
    if (l.balanceMinor === 0 && l.arrearsMinor === 0) {
      s.loans = s.loans.filter((x) => x.id !== l.id);
      notify(s, 'info', `대출 #${l.id} 상환 완료`);
    }
  }
}

/** 7일 의무 지출 예측 (유지비·수수료·임대료·상환) */
export function upcomingObligations(s: GameState, days = 7): number {
  const daily = s.facilities.reduce((a, f) => a + (f.status === 'operating' ? f.fixedMinorPerDay : 0) + (f.land.mode === 'lease' && f.land.state !== 'expired' ? f.land.rentPerDayMinor : 0), 0)
    + s.licenses.reduce((a, l) => a + (l.state !== 'expired' ? l.feePerDayMinor : 0), 0);
  const horizon = s.step + days * STEPS_PER_DAY;
  const loans = s.loans.reduce((a, l) => a + (l.nextDueStep <= horizon ? l.paymentMinor : 0) + l.arrearsMinor, 0);
  return daily * days + loans;
}

export function insolvencyDay(s: GameState) {
  const arrears = s.loans.reduce((a, l) => a + l.arrearsMinor, 0);
  const trouble = arrears > 0 || s.cash < 0;
  const prev = s.insolvency;
  if (prev === 'liquidated') return;
  if (prev === 'insolvent') return;
  if (prev === 'restructuring') {
    if (!trouble) { s.insolvency = 'normal'; notify(s, 'info', '구조조정 완료 — 정상 경영으로 복귀'); return; }
    if (s.step >= s.restructureUntil && s.rules.insolvency !== 'none') {
      s.insolvency = 'insolvent';
      notify(s, 'error', s.rules.insolvency === 'bailout' ? '회생불능 — 구제를 신청할 수 있습니다' : '회생불능 — 회사가 청산되었습니다');
      if (s.rules.insolvency === 'liquidation') s.insolvency = 'liquidated';
    }
    return;
  }
  if (trouble) {
    if (prev !== 'arrears') { s.insolvency = 'arrears'; s.arrearsSince = s.step; notify(s, 'error', '연체 상태 — 신규 투자가 막힙니다. 시설 매각·정지나 대출로 회복하세요'); }
    const days = (s.step - s.arrearsSince) / STEPS_PER_DAY;
    if (days >= INSOLVENCY.arrearsToRestructureDays || s.cash < -INSOLVENCY.negativeCashLimitMinor) {
      s.insolvency = 'restructuring';
      s.restructureUntil = s.step + INSOLVENCY.restructureDays * STEPS_PER_DAY;
      notify(s, 'error', `구조조정 시작 — ${INSOLVENCY.restructureDays}일 안에 연체와 음수 현금을 해소하세요 (재무 화면의 매각 후보 참고)`);
    }
    return;
  }
  const warn = upcomingObligations(s) > s.cash;
  if (warn && prev !== 'warning') notify(s, 'warn', '유동성 경고: 앞으로 7일 의무 지출이 현금보다 많습니다');
  s.insolvency = warn ? 'warning' : 'normal';
}

/** 구제 (S-12 옵션 ①): 부채를 60개월 저리 대출로 재조정하고 현금을 0으로 맞춘다. 기록에 남는다. */
export function bailout(s: GameState) {
  if (s.insolvency !== 'insolvent' || s.rules.insolvency !== 'bailout') return notify(s, 'error', '구제는 회생불능 상태에서만 신청할 수 있습니다');
  const debt = loanBalance(s) + Math.max(0, -s.cash);
  for (const l of s.loans) post(s, txId(s, `bail-close:${l.id}`), 'loan', 'bailout', l.balanceMinor + l.arrearsMinor, `구제: 대출 #${l.id} 인수`);
  s.loans = [];
  if (s.cash < 0) post(s, txId(s, 'bail-cash'), 'cash', 'bailout', -s.cash, '구제: 음수 현금 보전');
  const rate = Math.round(LOAN.baseRatePpmPerYear * 0.5);
  const loan: Loan = { id: s.nextId++, principalMinor: debt, balanceMinor: debt, ratePpmPerYear: rate, months: 60, paidMonths: 0, paymentMinor: annuityPayment(debt, rate, 60), nextDueStep: s.step + LOAN.monthDays * STEPS_PER_DAY, arrearsMinor: 0 };
  if (debt > 0) { s.loans.push(loan); post(s, txId(s, 'bail-loan'), 'bailout', 'loan', debt, '구제 대출 (60개월)'); }
  s.bailouts += 1;
  s.insolvency = 'normal';
  notify(s, 'warn', `구제 완료 — 부채 ${(debt / 100).toLocaleString()} CR를 60개월 저리 대출로 재조정 (기록에 표시됨)`);
}

// ---------- 매각·폐기 (Q35) ----------

export function saleValue(f: Facility): number {
  if (f.status !== 'operating') return 0;
  return Math.round(f.capexMinor * (f.health.s === 'failed' ? DISPOSAL.saleShareFailed : DISPOSAL.saleShareOk));
}

export function disposeCost(f: Facility): number {
  return Math.round((f.capexMinor * DISPOSAL.disposeCostPpm[f.type as TypeId]) / PPM);
}

function releaseLand(s: GameState, f: Facility) {
  if (f.land.mode === 'own') post(s, txId(s, `landsale:${f.id}`), 'cash', 'land_asset', Math.round(f.land.purchaseMinor * LAND.resaleShare), `토지 매각 #${f.id}`);
  else if (f.land.depositMinor) post(s, txId(s, `deposit-back:${f.id}`), 'cash', 'land_asset', f.land.depositMinor, `임대 보증금 반환 #${f.id}`);
}

export function sellFacility(s: GameState, f: Facility) {
  if (f.status !== 'operating') return notify(s, 'error', '매각 거부: 운영 중인 시설만 매각할 수 있습니다');
  const v = saleValue(f);
  post(s, txId(s, `sale:${f.id}`), 'cash', 'sale', v, `시설 매각 #${f.id}`);
  releaseLand(s, f);
  s.facilities = s.facilities.filter((x) => x.id !== f.id);
  notify(s, 'info', `시설 매각: #${f.id} (${(v / 100).toLocaleString()} CR). 기존 계약 의무는 유지됩니다`);
}

export function disposeFacility(s: GameState, f: Facility) {
  if (f.status !== 'operating') return notify(s, 'error', '폐기 거부: 건설 중인 시설은 취소하세요');
  const c = disposeCost(f);
  post(s, txId(s, `dispose:${f.id}`), 'disposal', 'cash', c, `시설 폐기 #${f.id}`);
  releaseLand(s, f);
  s.facilities = s.facilities.filter((x) => x.id !== f.id);
  notify(s, 'info', `시설 폐기: #${f.id} (비용 ${(c / 100).toLocaleString()} CR)`);
}

export function buyBlocked(s: GameState): string | null {
  return discretionaryBlocked(s);
}

export const landPrice = landBuyPrice;

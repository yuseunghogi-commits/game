// 단위 규칙 (Design Baseline 1.0 §3.5, §16.6)
// - 스텝 = 게임 1분, 정산 구간(DI) = 15 스텝, 게임일 = 1,440 스텝
// - 게임년 = 120 게임일 (결정 S-15)
// - 출력: 정수 kW / 에너지: 정수 Wh (kW × 15분 = kW × 250 Wh)
// - 화폐: 정수 minor unit (1 CR = 100) / 가격: minor per MWh / 비율: ppm

export const STEPS_PER_DI = 15;
export const DI_PER_DAY = 96;
export const STEPS_PER_DAY = 1440;
export const DAYS_PER_YEAR = 120;
export const WH_PER_KW_PER_DI = 250;
export const PPM = 1_000_000;
export const MINOR_PER_CR = 100;

/** 0.5에서는 짝수 쪽으로 반올림 (은행가 반올림). */
export function roundHalfEven(n: number): number {
  const f = Math.floor(n);
  const d = n - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** 에너지(Wh) × 가격(minor/MWh) → 화폐(minor). 거래당 한 번만 반올림한다. */
export function moneyFor(energyWh: number, priceMinorPerMWh: number): number {
  return roundHalfEven((energyWh * priceMinorPerMWh) / 1_000_000);
}

/** 정수 합계를 가중치대로 나누고, 나머지는 최대 잔여법으로 배분한다 (동률은 앞쪽 우선). */
export function splitByWeights(total: number, weights: readonly number[]): number[] {
  const wsum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (total * w) / wsum);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k++, rest--) out[order[k % order.length].i] += 1;
  return out;
}

export function formatCR(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const cr = Math.floor(abs / MINOR_PER_CR);
  return `${sign}${cr.toLocaleString('en-US')} CR`;
}

export function dayOf(step: number): number {
  return Math.floor(step / STEPS_PER_DAY);
}

export function clockOf(step: number): { year: number; day: number; hh: number; mm: number } {
  const totalDay = dayOf(step);
  const m = step % STEPS_PER_DAY;
  return {
    year: Math.floor(totalDay / DAYS_PER_YEAR) + 1,
    day: (totalDay % DAYS_PER_YEAR) + 1,
    hh: Math.floor(m / 60),
    mm: m % 60,
  };
}

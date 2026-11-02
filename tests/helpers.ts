import { addCapital, issue, type GameState } from '../src/sim/sim';

/** 테스트용: 지역들에 발전(대)·저장(중)·송전 사업권을 신청한다 (같은 스텝에서 건설보다 먼저 처리됨) */
export function licensed(s: GameState, regions: number[]) {
  addCapital(s, 100_000_000_00, '테스트 자본');
  for (const r of regions) {
    issue(s, { kind: 'acquireLicense', regionId: r, type: 'GEN', size: 'large' });
    issue(s, { kind: 'acquireLicense', regionId: r, type: 'STO', size: 'medium' });
    issue(s, { kind: 'acquireLicense', regionId: r, type: 'TRN', size: 'small' });
  }
}

// 저장·불러오기 (Baseline §29, §29.4). 스텝 경계에서만 호출된다.
// 마이그레이션: 버전별 변환 함수 체인. 미래 버전은 읽기를 거부한다.

import { HUB_BASE_KW } from './data';
import { SCHEMA_VERSION, type GameState } from './sim';

export function stateHash(s: unknown): string {
  const text = JSON.stringify(s);
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193 + 2);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function serialize(s: GameState): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, hash: stateHash(s), state: s });
}

export class SaveError extends Error {}

/* eslint-disable @typescript-eslint/no-explicit-any */
const MIGRATIONS: Record<number, (s: any) => any> = {
  // v1 (P0) → v2 (P1): 송전선, 허브, 저장·고장 필드, 난수 상태 추가
  1: (s) => ({
    ...s,
    schemaVersion: 2,
    hubs: s.regions.map(() => ({ capKw: HUB_BASE_KW, health: { s: 'ok' } })),
    lines: [],
    nextLineId: 1,
    rng: (s.seed ^ 0x9e3779b9) >>> 0,
    lastDI: { genWh: 0, dischargeWh: 0, deliveredWh: 0, lineLossWh: 0, chargeWh: 0, curtailWh: 0, storageLossWh: 0 },
    facilities: s.facilities.map((f: any) => ({
      ...f, health: { s: 'ok' }, energyWh: 0, socWh: 0, dischargeAtMinor: 0, chargeAtMinor: 0, lastStorageWh: 0, hubAddKw: 0,
    })),
  }),
};

export function deserialize(text: string): GameState {
  let data: { schemaVersion: number; hash: string; state: any };
  try {
    data = JSON.parse(text);
  } catch {
    throw new SaveError('세이브 파일을 읽을 수 없습니다 (형식 오류).');
  }
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion > SCHEMA_VERSION) {
    throw new SaveError('더 새로운 버전에서 만든 세이브입니다. 파일은 그대로 보존됩니다.');
  }
  if (stateHash(data.state) !== data.hash) throw new SaveError('세이브 무결성 검사 실패 (해시 불일치).');
  let st = data.state;
  for (let v = data.schemaVersion; v < SCHEMA_VERSION; v++) {
    const m = MIGRATIONS[v];
    if (!m) throw new SaveError(`버전 ${v} 세이브를 변환할 수 없습니다.`);
    st = m(st);
  }
  return st as GameState;
}

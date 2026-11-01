// 저장·불러오기 (Baseline §29, §29.4). 스텝 경계에서만 호출된다.

import { SCHEMA_VERSION, type GameState } from './sim';

export function stateHash(s: GameState): string {
  const text = JSON.stringify(s);
  // FNV-1a 두 개(서로 다른 시드)를 이어 64비트처럼 쓴다.
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

export function deserialize(text: string): GameState {
  let data: { schemaVersion: number; hash: string; state: GameState };
  try {
    data = JSON.parse(text);
  } catch {
    throw new SaveError('세이브 파일을 읽을 수 없습니다 (형식 오류).');
  }
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion > SCHEMA_VERSION) {
    throw new SaveError('더 새로운 버전에서 만든 세이브입니다. 파일은 그대로 보존됩니다.');
  }
  if (stateHash(data.state) !== data.hash) {
    throw new SaveError('세이브 무결성 검사 실패 (해시 불일치).');
  }
  return data.state;
}

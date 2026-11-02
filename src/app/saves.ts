// 세이브 슬롯: 수동 3칸 + 자동 저장 3칸(돌아가며 덮어씀). 브라우저·앱 로컬 저장소에 압축해 저장한다.
// 저장 내용은 sim/save.ts의 serialize 결과(스키마 버전·해시 포함) 그대로이며, 압축은 저장소 용량 때문이다.

import { netWorth, type GameState } from '../sim/sim';
import { deserialize, serialize } from '../sim/save';

export type SlotId = 'm1' | 'm2' | 'm3' | 'a1' | 'a2' | 'a3';
export const MANUAL: SlotId[] = ['m1', 'm2', 'm3'];
export const AUTO: SlotId[] = ['a1', 'a2', 'a3'];

export interface SlotMeta { slot: SlotId; savedAt: number; step: number; netWorth: number; preset: string; scenario: string; seed: number; regions: number; bytes: number }

const PREFIX = 'planetary-grid.slot.';
const META = 'planetary-grid.meta';
const LEGACY = 'planetary-grid.save.1';

function readMeta(): Partial<Record<SlotId, SlotMeta>> {
  try { return JSON.parse(localStorage.getItem(META) ?? '{}'); } catch { return {}; }
}
function writeMeta(m: Partial<Record<SlotId, SlotMeta>>) {
  localStorage.setItem(META, JSON.stringify(m));
}

// ---- 압축 (gzip + base64). 지원하지 않는 환경이면 평문 ----
async function pack(text: string): Promise<string> {
  if (typeof CompressionStream === 'undefined') return text;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return 'gz:' + btoa(bin);
}
async function unpack(data: string): Promise<string> {
  if (!data.startsWith('gz:')) return data;
  const bin = atob(data.slice(3));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** 이전 버전의 단일 세이브를 수동 1번 칸으로 옮긴다 */
export async function migrateLegacy() {
  try {
    const old = localStorage.getItem(LEGACY);
    if (!old || localStorage.getItem(PREFIX + 'm1')) return;
    const s = deserialize(old);
    await saveTo('m1', s);
    localStorage.removeItem(LEGACY);
  } catch { /* 읽을 수 없는 옛 세이브는 그대로 둔다 */ }
}

export function listSlots(): Partial<Record<SlotId, SlotMeta>> {
  return readMeta();
}

export function latestSlot(): SlotId | null {
  const m = readMeta();
  const all = Object.values(m).filter(Boolean) as SlotMeta[];
  if (!all.length) return null;
  return all.sort((a, b) => b.savedAt - a.savedAt)[0].slot;
}

export async function saveTo(slot: SlotId, s: GameState): Promise<SlotMeta> {
  const data = await pack(serialize(s));
  localStorage.setItem(PREFIX + slot, data); // 용량 초과 시 예외 → 호출한 쪽에서 알림
  const meta: SlotMeta = {
    slot, savedAt: Date.now(), step: s.step, netWorth: netWorth(s), preset: s.rules.preset, scenario: s.rules.scenario,
    seed: s.seed, regions: s.regions.length, bytes: data.length,
  };
  const m = readMeta();
  m[slot] = meta;
  writeMeta(m);
  return meta;
}

export async function loadFrom(slot: SlotId): Promise<GameState> {
  const data = localStorage.getItem(PREFIX + slot);
  if (!data) throw new Error('빈 칸입니다.');
  return deserialize(await unpack(data));
}

export function deleteSlot(slot: SlotId) {
  localStorage.removeItem(PREFIX + slot);
  const m = readMeta();
  delete m[slot];
  writeMeta(m);
}

/** 자동 저장: 가장 오래된 자동 칸을 덮어쓴다 */
export async function autosave(s: GameState): Promise<SlotMeta> {
  const m = readMeta();
  const slot = AUTO.slice().sort((a, b) => (m[a]?.savedAt ?? 0) - (m[b]?.savedAt ?? 0))[0];
  return saveTo(slot, s);
}

/** 파일로 내보내기·가져오기 (기기 간 이동, 백업) */
export function exportText(s: GameState): string {
  return serialize(s);
}
export function importText(text: string): GameState {
  return deserialize(text);
}

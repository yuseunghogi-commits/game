// 상호작용 튜토리얼: 첫 발전소 → 계약 → 첫 수익. 각 단계는 게임 상태로 완료를 판정하고, 해당 버튼을 강조한다.

import { FACILITY_TYPES } from '../sim/data';
import type { GameState } from '../sim/sim';
import type { UiState } from './views';

export interface TutStep { title: string; text: string; target?: string; done: (s: GameState, ui: UiState) => boolean }

const hasGen = (s: GameState) => s.facilities.some((f) => FACILITY_TYPES[f.type].kind === 'gen');

export const STEPS: TutStep[] = [
  { title: '지역 고르기', text: '왼쪽 목록이나 행성 위 지역 이름을 눌러 사업할 지역을 고르세요. 가격(CR/MWh)이 높고 일사·풍황이 좋은 곳이 유리합니다.', target: '#regions', done: (_s, ui) => ui.selected !== null },
  { title: '발전 사업권', text: '지역 화면의 「사업권」에서 발전 사업권 <b>소형</b>을 취득하세요. 사업권이 있어야 발전소를 지을 수 있습니다.', target: '[data-lic$=":GEN:small"]', done: (s) => s.licenses.some((l) => l.type === 'GEN') },
  { title: '첫 발전소', text: '「건설」에서 <b>태양광 · 소형</b>(공사 5일)을 고르고 <b>건설 승인</b>을 누르세요. 부지는 자동으로 임대됩니다.', target: '[data-act="build"]', done: (s) => hasGen(s) },
  { title: '시간 빨리 감기', text: '위쪽 배속 버튼(또는 숫자 키 <b>4</b>)으로 8배속을 켜고 공사가 끝나기를 기다리세요. 시운전 단계부터 전기를 팝니다.', target: '.speed', done: (s) => s.facilities.some((f) => FACILITY_TYPES[f.type].kind === 'gen' && (f.status === 'operating' || f.stage === 5)) },
  { title: '계약 화면', text: '위쪽 <b>계약</b> 탭을 여세요. 계약은 시장 가격이 흔들려도 정해진 값에 팝니다.', target: '[data-view="contracts"]', done: (s, ui) => ui.view === 'contracts' || s.contracts.length > 0 },
  { title: 'PPA 수락', text: '「내 지역」 필터를 누르고, <b>공급 여력 안의 작은 PPA</b>를 수락하세요. 경고가 뜨는 큰 계약은 공급이 부족하면 위약금이 쌓입니다.', target: '[data-accept]', done: (s) => s.contracts.length > 0 },
  { title: '첫 수익', text: '하루가 지나면 판매·계약 수익이 장부에 기록됩니다. <b>재무</b> 탭에서 30일 현금 흐름을 확인하세요.', target: '[data-view="finance"]', done: (s, ui) => ui.view === 'finance' && s.ledger.some((e) => e.credit === 'revenue_market' || e.credit === 'revenue_contract') },
  { title: '기본 흐름 완료', text: '다음 목표: 이웃 지역과 <b>송전선</b>을 이어 시간대 차이로 팔기, <b>자동화</b>로 사업권 갱신 맡기기, <b>계획</b>으로 여러 건설을 한 번에 예약하기. 도움말은 위쪽 <b>?</b> 버튼.', done: () => false },
];

/** 이미 끝난 단계는 건너뛴다 (중간에 켠 경우, 불러온 경우) */
export function advanceTutorial(step: number, s: GameState, ui: UiState): number {
  while (step < STEPS.length - 1 && STEPS[step].done(s, ui)) step++;
  return step;
}

export function tutorialHtml(step: number): string {
  const st = STEPS[step];
  const last = step === STEPS.length - 1;
  return `<div class="tut-head"><span class="tut-n num">${step + 1} / ${STEPS.length}</span><b>${st.title}</b><span class="spacer"></span><button class="btn tiny ghost" data-tut="${last ? 'close' : 'skip'}">${last ? '닫기' : '건너뛰기'}</button></div>
    <div class="tut-body">${st.text}</div>
    <div class="tut-bar"><span style="width:${((step + (last ? 1 : 0)) / STEPS.length) * 100}%"></span></div>`;
}

/** 렌더 뒤 호출: 목표 요소 강조 */
let scrolledFor = -1;
export function highlight(step: number | null) {
  document.querySelectorAll('.tut-hl').forEach((e) => e.classList.remove('tut-hl'));
  if (step === null) return;
  const sel = STEPS[step]?.target;
  if (!sel) return;
  const el = document.querySelector(sel);
  if (!el) return;
  el.classList.add('tut-hl');
  // 단계가 바뀔 때 한 번만 화면 안으로 스크롤 (사용자 스크롤과 싸우지 않도록)
  if (scrolledFor !== step) { scrolledFor = step; el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

// 사용자 설정 (게임 상태와 분리, 기기별 저장).

export type Quality = 'low' | 'medium' | 'high';
export type Lang = 'ko' | 'en';

export interface Settings {
  master: number;
  sfx: number;
  ambient: number;
  quality: Quality;
  /** S-21: 긴급 등급 경고 시 자동 일시정지 (기본 켜짐) */
  autoPause: boolean;
  /** 자동 저장 간격 (게임일, 0 = 끔) */
  autosaveDays: number;
  tutorial: boolean;
  tutorialStep: number;
  lang: Lang;
}

const KEY = 'planetary-grid.settings';
export const DEFAULTS: Settings = { master: 0.7, sfx: 0.8, ambient: 0.4, quality: 'high', autoPause: true, autosaveDays: 1, tutorial: true, tutorialStep: 0, lang: 'ko' };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, quality: defaultQuality() };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 저장소 없음: 이번 실행 동안만 유지 */ }
}

/** 첫 실행: 화면이 작거나 코어가 적으면 중간 품질 */
function defaultQuality(): Quality {
  const cores = navigator.hardwareConcurrency ?? 4;
  return cores <= 2 ? 'low' : cores <= 4 ? 'medium' : 'high';
}

export const QUALITY = {
  low: { tex: 1024, pixelRatio: 1, segments: 64, clouds: false, antialias: false },
  medium: { tex: 2048, pixelRatio: 1.25, segments: 96, clouds: true, antialias: true },
  high: { tex: 2048, pixelRatio: 2, segments: 128, clouds: true, antialias: true },
} as const;

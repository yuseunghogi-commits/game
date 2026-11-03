# 3D 사운드 웹 앱 (PC 크롬·엣지 / 아이패드)

**주소: https://yuseunghogi-commits.github.io/game/** (설치형 웹 앱 — 주소창의 설치 버튼이나 '홈 화면에 추가')

- **PC 크롬·엣지**: 유튜브 같은 **다른 탭의 소리**를 받아 헤드폰용 3D 로 바꿔 줍니다. 설치할 것 없음 (VB-CABLE 불필요).
  [다른 탭 소리] → 창에서 '탭' → 유튜브 탭 선택 → **탭 오디오도 공유** → 공유. 원래 탭 소리는 꺼지고 3D 소리만 들립니다.
- **아이패드 사파리**: 아이패드에 저장된 음악·영상 파일을 3D 로 재생 (iPadOS 는 다른 앱 소리를 가져갈 수 없음)

폰·PC 앱의 실측 엔진(Kotlin)을 JavaScript 로 옮긴 [`engine.js`](engine.js) 를 씁니다.

## 기능
- 예시 음원 (왼쪽→오른쪽 16단계 이동 + 음악) / 파일 열기 (오디오·영상)
- 3D 켜짐 ↔ 원음 즉시 비교 (같은 시점으로 부드럽게 교차)
- 엔진: 공간 모드(가상 스피커 7개 + 실측 방) / 정위 모드(방향 펼침)
- 높이: 앞 스피커 높이(-20°~+40°), 천장 스피커 4개(앞 2·뒤 2), 바닥 스피커 2개 — MIT KEMAR 높이 데이터
- 3D 강조: 앞뒤·위아래 귓바퀴 단서를 키움 (손을 뗄 때 반영, 오디오가 끊기지 않게 8방향씩 나눠 계산)
- 스피커 배치도: 앞·뒤 스피커를 끌어서 각도 조절, 천장(▲)·바닥(▼)은 돌려서 방향, 머리 쪽으로 끌면 높이·실선 원 바깥은 아래
- 헤드폰 보정 13개 모델 (기본: Bose QuietComfort Headphones 2023), 귀 맞춤 5단계 + 테스트음
- 설정은 이 기기 브라우저에만 저장

## 검증
- 같은 입력·설정에서 Kotlin 엔진과 비교 (천장·바닥·3D 강조 켬): 공간 모드 SNR 129 dB (부동소수점 반올림 수준), 정위 모드 65~75 dB
- 속도 (V8): 실시간의 11~21배 — AudioWorklet 에서 처리, 막히면 ScriptProcessor 로 대체
- 헤드리스 Chromium: 워크릿 동작·출력 신호·버튼·끌기·가로 넘침 없음 확인

## 탭 소리 (PC)
- `getDisplayMedia` 로 탭을 공유받고(영상 트랙은 바로 끔), `suppressLocalAudioPlayback` 으로 원래 탭 재생을 끕니다.
- 크롬이 화면 공유 소리에 기본으로 거는 **자동 음량 조절·잡음 제거·에코 제거를 끕니다** — 켜 두면 일정한 음이 2초 안에
  25dB 줄어드는 것을 확인했습니다 (끈 상태: 사인파 RMS 0.212 그대로 들어옴).
- 지연을 줄이려고 PC 에서는 `latencyHint: 'interactive'`. 영상보다 소리가 아주 살짝 늦을 수 있습니다.
- 브라우저 밖 프로그램(게임 등)은 Windows 앱 + VB-CABLE.

## 빌드 / 배포
```
python3 build.py              # → dist/3d-sound-player.html (엔진·HRIR·EQ 데이터를 한 파일에 포함, 아티팩트용)
python3 build.py --pwa site   # → site/ (GitHub Pages: index.html + manifest + 서비스 워커 + 아이콘 + version.json)
```
- `.github/workflows/web-pages.yml` 이 푸시할 때마다 `site/` 를 **gh-pages** 브랜치에 올립니다.
  처음 한 번은 저장소 **Settings → Pages → Branch: gh-pages / (root) → Save** 로 Pages 를 켜야 합니다.
- 자동 업데이트: 서비스 워커가 항상 네트워크를 먼저 확인해서 새로 열 때 최신 버전이 바로 적용되고,
  열어 둔 페이지는 30분마다 `version.json` 을 보고 '새 버전' 알림을 띄웁니다. 오프라인이면 마지막 버전이 열립니다.

## 데이터 출처
- 실측 HRTF: KEMAR HRTFs with low frequency correction — H. Wierstorf, M. Geier, S. Spors, V. Erbes, CC BY 4.0
- 헤드폰 보정: AutoEq (Jaakko Pasanen, MIT) — 측정 Rtings, oratory1990, HypetheSonics
- 높이: MIT KEMAR HRTF (W. Gardner, K. Martin, MIT Media Lab), mit-hrtf-lib (MIT) 배열에서 추출

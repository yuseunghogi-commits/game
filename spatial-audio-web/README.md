# 3D 사운드 플레이어 (아이패드·웹)

아이패드 사파리에서 **아이패드에 저장된 음악·영상 파일**을 헤드폰용 3D 입체 음향으로 재생하는 단일 HTML 페이지.
폰·PC 앱의 실측 엔진(Kotlin)을 JavaScript 로 옮긴 [`engine.js`](engine.js) 를 쓴다.

> iPadOS 는 앱이 유튜브 같은 다른 앱의 소리를 가져가거나 기기 전체에 효과를 거는 것을 막아 두었기 때문에,
> 유튜브 3D 는 안드로이드·Windows 앱으로만 가능하다.

## 기능
- 예시 음원 (왼쪽→오른쪽 16단계 이동 + 음악) / 파일 열기 (오디오·영상)
- 3D 켜짐 ↔ 원음 즉시 비교 (같은 시점으로 부드럽게 교차)
- 엔진: 공간 모드(가상 스피커 7개 + 실측 방) / 정위 모드(방향 펼침)
- 높이: 앞 스피커 높이(-20°~+40°), 높이감(천장 스피커), 천장 스피커 위치(방향 ±20°~160°, 높이 30°~85°) — MIT KEMAR 높이 데이터
- 스피커 배치도: 앞·뒤 스피커를 끌어서 각도 조절, 천장 스피커(▲)는 돌려서 방향·머리 쪽으로 끌어서 높이
- 헤드폰 보정 13개 모델 (기본: Bose QuietComfort Headphones 2023), 귀 맞춤 5단계 + 테스트음
- 설정은 이 기기 브라우저에만 저장

## 검증
- 같은 입력·설정에서 Kotlin 엔진과 비교 (높이 기능 켬): 공간 모드 SNR 129 dB (부동소수점 반올림 수준), 정위 모드 75 dB
- 속도 (V8): 실시간의 11~21배 — AudioWorklet 에서 처리, 막히면 ScriptProcessor 로 대체
- 헤드리스 Chromium: 워크릿 동작·출력 신호·버튼·끌기·가로 넘침 없음 확인

## 빌드
```
python3 build.py            # → dist/3d-sound-player.html (엔진·HRIR·EQ 데이터를 한 파일에 포함)
```

## 데이터 출처
- 실측 HRTF: KEMAR HRTFs with low frequency correction — H. Wierstorf, M. Geier, S. Spors, V. Erbes, CC BY 4.0
- 헤드폰 보정: AutoEq (Jaakko Pasanen, MIT) — 측정 Rtings, oratory1990, HypetheSonics
- 높이: MIT KEMAR HRTF (W. Gardner, K. Martin, MIT Media Lab), mit-hrtf-lib (MIT) 배열에서 추출

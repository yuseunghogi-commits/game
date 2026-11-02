## 🎧 3D 사운드 — 유튜브·게임 소리를 헤드폰용 3D 입체 음향으로

아래 **Assets** 에서 기기에 맞는 파일을 받으세요.

| 파일 | 기기 |
|---|---|
| **3DSound-Android.apk** | 안드로이드 폰 (Android 8 이상, 강력 3D 모드는 10 이상) |
| **3DSound-Windows.zip** | Windows 노트북/PC (Java 포함, 설치 불필요) |
| 3DSound-Mac-Linux.jar | Mac / Linux (Java 17 이상 필요) |

> ℹ️ **Shizuku**(폰)와 **VB-CABLE**(PC)는 다른 회사 프로그램이라 여기 포함되지 않습니다. 처음 한 번만 아래 링크에서 설치하세요.
> - Shizuku: [Play 스토어](https://play.google.com/store/apps/details?id=moe.shizuku.privileged.api)
> - VB-CABLE: [vb-audio.com/Cable](https://vb-audio.com/Cable/)

### 📱 안드로이드
1. APK 설치 (이전 버전이 있으면 덮어쓰기 — 안 되면 지우고 설치)
2. 앱 → **🔑 강력 모드 권한 설정** → 안내대로 Shizuku 로 권한 받기 (처음 1번)
3. **강력 3D 모드** 선택 → **3D 음향 켜기** → 소리 공유 창에서 **시작**

### 💻 Windows
1. 무료 [VB-CABLE](https://vb-audio.com/Cable/) 설치 (관리자 권한으로 실행 → Install → 재부팅)
2. 작업표시줄 🔊 → 출력 장치 **CABLE Input**
3. zip 압축 풀고 **3DSound.exe** → 입력 **CABLE Output**, 출력 **내 헤드폰** → ▶ 시작

### 🆕 v1.2
- 🏠 **실측 HRTF 공간 모드** (새 기본): 실제 더미헤드에서 측정한 귀 특성 사용
- 🎯 **정위 모드**: 소리 성분마다 정확한 방향에 배치 → 어디서 소리 나는지 또렷 (게임·영화)
- 👂 **귀 맞춤 테스트**: 앞/뒤가 가장 잘 구분되는 머리·귀 크기 단계 선택
- 🔊 스피커 배치를 손가락으로 끌어서 조절 (앞/뒤 각도, 뒤 스피커 양)
- 데이터: KEMAR HRTFs (Wierstorf·Geier·Spors·Erbes, CC BY 4.0)

### v1.1
- 🧭 **헤드 트래킹** (안드로이드 강력 3D 모드): 고개를 돌려도 소리가 제자리에.
  이어폰이 Android 표준 헤드 트래킹 센서를 공개해야 동작합니다 (Android 13+, 예: Pixel Buds Pro).
- 설정 변경 시 딸깍 소리 없이 부드럽게 전환

### 🎚 엔진
HRTF 머리 모델(양 귀 시간차·머리 그림자·귓바퀴) + 가상 스피커 ±30°~±80° + 벽 반사음 + FDN 잔향

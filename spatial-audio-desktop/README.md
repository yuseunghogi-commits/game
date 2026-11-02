# 3D 사운드 (PC / 노트북)

유튜브·게임·영화 등 PC 소리를 **헤드폰용 3D 입체 음향**으로 바꿔 줍니다.
안드로이드 앱의 "강력 3D 모드"와 같은 엔진(HRTF 머리 모델 + 가상의 방 + 잔향)을 씁니다.

```
모든 PC 소리 → [Windows 출력: CABLE Input] → CABLE Output → 3D 사운드 → 내 헤드폰
```

## 처음 한 번만 설정 (Windows)
1. 무료 가상 오디오 장치 **VB-CABLE** 설치: https://vb-audio.com/Cable/ → Download
   → 압축 풀고 `VBCABLE_Setup_x64.exe` 우클릭 → **관리자 권한으로 실행** → Install → 재부팅
2. 작업표시줄 🔊 → 출력 장치를 **CABLE Input** 으로 변경
3. `3DSound.exe` 실행 → 입력 **CABLE Output**, 출력 **내 헤드폰** → **▶ 시작**

끝낼 때는 🔊 출력 장치를 다시 헤드폰으로 바꾸면 원래대로 돌아옵니다.

## Mac
VB-CABLE 대신 무료 **BlackHole 2ch** 설치 → 시스템 설정 > 사운드 > 출력을 BlackHole 로 →
`java -jar 3DSound.jar` (Java 17 이상 필요) → 입력 BlackHole, 출력 헤드폰.

## 조절
- **3D 강도**: 원음 ↔ 3D 비율
- **좌우 넓이**: 가상 스피커 각도 ±30°~±80°, 높을수록 좌우가 또렷
- **방 울림 / 잔향**: 방 안에서 듣는 느낌
- **3D 효과 켜기** 체크를 끄면 원음과 바로 비교 가능

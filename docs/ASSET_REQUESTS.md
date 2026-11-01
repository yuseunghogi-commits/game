# PLANETARY GRID — 에셋 요청 목록 (사진 · Google Flow)

- 작성일: 2026-11-01
- 기술 방향: A안 — TypeScript 시뮬레이션 코어 + 웹 화면(Three.js), Windows 앱 패키징(Tauri/Electron)
- 시각 방향 기준: 원문 §1.1 [사용자 확정] "현실감 있는 SF", 가상 행성(작업명 NOVA-01)

---

## 0. 보내는 방법
- 채팅에 파일을 첨부해 주세요. 받은 파일은 저장소 `assets/` 아래에 정리합니다.
- 이미지는 **PNG**(가능하면), 영상은 **MP4**로 보내 주세요. 압축이 심한 JPG는 텍스처 품질이 떨어집니다.
- 파일 이름은 아래 표의 **파일명**을 쓰면 정리가 빠릅니다(필수는 아님).
- 프롬프트는 시작점입니다. 분위기 단어는 마음대로 바꾸세요. 스타일을 통일하려면 모든 이미지에 **§5 공통 스타일 문구**를 붙여 주세요.

---

## 1. 우선순위 1 — 시각 방향 (가장 먼저)

이게 있어야 색·글꼴·간격 규칙(디자인 토큰)을 정할 수 있습니다. 나머지 에셋보다 먼저 보내 주세요.

| # | 무엇 | 만드는 방법 | 규격 | 파일명 |
|---|---|---|---|---|
| 1-1 | **좋아하는 게임·앱 화면 스크린샷** 3–10장 (UI, 지도, 색감) | 사진/스크린샷 | 원본 그대로 | `ref_ui_01.png` … |
| 1-2 | **키 아트** — 궤도에서 본 행성과 빛나는 전력망 | Flow 이미지 | 16:9, 가장 큰 해상도 | `key_art_01.png` … (2–4장) |
| 1-3 | 각 키 아트에서 마음에 드는 점·싫은 점 한 줄씩 | 텍스트 | — | 채팅으로 |

> 1-1은 **참고용**으로만 쓰고 게임에는 넣지 않습니다(저작권).

**1-2 프롬프트**
```
Cinematic view of a fictional Earth-like planet from low orbit at night side terminator,
continents with glowing power grid lines connecting cities, thin cyan transmission lines,
warm amber city lights, realistic clouds and atmosphere glow, no text, no logos
+ [공통 스타일 문구]
```

---

## 2. 우선순위 2 — 행성

| # | 무엇 | 만드는 방법 | 규격 | 파일명 |
|---|---|---|---|---|
| 2-1 | 행성 지표 텍스처 (낮) | Flow 이미지 | **2:1 가로**, 가능한 최대 해상도 | `planet_day.png` |
| 2-2 | 야간 도시 불빛 | Flow 이미지 | 2:1, **검은 배경**에 불빛만 | `planet_night.png` |
| 2-3 | 구름 | Flow 이미지 | 2:1, **검은 배경**에 흰 구름 | `planet_clouds.png` |
| 2-4 | 우주 배경 (별, 은은한 성운) | Flow 이미지 | 16:9 또는 2:1 | `space_bg.png` |

**주의 (솔직하게)**: AI 이미지 생성기는 구에 정확히 감기는 지도(정거원통 투영, 좌우 끝이 이어지고 극지방이 늘어난 형태)를 잘 못 만듭니다.
- 받은 이미지의 좌우 이음매는 제가 블렌딩으로 고치겠습니다.
- 결과가 어색하면 행성 지형은 제가 코드(절차적 노이즈)로 만들고, 보내 주신 이미지는 **색감 기준**으로만 쓰겠습니다. 이 경우에도 2-1은 꼭 필요합니다.
- 2-2, 2-3을 검은 배경으로 요청하는 이유: Flow는 투명 배경을 만들지 못합니다. 검은 부분은 제가 투명으로 바꿉니다.

**2-1 프롬프트**
```
Equirectangular world map texture of a fictional alien-but-habitable planet, 2:1 aspect ratio,
top-down satellite view, oceans, 6–8 distinct continents with deserts, forests, tundra and mountains,
polar ice caps stretched across top and bottom edges, left and right edges continuous,
no clouds, no text, no grid lines, no borders
+ [공통 스타일 문구]
```

**2-2 프롬프트**
```
Equirectangular night lights map, 2:1 aspect ratio, pure black background,
only warm amber and white city lights clustered along coastlines and rivers,
no landmass colors, no text
```

**2-3 프롬프트**
```
Equirectangular cloud cover map, 2:1 aspect ratio, pure black background,
white realistic cloud formations, storm spirals, thin wisps, no land, no text
```

---

## 3. 우선순위 3 — 시설 카드 이미지

건설 메뉴와 시설 상세 화면에 쓰는 일러스트입니다. MVP 발전 유형(S-10)에 맞췄습니다. **같은 각도·조명·배경**으로 맞춰야 한 세트로 보입니다.

| # | 시설 | 파일명 |
|---|---|---|
| 3-1 | 태양광 발전소 | `facility_solar.png` |
| 3-2 | 풍력 발전단지 | `facility_wind.png` |
| 3-3 | 열발전소 | `facility_thermal.png` |
| 3-4 | 배터리 저장시설 | `facility_storage.png` |
| 3-5 | 변전소 | `facility_substation.png` |
| 3-6 | 송전탑과 선로 | `facility_line.png` |

- 규격: **1:1 정사각형**, 가능한 최대 해상도, 단색 어두운 배경(#101418 근처).
- 크기별(소·중·대) 이미지는 MVP에 필요 없습니다. 같은 이미지에 크기 표시를 붙이겠습니다.

**공통 프롬프트 (시설 이름만 바꾸기)**
```
Isometric 3/4 view of a [solar power plant | wind farm | thermal power plant |
grid-scale battery storage facility | electrical substation | high-voltage transmission towers with lines],
single facility centered on a small square plot of land, clean industrial design,
soft studio lighting from top-left, plain dark charcoal background, no people, no text, no logos
+ [공통 스타일 문구]
```

> 3D 모델은 Flow로 만들 수 없습니다. 지도 위 시설 표시는 제가 단순한 3D 도형으로 만들겠습니다. 실제 3D 모델이 필요해지면 이 세션의 이미지→3D 변환 도구(크레딧 필요, 사용 전 확인)나 에셋 스토어를 쓰겠습니다.

---

## 4. 우선순위 4 — Google Flow 영상

| # | 무엇 | 규격 | 파일명 |
|---|---|---|---|
| 4-1 | **타이틀 화면 배경** — 천천히 자전하는 행성, 전력망이 하나씩 켜짐 | 16:9, 1080p, 8초 이상, **글자 없음**, 카메라는 고정 또는 아주 느린 이동 | `title_loop.mp4` |
| 4-2 | (선택) 정전 장면 — 도시 불빛이 구역별로 꺼짐 | 16:9, 4–8초 | `event_blackout.mp4` |
| 4-3 | (선택) 첫 발전소 가동 장면 | 16:9, 4–8초 | `event_first_power.mp4` |

- 영상이 끊김 없이 반복되지 않아도 괜찮습니다. 이어지는 부분은 제가 크로스페이드로 처리합니다.
- 4-2, 4-3은 MVP 필수가 아닙니다. 4-1만 있으면 됩니다.

**4-1 프롬프트**
```
Slow cinematic rotation of a fictional Earth-like planet in space, night side facing camera,
cyan power grid lines gradually lighting up between amber city clusters,
subtle atmosphere glow, static camera, calm and majestic, no text, no UI
+ [공통 스타일 문구]
```

---

## 5. 공통 스타일 문구 (모든 이미지·영상 프롬프트 끝에 붙이기)
```
realistic science fiction, grounded near-future engineering, high detail,
muted natural colors with cyan and amber energy accents, cinematic lighting, no text
```
→ 1-2 키 아트를 보고 방향이 바뀌면 이 문구를 함께 고칩니다.

---

## 6. 보내지 않아도 되는 것 (제가 처리)

| 항목 | 이유 | 처리 방법 |
|---|---|---|
| UI 아이콘 | AI 이미지로 만들면 아이콘마다 스타일이 달라져 세트가 안 됩니다 | 무료 오픈소스 아이콘 세트(Lucide 등, MIT 라이선스)를 디자인 토큰 색으로 통일 |
| 로고의 글자 | AI는 글자를 정확히 못 씁니다 | 글자는 폰트로 조판. **심볼(그림 부분)만** 원하시면 Flow로 만들어 보내 주세요 (1:1, 검은 배경, 글자 없음) |
| 글꼴 | 이미지가 아님 | Google Fonts에서 후보 2–3개를 제안 |
| 지도 오버레이, 그래프, 전력 흐름 표시 | 데이터에 따라 실시간으로 바뀜 | 코드로 그림 |
| 지역 경계선 | 시뮬레이션 데이터와 정확히 일치해야 함 | 코드로 생성 |

---

## 7. 사용 전 확인할 것
- Flow로 만든 이미지·영상을 상업용 게임에 써도 되는지 Google의 이용 약관을 확인해 주세요. 판매 계획이 있다면 특히 중요합니다.
- 1-1의 다른 게임 스크린샷은 참고용으로만 쓰고 게임 안에는 넣지 않습니다.

---

## 8. 진행 순서
1. **1-1, 1-2를 먼저** 보내 주세요 → 디자인 토큰 시안을 만들어 확인받습니다.
2. 그 사이 저는 **P0 시뮬레이션 코어**(지역 몇 개, 발전소, 수요, 정산, 원장, 건설, 저장 골격, 테스트)를 만듭니다. 이 부분은 에셋이 필요 없습니다.
3. 2번, 3번, 4번 에셋은 준비되는 대로 보내 주시면 됩니다.

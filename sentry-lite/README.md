# Sentry-Lite

**내 저장소 전용** 보안 스캐너. 결정적 스캐너(semgrep · gitleaks · osv-scanner)로 후보를 찾고, Claude Code가
데이터 흐름을 추적해 분류(triage)하고, 로컬에서만 PoC로 검증한 뒤, 수정안과 함께 보고서를 만든다.
Docker·CodeQL 없이 8 GB 노트북(Windows)에서 돌아가도록 설계했다.

> 현재 상태: **M1 완료** (설치 스크립트 · 인벤토리 · 스캐너 3종 · 저장소 · CLI 요약).
> 사용자 정의 규칙/Firebase 분석기/`safe_http`(M2), `/triage` `/hunt` `/verify`(M3), `/fix` `/report`(M4),
> 평가 앱과 `EVAL.md`(M5)는 아직 없다.

---

## 1. 범위 안전 규칙 (코드로 강제됨)

| 규칙 | 구현 위치 |
|---|---|
| 사용자가 명시한 로컬 폴더만 스캔한다 (자동 탐색 없음). 드라이브 루트·홈 폴더 자체는 거부. | `sentry/scope.py` |
| git 원격이 있으면 `origin`(없으면 모든 원격)의 소유자가 GitHub의 `yuseunghogi-commits`여야 한다. 아니면 `--i-own-this`가 필요하고, 확인 내역이 `logs/audit.jsonl`과 DB에 남는다. 원격 구성이 바뀌면 다시 확인을 요구한다. | `sentry/scope.py`, `store.consents` |
| 발견된 비밀값은 **메모리에서 해시·가림 처리**만 하고 평문으로 디스크/로그/DB에 쓰지 않는다. 실제로 사용해 보지 않는다. 조치는 "즉시 폐기(rotate)". | `normalize.gitleaks_to_findings`, `scanners/gitleaks.py` |
| 동적 요청(PoC)은 localhost/Firebase 에뮬레이터만 — `safe_http` 모듈 | **M2에서 구현** |

## 2. 설치 (Windows, 관리자 권한 불필요)

```powershell
cd sentry-lite
powershell -ExecutionPolicy Bypass -File .\setup.ps1
.\.venv\Scripts\Activate.ps1
sentry doctor
```

`setup.ps1`이 하는 일:
1. Python 3.11+ 확인(py 런처 우선) → `.venv` 생성 → `pip install -e .[scan,dev]` (semgrep 포함)
2. gitleaks **v8.30.1**, osv-scanner **v2.7.0** Windows 바이너리를 `.\bin`에 내려받고, 같은 릴리스의
   체크섬 파일로 **SHA-256 검증** (불일치 시 설치 거부)
3. git(필수), Node.js 20+, JDK 21, firebase-tools(에뮬레이터용, M3부터 필요) 확인 및 `winget` 설치 명령 안내
4. `sentry doctor`로 도구 버전 출력

**WSL2 대안 (semgrep이 Windows에서 설치되지 않을 때만):** `.\setup.ps1 -SkipSemgrep`으로 나머지를 설치한 뒤
WSL2 Ubuntu에서 `pipx install semgrep`, 그리고 WSL 안에서 같은 저장소 경로(`/mnt/c/...`)로 `sentry`를
실행한다. 필수 조건은 아니며, 최근 semgrep은 Windows 네이티브 wheel을 제공한다.

## 3. 사용법

```powershell
sentry scan C:\code\my-pwa                     # 전체 스캔 (프로필 자동 선택)
sentry scan C:\code\my-pwa --since main        # main 이후 바뀐 파일만 (diff-aware)
sentry scan C:\code\my-pwa --profile web       # web | python | mixed | auto
sentry scan C:\code\my-pwa --offline           # 레지스트리 규칙/온라인 취약점 DB 없이 (./rules만)
sentry scan C:\code\my-pwa --tools semgrep,gitleaks
sentry scan C:\code\forked --i-own-this --scope-note "옛 계정 저장소"

sentry findings list --status candidate --severity critical,high
sentry findings show 1c77dfa6                   # id 앞 4자 이상
sentry findings update 1c77dfa6 --status triaged_fp --justification "React가 자동 escape"
sentry findings history 1c77dfa6
sentry scans list                               # 스캔별 도구 시간·최대 RAM
sentry inventory C:\code\my-pwa                 # 언어/프레임워크/진입점만
sentry import-sarif other-tool.sarif --path C:\code\my-pwa
```

모든 조회/수정 명령은 `--json`을 지원한다(Claude Code 슬래시 명령이 이것만 사용, DB를 직접 건드리지 않음).
`findings update --from-json -`로 여러 줄 텍스트(근거, 재현 절차)를 표준입력 JSON으로 넘길 수 있다.

**종료 코드:** `0` 정상 · `1` 오류 · `2` 범위 확인 거부 · `3` 차단 대상 존재(기본: `confirmed` 상태의
critical/high; `--fail-on likely|candidate|never`로 조정) — CI에 그대로 사용 가능.

### 스캔 파이프라인 (`sentry scan`)
1. **범위 확인** → 2. **인벤토리**(`data/repos/<repo>/inventory.json`: 언어·LOC, 패키지 매니저, Express/Next/Vite/
   Flask/FastAPI/Firebase/Netlify 탐지, HTTP 라우트·Cloud Functions·Netlify 함수·폼 핸들러·URL 파라미터 읽기·
   postMessage 수신부) → 3. **semgrep** (`p/default p/owasp-top-ten p/secrets` + 프로필별 `p/javascript
   p/typescript`/`p/python` + `./rules`, `--jobs 2 --max-memory 1500 --timeout 30`, node_modules/dist/build/.venv 제외)
   → 4. **gitleaks** (작업 트리 + `--all` 전체 git 기록; dist/build 번들도 검사) → 5. **osv-scanner** (lockfile;
   수정 버전이 있거나 소스에서 직접 import하는 패키지만 유지) → 6. 정규화 → 저장 → 요약 표.

비밀값 심각도는 **노출 정도**로 정한다: git 기록/추적 파일 → high · `VITE_`/`NEXT_PUBLIC_` 등 번들에 들어가는
변수나 dist 번들 → high · 커밋 직전(.gitignore 미등록) → medium · 무시된 로컬 파일 → low · Firebase 웹 API 키 → info
(공개가 정상이며 실제 경계는 보안 규칙/App Check라는 설명 포함).

### 재스캔 규칙
- 지문(id) = `sha1(rule_id + "<repo>/<경로>" + 공백 정규화한 코드 조각)` — **줄 번호와 무관**. 같은 파일에
  같은 코드가 반복되면 출현 순번을 붙인다. 비밀값은 원문 대신 SHA-256 해시로 지문을 만든다.
- 다시 발견된 항목은 판정(status, 근거, 데이터 흐름, PoC, 분류 후 심각도)을 **유지**한다.
- 해당 도구가 실제로 검사한 범위에서 사라진 열린 항목(candidate/likely/confirmed)은 `fixed`(검증 대기,
  `fix_verified=false`)로 바뀐다. 도구가 실패했거나, `--since`로 검사 범위 밖이거나, 도구 오류가 난 파일은
  건드리지 않는다. `triaged_fp`/`wont_fix`와 Claude가 추가한 항목(`/hunt`)도 건드리지 않는다.
- `fixed` 항목이 다시 나타나면 이전 상태로 되살린다(검증된 수정이었다면 `regression` 이벤트).
- 모든 변경은 `finding_events`에 누가(actor)·언제·무엇을 바꿨는지 남는다.

### 저장 위치 (모두 `.gitignore` 처리됨 — 커밋 금지)
| 경로 | 내용 |
|---|---|
| `data/findings.db` | SQLite: repos, consents, scans, tool_runs, findings, finding_events |
| `data/repos/<repo>/inventory.json`, `.../scans/<scan_id>/` | 인벤토리, 원본 도구 출력(gitleaks는 가린 사본만) |
| `logs/tools.jsonl` | 모든 외부 도구 호출: 도구·버전·인자·소요 시간·최대 RAM·종료 코드 (출력은 기록 안 함) |
| `logs/audit.jsonl` | 범위 확인 결과, `--i-own-this` 확인, 스캔 완료 |
| `bin/` | setup.ps1이 받은 gitleaks/osv-scanner |

`SENTRY_LITE_HOME`(기본: 이 폴더), `SENTRY_LITE_DB`로 위치를 바꿀 수 있다.

### 오프라인 모드
`--offline`은 semgrep 레지스트리 규칙을 건너뛰고 `./rules`만 쓰며, osv-scanner를
`--offline-vulnerabilities`로 실행한다. 오프라인 DB는 미리 한 번 받아 둬야 한다:
`bin\osv-scanner.exe scan source --offline-vulnerabilities --download-offline-databases -r <repo>`
(저장 위치: `%LOCALAPPDATA%\osv-scalibr\<생태계>\all.zip`, 또는 `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY`).

### 심각도 기준 (스캐너 단계 → `/triage`에서 재평가)
스캐너 단계에서는 도구 값을 그대로 옮긴다: semgrep `ERROR→high, WARNING→medium, INFO→low`; osv는 CVSS
점수(9+ critical, 7+ high, 4+ medium); gitleaks는 위의 노출 기준. `confidence`는 분류 전 사전값(규칙 신뢰도
HIGH 0.5 / MEDIUM 0.35 / LOW 0.2)이다. `/triage`(M3)는 **영향 × 도달 가능성 × 필요한 인증** 루브릭으로 다시
매기며, 그 표는 M3에서 이 문서에 추가한다.

## 4. 성능 예산
- 단일 도구 최대 RAM < 2 GB: semgrep `--jobs 2 --max-memory 1500`에 더해, 모든 외부 도구의 **프로세스 트리
  RSS 합**을 0.2초마다 재서 `--mem-cap-mb`(기본 1900)를 넘으면 강제 종료한다(나머지 도구는 계속 실행).
  RSS 합은 공유 메모리를 중복 계산하므로 보수적인(높게 나오는) 값이다.
- 50k LOC 저장소 10분 이내: 측정 결과는 `docs/BENCHMARK.md`.

---

## English developer notes

**Layout.** `sentry/cli.py` (Typer) → `pipeline.run_scan` → `scope.check_scope` → `inventory.build_inventory`
→ `scanners/{semgrep,gitleaks,osv}.py` (each returns `ScannerOutput` with findings + a `ToolCoverage`) →
`store.Store.ingest`. Parsers live in `normalize.py` (semgrep JSON, gitleaks JSON, osv-scanner JSON, generic
SARIF). Every subprocess goes through `toolrun.run_tool` (version probe cached, duration, sampled peak RSS of
the whole process tree, timeout and RAM-cap kill, JSONL log; outputs are never logged). `models.Finding` is
the shared pydantic schema; extensions beyond the spec: `repo`, `message`, `justification`, `evidence`,
`references`, `metadata`, `fix_verified`.

**Coverage-aware auto-fix.** `ToolCoverage(files=None|set, skip_files, history_findings_covered)` tells the
store what a tool really examined, so a diff-aware or partially failed scan never marks unrelated findings as
fixed. git-history secrets are protected in `--since` scans.

**Things learned from real tool output** (and handled):
- semgrep prefixes rules loaded from a local path with that path (`C.Users.me.sentry-lite.rules.<id>`);
  `normalize.canonical_rule_id` strips it so fingerprints don't depend on the install folder.
- semgrep OSS returns `"requires login"` for `extra.lines`/`fingerprint`; snippets are read from the file.
- semgrep OSS omits dataflow traces from JSON/SARIF (text output only), so `dataflow` is filled by `/triage`.
- `semgrep --version` performs a network version check (98 s stall when semgrep.dev is unreachable);
  `SEMGREP_ENABLE_VERSION_CHECK=0` and `SEMGREP_SEND_METRICS=off` are forced for every child process.
- osv-scanner 2.x keeps its offline DB under `<cache>/osv-scalibr/<ecosystem>/all.zip`.

**Tests.** `pytest` (85 tests). Unit tests replay outputs recorded from real semgrep 1.184 / gitleaks 8.30.1 /
osv-scanner 2.7.0 runs (`tests/data/`); `tests/test_integration.py` runs the real binaries offline (local
rules only, a tiny local OSV DB) and is skipped when a tool is missing. No network in tests. Also
`ruff check .`, `ruff format --check .`, `mypy` (strict) are clean.

```bash
pip install -e ".[scan,dev]"
pytest -q && ruff check . && ruff format --check . && mypy
```

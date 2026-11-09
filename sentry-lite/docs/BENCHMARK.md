# Benchmark (M1)

요구사항: 50k LOC 저장소를 노트북에서 10분 이내, 단일 도구 최대 RAM 2 GB 미만.

## 측정 환경과 한계
- **클라우드 샌드박스에서 측정**: Linux, Intel Xeon 2.10 GHz 4 vCPU, 16 GB RAM. 사용자 노트북(Windows, 8 GB)이
  아니다. semgrep은 `--jobs 2`로 고정이라 코어 수 영향은 작지만, 클럭·디스크·Windows 네이티브 semgrep 차이로
  노트북에서는 몇 배 느릴 수 있다. 아래 수치에 5배 여유를 줘도 예산 안이다.
- 도구 버전: semgrep 1.184.0, gitleaks 8.30.1(소스 빌드), osv-scanner 2.7.0. 레지스트리 규칙과 osv.dev 온라인 조회 사용.
- **최대 RAM** = 도구 프로세스 트리(semgrep → semgrep-core 포함)의 RSS 합을 0.2초 간격으로 잰 최댓값. 공유 페이지를
  중복 계산하므로 실제보다 높게 나오는 보수적 수치다.
- 50k LOC 대상은 **합성 코퍼스**다: 사용자 소유인 `yuseunghogi-commits/game`의 소스(TS/HTML/Rust/설정)를 7벌 복사한
  로컬 git 저장소(커밋 1개). 실제 50k LOC 저장소보다 git 기록이 짧아 gitleaks 기록 스캔 시간은 과소평가된다.

## 결과

| 대상 | LOC | 프로필 / 규칙 팩 | 전체 | semgrep | gitleaks | osv-scanner |
|---|---:|---|---:|---|---|---|
| `yuseunghogi-commits/game` (실제, 기록 전체) | 12,706 | mixed: default, owasp-top-ten, secrets, javascript, typescript, python | **17.3 s** | 9.1 s / 507 MB | 1.5 s / 56 MB | 1.4 s / 56 MB |
| 합성 코퍼스 (game × 7) — 첫 스캔 | 55,027 | web: default, owasp-top-ten, secrets, javascript, typescript | **21.9 s** | 17.9 s / 516 MB | 1.2 s / 54 MB | 0.8 s / 57 MB |
| 같은 코퍼스 — 재스캔 (신규 0, 재발견 67) | 55,027 | web | **22.8 s** | 18.6 s / 507 MB | 1.2 s / 56 MB | 0.9 s / 56 MB |
| 같은 코퍼스 — `--since HEAD` (파일 2개 변경) | 55,027 | web | **7.5 s** | 5.0 s / 451 MB | 0.6 s / 53 MB | 건너뜀 (lockfile 변경 없음) |

결론: 50k LOC 기준 약 22초, 최대 RAM 약 0.5 GB로 예산(10분 / 2 GB) 대비 여유가 크다. semgrep 메모리는 대상 크기보다
**규칙 수**에 좌우된다(파일 2개 스캔에도 451 MB) — 규칙 팩을 줄이면 RAM이 줄어든다.

## 발견된 점
- `semgrep --version`이 버전 확인을 위해 semgrep.dev에 접속하며, 접속이 막히면 98초 멈춘다. 모든 하위 프로세스에
  `SEMGREP_ENABLE_VERSION_CHECK=0`, `SEMGREP_SEND_METRICS=off`를 강제해 해결했다.
- 무료 레지스트리 팩(p/default, p/javascript, p/typescript, p/owasp-top-ten)은 가장 단순한 DOM XSS
  (`el.innerHTML = location.hash`, `document.write(location.search)`)를 `.js`/`.ts` 모두에서 **잡지 못했다**.
  M2의 사용자 정의 규칙(`rules/`)이 이 공백을 메워야 한다.

## 노트북에서 직접 재기
```powershell
sentry scan C:\code\<50k-LOC-repo>
sentry scans list            # 스캔별 도구 시간 / 최대 RAM
Get-Content logs\tools.jsonl -Tail 5
```
결과를 이 표에 추가해 주면 M5의 `EVAL.md`에 반영한다.

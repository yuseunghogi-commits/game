# DevTools 브라우저 (Android)

안드로이드에서 아무 사이트나 열고 **개발자 도구**(콘솔·요소·네트워크·저장소)를 바로 띄울 수 있는 브라우저 앱.
개발자 도구 화면은 [Eruda](https://github.com/liriliri/eruda)(MIT)를 앱 안에 넣어 쓴다. 인터넷에서 따로 받지 않는다.

## 기능

| 기능 | 설명 |
|---|---|
| 개발자 도구 | 아래 파란 `</>` 버튼으로 열기/닫기. 페이지 구석의 톱니 버튼으로도 열린다. 탭: Console, Elements, Network, Resources, Sources, Info, Snippets |
| 로딩 초반 로그 | '페이지마다 자동 준비'(기본 켬)이면 페이지가 만들어지는 순간 스크립트를 넣어, 개발자 도구가 뜨기 전 찍힌 `console.*`·오류도 Console 탭에 남는다 (WebView가 문서 시작 주입을 지원할 때) |
| 엄격한 CSP 사이트 | 인라인 스타일이 막힌 사이트에서도 개발자 도구 화면이 깨지지 않게 스타일을 우회해 입힌다. Trusted Types 강제 사이트도 처리 |
| CSP 해제 (실험적) | `eval`이 막혀 콘솔에 입력한 코드가 실행되지 않는 사이트용. 최상위 문서의 `Content-Security-Policy` 헤더를 빼고 연다 |
| 데스크톱 사이트 | PC 크롬 User-Agent로 요청 |
| 원격 디버깅 | 항상 켜져 있음. PC 크롬 `chrome://inspect`에서 이 앱의 페이지를 데스크톱 개발자 도구로 볼 수 있다 |
| 로컬 개발 서버 | `localhost:5173`, `192.168.0.10:3000` 같은 주소는 http로 연다. http 허용, 사용자 설치 인증서(mkcert 등) 신뢰, 인증서 오류 시 '무시하고 계속' 선택 가능 |
| 그 밖에 | 다른 앱의 링크 열기·공유받기, 파일 업로드, 다운로드(Android 10+), 쿠키·캐시 삭제, 마지막 페이지 기억 |

## APK 받기

1. 이 폴더나 워크플로 파일이 바뀐 커밋을 push하면 GitHub Actions의 **Android DevTools Browser** 워크플로가 APK를 만든다.
2. 저장소의 **Actions** 탭 → 해당 실행 → 아래 **Artifacts**의 `devtools-browser-apk`를 내려받아 압축을 푼다.
3. 휴대폰에서 `devtools-browser-x.y.z.apk`를 열어 설치한다 ('출처를 알 수 없는 앱 설치' 허용 필요).

업데이트 설치가 '서명이 다름'으로 실패하면 기존 앱을 지우고 설치한다. 매번 같은 키로 서명하려면 서명 키를 만들어
저장소 **Settings → Secrets and variables → Actions**에 `ANDROID_DEBUG_KEYSTORE_BASE64`로 넣는다.

```bash
keytool -genkeypair -keystore debug.keystore -storepass android -alias androiddebugkey -keypass android \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
base64 -w0 debug.keystore   # 출력 전체를 Secret 값으로
```

## 직접 빌드

JDK 17과 Android SDK(API 35)가 있으면:

```bash
cd android-devtools-browser
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest      # 주소창 해석 등 단위 테스트
```

Android Studio에서 이 폴더를 열어도 된다. 최소 Android 7.0 (API 24).

## 구조

| 파일 | 역할 |
|---|---|
| `app/src/main/java/.../MainActivity.java` | 화면, WebView 설정, 메뉴, 다운로드·파일 선택·외부 앱 연동 |
| `app/src/main/java/.../DevTools.java` | Eruda 주입: 문서 시작 주입 등록, 로드 후 보충 주입, 열기/닫기 |
| `app/src/main/assets/devtools/boot.js` | 페이지 안에서 도는 부트스트랩: 로그 모으기·재생, eruda 초기화, CSP·Trusted Types 우회 |
| `app/src/main/assets/devtools/eruda.js` | Eruda 3.4.3 (npm 배포본, 라이선스는 `eruda-LICENSE.txt`) |
| `app/src/main/java/.../CspStripper.java` | 'CSP 해제' 옵션: 최상위 문서를 대신 받아 CSP 헤더 제거 |
| `app/src/main/java/.../UrlInput.java` | 주소창 입력 → 주소/검색어 판단 |
| `app/src/main/assets/start.html` | 시작 페이지(사용법) |

Eruda를 새 버전으로 바꾸려면 `npm pack eruda`로 받은 `eruda.js`에서 마지막 `//# sourceMappingURL=` 줄을 빼고
`assets/devtools/eruda.js`를 덮어쓴다.

## 한계

- Network 탭은 Eruda가 뜬 뒤의 XHR·fetch 요청을 보여 준다. 이미지·스크립트 같은 정적 리소스나 그 전 요청까지 보려면 PC 크롬 원격 디버깅을 쓴다.
- CSP가 `data:` 글꼴을 막는 사이트에서는 개발자 도구의 아이콘이 보이지 않는다(기능은 동작).
- 'CSP 해제'는 HTTP 헤더만 지운다. HTML 안의 `<meta http-equiv="Content-Security-Policy">`는 남는다. POST로 연 페이지에는 적용되지 않는다.
- WebView 기반이라 크롬 앱의 확장 기능·동기화는 없다. 구글 로그인 등 일부 서비스는 WebView 로그인을 막는다.

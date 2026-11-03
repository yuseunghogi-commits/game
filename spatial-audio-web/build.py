"""page.html + engine.js + 데이터(HRIR, 헤드폰 EQ) → 파일 하나짜리 웹 앱.

  python3 build.py                 → dist/3d-sound-player.html (아티팩트용 한 파일)
  python3 build.py --pwa site      → site/ (GitHub Pages 용: 설치형 웹 앱 + 오프라인 + 새 버전 알림)
"""
import base64, hashlib, json, pathlib, shutil, sys

here = pathlib.Path(__file__).parent
root = here.parent
assets = root / "spatial-audio-android/app/src/main/assets"

args = sys.argv[1:]
pwa = "--pwa" in args
if pwa:
    args.remove("--pwa")

page = (here / "page.html").read_text("utf-8")
engine = (here / "engine.js").read_text("utf-8")
eq = (assets / "headphone_eq.txt").read_text("utf-8")
hrir = base64.b64encode((assets / "hrir_kemar.bin").read_bytes()).decode("ascii")
elev = base64.b64encode((assets / "hrir_mit_elev.bin").read_bytes()).decode("ascii")
for name, text in (("engine.js", engine), ("headphone_eq.txt", eq)):
    assert "</script" not in text.lower(), name
for ph in ("/*ENGINE_SRC*/", "__EQ_TEXT__", "__HRIR_B64__", "__ELEV_B64__", "/*PWA_BOOT*/"):
    assert page.count(ph) == 1, ph

# 설치형 웹 앱: 서비스 워커(오프라인) + 새 버전이 올라오면 알림 띄우기
PWA_BOOT = """// ── 설치형 웹 앱 (GitHub Pages): 오프라인에서도 열리고, 새 버전이 올라오면 알림 ──
  (() => {
    const BUILD = '__WEB_BUILD__';
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
    $('updateReload').addEventListener('click', () => location.reload());
    let shown = false;
    const check = async () => {
      if (shown) return;
      try {
        const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return;
        const v = await r.json();
        if (v.build && v.build !== BUILD) {
          shown = true;
          $('updateText').textContent = '새 버전 v' + v.version + ' 이 나왔어요 (다음에 열 때 자동 적용)';
          $('updateBanner').hidden = false;
        }
      } catch (e) { /* 오프라인 */ }
    };
    setTimeout(check, 4000);
    setInterval(check, 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  })();"""

page = (page.replace("/*ENGINE_SRC*/", engine).replace("__EQ_TEXT__", eq)
        .replace("__HRIR_B64__", hrir).replace("__ELEV_B64__", elev)
        .replace("/*PWA_BOOT*/", PWA_BOOT if pwa else ""))

if not pwa:
    out = pathlib.Path(args[0]) if args else here / "dist/3d-sound-player.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, "utf-8")
    print(f"{out} {len(page.encode('utf-8')) / 1024:.0f} KB")
    sys.exit(0)

# ── GitHub Pages 사이트 ──
site = pathlib.Path(args[0]) if args else here / "site"
if site.exists():
    shutil.rmtree(site)
site.mkdir(parents=True)
version = (root / "RELEASE_VERSION").read_text("utf-8").strip()

# 아티팩트용 조각(head 내용 + body 내용)을 완전한 HTML 문서로
split = page.index('<div class="wrap">')
head_part, body_part = page[:split], page[split:]
head = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="헤드폰용 3D 입체 음향 — PC 크롬·엣지의 다른 탭 소리(유튜브 등)와 저장된 음악·영상">
<meta name="theme-color" content="#eceeea" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111513" media="(prefers-color-scheme: dark)">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="3D 사운드">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="favicon-48.png" sizes="48x48" type="image/png">
<link rel="icon" href="icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
"""
doc = head + head_part + "</head>\n<body>\n" + body_part + "\n</body>\n</html>\n"
build = hashlib.sha256(doc.encode("utf-8")).hexdigest()[:12]
doc = doc.replace("__WEB_BUILD__", build)
assert "__WEB_BUILD__" not in doc
(site / "index.html").write_text(doc, "utf-8")

manifest = {
    "name": "3D 사운드",
    "short_name": "3D 사운드",
    "description": "헤드폰용 3D 입체 음향 — PC 크롬·엣지의 다른 탭 소리와 저장된 음악·영상",
    "lang": "ko",
    "id": "./",
    "start_url": "./",
    "scope": "./",
    "display": "standalone",
    "background_color": "#111513",
    "theme_color": "#111513",
    "icons": [
        {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
        {"src": "icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
}
(site / "manifest.webmanifest").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
sw = (here / "sw.js").read_text("utf-8").replace("__WEB_BUILD__", build)
(site / "sw.js").write_text(sw, "utf-8")
(site / "version.json").write_text(json.dumps({"version": version, "build": build}), "utf-8")
for f in (here / "pwa").glob("*.png"):
    shutil.copy(f, site / f.name)
(site / ".nojekyll").write_text("", "utf-8")
size = sum(f.stat().st_size for f in site.iterdir() if f.is_file())
print(f"{site} v{version} build {build} · {size / 1024:.0f} KB")

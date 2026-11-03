"""page.html + engine.js + 데이터(HRIR, 헤드폰 EQ) → 파일 하나짜리 웹 앱 (dist/3d-sound-player.html)."""
import base64, pathlib, sys
here = pathlib.Path(__file__).parent
assets = here.parent / "spatial-audio-android/app/src/main/assets"
out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else here / "dist/3d-sound-player.html"
page = (here / "page.html").read_text("utf-8")
engine = (here / "engine.js").read_text("utf-8")
eq = (assets / "headphone_eq.txt").read_text("utf-8")
hrir = base64.b64encode((assets / "hrir_kemar.bin").read_bytes()).decode("ascii")
elev = base64.b64encode((assets / "hrir_mit_elev.bin").read_bytes()).decode("ascii")
for name, text in (("engine.js", engine), ("headphone_eq.txt", eq)):
    assert "</script" not in text.lower(), name
for ph in ("/*ENGINE_SRC*/", "__EQ_TEXT__", "__HRIR_B64__", "__ELEV_B64__"):
    assert page.count(ph) == 1, ph
page = page.replace("/*ENGINE_SRC*/", engine).replace("__EQ_TEXT__", eq).replace("__HRIR_B64__", hrir).replace("__ELEV_B64__", elev)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(page, "utf-8")
print(f"{out} {len(page.encode('utf-8')) / 1024:.0f} KB")

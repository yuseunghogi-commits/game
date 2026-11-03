"""AutoEq 파라메트릭 EQ 결과를 내려받아 앱용 headphone_eq.txt 로 묶는다 (엄격 파싱)."""
import re, sys, urllib.parse, urllib.request, pathlib
out_path, cache = sys.argv[1], pathlib.Path(sys.argv[2])
MODELS = [
    ("Bose QuietComfort Headphones (2023)", "Rtings/Bruel & Kjaer 5128 over-ear/Bose QuietComfort", "Rtings · B&K 5128"),
    ("Bose QuietComfort Ultra Headphones", "Rtings/Bruel & Kjaer 5128 over-ear/Bose QuietComfort Ultra Headphones", "Rtings · B&K 5128"),
    ("Bose QuietComfort 45", "oratory1990/over-ear/Bose QuietComfort 45", "oratory1990"),
    ("Bose QuietComfort 35 II", "Rtings/HMS II.3 over-ear/Bose QuietComfort 35 II", "Rtings · HMS II.3"),
    ("Sony WH-1000XM5", "oratory1990/over-ear/Sony WH-1000XM5", "oratory1990"),
    ("Sony WH-1000XM4", "oratory1990/over-ear/Sony WH-1000XM4", "oratory1990"),
    ("Sony WF-1000XM5", "oratory1990/in-ear/Sony WF-1000XM5", "oratory1990"),
    ("Apple AirPods Max", "oratory1990/over-ear/Apple AirPods Max", "oratory1990"),
    ("Apple AirPods Pro 2", "HypetheSonics/GRAS RA0045 in-ear/Apple Airpods Pro 2", "HypetheSonics · GRAS RA0045"),
    ("Apple AirPods 4", "Rtings/Bruel & Kjaer 5128 earbud/Apple AirPods 4", "Rtings · B&K 5128"),
    ("Samsung Galaxy Buds3 Pro", "Rtings/Bruel & Kjaer 5128 in-ear/Samsung Galaxy Buds3 Pro", "Rtings · B&K 5128"),
    ("Samsung Galaxy Buds2 Pro", "oratory1990/in-ear/Samsung Galaxy Buds2 Pro", "oratory1990"),
    ("Samsung Galaxy Buds FE", "Rtings/Bruel & Kjaer 5128 in-ear/Samsung Galaxy Buds FE", "Rtings · B&K 5128"),
]
BASE = "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/"
pre_re = re.compile(r"^Preamp:\s*(-?\d+(?:\.\d+)?)\s*dB\s*$")
flt_re = re.compile(r"^Filter\s+\d+:\s+ON\s+(PK|LSC|HSC)\s+Fc\s+(\d+(?:\.\d+)?)\s+Hz\s+Gain\s+(-?\d+(?:\.\d+)?)\s+dB\s+Q\s+(\d+(?:\.\d+)?)\s*$")
lines = ["# 헤드폰 보정 파라메트릭 EQ — AutoEq (Jaakko Pasanen, MIT License) 결과에서 추출",
         "# 형식: [이름|측정 출처] / preamp dB / 타입 Fc Gain Q (타입: PK=피킹, LSC=저역 쉘프, HSC=고역 쉘프)"]
for name, path, src in MODELS:
    leaf = path.split("/")[-1]
    f = cache / (leaf + ".txt")
    if not f.exists():
        url = BASE + urllib.parse.quote(f"{path}/{leaf} ParametricEQ.txt")
        with urllib.request.urlopen(url, timeout=60) as r:
            f.write_bytes(r.read()[:20000])
    pre, flts = None, []
    for ln in f.read_text("utf-8", "replace").splitlines():
        ln = ln.strip()
        if not ln: continue
        m = pre_re.match(ln)
        if m: pre = float(m.group(1)); continue
        m = flt_re.match(ln)
        if m:
            t, fc, g, q = m.group(1), float(m.group(2)), float(m.group(3)), float(m.group(4))
            assert 10 <= fc <= 22000 and -20 <= g <= 20 and 0.05 <= q <= 20, ln
            flts.append((t, fc, g, q)); continue
        raise SystemExit(f"unexpected line in {f.name}: {ln!r}")
    assert pre is not None and 3 <= len(flts) <= 12, (name, pre, len(flts))
    lines.append(f"[{name}|{src}]")
    lines.append(f"preamp {pre}")
    lines += [f"{t} {fc:g} {g:g} {q:g}" for t, fc, g, q in flts]
    print(f"{name:40s} preamp {pre:+.1f} dB, {len(flts)} filters")
pathlib.Path(out_path).write_text("\n".join(lines) + "\n", "utf-8")

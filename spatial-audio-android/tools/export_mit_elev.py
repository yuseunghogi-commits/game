"""MIT KEMAR (Gardner & Martin) 확산음장 등화 compact 세트, 48kHz → 앱용 높이 HRIR 파일.
입력: mit-hrtf-lib 의 diffuse/mit_hrtf_diffuse_48000.h (MIT 라이선스 C 라이브러리, 데이터 출처 MIT Media Lab)."""
import re, sys, struct, numpy as np
src, out = sys.argv[1], sys.argv[2]
text = open(src, encoding='latin-1').read()
pat = re.compile(r'//\s*H(-?\d+)e(\d+)a\.wav\s*\{([^}]*)\}\s*,\s*\{([^}]*)\}', re.S)
entries = {}
for m in pat.finditer(text):
    el, az = int(m.group(1)), int(m.group(2))
    L = np.array([int(v) for v in m.group(3).replace('\n', ' ').split(',') if v.strip()], dtype=np.int16)
    R = np.array([int(v) for v in m.group(4).replace('\n', ' ').split(',') if v.strip()], dtype=np.int16)
    assert len(L) == 140 and len(R) == 140, (el, az, len(L), len(R))
    entries[(el, az)] = (L, R)
els = sorted({e for e, _ in entries})
print('높이:', els, '총', len(entries), '개')
for e in els:
    azs = sorted(a for ee, a in entries if ee == e)
    print(f'  {e:+3d}°: {len(azs)}개 방위각 {azs[:4]}…{azs[-2:]}')
# 어느 쪽 귀가 큰지로 방위각 방향 확인 (+90°)
L, R = entries[(0, 90)]
eL, eR = float(np.sum(L.astype(float)**2)), float(np.sum(R.astype(float)**2))
print('0° 높이, 방위각 90°: 왼쪽 귀 %.1f dB, 오른쪽 귀 %.1f dB' % (10*np.log10(eL), 10*np.log10(eR)))
right_positive = eR > eL
with open(out, 'wb') as f:
    f.write(b'HREL'); f.write(struct.pack('<iiii', 1, 48000, 140, len(entries)))
    for (e, a) in sorted(entries):
        Lx, Rx = entries[(e, a)]
        if not right_positive:  # 엔진 규칙: + = 오른쪽
            Lx, Rx = Rx, Lx
        f.write(struct.pack('<hh', e, a)); f.write(Lx.astype('<i2').tobytes()); f.write(Rx.astype('<i2').tobytes())
print('저장:', out, '(+ 방위각 = 오른쪽 기준으로 정렬:', right_positive, ')')

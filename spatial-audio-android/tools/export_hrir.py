import sys, struct, h5py, numpy as np
from scipy.signal import resample_poly
src, out = sys.argv[1], sys.argv[2]
f = h5py.File(src, 'r'); ir = f['Data.IR'][:]; sp = f['SourcePosition'][:]
order = np.argsort(sp[:,0]); ir = ir[order]; sp = sp[order]
assert np.allclose(sp[:,0], np.arange(360)), sp[:5,0]
# 채널 0 = 왼쪽 귀, SOFA 방위각 반시계(90 = 왼쪽) — 데이터로 확인함
ir48 = resample_poly(ir, 160, 147, axis=2)            # 44.1k -> 48k
# 확산음장 등화: 모든 방향 평균 파워 스펙트럼의 역 (1/3 옥타브 스무딩, 최소위상)
N = 4096
H = np.fft.rfft(ir48, N, axis=2)
P = np.mean(np.abs(H)**2, axis=(0,1))
freqs = np.fft.rfftfreq(N, 1/48000)
sm = np.empty_like(P)
for k, fk in enumerate(freqs):
    lo, hi = fk/2**(1/6), fk*2**(1/6)
    m = (freqs >= lo) & (freqs <= hi)
    sm[k] = P[m].mean() if m.any() else P[k]
mag = 1/np.sqrt(sm)
# 극단 보정 제한: ±12dB, 저역(<150Hz)과 초고역(>16k)은 보정 안 함
mag /= np.median(mag[(freqs>300)&(freqs<3000)])
mag = np.clip(mag, 10**(-12/20), 10**(12/20))
mag[freqs < 150] = mag[np.argmin(np.abs(freqs-150))]
mag[freqs > 16000] = mag[np.argmin(np.abs(freqs-16000))]
# 최소위상 필터 (켑스트럼)
logm = np.log(np.concatenate([mag, mag[-2:0:-1]]))
c = np.fft.ifft(logm).real
w = np.zeros(N); w[0]=1; w[1:N//2]=2; w[N//2]=1
eq = np.fft.irfft(np.exp(np.fft.fft(c*w))[:N//2+1], N)[:512]
irq = np.array([[np.convolve(ir48[d,e], eq)[:ir48.shape[2]+512] for e in (0,1)] for d in range(360)])
# 앞쪽 공통 지연 제거, 길이 384
on = min(int(np.argmax(np.abs(irq[d,e]) > 0.05*np.abs(irq[d,e]).max())) for d in range(360) for e in (0,1))
start = max(0, on - 8); taps = 384
irq = irq[:,:,start:start+taps]
fade = np.ones(taps); fade[-48:] = np.hanning(96)[48:]
irq *= fade
# 정면(0°) 양 귀 파워 합이 1(=0dB)이 되게 레벨 정규화
front = np.sum(irq[0]**2)
irq /= np.sqrt(front/2)
# 엔진 방향(오른쪽 +, 2° 간격) 순서로: 엔진 θ → SOFA 방위각 (-θ) mod 360
step = 2; dirs = 360//step
data = np.stack([irq[(-th) % 360] for th in range(0, 360, step)])   # [dir][ear][tap]
scale = np.abs(data).max()
q = np.round(data/scale*32767).astype('<i2')
with open(out, 'wb') as fo:
    fo.write(b'HRIR'); fo.write(struct.pack('<iiiif', 1, 48000, taps, dirs, float(scale))); fo.write(struct.pack('<i', step))
    fo.write(q.tobytes())
# 확인
def ild(th):
    d = data[(th//step) % dirs]; return 10*np.log10(np.sum(d[0]**2)/np.sum(d[1]**2))
print('written', out, q.nbytes, 'bytes; start', start, 'scale', scale)
for th in (0, 30, 90, -90, 150, 180):
    print('engine θ=%4d°  ILD(L-R) %+.1f dB' % (th, ild(th % 360)))

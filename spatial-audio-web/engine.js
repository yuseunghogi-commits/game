/*
 * 3D 사운드 엔진 (웹/아이패드용) — 안드로이드·PC 앱의 실측 엔진(Kotlin)을 그대로 옮긴 것.
 *   HrirSet.kt / HrtfRenderer.kt / RoomModel.kt / HeadphoneEq.kt / BinauralProcessor.kt(실측 경로)
 *
 * 실측 HRTF: KEMAR HRTFs with low frequency correction — H. Wierstorf, M. Geier, S. Spors, V. Erbes
 *            (TU Berlin / Universität Rostock), CC BY 4.0.
 * 헤드폰 보정: AutoEq (Jaakko Pasanen, MIT License) 결과.
 *
 * DOM 을 쓰지 않는 순수 계산 코드라서 페이지, AudioWorklet, Node 테스트에서 똑같이 돈다.
 */
(function (G) {
  'use strict';
  const PI = Math.PI;

  // ─────────────────────────────── FFT ───────────────────────────────
  class Fft {
    constructor(n) {
      this.n = n;
      this.cosT = new Float64Array(n / 2);
      this.sinT = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) { this.cosT[i] = Math.fround(Math.cos(2 * PI * i / n)); this.sinT[i] = Math.fround(Math.sin(2 * PI * i / n)); }
      let bits = 0; while ((1 << bits) < n) bits++;
      const sw = [];
      for (let i = 0; i < n; i++) {
        let x = i, y = 0;
        for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; }
        if (y > i) sw.push(i, y);
      }
      this.swaps = Int32Array.from(sw);
    }
    /** 제자리 복소 FFT. 단계별로 회전인자를 바깥 루프에 둬서 표 읽기를 줄임 (결과는 단순 구현과 동일) */
    transform(re, im, inverse) {
      const n = this.n, cosT = this.cosT, sinT = this.sinT, sw = this.swaps;
      for (let s = 0; s < sw.length; s += 2) {
        const i = sw[s], j = sw[s + 1];
        let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t;
      }
      for (let i = 0; i < n; i += 2) {
        const ar = re[i], ai = im[i], br = re[i + 1], bi = im[i + 1];
        re[i] = ar + br; im[i] = ai + bi; re[i + 1] = ar - br; im[i + 1] = ai - bi;
      }
      const sgn = inverse ? 1 : -1;
      for (let len = 4; len <= n; len <<= 1) {
        const half = len >> 1, step = n / len;
        for (let k = 0; k < half; k++) {
          const wr = cosT[k * step], wi = sgn * sinT[k * step];
          for (let i = k; i < n; i += len) {
            const j = i + half;
            const rj = re[j], ij = im[j];
            const xr = rj * wr - ij * wi, xi = rj * wi + ij * wr;
            const ri = re[i], ii = im[i];
            re[j] = ri - xr; im[j] = ii - xi; re[i] = ri + xr; im[i] = ii + xi;
          }
        }
      }
      if (inverse) { const s = 1 / n; for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; } }
    }
  }

  // ─────────────────────────────── HRIR ───────────────────────────────
  const EAR_FACTORS = [0.88, 0.94, 1.0, 1.06, 1.12];
  const EAR_NAMES = ['1 (아주 작게)', '2 (작게)', '3 (보통 · 기본)', '4 (크게)', '5 (아주 크게)'];

  /** hrir_kemar.bin (tools/export_hrir.py 형식) → { fs, taps, dirs, step, data[dir][ear] } */
  function loadHrir(buffer) {
    const dv = new DataView(buffer);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'HRIR') throw new Error('HRIR 파일 형식이 아닙니다');
    const fs = dv.getInt32(8, true), taps = dv.getInt32(12, true), dirs = dv.getInt32(16, true);
    const scale = dv.getFloat32(20, true), step = dv.getInt32(24, true);
    const k = scale / 32767;
    let off = 28;
    const data = [];
    for (let d = 0; d < dirs; d++) {
      const pair = [];
      for (let e = 0; e < 2; e++) {
        const a = new Float32Array(taps);
        for (let t = 0; t < taps; t++) { a[t] = dv.getInt16(off, true) * k; off += 2; }
        pair.push(a);
      }
      data.push(pair);
    }
    return { fs, taps, dirs, step, data };
  }

  function cubic(s, x) {
    const i = Math.floor(x), t = Math.fround(x - i);
    const at = (k) => (k >= 0 && k < s.length) ? s[k] : 0;
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  }
  function sincInterp(s, x, cutoff) {
    const half = 8, c = Math.floor(x);
    let acc = 0;
    for (let k = c - half; k <= c + half; k++) {
      if (k < 0 || k >= s.length) continue;
      const d = x - k;
      const w = 0.5 + 0.5 * Math.cos(PI * d / (half + 1));
      const a = PI * d * cutoff;
      const sinc = Math.abs(a) < 1e-9 ? 1 : Math.sin(a) / a;
      acc += s[k] * cutoff * sinc * w;
    }
    return acc;
  }
  /** 머리/귀 크기 맞춤 + 샘플레이트 변환 (HrirSet.adapted 와 동일) */
  function adaptHrir(set, targetFs, factor) {
    const ratio = targetFs / set.fs * factor;
    const newTaps = Math.min(1024, Math.max(64, Math.round(set.taps * ratio)));
    const lp = ratio < 1;
    const data = set.data.map(pair => pair.map(src => {
      const out = new Float32Array(newTaps);
      for (let i = 0; i < newTaps; i++) { const x = i / ratio; out[i] = lp ? sincInterp(src, x, ratio) : cubic(src, x); }
      if (ratio !== 1) { const g = 1 / ratio; for (let k = 0; k < newTaps; k++) out[k] *= g; }
      return out;
    }));
    return { fs: targetFs, taps: newTaps, dirs: set.dirs, step: set.step, data };
  }

  // ─────────────────────────────── 높이 단서 (MIT KEMAR) ───────────────────────────────
  /*
   * MIT KEMAR HRTF (W. Gardner, K. Martin, MIT Media Lab) 확산음장 등화 compact 48kHz, 높이 -40°~+90° (ElevationSet.kt 와 동일).
   * 수평은 기존 실측(2°)을 쓰고, 여기서는 "같은 좌우 각도 수평 방향 대비 위/아래에서 올 때 달라지는 주파수 모양"만 가져온다.
   */
  const MIT_N = 2048, MAX_ELEV_DB = 6, MAX_ELEV_DB_ENH = 9, LN10_20 = 0.11512925;
  function loadElevation(buffer) {
    const dv = new DataView(buffer);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'HREL') throw new Error('높이 HRIR 파일 형식이 아닙니다');
    const taps = dv.getInt32(12, true), count = dv.getInt32(16, true);
    let off = 20;
    const map = new Map();
    for (let c = 0; c < count; c++) {
      const el = dv.getInt16(off, true), az = dv.getInt16(off + 2, true); off += 4;
      const l = new Float32Array(taps), r = new Float32Array(taps);
      for (let t = 0; t < taps; t++) { l[t] = dv.getInt16(off, true) / 32768; off += 2; }
      for (let t = 0; t < taps; t++) { r[t] = dv.getInt16(off, true) / 32768; off += 2; }
      if (!map.has(el)) map.set(el, []);
      map.get(el).push([az, [l, r]]);
    }
    const layers = [...map.keys()].sort((a, b) => a - b);
    const az = layers.map(e => map.get(e).sort((a, b) => a[0] - b[0]).map(x => x[0]));
    const hrir = layers.map(e => map.get(e).sort((a, b) => a[0] - b[0]).map(x => x[1]));
    return new ElevationSet(layers, az, hrir);
  }
  class ElevationSet {
    constructor(layers, az, hrir) { this.layers = layers; this.az = az; this.hrir = hrir; this.magDb = null; this.mitBins = MIT_N / 2 + 1; this.mapKey = 0; }
    prepare() {
      if (this.magDb) return;
      const f = new Fft(MIT_N), re = new Float64Array(MIT_N), im = new Float64Array(MIT_N), raw = new Float64Array(this.mitBins);
      this.magDb = this.hrir.map(layer => layer.map(pair => pair.map(h => {
        re.fill(0); im.fill(0); re.set(h);
        f.transform(re, im, false);
        for (let k = 0; k < this.mitBins; k++) raw[k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-12);
        return this.smooth(raw);
      })));
    }
    smooth(db) {
      // 1옥타브 평활: 귀마다 다른 좁은 골짜기는 버리고 넓은 경향만 (보컬이 날카로워지는 문제 방지)
      const n = db.length, out = new Float32Array(n), cum = new Float64Array(n + 1), r = Math.pow(2, 1 / 2);
      for (let k = 0; k < n; k++) cum[k + 1] = cum[k] + db[k];
      for (let k = 0; k < n; k++) {
        const lo = Math.max(0, Math.floor(k / r)), hi = Math.min(n - 1, Math.max(k, Math.trunc(k * r)));
        out[k] = (cum[hi + 1] - cum[lo]) / (hi - lo + 1);
      }
      return out;
    }
    weights(azDeg, elDeg, ear) {
      let a = azDeg, e2 = ear;
      if (a < 0) { a = -a; e2 = 1 - ear; }
      if (a > 180) a = 180;
      const L = this.layers, el = Math.min(L[L.length - 1], Math.max(L[0], elDeg));
      let li = 0;
      while (li < L.length - 2 && L[li + 1] <= el) li++;
      const l1 = Math.min(li + 1, L.length - 1);
      const t = L[l1] === L[li] ? 0 : Math.min(1, Math.max(0, (el - L[li]) / (L[l1] - L[li])));
      const out = [];
      for (const [layer, lw] of [[li, 1 - t], [l1, t]]) {
        const azs = this.az[layer];
        if (azs.length === 1) { out.push([layer, 0, e2, lw]); continue; }
        let j = 0;
        while (j < azs.length - 2 && azs[j + 1] <= a) j++;
        const u = Math.min(1, Math.max(0, (a - azs[j]) / (azs[j + 1] - azs[j])));
        out.push([layer, j, e2, lw * (1 - u)], [layer, j + 1, e2, lw * u]);
      }
      return out;
    }
    dbAt(w, b) { let s = 0; for (const [li, ai, e, wt] of w) s += wt * this.magDb[li][ai][e][b]; return s; }
    /** scale: 3D 강조 배율 (1 = 그대로, 2 = 단서 2배, 이때 한계도 ±9dB 까지) */
    cueGain(azS, elS, azEq, ear, fs, n, out, scale = 1) {
      if (!this.magDb) { out.fill(1); return; }
      const bins = n / 2 + 1, key = fs * 100000 + n;
      if (key !== this.mapKey) {
        const mitHz = 48000 / MIT_N;
        this.mapB0 = new Int32Array(bins); this.mapFr = new Float64Array(bins);
        for (let k = 0; k < bins; k++) { const pos = (k * fs / n) / mitHz; this.mapB0[k] = Math.min(this.mitBins - 2, Math.trunc(pos)); this.mapFr[k] = Math.min(1, Math.max(0, pos - this.mapB0[k])); }
        this.mapKey = key;
      }
      const wu = this.weights(azS, elS, ear), wf = this.weights(azEq, 0, ear);
      const lim = Math.min(MAX_ELEV_DB * scale, MAX_ELEV_DB_ENH);
      const lo = 400 * n / fs, ramp = 800 * n / fs;
      for (let k = 0; k < bins; k++) {
        if (k < lo) { out[k] = 1; continue; }
        const b0 = this.mapB0[k], fr = this.mapFr[k];
        const up = this.dbAt(wu, b0) * (1 - fr) + this.dbAt(wu, b0 + 1) * fr;
        const flat = this.dbAt(wf, b0) * (1 - fr) + this.dbAt(wf, b0 + 1) * fr;
        let g = Math.min(lim, Math.max(-lim, (up - flat) * scale));
        if (k < ramp) g *= (k - lo) / (ramp - lo);
        out[k] = Math.exp(g * LN10_20);
      }
    }
  }
  /** 같은 좌우 각도를 가진 수평 방위각 (위로 올라간 소리는 양 귀 차이가 줄어듦) */
  function lateralAzimuth(x, y) {
    const lat = Math.asin(Math.min(1, Math.max(-1, x))) * 180 / PI;
    return y >= 0 ? lat : (lat >= 0 ? 180 - lat : -180 - lat);
  }

  // ─────────────────────────────── 방 모델 ───────────────────────────────
  const BUSES = 8;
  const GEOS = [
    [4.0, 4.5, 2.5, 0.60], [3.5, 4.0, 2.5, 0.65], [5.0, 6.0, 2.8, 0.70], [7.0, 8.5, 3.2, 0.72],
    [12.0, 16.0, 6.0, 0.78], [18.0, 26.0, 9.0, 0.80], [4.0, 5.0, 2.6, 0.75],
  ];
  function mirror(x, a, b, n) {
    let p = x;
    for (let i = 1; i <= Math.abs(n); i++) p = ((i % 2 === 1) === (n > 0)) ? 2 * b - p : 2 * a - p;
    return p;
  }
  /** 직육면체 방 거울상 반사 1·2차 (RoomModel.build 와 동일) */
  function buildRoom(fs, frontDeg, roomIdx, amount) {
    const g = GEOS[Math.max(0, Math.min(GEOS.length - 1, roomIdx))];
    const [w, l, h, beta] = g;
    const C = 343, EAR_H = 1.2, FLOOR_BETA = 0.45;
    const x0 = -w / 2, x1 = w / 2, y0 = -0.45 * l, y1 = 0.55 * l, z0 = 0, z1 = h;
    const d0 = Math.min(3.0, Math.max(1.5, 0.35 * Math.min(w, l)));
    const list = [];
    for (let input = 0; input <= 1; input++) {
      const th = (input === 0 ? -frontDeg : frontDeg) * PI / 180;
      const sx = d0 * Math.sin(th), sy = d0 * Math.cos(th), sz = EAR_H;
      for (let nx = -2; nx <= 2; nx++) for (let ny = -2; ny <= 2; ny++) for (let nz = -2; nz <= 2; nz++) {
        const order = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
        if (order < 1 || order > 2) continue;
        const dx = mirror(sx, x0, x1, nx), dy = mirror(sy, y0, y1, ny), dz = mirror(sz, z0, z1, nz) - EAR_H;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const floors = nz > 0 ? Math.floor(Math.abs(nz) / 2) : Math.floor((Math.abs(nz) + 1) / 2);
        const others = order - floors;
        let gain = (d0 / r) * Math.pow(beta, others) * Math.pow(FLOOR_BETA, floors) * amount;
        const elev = Math.abs(Math.atan2(dz, Math.sqrt(dx * dx + dy * dy)));
        gain *= Math.max(0.5, Math.cos(elev));
        if (gain < 0.015) continue;
        const delaySec = (r - d0) / C;
        let cutoff = order === 1 ? 8000 : 5000;
        if (floors > 0) cutoff = Math.min(cutoff, 3500);
        const lpc = Math.fround(1 - Math.exp(-2 * PI * cutoff / fs));
        const az = Math.atan2(dx, dy) * 180 / PI;
        list.push({ input, delay: Math.trunc(delaySec * fs), gain, lpc, az });
      }
    }
    const n = list.length;
    const t = {
      n, input: new Int32Array(n), delay: new Int32Array(n), gain: new Float32Array(n), lpc: new Float32Array(n),
      lp: new Float32Array(n), busA: new Int32Array(n), busB: new Int32Array(n), wA: new Float32Array(n), wB: new Float32Array(n),
      azimuth: new Float64Array(n), energy: 0,
    };
    let e = 0;
    list.forEach((v, i) => {
      t.input[i] = v.input; t.delay[i] = v.delay; t.gain[i] = v.gain; t.lpc[i] = v.lpc; t.azimuth[i] = v.az;
      const a = ((v.az % 360) + 360) % 360;
      const pos = a / (360 / BUSES);
      const i0 = Math.floor(pos) % BUSES;
      const frac = pos - Math.floor(pos);
      t.busA[i] = i0; t.busB[i] = (i0 + 1) % BUSES;
      t.wA[i] = Math.cos(frac * PI / 2); t.wB[i] = Math.sin(frac * PI / 2);
      if (v.input === 0) e += v.gain * v.gain;
    });
    t.energy = e;
    return t;
  }

  // ─────────────────────────────── 헤드폰 보정 ───────────────────────────────
  function parseEq(text) {
    const out = [];
    let cur = null;
    for (const raw of text.split(/\r?\n/)) {
      const ln = raw.trim();
      if (!ln || ln.startsWith('#')) continue;
      if (ln.startsWith('[') && ln.endsWith(']')) {
        const parts = ln.slice(1, -1).split('|');
        cur = { name: parts[0], source: parts[1] || '', preampDb: 0, filters: [] };
        out.push(cur);
      } else if (cur && ln.startsWith('preamp ')) {
        cur.preampDb = parseFloat(ln.slice(7));
      } else if (cur) {
        const p = ln.split(/\s+/);
        if (p.length === 4 && (p[0] === 'PK' || p[0] === 'LSC' || p[0] === 'HSC')) {
          cur.filters.push({ type: p[0], fc: parseFloat(p[1]), gainDb: parseFloat(p[2]), q: parseFloat(p[3]) });
        }
      }
    }
    return out;
  }
  class EqChain {
    constructor(profile, fs) {
      const n = this.n = profile.filters.length;
      this.b0 = new Float64Array(n); this.b1 = new Float64Array(n); this.b2 = new Float64Array(n);
      this.a1 = new Float64Array(n); this.a2 = new Float64Array(n);
      this.z1 = [new Float64Array(n), new Float64Array(n)]; this.z2 = [new Float64Array(n), new Float64Array(n)];
      // AutoEq 프리앰프는 최대 3.5dB 까지 되돌림 (3D 를 켜도 원음과 같은 크기로, 넘는 순간은 끝단 리미터가 잡음)
      this.pre = Math.pow(10, (profile.preampDb + Math.min(-profile.preampDb, 3.5)) / 20);
      profile.filters.forEach((f, i) => {
        const fc = Math.min(f.fc, fs * 0.45);
        const a = Math.pow(10, f.gainDb / 40), w0 = 2 * PI * fc / fs, cw = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * f.q), sa = 2 * Math.sqrt(a) * alpha;
        let b0, b1, b2, a0, a1, a2;
        if (f.type === 'LSC') {
          b0 = a * ((a + 1) - (a - 1) * cw + sa); b1 = 2 * a * ((a - 1) - (a + 1) * cw); b2 = a * ((a + 1) - (a - 1) * cw - sa);
          a0 = (a + 1) + (a - 1) * cw + sa; a1 = -2 * ((a - 1) + (a + 1) * cw); a2 = (a + 1) + (a - 1) * cw - sa;
        } else if (f.type === 'HSC') {
          b0 = a * ((a + 1) + (a - 1) * cw + sa); b1 = -2 * a * ((a - 1) + (a + 1) * cw); b2 = a * ((a + 1) + (a - 1) * cw - sa);
          a0 = (a + 1) - (a - 1) * cw + sa; a1 = 2 * ((a - 1) - (a + 1) * cw); a2 = (a + 1) - (a - 1) * cw - sa;
        } else {
          b0 = 1 + alpha * a; b1 = -2 * cw; b2 = 1 - alpha * a; a0 = 1 + alpha / a; a1 = -2 * cw; a2 = 1 - alpha / a;
        }
        this.b0[i] = b0 / a0; this.b1[i] = b1 / a0; this.b2[i] = b2 / a0; this.a1[i] = a1 / a0; this.a2[i] = a2 / a0;
      });
    }
    process(x, ch) {
      let v = x * this.pre;
      const z1 = this.z1[ch], z2 = this.z2[ch];
      for (let i = 0; i < this.n; i++) {
        const y = this.b0[i] * v + z1[i];
        z1[i] = this.b1[i] * v - this.a1[i] * y + z2[i];
        z2[i] = this.b2[i] * v - this.a2[i] * y;
        v = y;
      }
      return v;
    }
  }

  // ─────────────────────────────── HRTF 렌더러 ───────────────────────────────
  const N = 2048, WIN = 1024, HOP = 512, LATENCY = WIN, MAX_DELAY = 512;
  const BUS_ANGLES = Array.from({ length: BUSES }, (_, i) => i * 360 / BUSES);
  const SIDE_ANGLE = 95;
  /** 천장 앞 스피커 기본 위치 ±45°·위 45°, 천장 뒤 ±135°·위 45° (7.1.4 배치), 바닥 ±45°·아래 30° */
  const HEIGHT_AZ = 45, HEIGHT_EL = 45, TOP_REAR_AZ = 135, TOP_REAR_EL = 45, BOTTOM_AZ = 45, BOTTOM_EL = -30;
  /** 3D 강조: 앞/뒤 짝과의 차이를 뒤쪽이 3/4, 앞쪽이 1/4 맡음. 최대 ±10dB */
  const ENH_BACK = 0.75, ENH_FRONT = 0.25, ENH_MAX_DB = 10, HALF = Math.SQRT1_2;
  const SIDE_SHARE = Math.sqrt(0.6), REAR_SHARE = Math.sqrt(0.4), SQRT2 = Math.SQRT2;

  class HrtfRenderer {
    constructor(fs, base, elev) {
      this.fs = fs; this.base = base; this.elev = elev || null;
      this.headPitch = 0; this.frontElev = 0; this.heightLevel = 0; this.yawF = 0; this.pitchF = 0; this.elevF = 0;
      this.topAz = HEIGHT_AZ; this.topEl = HEIGHT_EL; // 천장 앞 스피커 위치 (좌우 ±각도, 높이)
      this.topRearAz = TOP_REAR_AZ; this.topRearEl = TOP_REAR_EL; // 천장 뒤
      this.bottomLevel = 0; this.bottomAz = BOTTOM_AZ; this.bottomEl = BOTTOM_EL; // 바닥 (높이 −)
      this.specCache = new Map(); this.specTable = null; this.rowSpec = new Array(180).fill(null);
      this.mode = 'speakers'; this.frontAngle = 45; this.rearAngle = 135; this.rearLevel = 0.45;
      this.centerLevel = 0.7; this.spread = 90; this.headYaw = 0;
      this.fft = new Fft(N);
      const bins = this.bins = N / 2 + 1;
      this.earIdx = 2; this.enhanceAmt = 0;
      // 3D 강조 적용 범위: 700Hz 아래는 그대로, 1.4kHz 까지 서서히
      this.enhRamp = new Float32Array(bins);
      for (let k = 0; k < bins; k++) this.enhRamp[k] = Math.min(1, Math.max(0, (k * fs / N - 700) / 700));
      this.baseTab = this.buildBase(adaptHrir(base, fs, 1.0));
      this.table = this.baseTab.t;
      // 계산용 배열은 64비트 (JS 엔진에서 32비트 배열보다 FFT 가 약 3배 빠름)
      const F = (n) => new Float64Array(n);
      this.window = F(WIN); for (let i = 0; i < WIN; i++) this.window[i] = 0.5 - 0.5 * Math.cos(2 * PI * i / WIN);
      this.inL = F(WIN); this.inR = F(WIN); this.busIn = Array.from({ length: BUSES }, () => F(WIN));
      this.inPos = WIN - HOP;
      this.olaL = F(N); this.olaR = F(N); this.outL = F(HOP); this.outR = F(HOP); this.outPos = 0;
      this.zr = new Float64Array(N); this.zi = new Float64Array(N);
      this.xLr = F(bins); this.xLi = F(bins); this.xRr = F(bins); this.xRi = F(bins);
      this.bR = Array.from({ length: BUSES }, () => F(bins)); this.bI = Array.from({ length: BUSES }, () => F(bins));
      this.yLr = F(bins); this.yLi = F(bins); this.yRr = F(bins); this.yRi = F(bins);
      this.fLr = F(bins); this.fLi = F(bins); this.fRr = F(bins); this.fRi = F(bins);
      this.cRr = F(bins); this.cIi = F(bins);
      this.aLr = F(bins); this.aLi = F(bins); this.aRr = F(bins); this.aRi = F(bins);
      this.pLL = F(bins); this.pRR = F(bins); this.pLRr = F(bins); this.pLRi = F(bins);
      this.sLL = F(bins); this.sRR = F(bins); this.sLRr = F(bins); this.sLRi = F(bins);
      this.cum = new Float64Array(bins + 1);
      this.lowBin = Math.round(130 * N / fs);
      this.phaseCache = new Map();
      this.dSide = Math.min(MAX_DELAY, Math.round(0.004 * fs));
      this.dRear = Math.min(MAX_DELAY, Math.round(0.009 * fs));
      this.dTop = Math.min(MAX_DELAY, Math.round(0.006 * fs));
      this.dTopRear = Math.min(MAX_DELAY, Math.round(0.0105 * fs));
      this.dBottom = Math.min(MAX_DELAY, Math.round(0.0025 * fs));
      this.gainTmp = new Float64Array(this.bins);
      this.routedEnergy = [0, 0, 0];
    }

    setEarSize(idx) {
      const i = Math.max(0, Math.min(EAR_FACTORS.length - 1, idx));
      if (i === this.earIdx) return;
      this.earIdx = i;
      this.baseTab = this.buildBase(adaptHrir(this.base, this.fs, EAR_FACTORS[i]));
      this.enhJob = null;
      this.table = this.enhanced(this.baseTab, this.enhanceAmt);
    }

    /**
     * 3D 강조 0..1 (α = 1 + amount): 0 이면 실측 그대로. FFT 없이 게인만 다시 곱함.
     * now 가 아니면 오디오가 끊기지 않게 프레임마다 8방향씩 나눠 계산하고 다 되면 교체 (48kHz 에서 약 0.25초).
     */
    setEnhance(amount, now = false) {
      const a = Math.min(1, Math.max(0, amount || 0));
      if (a === this.enhanceAmt && !this.enhJob) return;
      this.enhanceAmt = a;
      if (now || !(a > 0)) { this.enhJob = null; this.table = this.enhanced(this.baseTab, a); return; }
      this.enhJob = { b: this.baseTab, a, d: 0, re: [], im: [] };
    }

    stepEnhance(count) {
      const j = this.enhJob, t = j.b.t;
      for (let n = 0; n < count && j.d < t.dirs; n++, j.d++) { const [r2, i2] = this.enhanceDir(j.b, j.a, j.d); j.re.push(r2); j.im.push(i2); }
      if (j.d === t.dirs) { this.table = { dirs: t.dirs, step: t.step, re: j.re, im: j.im, enh: j.a }; this.enhJob = null; }
    }

    /** 원본 표 + 방향마다 "앞/뒤 짝 방향(θ ↔ 180°−θ)과의 크기 차이(dB, 1/2 옥타브 평활)" */
    buildBase(set) {
      const t = this.buildTable(set), bins = this.bins;
      const r = Math.pow(2, 0.25), c = new Float64Array(bins + 1);
      const sm = t.re.map((pair, d) => pair.map((re, e) => {
        const im = t.im[d][e];
        for (let k = 0; k < bins; k++) c[k + 1] = c[k] + 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-20);
        const out = new Float32Array(bins);
        for (let k = 0; k < bins; k++) {
          const lo = Math.max(0, Math.floor(k / r)), hi = Math.min(bins - 1, Math.max(k, Math.trunc(k * r)));
          out[k] = (c[hi + 1] - c[lo]) / (hi - lo + 1);
        }
        return out;
      }));
      const diff = sm.map((pair, d) => {
        const p = Math.floor(((((180 - d * t.step) % 360) + 360) % 360) / t.step) % t.dirs;
        return pair.map((s, e) => { const o = new Float32Array(bins), q = sm[p][e]; for (let k = 0; k < bins; k++) o[k] = s[k] - q[k]; return o; });
      });
      return { t, diff };
    }

    /** 3D 강조: 앞/뒤 짝과의 차이를 (α−1)배 더 벌림 — 뒤쪽 3/4, 앞쪽 1/4 (보컬 음색은 거의 그대로) */
    enhanced(b, amount) {
      const t = b.t;
      if (!(amount > 0)) return t;
      const re = [], im = [];
      for (let d = 0; d < t.dirs; d++) { const [r2, i2] = this.enhanceDir(b, amount, d); re.push(r2); im.push(i2); }
      return { dirs: t.dirs, step: t.step, re, im, enh: amount };
    }

    enhanceDir(b, amount, d) {
      const t = b.t, bins = this.bins, ramp = this.enhRamp;
      const back = Math.cos(d * t.step * PI / 180) < -1e-9;
      const c = amount * (back ? ENH_BACK : ENH_FRONT);
      const r2 = [], i2 = [];
      for (let e = 0; e < 2; e++) {
        const df = b.diff[d][e], sr = t.re[d][e], si = t.im[d][e], dr = new Float32Array(bins), di = new Float32Array(bins);
        for (let k = 0; k < bins; k++) {
          const g = Math.fround(Math.fround(Math.min(ENH_MAX_DB, Math.max(-ENH_MAX_DB, Math.fround(c * df[k])))) * ramp[k]);
          const m = Math.fround(Math.exp(Math.fround(g * LN10_20)));
          dr[k] = sr[k] * m; di[k] = si[k] * m;
        }
        r2.push(dr); i2.push(di);
      }
      return [r2, i2];
    }

    buildTable(set) {
      const f = new Fft(N), bins = N / 2 + 1;
      const re = [], im = [];
      const br = new Float64Array(N), bi = new Float64Array(N);
      const taps = Math.min(set.taps, N - WIN - MAX_DELAY);
      for (let d = 0; d < set.dirs; d++) {
        const r2 = [], i2 = [];
        for (let e = 0; e < 2; e++) {
          br.fill(0); bi.fill(0);
          br.set(set.data[d][e].subarray(0, taps));
          f.transform(br, bi, false);
          r2.push(Float32Array.from(br.subarray(0, bins))); i2.push(Float32Array.from(bi.subarray(0, bins)));
        }
        re.push(r2); im.push(i2);
      }
      return { dirs: set.dirs, step: set.step, re, im, enh: 0 };
    }

    phase(delay) {
      let p = this.phaseCache.get(delay);
      if (!p) {
        const c = new Float64Array(this.bins), s = new Float64Array(this.bins);
        for (let k = 0; k < this.bins; k++) { const ph = -2 * PI * k * delay / N; c[k] = Math.cos(ph); s[k] = Math.sin(ph); }
        p = [c, s]; this.phaseCache.set(delay, p);
      }
      return p;
    }

    /** 샘플 하나 → LATENCY 샘플 전 결과를 out[0], out[1] 에. bus: 방 버스 8개(또는 null) */
    process(l, r, bus, out) {
      out[0] = this.outL[this.outPos]; out[1] = this.outR[this.outPos]; this.outPos++;
      const p = this.inPos;
      this.inL[p] = l; this.inR[p] = r;
      for (let b = 0; b < BUSES; b++) this.busIn[b][p] = bus ? bus[b] : 0;
      this.inPos++;
      if (this.inPos === WIN) {
        this.frame();
        this.inL.copyWithin(0, HOP); this.inR.copyWithin(0, HOP);
        for (let b = 0; b < BUSES; b++) this.busIn[b].copyWithin(0, HOP);
        this.inPos = WIN - HOP; this.outPos = 0;
      }
    }

    /**
     * 블록 처리: 입력 m 샘플 → 출력 m 샘플 (LATENCY 만큼 늦음). bus: 방 버스 8개 각각 m 샘플 배열(또는 null).
     * 샘플 단위 process() 와 결과가 같고 훨씬 빠르다.
     */
    processBlock(inL, inR, bus, outL, outR, m) {
      let i = 0;
      while (i < m) {
        const take = Math.min(m - i, WIN - this.inPos);
        outL.set(this.outL.subarray(this.outPos, this.outPos + take), i);
        outR.set(this.outR.subarray(this.outPos, this.outPos + take), i);
        this.inL.set(inL.subarray(i, i + take), this.inPos);
        this.inR.set(inR.subarray(i, i + take), this.inPos);
        for (let b = 0; b < BUSES; b++) {
          if (bus) this.busIn[b].set(bus[b].subarray(i, i + take), this.inPos);
          else this.busIn[b].fill(0, this.inPos, this.inPos + take);
        }
        this.outPos += take; this.inPos += take; i += take;
        if (this.inPos === WIN) {
          this.frame();
          this.inL.copyWithin(0, HOP); this.inR.copyWithin(0, HOP);
          for (let b = 0; b < BUSES; b++) this.busIn[b].copyWithin(0, HOP);
          this.inPos = WIN - HOP; this.outPos = 0;
        }
      }
    }

    dirIndex(t, deg) {
      let a = (deg - this.yawF) % 360; if (a < 0) a += 360;
      return Math.round(a / t.step) % t.dirs;
    }

    fft2(a, b, ar, ai, br, bi) {
      const zr = this.zr, zi = this.zi, w = this.window, bins = this.bins;
      for (let i = 0; i < N; i++) {
        if (i < WIN) { zr[i] = a[i] * w[i]; zi[i] = b[i] * w[i]; } else { zr[i] = 0; zi[i] = 0; }
      }
      this.fft.transform(zr, zi, false);
      for (let k = 0; k < bins; k++) {
        const m = (N - k) % N;
        ar[k] = 0.5 * (zr[k] + zr[m]); ai[k] = 0.5 * (zi[k] - zi[m]);
        br[k] = 0.5 * (zi[k] + zi[m]); bi[k] = 0.5 * (zr[m] - zr[k]);
      }
    }

    frame() {
      if (this.enhJob) this.stepEnhance(8);
      const t = this.table;
      this.yawF = this.headYaw; this.pitchF = this.headPitch; this.elevF = this.frontElev;
      this.fft2(this.inL, this.inR, this.xLr, this.xLi, this.xRr, this.xRi);
      let hasBus = false;
      outer: for (let b = 0; b < BUSES; b++) { const a = this.busIn[b]; for (let i = 0; i < WIN; i++) if (a[i] !== 0) { hasBus = true; break outer; } }
      if (hasBus) for (let p = 0; p < BUSES / 2; p++) this.fft2(this.busIn[2 * p], this.busIn[2 * p + 1], this.bR[2 * p], this.bI[2 * p], this.bR[2 * p + 1], this.bI[2 * p + 1]);
      this.yLr.fill(0); this.yLi.fill(0); this.yRr.fill(0); this.yRi.fill(0);
      this.analyse();
      if (this.mode === 'speakers') this.speakers(t); else this.localize(t);
      if (hasBus) for (let b = 0; b < BUSES; b++) this.addSource(t, this.bR[b], this.bI[b], BUS_ANGLES[b], 0, 1, 0);
      const { yLr, yLi, yRr, yRi, zr, zi } = this;
      yLi[0] = 0; yRi[0] = 0; yLi[N / 2] = 0; yRi[N / 2] = 0;
      for (let k = 0; k <= N / 2; k++) { zr[k] = yLr[k] - yRi[k]; zi[k] = yLi[k] + yRr[k]; }
      for (let k = N / 2 + 1; k < N; k++) { const m = N - k; zr[k] = yLr[m] + yRi[m]; zi[k] = yRr[m] - yLi[m]; }
      this.fft.transform(zr, zi, true);
      const { olaL, olaR } = this;
      for (let i = 0; i < N; i++) { olaL[i] += zr[i]; olaR[i] += zi[i]; }
      this.outL.set(olaL.subarray(0, HOP)); this.outR.set(olaR.subarray(0, HOP));
      olaL.copyWithin(0, HOP); olaL.fill(0, N - HOP);
      olaR.copyWithin(0, HOP); olaR.fill(0, N - HOP);
    }

    analyse() {
      const a = 0.55, b = 1 - a, bins = this.bins;
      const { xLr, xLi, xRr, xRi, pLL, pRR, pLRr, pLRi } = this;
      for (let k = 0; k < bins; k++) {
        const lr = xLr[k], li = xLi[k], rr = xRr[k], ri = xRi[k];
        pLL[k] = a * pLL[k] + b * (lr * lr + li * li);
        pRR[k] = a * pRR[k] + b * (rr * rr + ri * ri);
        pLRr[k] = a * pLRr[k] + b * (lr * rr + li * ri);
        pLRi[k] = a * pLRi[k] + b * (li * rr - lr * ri);
      }
      this.smooth(pLL, this.sLL); this.smooth(pRR, this.sRR); this.smooth(pLRr, this.sLRr); this.smooth(pLRi, this.sLRi);
    }

    smooth(src, dst) {
      const cum = this.cum, bins = this.bins;
      cum[0] = 0;
      for (let k = 0; k < bins; k++) cum[k + 1] = cum[k] + src[k];
      for (let k = 0; k < bins; k++) {
        const h = 1 + Math.floor(k / 32);
        const lo = Math.max(0, k - h), hi = Math.min(bins - 1, k + h);
        dst[k] = (cum[hi + 1] - cum[lo]) / (hi - lo + 1);
      }
    }

    /** 세계 방향 (방위 azW, 높이 elW) 의 두 귀 스펙트럼 — 머리 좌우·위아래 회전 반영, 수평 실측 × 높이 단서 (캐시) */
    specFor(t, azW, elW) {
      if (this.specTable !== t) { this.specCache.clear(); this.specTable = t; }
      const a = azW * PI / 180, e = elW * PI / 180;
      const x = Math.cos(e) * Math.sin(a), y = Math.cos(e) * Math.cos(a), z = Math.sin(e);
      const ps = this.yawF * PI / 180, th = this.pitchF * PI / 180;
      const x1 = x * Math.cos(ps) - y * Math.sin(ps), y1 = x * Math.sin(ps) + y * Math.cos(ps);
      const y2 = y1 * Math.cos(th) + z * Math.sin(th), z2 = -y1 * Math.sin(th) + z * Math.cos(th);
      const azH = Math.atan2(x1, y2) * 180 / PI, elH = Math.asin(Math.min(1, Math.max(-1, z2))) * 180 / PI;
      const ai = Math.round((((azH % 360) + 360) % 360) / 2) % 180;
      const ei = Math.min(36, Math.max(-36, Math.round(elH / 2.5)));
      const key = ai * 100 + ei + 50;
      const hit = this.specCache.get(key);
      if (hit) { this.specCache.delete(key); this.specCache.set(key, hit); return hit; }
      const azQ = ai * 2 > 180 ? ai * 2 - 360 : ai * 2, elQ = ei * 2.5;
      const er = elQ * PI / 180, arr = azQ * PI / 180;
      const azEq = lateralAzimuth(Math.cos(er) * Math.sin(arr), Math.cos(er) * Math.cos(arr));
      const d = Math.round((((azEq % 360) + 360) % 360) / t.step) % t.dirs;
      const sp = { lr: t.re[d][0].slice(), li: t.im[d][0].slice(), rr: t.re[d][1].slice(), ri: t.im[d][1].slice() };
      if (this.elev && ei !== 0) {
        const g = this.gainTmp, bins = this.bins, sc = 1 + (t.enh || 0); // 3D 강조: 위·아래 단서도 α 배
        this.elev.cueGain(azQ, elQ, azEq, 0, this.fs, N, g, sc);
        for (let k = 0; k < bins; k++) { sp.lr[k] *= g[k]; sp.li[k] *= g[k]; }
        this.elev.cueGain(azQ, elQ, azEq, 1, this.fs, N, g, sc);
        for (let k = 0; k < bins; k++) { sp.rr[k] *= g[k]; sp.ri[k] *= g[k]; }
      }
      this.specCache.set(key, sp);
      if (this.specCache.size > 600) this.specCache.delete(this.specCache.keys().next().value);
      return sp;
    }

    addSource(t, xr, xi, deg, el, g, delay) {
      let hLr, hLi, hRr, hRi;
      if (el === 0 && this.pitchF === 0) {
        const d = this.dirIndex(t, deg);
        hLr = t.re[d][0]; hLi = t.im[d][0]; hRr = t.re[d][1]; hRi = t.im[d][1];
      } else {
        const sp = this.specFor(t, deg, el);
        hLr = sp.lr; hLi = sp.li; hRr = sp.rr; hRi = sp.ri;
      }
      const { yLr, yLi, yRr, yRi, bins } = this;
      if (delay === 0) {
        for (let k = 0; k < bins; k++) {
          const ar = xr[k] * g, ai = xi[k] * g;
          yLr[k] += ar * hLr[k] - ai * hLi[k]; yLi[k] += ar * hLi[k] + ai * hLr[k];
          yRr[k] += ar * hRr[k] - ai * hRi[k]; yRi[k] += ar * hRi[k] + ai * hRr[k];
        }
      } else {
        const [c, s] = this.phase(delay);
        for (let k = 0; k < bins; k++) {
          const xr0 = xr[k] * g, xi0 = xi[k] * g;
          const ar = xr0 * c[k] - xi0 * s[k], ai = xr0 * s[k] + xi0 * c[k];
          yLr[k] += ar * hLr[k] - ai * hLi[k]; yLi[k] += ar * hLi[k] + ai * hLr[k];
          yRr[k] += ar * hRr[k] - ai * hRi[k]; yRi[k] += ar * hRi[k] + ai * hRr[k];
        }
      }
    }

    directness(k) {
      const sLL = this.sLL[k], sRR = this.sRR[k], sLRr = this.sLRr[k], sLRi = this.sLRi[k];
      const tot = sLL + sRR + 1e-20;
      const cross = Math.sqrt(sLRr * sLRr + sLRi * sLRi);
      const coh = Math.min(1, Math.max(0, cross / Math.sqrt(sLL * sRR + 1e-30)));
      const side = Math.abs(sRR - sLL) / tot;
      const c = Math.min(1, Math.max(0, (coh - 0.3) / 0.7));
      const sd = Math.min(1, Math.max(0, (side - 0.4) / 0.6));
      return Math.max(c, sd);
    }

    speakers(t) {
      const cl = this.centerLevel, r = Math.min(1, Math.max(0, this.rearLevel)), h = Math.min(1, Math.max(0, this.heightLevel));
      const bt = Math.min(1, Math.max(0, this.bottomLevel));
      // 배경음 에너지 나누기: 앞 (1-r)(1-h)(1-b), 옆·뒤 r(1-h)(1-b), 천장 h(1-b), 바닥 b
      const frontAmb = Math.fround(Math.sqrt(Math.fround(Math.fround((1 - r) * (1 - h)) * (1 - bt))));
      const surAmb = Math.fround(Math.sqrt(Math.fround(Math.fround(r * (1 - h)) * (1 - bt))));
      const topAmb = Math.fround(Math.sqrt(Math.fround(h * (1 - bt)))), botAmb = Math.fround(Math.sqrt(bt));
      const { xLr, xLi, xRr, xRi, fLr, fLi, fRr, fRi, cRr, cIi, aLr, aLi, aRr, aRi, sLL, sRR, sLRr, sLRi, bins, lowBin } = this;
      for (let k = 0; k < bins; k++) {
        const lr = xLr[k], li = xLi[k], rr = xRr[k], ri = xRi[k];
        if (k < lowBin) {
          fLr[k] = lr; fLi[k] = li; fRr[k] = rr; fRi[k] = ri;
          cRr[k] = 0; cIi[k] = 0; aLr[k] = 0; aLi[k] = 0; aRr[k] = 0; aRi[k] = 0;
          continue;
        }
        const dir = this.directness(k);
        const md = Math.sqrt(dir), ma = Math.sqrt(1 - dir);
        const ldr = lr * md, ldi = li * md, rdr = rr * md, rdi = ri * md;
        const tot = sLL[k] + sRR[k] + 1e-20;
        const psi = Math.min(1, Math.max(0, 2 * Math.sqrt(sLRr[k] * sLRr[k] + sLRi[k] * sLRi[k]) / tot));
        // 좌우가 완전히 같은 소리는 가운데 스피커로만 (세 스피커 간섭 → 1~2kHz 골·250Hz 부풂 방지), cl 은 모으는 범위
        const u = cl > 0.001 ? Math.min(1, Math.max(0, (psi - (1 - cl)) / cl)) : 0, wc = u * u;
        const cr = wc * 0.5 * (ldr + rdr), ci = wc * 0.5 * (ldi + rdi);
        let flr = ldr - cr, fli = ldi - ci, frr = rdr - cr, fri = rdi - ci;
        const eIn = ldr * ldr + ldi * ldi + rdr * rdr + rdi * rdi;
        const eOut = flr * flr + fli * fli + frr * frr + fri * fri + 2 * (cr * cr + ci * ci);
        const gN = eOut > 1e-24 ? Math.min(2, Math.max(1, Math.sqrt(eIn / eOut))) : 1;
        flr *= gN; fli *= gN; frr *= gN; fri *= gN;
        cRr[k] = cr * gN * SQRT2; cIi[k] = ci * gN * SQRT2;
        const alr = lr * ma, ali = li * ma, arr = rr * ma, ari = ri * ma;
        fLr[k] = flr + alr * frontAmb; fLi[k] = fli + ali * frontAmb;
        fRr[k] = frr + arr * frontAmb; fRi[k] = fri + ari * frontAmb;
        aLr[k] = alr; aLi[k] = ali; aRr[k] = arr; aRi[k] = ari;
      }
      const f = this.frontAngle, ef = this.elevF;
      this.addSource(t, fLr, fLi, -f, ef, 1, 0);
      this.addSource(t, fRr, fRi, f, ef, 1, 0);
      if (cl > 0.001) this.addSource(t, cRr, cIi, 0, ef, 1, 0);
      this.addAmbience(t, surAmb, topAmb, botAmb);
    }

    /** 배경음 → 옆(±95°)·뒤(±rear)·천장 앞/뒤·바닥 — 서로 다른 지연으로 디코릴레이션 */
    addAmbience(t, surAmb, topAmb, botAmb) {
      const { aLr, aLi, aRr, aRi } = this;
      if (surAmb > 0.0005) {
        this.addSource(t, aLr, aLi, -SIDE_ANGLE, 0, SIDE_SHARE * surAmb, this.dSide);
        this.addSource(t, aRr, aRi, SIDE_ANGLE, 0, SIDE_SHARE * surAmb, this.dSide);
        this.addSource(t, aLr, aLi, -this.rearAngle, 0, REAR_SHARE * surAmb, this.dRear);
        this.addSource(t, aRr, aRi, this.rearAngle, 0, REAR_SHARE * surAmb, this.dRear);
      }
      if (topAmb > 0.0005) {
        // 천장 앞·뒤에 에너지 반씩
        const g = Math.fround(topAmb * Math.fround(HALF)), az = this.topAz, el = this.topEl, raz = this.topRearAz, rel = this.topRearEl;
        this.addSource(t, aLr, aLi, -az, el, g, this.dTop);
        this.addSource(t, aRr, aRi, az, el, g, this.dTop);
        this.addSource(t, aLr, aLi, -raz, rel, g, this.dTopRear);
        this.addSource(t, aRr, aRi, raz, rel, g, this.dTopRear);
      }
      if (botAmb > 0.0005) {
        const az = this.bottomAz, el = this.bottomEl;
        this.addSource(t, aLr, aLi, -az, el, botAmb, this.dBottom);
        this.addSource(t, aRr, aRi, az, el, botAmb, this.dBottom);
      }
    }

    localize(t) {
      const spr = this.spread, r = Math.min(1, Math.max(0, this.rearLevel)), h = Math.min(1, Math.max(0, this.heightLevel));
      const bt = Math.min(1, Math.max(0, this.bottomLevel));
      const frontAmb = Math.fround(Math.sqrt(Math.fround(Math.fround((1 - r) * (1 - h)) * (1 - bt))));
      const surAmb = Math.fround(Math.sqrt(Math.fround(Math.fround(r * (1 - h)) * (1 - bt))));
      const topAmb = Math.fround(Math.sqrt(Math.fround(h * (1 - bt)))), botAmb = Math.fround(Math.sqrt(bt));
      const fast = this.elevF === 0 && this.pitchF === 0, row = this.rowSpec, ef = this.elevF;
      if (!fast) row.fill(null);
      const { xLr, xLi, xRr, xRi, fLr, fLi, fRr, fRi, aLr, aLi, aRr, aRi, sLL, sRR, yLr, yLi, yRr, yRi, bins, lowBin } = this;
      for (let k = 0; k < bins; k++) {
        const lr = xLr[k], li = xLi[k], rr = xRr[k], ri = xRi[k];
        const ll = lr * lr + li * li, rrE = rr * rr + ri * ri;
        const dir = k < lowBin ? 1 : this.directness(k);
        const md = Math.sqrt(dir), ma = Math.sqrt(1 - dir);
        const sr = lr + rr, si = li + ri, sumE = sr * sr + si * si;
        const norm = sumE > 1e-24 ? Math.min(2, Math.sqrt((ll + rrE) / sumE)) : 0;
        const dr = sr * norm * md, di = si * norm * md;
        const tot = sLL[k] + sRR[k] + 1e-20;
        const pan = (sRR[k] - sLL[k]) / tot;
        const deg = k < lowBin ? 0 : spr * pan;
        let hL, hLi, hR, hRi;
        if (fast) {
          const d = this.dirIndex(t, deg);
          hL = t.re[d][0]; hLi = t.im[d][0]; hR = t.re[d][1]; hRi = t.im[d][1];
        } else {
          const idx = Math.round((((deg % 360) + 360) % 360) / 2) % 180;
          let sp = row[idx];
          if (!sp) { sp = this.specFor(t, idx * 2, ef); row[idx] = sp; }
          hL = sp.lr; hLi = sp.li; hR = sp.rr; hRi = sp.ri;
        }
        yLr[k] += dr * hL[k] - di * hLi[k]; yLi[k] += dr * hLi[k] + di * hL[k];
        yRr[k] += dr * hR[k] - di * hRi[k]; yRi[k] += dr * hRi[k] + di * hR[k];
        fLr[k] = lr * ma * frontAmb; fLi[k] = li * ma * frontAmb; fRr[k] = rr * ma * frontAmb; fRi[k] = ri * ma * frontAmb;
        aLr[k] = lr * ma; aLi[k] = li * ma; aRr[k] = rr * ma; aRi[k] = ri * ma;
      }
      this.addSource(t, fLr, fLi, -this.frontAngle, ef, 1, 0);
      this.addSource(t, fRr, fRi, this.frontAngle, ef, 1, 0);
      this.addAmbience(t, surAmb, topAmb, botAmb);
    }
  }

  // ─────────────────────────────── 엔진 (실측 경로) ───────────────────────────────
  /** 잔향 보내기 저음 컷(Hz)과 긴 잔향 배율 — 배경음악 리듬 보존 0.71 → 0.84 (BinauralProcessor.kt 와 같음) */
  const REV_HP_HZ = 300, LATE_SCALE = 0.6;
  const ROOMS = [[0.8, 0, 0], [0.7, 0.4, 0.6], [1.0, 0.7, 0.75], [1.4, 1.0, 0.85], [2.0, 1.6, 0.95], [2.8, 2.4, 1.05], [1.2, 1.5, 1.0]];
  const FDN_N = 8, FDN_MAX = 1 << 13;
  const FDN_MS = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.7, 73.1];
  const LATE_BUS_L = [7, 6, 5, 7, 6, 5, 0, 4], LATE_BUS_R = [1, 2, 3, 1, 2, 3, 0, 4];
  const LATE_SIGN = [1, 1, 1, -1, -1, -1, 1, -1];
  const BLK = 128;

  /** 기본 설정 (안드로이드 SpatialSettings 와 같은 이름·범위) */
  const DEFAULTS = {
    virtualizerStrength: 1000, bassStrength: 250, spaceEq: 45, reverbPreset: 2, frontAngle: 45, rearAngle: 135,
    rearLevel: 45, centerLevel: 60, engineMode: 1, spread: 90, earSize: 2, hpEq: 0, enabled: true,
    frontElev: 0, heightLevel: 25, topAngle: HEIGHT_AZ, topElev: HEIGHT_EL, topRearAngle: TOP_REAR_AZ, topRearElev: TOP_REAR_EL,
    bottomLevel: 10, bottomAngle: BOTTOM_AZ, bottomElev: BOTTOM_EL, enhance: 30,
  };

  class Engine {
    /** @param eqProfiles parseEq() 결과, @param elevBase loadElevation() 결과 (없으면 높이 기능 없이 동작) */
    constructor(fs, hrirBase, eqProfiles, elevBase) {
      this.fs = fs;
      this.eqProfiles = eqProfiles || [];
      if (elevBase) elevBase.prepare();
      this.renderer = new HrtfRenderer(fs, hrirBase, elevBase || null);
      const size = this.size = 1 << 15; this.mask = size - 1;
      this.bufL = new Float32Array(size); this.bufR = new Float32Array(size); this.w = 0;
      this.bus = new Float32Array(BUSES); this.rOut = new Float32Array(2);
      const lp = (hz) => hz <= 0 ? 1 : Math.min(1, Math.fround(1 - Math.exp(-2 * PI * hz / fs)));
      this.lpCoef = lp;
      this.dampCoef = lp(9000); this.revInLp = lp(6000);
      // 잔향으로 보내는 소리의 저음(300Hz 아래)을 뺌 — 킥·베이스 잔향 꼬리가 배경음악을 뭉개지 않게 (2단 1차 고역통과)
      this.revHp = lp(REV_HP_HZ); this.revH1L = 0; this.revH2L = 0; this.revH1R = 0; this.revH2R = 0;
      this.aBass = lp(130); this.aDc = lp(15);
      this.release = Math.fround(1 - Math.exp(-1 / (0.25 * fs)));
      this.revL = this.makeFdn(); this.revR = this.makeFdn();
      this.revLpL = 0; this.revLpR = 0;
      this.lowL = 0; this.lowR = 0; this.dcL = 0; this.dcR = 0; this.limGain = 1;
      this.mix = 1; // 3D 켜짐/꺼짐 부드러운 전환 (1 = 3D)
      this.mixStep = 1 / (0.04 * fs);
      this.hpEq = null; this.hpEqIdx = 0;
      this.p = Object.assign({}, DEFAULTS);
      this.applyParams();
      this.applied = false; // 밖에서 처음 주는 설정(setParams)도 3D 강조를 바로 계산 — 그 뒤 바뀔 때만 나눠서
    }

    makeFdn() {
      return { lines: Array.from({ length: FDN_N }, () => new Float32Array(FDN_MAX)), idx: new Int32Array(FDN_N),
        len: new Int32Array(FDN_N).fill(1000), g: new Float32Array(FDN_N), damp: new Float32Array(FDN_N) };
    }
    configureFdn(f, size, stretch) {
      for (let i = 0; i < FDN_N; i++) {
        f.len[i] = Math.min(FDN_MAX - 1, Math.max(16, Math.round(FDN_MS[i] / 1000 * size * stretch * this.fs)));
        f.g[i] = this.rt60 <= 0 ? 0 : Math.pow(10, -3 * f.len[i] / (this.fs * this.rt60));
        if (f.idx[i] >= f.len[i]) f.idx[i] = 0;
      }
    }
    runFdn(f, x) {
      const dc = this.dampCoef;
      let sum = 0;
      for (let i = 0; i < FDN_N; i++) { f.damp[i] += dc * (f.lines[i][f.idx[i]] - f.damp[i]); sum += f.damp[i]; }
      const h = sum * (2 / FDN_N);
      for (let i = 0; i < FDN_N; i++) {
        const inp = (i & 1) === 0 ? x : -x;
        f.lines[i][f.idx[i]] = inp * 0.9 + f.g[i] * (f.damp[i] - h);
        if (++f.idx[i] >= f.len[i]) f.idx[i] = 0;
      }
    }

    /** 설정 바꾸기 (일부만 넘겨도 됨) */
    setParams(p) {
      Object.assign(this.p, p);
      this.applyParams();
    }

    applyParams() {
      const p = this.p, fs = this.fs;
      this.amount = p.virtualizerStrength / 1000;
      this.early = p.spaceEq / 100;
      this.bass = p.bassStrength / 1000;
      this.roomIdx = p.reverbPreset;
      this.engineMode = p.engineMode === 2 ? 2 : 1;
      const rnd = this.renderer;
      rnd.mode = this.engineMode === 2 ? 'localize' : 'speakers';
      rnd.frontAngle = Math.min(90, Math.max(0, p.frontAngle));
      rnd.rearAngle = Math.min(180, Math.max(90, p.rearAngle));
      rnd.rearLevel = p.rearLevel / 100;
      rnd.centerLevel = p.centerLevel / 100;
      rnd.frontElev = Math.min(45, Math.max(-30, p.frontElev));
      rnd.heightLevel = p.heightLevel / 100;
      const num = (v, lo, hi, d) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
      rnd.topAz = num(p.topAngle, 0, 90, HEIGHT_AZ);
      rnd.topEl = num(p.topElev, 25, 89, HEIGHT_EL);
      rnd.topRearAz = num(p.topRearAngle, 90, 180, TOP_REAR_AZ);
      rnd.topRearEl = num(p.topRearElev, 25, 89, TOP_REAR_EL);
      rnd.bottomLevel = num(p.bottomLevel, 0, 100, 0) / 100;
      rnd.bottomAz = num(p.bottomAngle, 0, 180, BOTTOM_AZ);
      rnd.bottomEl = num(p.bottomElev, -45, -5, BOTTOM_EL);
      rnd.spread = p.spread;
      rnd.setEarSize(p.earSize);
      // 처음 설정은 바로, 그 뒤 바뀔 때는 오디오가 끊기지 않게 나눠서 계산
      rnd.setEnhance(num(p.enhance, 0, 100, 0) / 100, !this.applied);
      this.applied = true;
      if (p.hpEq !== this.hpEqIdx) {
        this.hpEqIdx = p.hpEq;
        const prof = this.eqProfiles[p.hpEq - 1];
        this.hpEq = prof ? new EqChain(prof, fs) : null;
      }
      const room = ROOMS[Math.max(0, Math.min(ROOMS.length - 1, this.roomIdx))];
      const modeRoom = this.engineMode === 2 ? 0.5 : 1.0;
      this.roomTaps = this.early > 0.001 ? buildRoom(fs, rnd.frontAngle, this.roomIdx, this.early * 1.1 * modeRoom) : null;
      this.rt60 = room[1];
      this.lateGain = Math.fround(room[2] * (0.4 + 0.6 * this.early) * modeRoom * LATE_SCALE);
      this.preDelay = Math.round(0.012 * room[0] * fs);
      this.configureFdn(this.revL, room[0], 1.0);
      this.configureFdn(this.revR, room[0], 1.037);
      const lateE = this.rt60 > 0 ? Math.pow(this.lateGain * 0.6, 2) * 2.5 * this.rt60 : 0;
      const trim = this.engineMode === 1 ? 0.57 : 0.72;
      this.roomNorm = Math.fround(trim / Math.sqrt(1 + (this.roomTaps ? this.roomTaps.energy : 0) + lateE));
    }

    /** 평면(채널별) 버퍼 처리. inR 이 null 이면 모노. 내부적으로 128 샘플 블록 단위 */
    processPlanar(inL, inR, outL, outR, n) {
      for (let off = 0; off < n; off += BLK) {
        const m = Math.min(BLK, n - off);
        this.block(inL.subarray(off, off + m), inR ? inR.subarray(off, off + m) : null,
          outL.subarray(off, off + m), outR.subarray(off, off + m), m);
      }
    }

    block(inL, inR, outL, outR, m) {
      if (!this.blk) {
        this.blk = { l: new Float32Array(BLK), r: new Float32Array(BLK), oL: new Float32Array(BLK), oR: new Float32Array(BLK),
          bus: Array.from({ length: BUSES }, () => new Float32Array(BLK)) };
      }
      const B = this.blk, mask = this.mask, bufL = this.bufL, bufR = this.bufR, w0 = this.w;
      // ① 원음: 직류 제거 후 지연선에 기록
      for (let i = 0; i < m; i++) {
        let l = inL[i], r = inR ? inR[i] : inL[i];
        this.dcL += this.aDc * (l - this.dcL); l -= this.dcL;
        this.dcR += this.aDc * (r - this.dcR); r -= this.dcR;
        B.l[i] = l; B.r[i] = r;
        bufL[(w0 + i) & mask] = l; bufR[(w0 + i) & mask] = r;
      }
      // ② 방 반사음 → 방향 버스 (반사음 하나씩 블록 전체를 돌림: JS 에서 훨씬 빠름)
      for (let b = 0; b < BUSES; b++) B.bus[b].fill(0, 0, m);
      const tp = this.roomTaps;
      if (tp) {
        for (let k = 0; k < tp.n; k++) {
          const src = tp.input[k] === 0 ? bufL : bufR, d = tp.delay[k], lpc = tp.lpc[k], gain = tp.gain[k];
          const ba = B.bus[tp.busA[k]], bb = B.bus[tp.busB[k]], wa = tp.wA[k], wb = tp.wB[k];
          let lp = tp.lp[k];
          for (let i = 0; i < m; i++) {
            lp += lpc * (src[(w0 + i - d) & mask] - lp);
            const v = lp * gain;
            ba[i] += v * wa; bb[i] += v * wb;
          }
          tp.lp[k] = lp;
        }
      }
      // ③ 잔향 (FDN) → 방향 버스
      const late = this.lateGain;
      if (late > 0 && this.rt60 > 0) {
        const g = late * 0.6, dL = this.revL.damp, dR = this.revR.damp;
        for (let i = 0; i < m; i++) {
          const di = (w0 + i - this.preDelay) & mask;
          this.revLpL += this.revInLp * (bufL[di] - this.revLpL);
          this.revLpR += this.revInLp * (bufR[di] - this.revLpR);
          const hp = this.revHp;
          let xl = this.revLpL, xr = this.revLpR;
          this.revH1L += hp * (xl - this.revH1L); xl -= this.revH1L;
          this.revH2L += hp * (xl - this.revH2L); xl -= this.revH2L;
          this.revH1R += hp * (xr - this.revH1R); xr -= this.revH1R;
          this.revH2R += hp * (xr - this.revH2R); xr -= this.revH2R;
          this.runFdn(this.revL, xl);
          this.runFdn(this.revR, xr);
          for (let k = 0; k < FDN_N; k++) {
            B.bus[LATE_BUS_L[k]][i] += g * LATE_SIGN[k] * dL[k];
            B.bus[LATE_BUS_R[k]][i] += g * LATE_SIGN[k] * dR[k];
          }
        }
      }
      // ④ 직접음 + 방 → 실측 HRTF (LATENCY 만큼 늦음)
      this.renderer.processBlock(B.l, B.r, B.bus, B.oL, B.oR, m);
      // ⑤ 원음(같은 만큼 늦춤)·저음·헤드폰 보정·켜기/끄기·리미터
      const eq = this.hpEq, wet = this.amount, dry = 1 - this.amount, gBass = 1.5 * this.bass, rn = this.roomNorm;
      const target = this.p.enabled ? 1 : 0;
      for (let i = 0; i < m; i++) {
        const di = (w0 + i - LATENCY) & mask;
        const dl = bufL[di], dr = bufR[di];
        let oL = dry * dl + wet * rn * B.oL[i];
        let oR = dry * dr + wet * rn * B.oR[i];
        this.lowL += this.aBass * (dl - this.lowL);
        this.lowR += this.aBass * (dr - this.lowR);
        oL += gBass * this.lowL; oR += gBass * this.lowR;
        if (eq) { oL = eq.process(oL, 0); oR = eq.process(oR, 1); }
        if (this.mix !== target) this.mix = target > this.mix ? Math.min(target, this.mix + this.mixStep) : Math.max(target, this.mix - this.mixStep);
        const mx = this.mix;
        if (mx < 1) { oL = mx * oL + (1 - mx) * dl; oR = mx * oR + (1 - mx) * dr; }
        const peak = Math.max(Math.abs(oL), Math.abs(oR));
        if (peak * this.limGain > 0.97) this.limGain = 0.97 / peak; else this.limGain += (1 - this.limGain) * this.release;
        outL[i] = Math.min(1, Math.max(-1, oL * this.limGain));
        outR[i] = Math.min(1, Math.max(-1, oR * this.limGain));
      }
      this.w = (w0 + m) & mask;
    }
  }

  // ─────────────────────────────── 귀 맞춤 테스트음 ───────────────────────────────
  const EAR_SEQUENCE = [0, 180, 0, 180, -90, 90];
  /** 짧은 잡음 버스트가 앞→뒤→앞→뒤→왼쪽→오른쪽 순서로 (EarFitTest.kt 와 같은 구성) */
  function renderEarTest(base, fs, earIdx) {
    const set = adaptHrir(base, fs, EAR_FACTORS[Math.max(0, Math.min(4, earIdx))]);
    const seg = Math.floor(fs * 0.65), burst = Math.floor(fs * 0.35);
    const n = seg * EAR_SEQUENCE.length + set.taps;
    const L = new Float32Array(n), R = new Float32Array(n);
    let seed = 11;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    EAR_SEQUENCE.forEach((deg, s) => {
      const d = set.data[(((deg + 360) % 360) / set.step) | 0];
      const src = new Float32Array(burst);
      let lp = 0;
      for (let i = 0; i < burst; i++) {
        const k = i % Math.floor(burst / 3);
        const env = k < burst / 4 ? Math.exp(-k / (fs * 0.03)) : 0;
        const w = rand() * 2 - 1;
        lp = 0.6 * lp + 0.4 * w;
        src[i] = (0.6 * w + 0.4 * lp) * env * 0.5;
      }
      const off = s * seg;
      for (let i = 0; i < burst; i++) {
        const v = src[i]; if (v === 0) continue;
        for (let k = 0; k < set.taps; k++) { L[off + i + k] += v * d[0][k]; R[off + i + k] += v * d[1][k]; }
      }
    });
    let peak = 1e-6;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    const g = 0.8 / peak;
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
    return [L, R];
  }

  // ─────────────────────────────── 예시 음원 ───────────────────────────────
  /** 20초 예시: 0~8초 짧은 소리가 왼쪽 끝→오른쪽 끝 16단계 이동, 8초~ 음악 + 위치가 바뀌는 박수 */
  function makeDemo(fs) {
    const sec = 20, n = fs * sec;
    const L = new Float32Array(n), R = new Float32Array(n);
    let seed = 3;
    const rnd = () => { // 가우시안 근사 (12개 균등 합)
      let s = 0; for (let i = 0; i < 12; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; s += seed / 4294967296; } return s - 6;
    };
    const add = (i, l, r) => { if (i >= 0 && i < n) { L[i] += l; R[i] += r; } };
    for (let step = 0; step < 16; step++) {
      const pan = -1 + 2 * step / 15, a = (pan + 1) * PI / 4, t0 = step * (fs / 2);
      const per = Math.floor(fs / 12), on = Math.floor(fs / 24);
      for (let k = 0; k < Math.floor(fs / 6); k++) {
        const kk = k % per;
        const env = kk < on ? Math.exp(-kk / 900) : 0;
        const v = rnd() * 0.3 * env; add(t0 + k, v * Math.cos(a), v * Math.sin(a));
      }
    }
    const chords = [[220, 277.2, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 311.1]];
    let phL = 0, phR = 0;
    const cposL = [-0.7, 0, 0.4, -0.3, 0.8, -1.0];
    for (let i = 8 * fs; i < n; i++) {
      const t = (i - 8 * fs) / fs, bar = Math.floor(t / 2) % 4;
      const vocal = Math.sin(2 * PI * chords[bar][2] * 2 * t) * 0.10 * (0.6 + 0.4 * Math.sin(2 * PI * 0.5 * t));
      const gt = t % 0.25, guitar = Math.sin(2 * PI * chords[bar][1] * t) * 0.16 * Math.exp(-gt * 10);
      const ht = t % 0.125, hat = rnd() * 0.07 * Math.exp(-ht * 80);
      phL += 2 * PI * chords[bar][0] / fs; phR += 2 * PI * chords[bar][0] * 1.003 / fs;
      const bass = Math.sin(2 * PI * chords[bar][0] / 2 * t) * 0.20;
      const tm = t % 1.0;
      const kick = tm < 0.15 ? Math.sin(2 * PI * (50 + 120 * Math.exp(-tm * 30)) * tm) * 0.35 * Math.exp(-tm * 12) : 0;
      const cpos = cposL[Math.floor(t) % 6];
      const ct = (t + 0.5) % 1.0, clap = ct < 0.08 ? rnd() * 0.25 * Math.exp(-ct * 60) : 0;
      const ca = (cpos + 1) * PI / 4;
      add(i, vocal + guitar * 0.95 + hat * 0.2 + Math.sin(phL) * 0.05 + bass + kick + clap * Math.cos(ca),
             vocal + guitar * 0.3 + hat * 0.95 + Math.sin(phR) * 0.05 + bass + kick + clap * Math.sin(ca));
    }
    return [L, R];
  }

  G.SpatialEngine = {
    Fft, loadHrir, adaptHrir, buildRoom, parseEq, EqChain, HrtfRenderer, Engine, renderEarTest, makeDemo, loadElevation, lateralAzimuth,
    EAR_FACTORS, EAR_NAMES, EAR_SEQUENCE, DEFAULTS, LATENCY, BUS_ANGLES, SIDE_ANGLE,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

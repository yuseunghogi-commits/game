// 엔진·바람 소리 (WebAudio 합성, 외부 파일 없음). 첫 입력 뒤에 시작한다.
export class FlightAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engGain!: GainNode;
  private osc1!: OscillatorNode;
  private osc2!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  muted = false;

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(ctx.destination);
    // 엔진: 톱니파 두 개 + 저역 필터
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 600;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.osc1 = ctx.createOscillator(); this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'square';
    this.osc1.connect(this.engFilter); this.osc2.connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.master);
    this.osc1.start(); this.osc2.start();
    // 바람: 잡음 + 대역 필터
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = last * 0.97 + (Math.random() * 2 - 1) * 0.03; d[i] = last * 6; }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    src.connect(this.windFilter).connect(this.windGain).connect(this.master);
    src.start();
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.05);
  }

  /** kind: 'jet' | 'prop' | 'none' */
  update(kind: 'jet' | 'prop' | 'none', throttle: number, speed: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (kind === 'none') {
      this.engGain.gain.setTargetAtTime(0, t, 0.2);
    } else if (kind === 'jet') {
      this.osc1.frequency.setTargetAtTime(70 + throttle * 90, t, 0.3);
      this.osc2.frequency.setTargetAtTime(141 + throttle * 183, t, 0.3);
      this.engFilter.frequency.setTargetAtTime(300 + throttle * 1500, t, 0.3);
      this.engGain.gain.setTargetAtTime(0.05 + throttle * 0.13, t, 0.3);
    } else {
      this.osc1.frequency.setTargetAtTime(38 + throttle * 50, t, 0.2);
      this.osc2.frequency.setTargetAtTime(76 + throttle * 100, t, 0.2);
      this.engFilter.frequency.setTargetAtTime(400 + throttle * 900, t, 0.2);
      this.engGain.gain.setTargetAtTime(0.06 + throttle * 0.12, t, 0.2);
    }
    const w = Math.min(1, speed / 120);
    this.windGain.gain.setTargetAtTime(w * 0.25, t, 0.3);
    this.windFilter.frequency.setTargetAtTime(300 + w * 1200, t, 0.3);
  }

  crash() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const len = ctx.sampleRate * 1.5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700;
    const g = ctx.createGain(); g.gain.value = 0.9;
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }
}

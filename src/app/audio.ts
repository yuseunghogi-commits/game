// 소리: 외부 파일 없이 WebAudio로 합성한다 (효과음 + 배경 앰비언트).
// 브라우저 정책상 첫 사용자 입력 뒤에 시작한다.

import type { Settings } from './settings';

export type Sfx = 'click' | 'build' | 'done' | 'warn' | 'alarm' | 'error' | 'money';

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  private ambStarted = false;
  private last = new Map<Sfx, number>();
  private vol = { master: 0.7, sfx: 0.8, ambient: 0.4 };

  /** 첫 입력에서 호출 */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.sfxBus = this.ctx.createGain();
    this.ambBus = this.ctx.createGain();
    this.sfxBus.connect(this.master);
    this.ambBus.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.apply();
    this.startAmbient();
  }

  setVolumes(s: Pick<Settings, 'master' | 'sfx' | 'ambient'>) {
    this.vol = { master: s.master, sfx: s.sfx, ambient: s.ambient };
    this.apply();
  }

  private apply() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.vol.master, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.vol.sfx * 0.5, t, 0.05);
    this.ambBus.gain.setTargetAtTime(this.vol.ambient * 0.35, t, 0.3);
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType, gain: number, endFreq?: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(this.sfxBus);
    o.start(start);
    o.stop(start + dur + 0.02);
  }

  play(kind: Sfx) {
    if (!this.ctx || this.vol.master === 0 || this.vol.sfx === 0) return;
    const now = this.ctx.currentTime;
    // 같은 소리가 짧은 시간에 몰리면 한 번만 (고배속에서 소음 방지)
    const gap = kind === 'click' ? 0.03 : kind === 'alarm' ? 2 : 0.4;
    if (now - (this.last.get(kind) ?? -10) < gap) return;
    this.last.set(kind, now);
    switch (kind) {
      case 'click': this.tone(1400, now, 0.035, 'square', 0.05); break;
      case 'build': this.tone(392, now, 0.12, 'triangle', 0.25); this.tone(587, now + 0.09, 0.18, 'triangle', 0.22); break;
      case 'done': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, now + i * 0.07, 0.35, 'sine', 0.2)); break;
      case 'money': this.tone(880, now, 0.08, 'sine', 0.15); this.tone(1320, now + 0.06, 0.12, 'sine', 0.12); break;
      case 'warn': this.tone(660, now, 0.16, 'triangle', 0.25); this.tone(495, now + 0.16, 0.24, 'triangle', 0.22); break;
      case 'error': this.tone(220, now, 0.22, 'sawtooth', 0.12, 160); break;
      case 'alarm': for (let i = 0; i < 3; i++) { this.tone(880, now + i * 0.32, 0.14, 'sawtooth', 0.14); this.tone(660, now + i * 0.32 + 0.15, 0.14, 'sawtooth', 0.14); } break;
    }
  }

  /** 배경: 낮은 드론 + 걸러낸 갈색 잡음(바람·변전 소음 느낌), 느리게 숨쉬는 음량 */
  private startAmbient() {
    if (!this.ctx || this.ambStarted) return;
    this.ambStarted = true;
    const ctx = this.ctx;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    const ng = ctx.createGain();
    ng.gain.value = 0.5;
    noise.connect(lp).connect(ng).connect(this.ambBus);
    noise.start();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.05;
    lfoGain.gain.value = 0.25;
    lfo.connect(lfoGain).connect(ng.gain);
    lfo.start();
    for (const [f, g] of [[55, 0.18], [82.6, 0.1], [110.3, 0.05]] as [number, number][]) {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      og.gain.value = g;
      o.connect(og).connect(this.ambBus);
      o.start();
    }
  }
}

export const sound = new Sound();

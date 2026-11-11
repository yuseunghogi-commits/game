// 비행 역학 (반사실적·아케이드형). 기체 축: 앞 = 지역 -z, 위 = +y, 오른쪽 = +x.
// 받음각 안정(fly-by-wire 비슷하게, 손을 떼면 현재 비행 경로를 유지)과 약한 자동 수평 복원을 넣어 조종을 쉽게 했다.
import * as THREE from 'three';
import type { World } from './world';

export interface AircraftSpec {
  id: 'airliner' | 'light';
  name: string;
  mass: number; thrust: number; vLapse: number;
  wingArea: number; cl0: number; clA: number; aStall: number;
  cd0: number; cdGear: number; k: number;
  gearH: number; vRot: number; ctrlSpeed: number;
  pitchRate: number; rollRate: number; yawRate: number; steerRate: number;
  maxSink: number; span: number; length: number;
}

export const SPECS: Record<AircraftSpec['id'], AircraftSpec> = {
  airliner: {
    id: 'airliner', name: '여객기 SD-320', mass: 62000, thrust: 240000, vLapse: 300,
    wingArea: 122, cl0: 0.25, clA: 5.5, aStall: 0.26, cd0: 0.03, cdGear: 0.018, k: 0.045,
    gearH: 3.6, vRot: 72, ctrlSpeed: 55, pitchRate: 0.32, rollRate: 0.9, yawRate: 0.15, steerRate: 0.35,
    maxSink: 6.5, span: 34, length: 38,
  },
  light: {
    id: 'light', name: '경비행기 SD-172', mass: 1100, thrust: 3600, vLapse: 75,
    wingArea: 16.2, cl0: 0.3, clA: 5.0, aStall: 0.28, cd0: 0.032, cdGear: 0.006, k: 0.05,
    gearH: 1.43, vRot: 27, ctrlSpeed: 24, pitchRate: 0.8, rollRate: 1.6, yawRate: 0.45, steerRate: 0.9,
    maxSink: 4.5, span: 11, length: 8.2,
  },
};

export interface FlightInput { pitch: number; roll: number; yaw: number; throttle: number; brake: boolean }

const G = 9.81;
const RHO = 1.225;
const _f = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3();
const _v = new THREE.Vector3(), _F = new THREE.Vector3(), _t = new THREE.Vector3();
const _q = new THREE.Quaternion(), _e = new THREE.Euler();

export class Aircraft {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  q = new THREE.Quaternion();
  omega = new THREE.Vector3(); // 기체 축 각속도: x = 기수 들기, y = 왼쪽 요, z = 왼쪽 롤
  throttle = 0;
  gearDown = true;
  onGround = true;
  crashed: string | null = null;
  alpha = 0;
  stall = false;
  groundH = 0;
  /** 마지막 착지 충격 (m/s, 표시용) */
  lastTouch = 0;

  constructor(public spec: AircraftSpec) {}

  /** 지면에 세워 놓기. heading = 도(북 0, 시계방향) */
  place(x: number, y: number, z: number, headingDeg: number, airborneSpeed = 0) {
    this.pos.set(x, y, z);
    this.q.setFromEuler(_e.set(0, (-headingDeg * Math.PI) / 180, 0, 'YXZ'));
    this.omega.set(0, 0, 0);
    this.crashed = null;
    this.throttle = airborneSpeed > 0 ? 0.6 : 0;
    this.gearDown = airborneSpeed === 0;
    this.onGround = airborneSpeed === 0;
    this.axes();
    this.vel.copy(_f).multiplyScalar(airborneSpeed);
  }

  axes() {
    _f.set(0, 0, -1).applyQuaternion(this.q);
    _u.set(0, 1, 0).applyQuaternion(this.q);
    _r.set(1, 0, 0).applyQuaternion(this.q);
  }
  get forward() { return new THREE.Vector3(0, 0, -1).applyQuaternion(this.q); }
  get up() { return new THREE.Vector3(0, 1, 0).applyQuaternion(this.q); }
  get speed() { return this.vel.length(); }
  /** 도 단위 헤딩 */
  get heading() {
    const f = this.forward;
    return (Math.atan2(f.x, -f.z) * 180 / Math.PI + 360) % 360;
  }
  euler() { return _e.setFromQuaternion(this.q, 'YXZ'); }

  step(dt: number, inp: FlightInput, world: World) {
    if (this.crashed) { this.vel.set(0, 0, 0); return; }
    const S = this.spec;
    this.throttle = THREE.MathUtils.clamp(inp.throttle, 0, 1);
    this.axes();
    const V = this.vel.length();
    const qd = 0.5 * RHO * V * V;
    const vf = this.vel.dot(_f), vu = this.vel.dot(_u), vr = this.vel.dot(_r);
    const alpha = V > 1 ? Math.atan2(-vu, Math.max(vf, 0.1)) : 0;
    const beta = V > 1 ? Math.atan2(vr, Math.max(Math.abs(vf), 0.1)) : 0;
    this.alpha = alpha;
    // 양력 계수 (실속 후 급감)
    let cl = S.cl0 + S.clA * alpha;
    const clMax = S.cl0 + S.clA * S.aStall;
    if (alpha > S.aStall) cl = Math.max(0.35, clMax - (alpha - S.aStall) * 6);
    if (alpha < -0.2) cl = Math.min(cl, S.cl0 + S.clA * -0.2);
    this.stall = !this.onGround && alpha > S.aStall * 0.92 && V > 3;

    _F.set(0, -S.mass * G, 0);
    if (V > 0.5) {
      _v.copy(this.vel).divideScalar(V);
      // 양력: 속도와 날개 오른쪽 축에 수직
      _t.crossVectors(_r, _v).normalize();
      _F.addScaledVector(_t, qd * S.wingArea * cl);
      const cd = S.cd0 + S.k * cl * cl + (this.gearDown ? S.cdGear : 0) + (this.stall ? 0.08 : 0);
      _F.addScaledVector(_v, -qd * S.wingArea * cd);
      // 옆미끄럼 저항
      _F.addScaledVector(_r, -qd * S.wingArea * 0.9 * Math.sin(beta));
    }
    const thrust = S.thrust * this.throttle * Math.max(0.25, 1 - 0.55 * (V / S.vLapse));
    _F.addScaledVector(_f, thrust);

    // ── 회전 ──
    const eff = Math.min(1, V / S.ctrlSpeed);
    const e = this.euler();
    let pitchT: number, rollT: number, yawT: number;
    if (!this.onGround) {
      // 현재 경사에서 수평 비행에 필요한 받음각 (최대 2g)
      const bank = e.z;
      const load = Math.min(2, 1 / Math.max(0.3, Math.cos(bank)));
      let aTrim = 0;
      if (qd > 1) aTrim = (S.mass * G * load / (qd * S.wingArea) - S.cl0) / S.clA;
      aTrim = THREE.MathUtils.clamp(aTrim, -0.1, S.aStall * 0.85);
      pitchT = inp.pitch * S.pitchRate * eff + 2.0 * eff * (aTrim - alpha) * (inp.pitch === 0 ? 1 : 0.6);
      rollT = -inp.roll * S.rollRate * eff;
      if (inp.roll === 0) rollT += -e.z * 0.35 * eff; // 약한 자동 수평
      yawT = -inp.yaw * S.yawRate * eff - 2.2 * beta * eff;
      // 실속 시 기수 떨어짐
      if (this.stall) pitchT -= 0.5;
      const k = Math.min(1, dt * 4);
      this.omega.x += (pitchT - this.omega.x) * k;
      this.omega.y += (yawT - this.omega.y) * k;
      this.omega.z += (rollT - this.omega.z) * k;
      _q.setFromEuler(_e.set(this.omega.x * dt, this.omega.y * dt, this.omega.z * dt, 'XYZ'));
      this.q.multiply(_q).normalize();
    } else {
      // 지상: 롤 0, 기수 들기는 회전 속도 근처에서만, 앞바퀴로 방향 전환
      let pitch = e.x, heading = e.y;
      const canRotate = V > S.vRot * 0.85;
      const settle = -Math.sign(pitch) * Math.min(Math.abs(pitch), 0.15 * dt) / dt; // 앞바퀴 내려놓기
      const pr = canRotate && inp.pitch !== 0 ? inp.pitch * S.pitchRate * 0.8 : settle;
      pitch = THREE.MathUtils.clamp(pitch + pr * dt, 0, 0.21);
      const steer = S.steerRate * Math.min(1, V / 6) / (1 + V / 40);
      heading += -inp.yaw * steer * dt;
      this.q.setFromEuler(_e.set(pitch, heading, 0, 'YXZ'));
      this.omega.set(pr, 0, 0);
      // 바퀴 마찰: 옆 미끄러짐 제거, 구름 저항, 브레이크
      const fh = _t.set(_f.x, 0, _f.z).normalize();
      const along = this.vel.x * fh.x + this.vel.z * fh.z;
      const side = this.vel.clone().setY(0).addScaledVector(fh, -along);
      this.vel.addScaledVector(side, -Math.min(1, dt * 10));
      const mu = (inp.brake ? 0.45 : 0.02);
      const decel = mu * G * dt;
      const sgn = Math.sign(along);
      if (Math.abs(along) <= decel) this.vel.addScaledVector(fh, -along);
      else this.vel.addScaledVector(fh, -sgn * decel);
    }

    // ── 적분 ──
    this.vel.addScaledVector(_F, dt / S.mass);
    this.pos.addScaledVector(this.vel, dt);

    // ── 지면 ──
    const g = world.ground(this.pos.x, this.pos.z, this.pos.y - S.gearH, 2.5);
    this.groundH = g.h;
    const bottom = this.pos.y - S.gearH;
    if (bottom <= g.h) {
      const sink = -this.vel.y;
      const e2 = this.euler();
      if (!this.onGround) this.lastTouch = sink;
      if (g.water) return this.crash(g.sea ? '바다에 추락했습니다' : '물에 빠졌습니다');
      if (!this.gearDown && !this.onGround) return this.crash('착륙장치를 내리지 않고 동체 착륙했습니다');
      if (!this.onGround && sink > S.maxSink) return this.crash(`너무 세게 내렸습니다 (강하율 ${sink.toFixed(1)} m/s)`);
      if (Math.abs(e2.z) > 0.3) return this.crash('날개가 땅에 닿았습니다');
      if (e2.x < -0.12) return this.crash('기수부터 땅에 부딪혔습니다');
      if (bottom < g.h - 3) return this.crash('지면에 충돌했습니다');
      this.pos.y = g.h + S.gearH;
      if (this.vel.y < 0) this.vel.y = 0;
      if (!this.onGround) {
        // 착지: 자세 정리
        this.onGround = true;
        this.omega.set(0, 0, 0);
      }
    } else if (this.onGround && bottom > g.h + 0.3) {
      this.onGround = false;
    }
    if (this.onGround && !this.gearDown) this.gearDown = true;

    // ── 건물·구조물 충돌 (기수, 꼬리, 양 날개 끝) ──
    this.axes();
    const L = S.length / 2, W = S.span / 2;
    const probes: [number, number][] = [[L, 0], [-L * 0.6, 0], [0, W], [0, -W]];
    for (const [a, b] of probes) {
      const px = this.pos.x + _f.x * a + _r.x * b;
      const py = this.pos.y + _f.y * a + _r.y * b;
      const pz = this.pos.z + _f.z * a + _r.z * b;
      const hit = world.hitAt(px, py, pz);
      if (hit && !(this.onGround && py - hit.top > -1.5)) return this.crash('건물에 충돌했습니다');
      // 다리 상판 아래에서 부딪힘
      const deck = world.deckAt(px, pz);
      if (deck > -Infinity && py < deck - 0.5 && py > deck - 7) return this.crash('다리에 충돌했습니다');
      if (!this.onGround && py < world.terrain(px, pz) - 1.5) return this.crash('지형에 충돌했습니다');
    }
  }

  crash(reason: string) {
    this.crashed = reason;
    this.vel.set(0, 0, 0);
    this.throttle = 0;
  }
}

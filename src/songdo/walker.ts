// 걷는 사람: 이동·점프·수영·낙하산, 건물 벽 충돌, 지붕·다리 위 서기.
import * as THREE from 'three';
import type { World } from './world';

export interface WalkInput { fwd: number; side: number; run: boolean; jump: boolean; camYaw: number }

export const WALK_SPEED = 2.2;
export const RUN_SPEED = 7.5;
const GRAV = 9.81;

export class Walker {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  facing = 0; // 몸이 향한 방향 (Y 회전)
  onGround = false;
  swimming = false;
  wading = false;
  chute = false;
  phase = 0;
  speed = 0;
  private jumpHeld = false;

  place(x: number, z: number, world: World, y?: number) {
    const g = world.ground(x, z, y ?? 1e5, 0.6);
    this.pos.set(x, y ?? g.h, z);
    this.vel.set(0, 0, 0);
    this.chute = false;
    this.onGround = y === undefined;
  }

  step(dt: number, inp: WalkInput, world: World) {
    // 원하는 수평 속도 (카메라 기준)
    const sy = Math.sin(inp.camYaw), cy = Math.cos(inp.camYaw);
    // 카메라가 보는 앞 = (-sin, -cos)
    let mx = -sy * inp.fwd + cy * inp.side;
    let mz = -cy * inp.fwd - sy * inp.side;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    let top = inp.run ? RUN_SPEED : WALK_SPEED;
    if (this.swimming) top = inp.run ? 2.2 : 1.2;
    else if (this.wading) top *= 0.5;
    if (this.chute && !this.onGround) top = 5;
    const air = !this.onGround && !this.swimming;
    const acc = air && !this.chute ? 2 : 12;
    const k = Math.min(1, acc * dt);
    this.vel.x += (mx * top - this.vel.x) * k;
    this.vel.z += (mz * top - this.vel.z) * k;
    if (ml > 0.05) {
      const target = Math.atan2(-mx, -mz);
      let d = target - this.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.facing += d * Math.min(1, dt * 10);
    }

    // 수직
    if (inp.jump && !this.jumpHeld) {
      if (this.onGround && !this.swimming) { this.vel.y = 5.2; this.onGround = false; }
      else if (!this.onGround && !this.chute) {
        const g = world.ground(this.pos.x, this.pos.z, this.pos.y, 0.6);
        if (this.pos.y - g.h > 12) this.chute = true;
      }
    }
    this.jumpHeld = inp.jump;
    if (!this.swimming) this.vel.y -= GRAV * dt;
    if (this.chute) this.vel.y = Math.max(this.vel.y, -5.2);
    this.vel.y = Math.max(this.vel.y, -55);

    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    const p = { x: nx, z: nz };
    world.pushOut(p, this.pos.y, 0.35, 1.75, 0.6);
    this.pos.x = p.x; this.pos.z = p.z;
    this.pos.y += this.vel.y * dt;

    const g = world.ground(this.pos.x, this.pos.z, this.pos.y + 0.05, 0.6);
    this.swimming = false;
    this.wading = false;
    if (g.sea && world.terrain(this.pos.x, this.pos.z) < -0.6) {
      // 바다: 수영
      if (this.pos.y <= -1.15) {
        this.pos.y = -1.15;
        this.vel.y = 0;
        this.swimming = true;
        this.chute = false;
        this.onGround = false;
      }
    } else if (this.pos.y <= g.h) {
      this.pos.y = g.h;
      if (this.vel.y < 0) this.vel.y = 0;
      this.onGround = true;
      this.chute = false;
      if (g.water) { this.wading = true; this.pos.y = g.h - 0.5; }
    } else if (this.pos.y > g.h + 0.25) {
      this.onGround = false;
    } else if (this.onGround) {
      this.pos.y = g.h; // 내리막 따라붙기
    }

    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.phase += dt * this.speed * (this.speed > 4 ? 1.45 : 2.6);
  }

  /** 팔다리 애니메이션 */
  animate(model: { root: THREE.Object3D; legL: THREE.Object3D; legR: THREE.Object3D; armL: THREE.Object3D; armR: THREE.Object3D; chute: THREE.Object3D }) {
    model.root.position.copy(this.pos);
    model.root.rotation.set(0, this.facing, 0);
    const s = Math.min(1, this.speed / 2) * (this.speed > 4 ? 0.95 : 0.55);
    let sw = Math.sin(this.phase) * s;
    if (this.swimming) sw = Math.sin(this.phase * 0.6) * 1.2;
    model.legL.rotation.x = sw;
    model.legR.rotation.x = -sw;
    model.armL.rotation.x = this.chute ? -2.6 : -sw * 0.9;
    model.armR.rotation.x = this.chute ? -2.6 : sw * 0.9;
    if (!this.onGround && !this.swimming && !this.chute) { model.legL.rotation.x = 0.4; model.legR.rotation.x = -0.2; }
    model.chute.visible = this.chute;
    model.root.rotation.x = this.swimming ? -1.2 : 0;
    if (this.swimming) model.root.position.y = -0.35;
  }
}

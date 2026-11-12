// 하늘·빛·안개·시간대 (낮 / 노을 / 밤).
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { nightU } from './materials';

export type TimeOfDay = 'day' | 'sunset' | 'night';
export const TIME_LABEL: Record<TimeOfDay, string> = { day: '낮', sunset: '노을', night: '밤' };

interface Preset { elev: number; azim: number; sun: number; sunColor: number; hemi: number; sky: number; ground: number; fog: number; fogDensity: number; exposure: number; night: number; turbidity: number; rayleigh: number }
const PRESETS: Record<TimeOfDay, Preset> = {
  day: { elev: 38, azim: 160, sun: 3.0, sunColor: 0xfff4e5, hemi: 0.9, sky: 0xbfd8ff, ground: 0x5a6650, fog: 0xb4c8dc, fogDensity: 0.000034, exposure: 0.62, night: 0, turbidity: 4, rayleigh: 1.2 },
  sunset: { elev: 3.5, azim: 255, sun: 2.2, sunColor: 0xffa060, hemi: 0.45, sky: 0xffb48a, ground: 0x4a4038, fog: 0xd9a483, fogDensity: 0.00004, exposure: 0.55, night: 0.55, turbidity: 8, rayleigh: 2.5 },
  night: { elev: -12, azim: 220, sun: 0.55, sunColor: 0x8fa8ff, hemi: 0.45, sky: 0x2a3d66, ground: 0x1c2230, fog: 0x0b1320, fogDensity: 0.00004, exposure: 0.85, night: 1, turbidity: 2, rayleigh: 0.5 },
};

export class Env {
  readonly sky = new Sky();
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xbfd8ff, 0x5a6650, 0.9);
  readonly stars: THREE.Points;
  time: TimeOfDay = 'day';
  private skyScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private sunDir = new THREE.Vector3();
  /** 여러 단계 그림자 (도시 전체에 건물 그림자) */
  csm: CSM | null = null;
  private csmDone = new WeakSet<THREE.Material>();

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer) {
    this.sky.scale.setScalar(400000);
    scene.add(this.sky);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -350; sc.right = 350; sc.top = 350; sc.bottom = -350; sc.near = 10; sc.far = 4000;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = new THREE.FogExp2(0xb4c8dc, 0.000034);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    // 별
    const n = 2500, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos[i * 3] = r * Math.cos(a) * 30000; pos[i * 3 + 1] = Math.abs(u) * 30000 + 800; pos[i * 3 + 2] = r * Math.sin(a) * 30000;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.9, depthWrite: false }));
    this.stars.frustumCulled = false;
    scene.add(this.stars);
  }

  set(t: TimeOfDay) {
    this.time = t;
    const p = PRESETS[t];
    const u = this.sky.material.uniforms;
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.8;
    const phi = THREE.MathUtils.degToRad(90 - p.elev), theta = THREE.MathUtils.degToRad(p.azim);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);
    this.sun.color.setHex(p.sunColor);
    this.sun.intensity = this.csm ? 0 : p.sun;
    if (this.csm) for (const l of this.csm.lights) { l.color.setHex(p.sunColor); l.intensity = p.sun; }
    this.hemi.color.setHex(p.sky);
    this.hemi.groundColor.setHex(p.ground);
    this.hemi.intensity = p.hemi;
    (this.scene.fog as THREE.FogExp2).color.setHex(p.fog);
    (this.scene.fog as THREE.FogExp2).density = p.fogDensity;
    this.renderer.toneMappingExposure = p.exposure;
    nightU.value = p.night;
    this.stars.visible = t === 'night';
    // 밤에는 달빛 방향
    if (t === 'night') this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(50), THREE.MathUtils.degToRad(200));
    // 환경 반사
    this.skyScene.add(this.sky);
    const rt = this.pmrem.fromScene(this.skyScene, 0, 0.1, 1000);
    this.scene.add(this.sky);
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = t === 'night' ? 0.45 : t === 'sunset' ? 0.7 : 1.0;
  }

  /** 여러 단계 그림자 켜기: 카메라 앞 5km까지 3단계 */
  enableCSM(camera: THREE.PerspectiveCamera) {
    if (this.csm) return;
    this.csm = new CSM({
      camera, parent: this.scene, cascades: 3, maxFar: 5000, mode: 'practical', shadowMapSize: 2048,
      lightDirection: this.sunDir.clone().negate(), lightIntensity: this.sun.intensity, lightNear: 1, lightFar: 8000, lightMargin: 600, shadowBias: -0.00015,
    });
    for (const l of this.csm.lights) l.shadow.normalBias = 0.8;
    this.sun.castShadow = false;
    this.sun.intensity = 0;
    this.set(this.time);
  }
  /** 장면의 모든 재질에 그림자 단계 설정 (기존 셰이더 수정은 유지) */
  setupMaterials(root: THREE.Object3D) {
    const csm = this.csm;
    if (!csm) return;
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mat of Array.isArray(m) ? m : [m]) {
        if (this.csmDone.has(mat) || !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
        this.csmDone.add(mat);
        const prev = mat.onBeforeCompile;
        csm.setupMaterial(mat);
        const mine = mat.onBeforeCompile;
        mat.onBeforeCompile = (sh, r) => { prev.call(mat, sh, r); mine.call(mat, sh, r); };
        mat.needsUpdate = true;
      }
    });
  }

  /** 그림자 영역을 카메라 주변으로 옮긴다 */
  follow(center: THREE.Vector3) {
    const d = this.sunDir.y < 0.05 ? new THREE.Vector3(this.sunDir.x, 0.05, this.sunDir.z).normalize() : this.sunDir;
    if (this.csm) {
      this.csm.lightDirection.copy(d).negate();
      this.csm.update();
    }
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(d, 1800);
    this.stars.position.set(center.x, 0, center.z);
  }
}

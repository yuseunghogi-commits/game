// 3D 행성 화면. 시뮬레이션 상태를 읽기만 하고, 상태를 바꾸지 않는다 (Baseline §30.4).

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { GameState } from '../sim/sim';
import { latLonToVec } from '../world/terrain';
import { STEPS_PER_DAY } from '../sim/units';

const TYPE_COLOR: Record<string, number> = { thermal: 0xf2b248, solar: 0x4fd1e0, wind: 0xdfe6ee };

export interface Globe {
  update(s: GameState, selected: number | null): void;
  focus(lat: number, lon: number): void;
  labels: HTMLElement;
}

function vec(lat: number, lon: number, r = 1): THREE.Vector3 {
  const [x, y, z] = latLonToVec(lat, lon);
  return new THREE.Vector3(x * r, y * r, z * r);
}

export async function createGlobe(
  host: HTMLElement,
  s: GameState,
  onProgress: (p: number) => void,
  onPick: (regionId: number) => void,
): Promise<Globe> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, host.clientWidth / host.clientHeight, 0.1, 100);
  camera.position.set(0, 1.0, 4.4);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 2.3;
  controls.maxDistance = 6;
  controls.rotateSpeed = 0.5;

  // ---- 텍스처 생성 (워커) ----
  const W = 2048, H = 1024;
  const tex = await new Promise<{ day: Uint8ClampedArray; night: Uint8ClampedArray }>((resolve) => {
    const worker = new Worker(new URL('./planetTexture.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.progress !== undefined) onProgress(e.data.progress);
      if (e.data.done) { resolve(e.data); worker.terminate(); }
    };
    worker.postMessage({ seed: s.seed, width: W, height: H, cities: s.regions.map((r) => ({ lat: r.lat, lon: r.lon })) });
  });
  const mk = (data: Uint8ClampedArray, srgb: boolean) => {
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  };
  const dayTex = mk(tex.day, true);
  const nightTex = mk(tex.night, true);

  const sunDir = new THREE.Vector3(1, 0, 0);
  const planetMat = new THREE.ShaderMaterial({
    uniforms: { dayMap: { value: dayTex }, nightMap: { value: nightTex }, sunDir: { value: sunDir }, mode: { value: Number(new URLSearchParams(location.search).get('view') ?? 0) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D dayMap; uniform sampler2D nightMap; uniform vec3 sunDir; uniform float mode;
      varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      void main(){
        float l = dot(normalize(vN), normalize(sunDir));
        float lit = smoothstep(-0.12, 0.25, l);
        vec3 day = texture2D(dayMap, vUv).rgb;
        vec3 night = texture2D(nightMap, vUv).rgb;
        vec3 col = day * (0.05 + 1.05 * lit) + night * (1.0 - smoothstep(-0.25, 0.05, l)) * 1.4;
        vec3 V = normalize(cameraPosition - vW);
        float rim = pow(1.0 - max(dot(normalize(vN), V), 0.0), 3.0);
        col += vec3(0.25, 0.55, 0.9) * rim * (0.15 + 0.6 * lit);
        if (mode > 0.5 && mode < 1.5) col = day;
        if (mode > 1.5 && mode < 2.5) col = night;
        if (mode > 2.5) col = vec3(lit);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  // 경도 0이 +Z가 되도록 SphereGeometry UV를 맞춘다 (u=0.5 ↔ lon 0).
  const planet = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), planetMat);
  planet.rotation.y = -Math.PI / 2;
  scene.add(planet);

  // 대기 바깥 빛
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(1.06, 64, 48),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(mat3(modelMatrix)*normal); vec4 w = modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vW; void main(){ vec3 V = normalize(cameraPosition - vW); float i = pow(0.72 - dot(vN, V), 3.0); gl_FragColor = vec4(0.3,0.6,1.0,1.0) * clamp(i,0.0,1.0) * 1.4; }`,
    }),
  );
  scene.add(atmo);

  // 구름
  const cloudTex = await new THREE.TextureLoader().loadAsync('./assets/clouds.png');
  cloudTex.colorSpace = THREE.SRGBColorSpace;
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(1.012, 96, 72),
    new THREE.MeshLambertMaterial({ map: cloudTex, transparent: true, opacity: 0.55, depthWrite: false }),
  );
  clouds.rotation.y = -Math.PI / 2;
  scene.add(clouds);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x1a2230, 0.6));

  // ---- 지역 표식 ----
  const markerGroup = new THREE.Group();
  scene.add(markerGroup);
  const ringGeo = new THREE.RingGeometry(0.018, 0.026, 32);
  const markers = s.regions.map((r) => {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x4fd1e0, side: THREE.DoubleSide, transparent: true }));
    const p = vec(r.lat, r.lon, 1.004);
    m.position.copy(p);
    m.lookAt(p.clone().multiplyScalar(2));
    markerGroup.add(m);
    return m;
  });

  const labels = document.createElement('div');
  labels.className = 'globe-labels';
  host.appendChild(labels);
  const labelEls = s.regions.map((r) => {
    const el = document.createElement('button');
    el.className = 'region-label';
    el.textContent = r.name;
    el.addEventListener('click', () => onPick(r.id));
    labels.appendChild(el);
    return el;
  });

  // 시설 표식 (지역 중심 주변 작은 기둥)
  const facGroup = new THREE.Group();
  scene.add(facGroup);
  const facGeo = new THREE.CylinderGeometry(0.009, 0.012, 0.05, 10);
  facGeo.translate(0, 0.025, 0);
  facGroup.renderOrder = 2;
  const facMeshes = new Map<number, THREE.Mesh>();

  function placeFacility(id: number, regionLat: number, regionLon: number, idx: number) {
    const ang = idx * 2.399963 + 0.6;
    const rad = 2.2 + Math.sqrt(idx) * 1.1;
    const lat = regionLat + Math.sin(ang) * rad;
    const lon = regionLon + (Math.cos(ang) * rad) / Math.max(0.3, Math.cos((regionLat * Math.PI) / 180));
    const p = vec(lat, lon, 1.002);
    const m = new THREE.Mesh(facGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
    m.renderOrder = 2;
    m.position.copy(p);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.clone().normalize());
    facGroup.add(m);
    facMeshes.set(id, m);
    return m;
  }

  // 클릭으로 지역 선택 (표식 근처)
  const ray = new THREE.Raycaster();
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if ((ev as PointerEvent).button !== 0) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(planet)[0];
    if (!hit) return;
    let best = -1, bestD = 0.12;
    s.regions.forEach((r) => {
      const d = hit.point.distanceTo(vec(r.lat, r.lon));
      if (d < bestD) { bestD = d; best = r.id; }
    });
    if (best >= 0) onPick(best);
  });

  const onResize = () => {
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
  };
  window.addEventListener('resize', onResize);

  let focusTarget: THREE.Vector3 | null = null;
  let state = s;
  let selectedId: number | null = null;
  const tmp = new THREE.Vector3();

  function render(time: number) {
    // 태양 방향: 게임 시각 12:00에 경도 0이 정오
    const m = (state.step % STEPS_PER_DAY) / STEPS_PER_DAY;
    const sunLon = 180 - m * 360;
    sunDir.copy(vec(8, sunLon)).normalize();
    sun.position.copy(sunDir).multiplyScalar(5);
    clouds.rotation.y = -Math.PI / 2 + time * 0.000004;

    if (focusTarget) {
      const dist = camera.position.length();
      camera.position.lerp(focusTarget.clone().multiplyScalar(dist), 0.08);
      camera.position.setLength(dist);
      if (camera.position.distanceTo(focusTarget.clone().multiplyScalar(dist)) < 0.01) focusTarget = null;
    }
    controls.update();

    // 라벨 위치 (뒷면이면 숨김)
    const camDir = camera.position.clone().normalize();
    state.regions.forEach((r, i) => {
      const p = vec(r.lat, r.lon, 1.01);
      const facing = p.clone().normalize().dot(camDir);
      tmp.copy(p).project(camera);
      const el = labelEls[i];
      const x = (tmp.x * 0.5 + 0.5) * host.clientWidth;
      const y = (-tmp.y * 0.5 + 0.5) * host.clientHeight;
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.opacity = facing > 0.15 ? '1' : '0';
      el.style.pointerEvents = facing > 0.15 ? 'auto' : 'none';
      el.classList.toggle('selected', selectedId === r.id);
      const mk = markers[i];
      (mk.material as THREE.MeshBasicMaterial).color.setHex(selectedId === r.id ? 0xf2b248 : 0x4fd1e0);
      const pulse = 1 + 0.25 * Math.sin(time / 300 + i);
      mk.scale.setScalar(selectedId === r.id ? 1.6 * pulse : 1);
    });

    // 시설
    const perRegion = new Map<number, number>();
    for (const f of state.facilities) {
      const idx = perRegion.get(f.regionId) ?? 0;
      perRegion.set(f.regionId, idx + 1);
      const r = state.regions[f.regionId];
      const mesh = facMeshes.get(f.id) ?? placeFacility(f.id, r.lat, r.lon, idx);
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.color.setHex(TYPE_COLOR[f.type]);
      const building = f.status === 'construction';
      mat.opacity = building ? 0.35 + 0.25 * Math.sin(time / 250) : f.online ? 1 : 0.4;
      const sz = f.size === 'large' ? 1.6 : f.size === 'medium' ? 1.2 : 0.9;
      mesh.scale.set(sz, building ? sz * 0.5 : sz * (0.6 + (f.outputKw / f.capKw) * 0.6), sz);
    }
    for (const [id, mesh] of facMeshes) {
      if (!state.facilities.some((f) => f.id === id)) { facGroup.remove(mesh); facMeshes.delete(id); }
    }

    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  return {
    labels,
    update(next, selected) { state = next; selectedId = selected; },
    focus(lat, lon) { focusTarget = vec(lat, lon).normalize(); },
  };
}

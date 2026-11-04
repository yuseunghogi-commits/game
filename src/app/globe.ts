// 3D 행성 화면. 시뮬레이션 상태를 읽기만 하고, 상태를 바꾸지 않는다 (Baseline §30.4).

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { GameState } from '../sim/sim';
import { latLonToVec } from '../world/terrain';
import { envIndex } from '../sim/environment';
import { STEPS_PER_DAY } from '../sim/units';
import { QUALITY, type Quality } from './settings';
import { buildFacilityModel, setModelState, spinRotors } from './models';

export type Overlay = 'none' | 'price' | 'env' | 'mine';

export interface Globe {
  update(s: GameState, selected: number | null, overlay?: Overlay, selectedFacility?: number | null): void;
  dispose(): void;
  focus(lat: number, lon: number): void;
  /** 타이틀(새 게임) 화면: 천천히 자동 회전 */
  setIdle(on: boolean): void;
  /** 위도·경도 → 화면 좌표 (보이지 않으면 null). 떠오르는 수익 숫자용 */
  project(lat: number, lon: number): { x: number; y: number } | null;
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
  opts: { quality?: Quality; onPickFacility?: (facilityId: number) => void } = {},
): Promise<Globe> {
  const Q = QUALITY[opts.quality ?? 'high'];
  const renderer = new THREE.WebGLRenderer({ antialias: Q.antialias, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, Q.pixelRatio));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, host.clientWidth / host.clientHeight, 0.1, 100);
  camera.position.set(0, 0.7, 3.1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 1.14;
  controls.maxDistance = 5;
  controls.rotateSpeed = 0.45;
  controls.zoomSpeed = 0.8;

  // ---- 텍스처 생성 (워커) ----
  const W = Q.tex, H = Q.tex / 2;
  const tex = await new Promise<{ day: Uint8ClampedArray; night: Uint8ClampedArray; relief: Uint8ClampedArray; ids: Uint8ClampedArray }>((resolve) => {
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
  const reliefTex = mk(tex.relief, false);
  // 지역 번호 지도: 보간하면 번호가 섞이므로 최근접 샘플링, 밉맵 없음
  const idTex = new THREE.DataTexture(tex.ids, W, H, THREE.RGBAFormat);
  idTex.colorSpace = THREE.NoColorSpace;
  idTex.wrapS = THREE.RepeatWrapping;
  idTex.minFilter = THREE.NearestFilter;
  idTex.magFilter = THREE.NearestFilter;
  idTex.generateMipmaps = false;
  idTex.needsUpdate = true;

  const MAX_REGIONS = 96;
  const regionTint = Array.from({ length: MAX_REGIONS }, () => new THREE.Vector4(0, 0, 0, 0));
  const sunDir = new THREE.Vector3(1, 0, 0);
  const planetMat = new THREE.ShaderMaterial({
    uniforms: {
      dayMap: { value: dayTex }, nightMap: { value: nightTex }, reliefMap: { value: reliefTex }, idMap: { value: idTex },
      texel: { value: new THREE.Vector2(1 / W, 1 / H) }, sunDir: { value: sunDir }, regionTint: { value: regionTint },
      selected: { value: -1 }, camDist: { value: 3 }, time: { value: 0 },
      mode: { value: Number(new URLSearchParams(location.search).get('view') ?? 0) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vN; varying vec3 vW; varying vec3 vP;
      void main(){ vUv = uv; vP = position; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D dayMap; uniform sampler2D nightMap; uniform sampler2D reliefMap; uniform sampler2D idMap;
      uniform vec2 texel; uniform vec3 sunDir; uniform float mode; uniform vec4 regionTint[${MAX_REGIONS}];
      uniform float selected; uniform float camDist; uniform float time;
      varying vec2 vUv; varying vec3 vN; varying vec3 vW; varying vec3 vP;

      float h3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float vnoise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(h3(i), h3(i+vec3(1,0,0)), f.x), mix(h3(i+vec3(0,1,0)), h3(i+vec3(1,1,0)), f.x), f.y),
                   mix(mix(h3(i+vec3(0,0,1)), h3(i+vec3(1,0,1)), f.x), mix(h3(i+vec3(0,1,1)), h3(i+vec3(1,1,1)), f.x), f.y), f.z); }
      float fbm(vec3 p){ float s = 0.0, a = 0.5; for (int k = 0; k < 4; k++) { s += a * vnoise(p); p *= 2.07; a *= 0.5; } return s; }
      int rid(vec2 uv){ return int(texture2D(idMap, uv).r * 255.0 + 0.5); }

      void main(){
        vec3 n0 = normalize(vN);
        vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), n0) + vec3(1e-5, 0.0, 0.0));
        vec3 north = cross(n0, east);
        vec4 rel = texture2D(reliefMap, vUv);
        float water = rel.b;
        // 가까이 볼수록 세부 기복을 더한다 (텍스처 해상도 한계를 가림)
        float near = 1.0 - smoothstep(1.25, 2.6, camDist);
        vec3 dp = vP * 90.0;
        float d1 = fbm(dp), d2 = fbm(dp + vec3(0.37, 0.0, 0.0)), d3 = fbm(dp + vec3(0.0, 0.37, 0.0));
        vec2 grad = (rel.rg - 0.5) * 2.2 + vec2(d2 - d1, d3 - d1) * (1.0 - water) * (0.8 + 2.2 * near);
        vec3 n = normalize(n0 - east * grad.x - north * grad.y);
        vec3 L = normalize(sunDir);
        float l0 = dot(n0, L);
        float lit = smoothstep(-0.12, 0.25, l0);
        float shade = clamp(dot(n, L) - l0 + 1.0, 0.55, 1.45);
        vec3 day = texture2D(dayMap, vUv).rgb;
        day *= mix(1.0, 0.86 + 0.28 * fbm(vP * 260.0), near * (1.0 - water)); // 땅의 잔무늬
        vec3 night = texture2D(nightMap, vUv).rgb;
        vec3 V = normalize(cameraPosition - vW);
        vec3 col = day * (0.04 + 1.08 * lit) * mix(1.0, shade, 1.0 - water * 0.85);
        // 바다: 햇빛 반사(물결 노이즈) + 비스듬한 각도의 하늘빛
        vec3 wn = normalize(n0 + (vec3(fbm(vP * 140.0 + time * 0.00004), fbm(vP * 140.0 + 7.3), 0.0) - 0.5) * 0.08);
        float spec = pow(max(dot(reflect(-L, wn), V), 0.0), 180.0);
        float fres = pow(1.0 - max(dot(n0, V), 0.0), 4.0);
        col += water * (vec3(1.0, 0.93, 0.8) * spec * 0.7 * lit + vec3(0.16, 0.32, 0.5) * fres * 0.6 * lit);
        // 해 질 녘 띠 (명암 경계)
        col += vec3(0.55, 0.25, 0.08) * exp(-pow(l0 * 7.0, 2.0)) * 0.22;
        col += night * (1.0 - smoothstep(-0.25, 0.05, l0)) * 1.45;
        // 지역: 색칠(지도 표시)과 경계선. 육지 위에만, 가까울수록 선명하게
        int id = rid(vUv);
        float land = texture2D(idMap, vUv).g;
        vec4 tint = regionTint[id];
        col = mix(col, tint.rgb * (0.35 + 0.75 * max(lit, 0.35)), tint.a * land);
        float edge = 0.0;
        for (int k = 0; k < 4; k++) {
          vec2 o = k == 0 ? vec2(texel.x, 0.0) : k == 1 ? vec2(-texel.x, 0.0) : k == 2 ? vec2(0.0, texel.y) : vec2(0.0, -texel.y);
          if (rid(vUv + o) != id) edge = 1.0;
        }
        float isSel = float(float(id) == selected);
        col = mix(col, vec3(0.95, 0.7, 0.28), isSel * land * 0.10);
        col = mix(col, isSel > 0.5 ? vec3(1.0, 0.72, 0.3) : vec3(0.85, 0.95, 1.0), edge * land * (0.14 + 0.08 * near + 0.45 * isSel));
        float rim = pow(1.0 - max(dot(n0, V), 0.0), 3.0);
        col += vec3(0.25, 0.55, 0.9) * rim * (0.12 + 0.55 * lit);
        if (mode > 0.5 && mode < 1.5) col = day;
        if (mode > 1.5 && mode < 2.5) col = night;
        if (mode > 2.5) col = vec3(lit * shade);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  // 경도 0이 +Z가 되도록 SphereGeometry UV를 맞춘다 (u=0.5 ↔ lon 0).
  const planet = new THREE.Mesh(new THREE.SphereGeometry(1, Q.segments, Math.round(Q.segments * 0.75)), planetMat);
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
  clouds.visible = Q.clouds;
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

  // 시설 모형 (지역 중심 주변에 배치, 유형별 저폴리 모형)
  const facGroup = new THREE.Group();
  scene.add(facGroup);
  const facMeshes = new Map<number, { g: THREE.Group; type: string; size: string; modules: number }>();
  const regionPx = Math.min(1, Math.sqrt(12 / s.regions.length)); // 지역이 많으면 배치 반경을 줄인다

  function placeFacility(f: GameState['facilities'][number], regionLat: number, regionLon: number, idx: number) {
    const ang = idx * 2.399963 + 0.6;
    const rad = (3.6 + Math.sqrt(idx) * 2.4) * regionPx;
    const lat = regionLat + Math.sin(ang) * rad;
    const lon = regionLon + (Math.cos(ang) * rad) / Math.max(0.3, Math.cos((regionLat * Math.PI) / 180));
    const p = vec(lat, lon, 1.001);
    const g = buildFacilityModel(f.type, f.size, f.modules);
    g.position.copy(p);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.clone().normalize());
    g.rotateY(((f.id * 137) % 360) * (Math.PI / 180));
    g.userData.facId = f.id;
    g.scale.multiplyScalar(regionPx < 1 ? 0.6 + 0.4 * regionPx : 1);
    g.userData.baseScale = g.scale.x;
    facGroup.add(g);
    const rec = { g, type: f.type, size: f.size, modules: f.modules };
    facMeshes.set(f.id, rec);
    return rec;
  }

  // 클릭: 시설 모형 → 시설 상세, 그 외 → 가까운 지역 선택
  const ray = new THREE.Raycaster();
  let downAt = { x: 0, y: 0 };
  renderer.domElement.addEventListener('pointerdown', (ev) => { downAt = { x: ev.clientX, y: ev.clientY }; });
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if ((ev as PointerEvent).button !== 0) return;
    if (Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 6) return; // 끌기(회전)는 클릭이 아님
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(planet)[0];
    const fh = ray.intersectObject(facGroup, true)[0];
    if (fh && (!hit || fh.distance <= hit.distance + 0.01) && opts.onPickFacility) {
      let o: THREE.Object3D | null = fh.object;
      while (o && o.userData.facId === undefined) o = o.parent;
      if (o) { opts.onPickFacility(o.userData.facId as number); return; }
    }
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
  let focusDist = 2.6;
  /** 지도 표시 값 (0..1, 지역별). 표시 없음이면 null */
  function overlayValues(): number[] | null {
    if (overlay === 'none') return null;
    if (overlay === 'price') { const ps = state.regionState.map((x) => x.priceMinor); const lo = Math.min(...ps), hi = Math.max(...ps); return ps.map((p) => (p - lo) / Math.max(1, hi - lo)); }
    if (overlay === 'env') return state.regions.map((_, i) => Math.min(1, envOf(i)));
    const caps = new Array(state.regions.length).fill(0);
    for (const f of state.facilities) if (f.status === 'operating') caps[f.regionId] += f.capKw;
    const hi = Math.max(1, ...caps);
    return caps.map((c) => c / hi);
  }
  const C_LO = new THREE.Color(0x2f7fd0), C_MID = new THREE.Color(0xf2b248), C_HI = new THREE.Color(0xe5604d), C_GREEN = new THREE.Color(0x6ccb8b), C_OK = new THREE.Color(0x4fb37a);
  const rampTmp = new THREE.Color();
  function rampColor(ov: Overlay, v: number): THREE.Color {
    if (ov === 'mine') return rampTmp.copy(C_GREEN);
    const lo = ov === 'env' ? C_OK : C_LO;
    return v < 0.5 ? rampTmp.copy(lo).lerp(C_MID, v * 2) : rampTmp.copy(C_MID).lerp(C_HI, (v - 0.5) * 2);
  }
  let stopped = false;
  let state = s;
  let selectedId: number | null = null;
  let overlay: Overlay = 'none';
  let selectedFac: number | null = null;
  let lastTime = 0;
  const envOf = (i: number) => envIndex(state, i);
  const tmp = new THREE.Vector3();

  // 송전선: 대원 호 위의 튜브. 흐름 방향으로 움직이는 빛, 색 = 상태·이용률
  const lineGroup = new THREE.Group();
  scene.add(lineGroup);
  const lineMeshes = new Map<number, { mesh: THREE.Mesh; mat: THREE.ShaderMaterial }>();
  function arcPoints(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
    const va = vec(a.lat, a.lon), vb = vec(b.lat, b.lon);
    const pts: THREE.Vector3[] = [];
    const angle = va.angleTo(vb);
    for (let i = 0; i <= 64; i++) {
      const t = i / 64;
      const p = new THREE.Vector3().copy(va).multiplyScalar(Math.sin((1 - t) * angle)).add(vb.clone().multiplyScalar(Math.sin(t * angle))).divideScalar(Math.sin(angle));
      p.setLength(1.006 + Math.sin(Math.PI * t) * (0.02 + angle * 0.03));
      pts.push(p);
    }
    return new THREE.CatmullRomCurve3(pts);
  }
  function makeLine(id: number, a: number, b: number) {
    const geo = new THREE.TubeGeometry(arcPoints(state.regions[a], state.regions[b]), 96, 0.0042, 6, false);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { color: { value: new THREE.Color(0x4fd1e0) }, time: { value: 0 }, dir: { value: 0 }, alpha: { value: 1 }, dash: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 color; uniform float time; uniform float dir; uniform float alpha; uniform float dash; varying vec2 vUv;
        void main(){
          float flow = dir == 0.0 ? 0.0 : pow(fract(vUv.x * 18.0 - time * 0.0012 * dir), 6.0);
          float d = dash > 0.5 ? step(0.5, fract(vUv.x * 30.0)) : 1.0;
          gl_FragColor = vec4(color * (0.55 + 1.2 * flow), alpha * d);
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    lineGroup.add(mesh);
    lineMeshes.set(id, { mesh, mat });
    return { mesh, mat };
  }

  function render(time: number) {
    if (stopped) return;
    // 태양 방향: 게임 시각 12:00에 경도 0이 정오
    const m = (state.step % STEPS_PER_DAY) / STEPS_PER_DAY;
    const sunLon = 180 - m * 360;
    sunDir.copy(vec(8, sunLon)).normalize();
    sun.position.copy(sunDir).multiplyScalar(5);
    clouds.rotation.y = -Math.PI / 2 + time * 0.000004;

    if (focusTarget) {
      // 지역 선택: 그 지역 위로 돌아가며 적당히 확대 (이미 가까우면 거리 유지)
      const cur = camera.position.length();
      const dist = cur + (focusDist - cur) * 0.08;
      camera.position.lerp(focusTarget.clone().multiplyScalar(dist), 0.08);
      camera.position.setLength(dist);
      if (camera.position.distanceTo(focusTarget.clone().multiplyScalar(focusDist)) < 0.01) focusTarget = null;
    }
    controls.update();
    const camDist = camera.position.length();
    planetMat.uniforms.camDist.value = camDist;
    planetMat.uniforms.time.value = time;
    planetMat.uniforms.selected.value = selectedId ?? -1;
    (clouds.material as THREE.MeshLambertMaterial).opacity = 0.5 * Math.min(1, Math.max(0.12, (camDist - 1.6) / 1.4));
    // 지역 색칠 (지도 표시): 표식 대신 지역 면 전체를 칠한다
    const ovVals = overlayValues();
    for (let i = 0; i < regionTint.length; i++) {
      const v = ovVals ? ovVals[i] : undefined;
      if (v === undefined) { regionTint[i].set(0, 0, 0, 0); continue; }
      const c = rampColor(overlay, v);
      regionTint[i].set(c.r, c.g, c.b, overlay === 'mine' ? (v > 0 ? 0.25 + 0.35 * v : 0) : 0.42);
    }
    const ringScale = Math.max(0.35, Math.min(1, (camDist - 1.0) / 2.0));
    // 가까이 볼수록 시설 모형을 작게 (멀리서는 잘 보이게 과장, 가까이서는 땅에 맞게)
    const modelScale = Math.max(0.3, Math.min(1, (camDist - 0.9) / 2.2));
    for (const g of facGroup.children) g.scale.setScalar((g.userData.baseScale ?? 1) * modelScale);

    // 라벨 위치 (뒷면이면 숨김). 지역이 많으면 가까이 볼 때나 내 지역만 이름을 띄운다.
    const camDir = camera.position.clone().normalize();
    const crowded = state.regions.length > 24 && camera.position.length() > 3.3;
    const present = crowded ? new Set([...state.facilities.map((f) => f.regionId), ...state.licenses.map((l) => l.regionId)]) : null;
    state.regions.forEach((r, i) => {
      const p = vec(r.lat, r.lon, 1.01);
      const facing = p.clone().normalize().dot(camDir);
      tmp.copy(p).project(camera);
      const el = labelEls[i];
      const x = (tmp.x * 0.5 + 0.5) * host.clientWidth;
      const y = (-tmp.y * 0.5 + 0.5) * host.clientHeight;
      el.style.transform = `translate(${x}px, ${y}px)`;
      const show = facing > 0.15 && (!present || present.has(r.id) || selectedId === r.id);
      el.style.opacity = show ? '1' : '0';
      el.style.pointerEvents = show ? 'auto' : 'none';
      el.classList.toggle('selected', selectedId === r.id);
      const mk = markers[i];
      const mat = mk.material as THREE.MeshBasicMaterial;
      // 지역 중심 표식 (도시). 값 표시는 지역 면 색칠이 맡는다 (Baseline §27.4)
      mat.color.setHex(selectedId === r.id ? 0xf2b248 : 0x4fd1e0);
      mat.opacity = selectedId === r.id ? 1 : 0.75;
      const pulse = 1 + 0.25 * Math.sin(time / 300 + i);
      mk.scale.setScalar((selectedId === r.id ? 1.5 * pulse : 0.9) * ringScale);
    });

    // 시설 모형: 건설 중 = 반투명 골조, 정지 = 어둡게, 고장·전조 = 머리 위 표시등, 풍력 날개는 출력에 비례해 회전
    const perRegion = new Map<number, number>();
    const dt = lastTime ? Math.min(100, time - lastTime) : 16;
    lastTime = time;
    const live = new Set<number>();
    for (const f of state.facilities) {
      live.add(f.id);
      const idx = perRegion.get(f.regionId) ?? 0;
      perRegion.set(f.regionId, idx + 1);
      const r = state.regions[f.regionId];
      let rec = facMeshes.get(f.id);
      if (rec && rec.modules !== f.modules) { facGroup.remove(rec.g); facMeshes.delete(f.id); rec = undefined; } // 모듈 추가 → 모형 교체
      rec ??= placeFacility(f, r.lat, r.lon, idx);
      const mode = f.status === 'construction' ? 'build' : !f.rightsOk || !f.online || f.health.s === 'failed' ? 'off' : 'on';
      setModelState(rec.g, mode, f.health.s, time, f.id === selectedFac);
      if (f.type === 'wind') spinRotors(rec.g, mode === 'on' ? (f.outputKw / Math.max(1, f.capKw)) * dt * 0.012 : 0);
    }
    for (const [id, rec] of facMeshes) if (!live.has(id)) { facGroup.remove(rec.g); facMeshes.delete(id); }

    for (const l of state.lines) {
      const o = lineMeshes.get(l.id) ?? makeLine(l.id, l.a, l.b);
      const u = o.mat.uniforms;
      u.time.value = time;
      const util = l.lastSentWh / Math.max(1, l.capKw * 250);
      if (l.status === 'construction') { u.color.value.setHex(0x8b95a1); u.alpha.value = 0.45; u.dash.value = 1; u.dir.value = 0; }
      else if (l.health.s === 'failed') { u.color.value.setHex(0xe5604d); u.alpha.value = 0.9; u.dash.value = 1; u.dir.value = 0; }
      else {
        u.dash.value = 0; u.alpha.value = 0.95;
        u.color.value.setHex(l.health.s === 'warning' ? 0xf2b248 : util > 0.9 ? 0xf2b248 : 0x4fd1e0);
        u.dir.value = l.lastSentWh > 0 ? l.lastDir : 0;
      }
    }
    for (const [id, o] of lineMeshes) {
      if (!state.lines.some((l) => l.id === id)) { lineGroup.remove(o.mesh); o.mesh.geometry.dispose(); lineMeshes.delete(id); }
    }

    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  return {
    labels,
    update(next, selected, ov, fac) { state = next; selectedId = selected; if (ov) overlay = ov; selectedFac = fac ?? null; },
    focus(lat, lon) { focusTarget = vec(lat, lon).normalize(); focusDist = Math.min(camera.position.length(), 2.15); },
    project(lat, lon) {
      const p = vec(lat, lon, 1.02);
      if (p.clone().normalize().dot(camera.position.clone().normalize()) < 0.2) return null;
      p.project(camera);
      return { x: (p.x * 0.5 + 0.5) * host.clientWidth, y: (-p.y * 0.5 + 0.5) * host.clientHeight };
    },
    setIdle(on) { controls.autoRotate = on; controls.autoRotateSpeed = 0.35; labels.style.opacity = on ? '0' : '1'; },
    dispose() { stopped = true; window.removeEventListener('resize', onResize); controls.dispose(); renderer.dispose(); },
  };
}

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
  camera.position.set(0, 1.0, 4.4);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 2.3;
  controls.maxDistance = 6;
  controls.rotateSpeed = 0.5;

  // ---- 텍스처 생성 (워커) ----
  const W = Q.tex, H = Q.tex / 2;
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
  let stopped = false;
  let state = s;
  let selectedId: number | null = null;
  let overlay: Overlay = 'none';
  let selectedFac: number | null = null;
  let lastTime = 0;
  const tmpColor = new THREE.Color();
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
      const dist = camera.position.length();
      camera.position.lerp(focusTarget.clone().multiplyScalar(dist), 0.08);
      camera.position.setLength(dist);
      if (camera.position.distanceTo(focusTarget.clone().multiplyScalar(dist)) < 0.01) focusTarget = null;
    }
    controls.update();

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
      // 오버레이: 지역 표식의 색·크기로 값을 보여준다 (Baseline §27.4)
      let ov = 0;
      if (overlay === 'price') { const ps = state.regionState.map((x) => x.priceMinor); const lo = Math.min(...ps), hi = Math.max(...ps); ov = (state.regionState[i].priceMinor - lo) / Math.max(1, hi - lo); }
      else if (overlay === 'env') ov = Math.min(1, envOf(i));
      else if (overlay === 'mine') { const caps = state.regions.map((_, j) => state.facilities.filter((f) => f.regionId === j && f.status === 'operating').reduce((a, f) => a + f.capKw, 0)); const hi = Math.max(1, ...caps); ov = caps[i] / hi; }
      if (selectedId === r.id) mat.color.setHex(0xf2b248);
      else if (overlay === 'none') mat.color.setHex(0x4fd1e0);
      else mat.color.copy(tmpColor.setHex(0x4fd1e0)).lerp(new THREE.Color(overlay === 'env' ? 0xe5604d : overlay === 'mine' ? 0x6ccb8b : 0xf2b248), ov);
      const pulse = 1 + 0.25 * Math.sin(time / 300 + i);
      mk.scale.setScalar(selectedId === r.id ? 1.6 * pulse : overlay === 'none' ? 1 : 0.8 + ov * 1.6);
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
    focus(lat, lon) { focusTarget = vec(lat, lon).normalize(); },
    setIdle(on) { controls.autoRotate = on; controls.autoRotateSpeed = 0.35; labels.style.opacity = on ? '0' : '1'; },
    dispose() { stopped = true; window.removeEventListener('resize', onResize); controls.dispose(); renderer.dispose(); },
  };
}

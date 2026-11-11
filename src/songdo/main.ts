// 송도 플라이트: 인천공항에서 이륙해 송도·인천대교·영종도를 날아다니고, 내려서 걸을 수 있다.
import * as THREE from 'three';
import { HeightField } from './heightfield';
import { World } from './world';
import { buildTerrain, buildSea } from './terrain';
import { buildAirport, type RunwayInfo } from './airport';
import { buildPylons } from './bridge';
import { loadMapData, type Meta } from './data';
import { BuildingSet } from './buildings';
import { TreeSet } from './trees';
import { buildRoads, processRoads } from './roads';
import { Aircraft, SPECS, type AircraftSpec, type FlightInput } from './aircraft';
import { makeAirliner, makeLightPlane, makePerson, type PlaneModel } from './aircraftModels';
import { Walker } from './walker';
import { Env, TIME_LABEL, type TimeOfDay } from './env';
import { MapArt } from './mapview';
import { FlightAudio } from './audio';
import { Traffic } from './traffic';
import { LightPoints } from './lights';
import { nightU } from './materials';
import { LANDMARKS, headingOf, initGeo, landmark, placeName, toLatLon, type P2 } from './geo';

// ───────────────────────── DOM ─────────────────────────
const app = document.getElementById('sd-app')!;
app.innerHTML = `
<div id="sd-loading"><div class="t">송도 플라이트</div><div class="bar"><span></span></div><div class="s">준비 중…</div></div>
<div id="sd-hud" class="hidden">
  <div id="sd-top" class="panel"><span class="place"></span><span class="dim mode"></span><span class="dim coord"></span></div>
  <div id="sd-btns">
    <button data-k="KeyM" title="지도 · 순간이동 (M)">🗺 지도</button>
    <button data-k="KeyN" title="시간대 (N)">🌓 시간</button>
    <button data-k="KeyC" title="카메라 (C)">🎥 시점</button>
    <button data-k="KeyF" title="탑승/하차 (F)">🚪 탑승</button>
    <button data-k="KeyH" title="도움말 (H)">❔</button>
  </div>
  <div id="sd-flight" class="panel">
    <canvas id="sd-att" width="260" height="260"></canvas>
    <div class="col"><span class="lab">속도</span><span class="big spd">0</span><span class="sub spd2"></span></div>
    <div class="col"><span class="lab">고도</span><span class="big alt">0</span><span class="sub alt2"></span></div>
    <div class="col"><span class="lab">방위</span><span class="big hdg">000°</span><span class="sub vs"></span></div>
    <div class="thr" title="추력"><span></span></div>
    <div class="col" style="min-width:96px"><span class="lab">상태</span><div class="tags"></div></div>
  </div>
  <div id="sd-walk" class="panel hidden"></div>
  <canvas id="sd-mini" width="400" height="400"></canvas>
  <div id="sd-hint" class="panel hidden"></div>
  <div id="sd-toast" class="panel hidden"></div>
  <div id="sd-msg" class="panel hidden"></div>
  <div id="sd-attr">© OpenStreetMap 기여자 · Overture Maps · AWS Terrain Tiles</div>
</div>
<div id="sd-touch" class="hidden">
  <div class="stick"><div class="knob"></div></div>
  <div class="tbtns"></div>
</div>
<div id="sd-map" class="overlay hidden"><div class="panel">
  <div class="mapwrap"><canvas id="sd-mapc"></canvas></div>
  <div class="side">
    <b>지도 · 순간이동</b>
    <div class="note" style="margin:0">지도를 누르면 그곳으로 이동합니다.</div>
    <div class="row seg" id="sd-tpmode"><button data-m="walk" class="sel">🚶 걸어서</button><button data-m="air">✈ 하늘에서</button></div>
    <div class="row"><button class="primary" data-rw="airliner">여객기 · 활주로</button><button data-rw="light">경비행기 · 활주로</button></div>
    <div class="list"></div>
    <button data-close>닫기 (M)</button>
  </div>
</div></div>
<div id="sd-help" class="overlay hidden"><div class="panel"></div></div>
<div id="sd-start" class="overlay hidden"><div class="panel">
  <h1>송도 플라이트</h1>
  <div class="subtitle">실제 지도 자료로 만든 인천 — 인천국제공항에서 이륙해 인천대교를 넘어 송도국제도시 하늘을 날고, 내려서 걸어 보세요.</div>
  <div class="choices">
    <button class="primary" data-start="airliner"><b>✈ 여객기로 이륙</b><span>인천공항 15L 활주로에서 출발</span></button>
    <button data-start="light"><b>🛩 경비행기로 이륙</b><span>느리고 다루기 쉬움 · 송도 구경용</span></button>
    <button data-start="walk"><b>🚶 센트럴파크 걷기</b><span>송도 센트럴파크 산책로에서 출발</span></button>
    <button data-start="map"><b>🗺 지도에서 고르기</b><span>원하는 곳으로 바로 이동</span></button>
  </div>
  <div class="row seg" id="sd-tod"><span style="color:var(--dim)">시간대</span><button data-t="day" class="sel">낮</button><button data-t="sunset">노을</button><button data-t="night">밤</button></div>
  <div class="keys"></div>
</div></div>`;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => app.querySelector(s) as T;
const loading = $('#sd-loading');
const setProgress = (f: number, s: string) => { ($('#sd-loading .bar span')).style.width = `${Math.round(f * 100)}%`; $('#sd-loading .s').textContent = s; };
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

const KEYS_HTML = `
<h3>비행</h3>
<div><kbd>W</kbd> / <kbd>S</kbd> 추력 올리기 / 내리기</div>
<div><kbd>↓</kbd> 기수 들기 · <kbd>↑</kbd> 기수 내리기</div>
<div><kbd>←</kbd> <kbd>→</kbd> 좌우 기울이기 (선회)</div>
<div><kbd>A</kbd> <kbd>D</kbd> 방향타 · 지상에서 방향 전환</div>
<div><kbd>B</kbd> 브레이크(누르고 있기) · <kbd>G</kbd> 착륙장치</div>
<div><kbd>F</kbd> 내리기 (하늘에서는 낙하산)</div>
<h3>걷기</h3>
<div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 이동 · <kbd>Shift</kbd> 달리기</div>
<div><kbd>Space</kbd> 점프 · 높은 곳에서 떨어질 때 낙하산</div>
<div><kbd>F</kbd> 가까운 비행기 타기 · 화면 클릭: 마우스로 둘러보기</div>
<h3>공통</h3>
<div><kbd>C</kbd> 시점 바꾸기 · 마우스 끌기: 둘러보기 · 휠: 거리</div>
<div><kbd>M</kbd> 지도·순간이동 · <kbd>N</kbd> 낮/노을/밤</div>
<div><kbd>R</kbd> 활주로에서 다시 시작 · <kbd>O</kbd> 소리 · <kbd>H</kbd> 도움말</div>`;
$('#sd-start .keys').innerHTML = KEYS_HTML;
$('#sd-help .panel').innerHTML = `<h2 style="margin:0 0 8px">조작법</h2><div class="keys">${KEYS_HTML}</div>
<div class="note"><b>이륙</b>: <kbd>W</kbd>를 눌러 추력을 끝까지 올리고, 여객기는 시속 약 270km, 경비행기는 약 100km에서 <kbd>↓</kbd>로 기수를 듭니다. 이륙 뒤 <kbd>G</kbd>로 착륙장치를 올리세요.<br>
<b>송도 가는 길</b>: 공항에서 동남동쪽(방위 약 110°)으로 약 18km. 인천대교를 따라가면 송도가 나옵니다.<br>
<b>착륙</b>: 착륙장치를 내리고 천천히 내려앉으면 활주로·도로·공원·옥상·다리 위 어디든 내릴 수 있습니다 (강하율이 너무 크면 추락).<br>
<b>지도 자료</b>: 건물 약 12만 채의 실제 외곽선, 도로·철도·다리, 활주로·유도로, 공원·물·땅 쓰임새는 OpenStreetMap(© OpenStreetMap 기여자, ODbL)과 Overture Maps 자료, 지형 높이는 AWS Terrain Tiles(SRTM 등)를 썼습니다. 높이 정보가 있는 건물(약 1만 4천 채)은 실제 높이, 나머지는 건물 종류·면적으로 추정한 높이입니다.</div>
<div class="row" style="justify-content:flex-end"><button data-close>닫기 (H)</button></div>`;

// ───────────────────────── 렌더러 ─────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.className = 'gl';
app.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.15, 90000);
const env = new Env(scene, renderer);

// ───────────────────────── 상태 ─────────────────────────
type Mode = 'fly' | 'walk';
let world!: World;
let hf!: HeightField;
let mapArt!: MapArt;
let traffic!: Traffic;
let meta!: Meta;
let buildings!: BuildingSet;
let trees!: TreeSet;
let runways: RunwayInfo[] = [];
let paths: THREE.Vector3[] = []; // 걷기 시작점 후보 (산책로·보행로)
let seaUpdate: (t: number) => void = () => {};
const lightSets: { lp: LightPoints; day: number; night: number }[] = [];
let mode: Mode = 'fly';
let plane!: Aircraft;
let planeModel!: PlaneModel;
let piloting = true;
const walker = new Walker();
const person = makePerson();
scene.add(person.root);
person.root.visible = false;
const audio = new FlightAudio();
let camMode: 'chase' | 'cockpit' = 'chase';
let walkCam: 'third' | 'first' = 'third';
let camYaw = 0, camPitch = 0.25; // 걷기 시점
let orbitYaw = 0, orbitPitch = 0, orbitIdle = 0; // 비행 추적 시점 보정
let chaseYaw = 0;
let zoom = 1;
let started = false;
let paused = false;
let time = 0;
const fx: { mesh: THREE.Mesh; t: number; kind: 'fire' | 'smoke' }[] = [];

// ───────────────────────── 입력 ─────────────────────────
const keys = new Set<string>();
const touch = { x: 0, y: 0, thrUp: false, thrDn: false, brake: false, jump: false, run: false };
let throttleCmd = 0;
window.addEventListener('keydown', (e) => {
  if (e.repeat && keys.has(e.code)) return;
  audio.unlock();
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  onKey(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
const k = (...c: string[]) => c.some((x) => keys.has(x));

function onKey(code: string) {
  if (!started) return;
  const overlayOpen = !$('#sd-map').classList.contains('hidden') || !$('#sd-help').classList.contains('hidden');
  if (code === 'Escape') { closeOverlays(); return; }
  if (code === 'KeyM') { toggleMap(); return; }
  if (code === 'KeyH') { $('#sd-help').classList.toggle('hidden'); return; }
  if (overlayOpen) return;
  switch (code) {
    case 'KeyN': {
      const order: TimeOfDay[] = ['day', 'sunset', 'night'];
      env.set(order[(order.indexOf(env.time) + 1) % 3]);
      toast(`시간대: ${TIME_LABEL[env.time]}`);
      break;
    }
    case 'KeyC':
      if (mode === 'fly') { camMode = camMode === 'chase' ? 'cockpit' : 'chase'; toast(camMode === 'chase' ? '추적 시점' : '조종석 시점'); }
      else { walkCam = walkCam === 'third' ? 'first' : 'third'; toast(walkCam === 'third' ? '3인칭 시점' : '1인칭 시점'); }
      break;
    case 'KeyF': toggleBoard(); break;
    case 'KeyG':
      if (mode === 'fly' && piloting && !plane.onGround && !plane.crashed) { plane.gearDown = !plane.gearDown; toast(plane.gearDown ? '착륙장치 내림' : '착륙장치 올림'); }
      break;
    case 'KeyR': spawnRunway(plane?.spec.id ?? 'airliner'); break;
    case 'KeyO': audio.setMuted(!audio.muted); toast(audio.muted ? '소리 끔' : '소리 켬'); break;
    case 'KeyP': paused = !paused; toast(paused ? '일시정지' : '계속'); break;
  }
}

// 마우스: 끌어서 둘러보기, 걷기에서는 클릭하면 포인터 잠금
let dragging = false, lastX = 0, lastY = 0;
const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  audio.unlock();
  if (e.pointerType === 'touch') return;
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  if (mode === 'walk' && walkCam === 'first' && document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
});
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  const locked = document.pointerLockElement === canvas;
  if (!dragging && !locked) return;
  const dx = locked ? e.movementX : e.clientX - lastX, dy = locked ? e.movementY : e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  look(dx, dy);
});
canvas.addEventListener('wheel', (e) => { zoom = THREE.MathUtils.clamp(zoom * (e.deltaY > 0 ? 1.12 : 0.89), 0.35, 4); }, { passive: true });
function look(dx: number, dy: number) {
  if (mode === 'walk') {
    camYaw -= dx * 0.005;
    camPitch = THREE.MathUtils.clamp(camPitch + dy * 0.004 * (walkCam === 'first' ? -1 : 1), -1.2, 1.3);
  } else {
    orbitYaw -= dx * 0.005;
    orbitPitch = THREE.MathUtils.clamp(orbitPitch + dy * 0.004, -0.6, 1.2);
    orbitIdle = 0;
  }
}

// 터치 조작
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
function setupTouch() {
  if (!isTouch) return;
  const t = $('#sd-touch');
  t.classList.remove('hidden');
  const stick = $('#sd-touch .stick'), knob = $('#sd-touch .knob');
  let sid: number | null = null;
  const upd = (e: PointerEvent) => {
    const r = stick.getBoundingClientRect();
    let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    touch.x = x; touch.y = y;
    knob.style.transform = `translate(${x * 38}px, ${y * 38}px)`;
  };
  stick.addEventListener('pointerdown', (e) => { sid = e.pointerId; stick.setPointerCapture(e.pointerId); upd(e); audio.unlock(); });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === sid) upd(e); });
  const end = () => { sid = null; touch.x = touch.y = 0; knob.style.transform = ''; };
  stick.addEventListener('pointerup', end); stick.addEventListener('pointercancel', end);
  // 화면 오른쪽 끌기 = 둘러보기
  let lid: number | null = null, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') return; lid = e.pointerId; lx = e.clientX; ly = e.clientY; });
  canvas.addEventListener('pointermove', (e) => { if (e.pointerId !== lid) return; look((e.clientX - lx) * 1.4, (e.clientY - ly) * 1.4); lx = e.clientX; ly = e.clientY; });
  canvas.addEventListener('pointerup', (e) => { if (e.pointerId === lid) lid = null; });
  renderTouchButtons();
}
function renderTouchButtons() {
  if (!isTouch) return;
  const box = $('#sd-touch .tbtns');
  const hold = (label: string, key: keyof typeof touch) => `<button data-hold="${key}">${label}</button>`;
  box.innerHTML = mode === 'fly'
    ? `${hold('추력 +', 'thrUp')}${hold('추력 −', 'thrDn')}<button data-tk="KeyG">기어</button>${hold('브레이크', 'brake')}`
    : `${hold('점프', 'jump')}${hold('달리기', 'run')}`;
  box.querySelectorAll<HTMLButtonElement>('[data-hold]').forEach((b) => {
    const key = b.dataset.hold as keyof typeof touch;
    const set = (v: boolean) => { (touch as Record<string, unknown>)[key] = v; };
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); set(true); });
    b.addEventListener('pointerup', () => set(false));
    b.addEventListener('pointercancel', () => set(false));
    b.addEventListener('pointerleave', () => set(false));
  });
  box.querySelectorAll<HTMLButtonElement>('[data-tk]').forEach((b) => b.addEventListener('click', () => onKey(b.dataset.tk!)));
}

// 상단 버튼
$('#sd-btns').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b?.dataset.k) { audio.unlock(); onKey(b.dataset.k); }
});
app.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeOverlays));
function closeOverlays() { $('#sd-map').classList.add('hidden'); $('#sd-help').classList.add('hidden'); }

// ───────────────────────── 메시지 ─────────────────────────
let toastTimer = 0;
function toast(s: string, sec = 2.2) { const t = $('#sd-toast'); t.textContent = s; t.classList.remove('hidden'); toastTimer = sec; }
function showMsg(html: string | null) {
  const m = $('#sd-msg');
  if (!html) { m.classList.add('hidden'); return; }
  m.innerHTML = html; m.classList.remove('hidden');
}

// ───────────────────────── 생성 ─────────────────────────
async function load() {
  const data = await loadMapData(`${import.meta.env.BASE_URL}songdo/`, setProgress);
  meta = data.meta;
  initGeo(meta);
  setProgress(0.25, '지형 만드는 중…'); await frame();
  hf = new HeightField(meta, data.heights, data.water);
  world = new World(hf);
  const groundTex = await new THREE.TextureLoader().loadAsync(data.groundUrl);
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  scene.add(buildTerrain(hf, groundTex));
  const sea = buildSea();
  scene.add(sea.mesh);
  seaUpdate = sea.update;
  scene.add(buildWaterAreas(data.areas));
  setProgress(0.4, `건물 ${data.buildings.n.toLocaleString()}채 세우는 중…`); await frame();
  buildings = new BuildingSet(data.buildings, hf, world);
  scene.add(buildings.group);
  setProgress(0.6, '도로·다리 까는 중…'); await frame();
  const lines = processRoads(data.roads, hf);
  for (const l of lines) if ((l.cls === 8 || l.cls === 9 || l.cls === 6) && !l.bridge) for (let k = 0; k < l.pts.length; k += 2) paths.push(l.pts[k]);
  const roads = buildRoads(lines, hf, world);
  scene.add(roads.group);
  setProgress(0.72, '인천국제공항·인천대교…'); await frame();
  const airport = buildAirport(meta, world);
  runways = airport.runways;
  scene.add(airport.group);
  const pylons = buildPylons(meta, world);
  scene.add(pylons.group);
  setProgress(0.82, '나무 심는 중…'); await frame();
  trees = new TreeSet(data.trees, hf);
  scene.add(trees.group);
  setProgress(0.9, '불빛과 자동차…'); await frame();
  const addLights = (lp: LightPoints, day: number, night: number) => { lightSets.push({ lp, day, night }); scene.add(lp.points); };
  addLights(new LightPoints(roads.lights, new THREE.Color(1, 0.78, 0.45), { size: 2.2, minPx: 1.2, maxPx: 14 }), 0, 1);
  addLights(new LightPoints(airport.lights.map((l) => l.pos), airport.lights.map((l) => l.color), { size: 1.6, minPx: 1.4, maxPx: 10 }), 0.25, 1);
  addLights(new LightPoints(pylons.lights, new THREE.Color(1, 1, 0.95), { size: 6, minPx: 2, maxPx: 22 }), 0, 1);
  addLights(new LightPoints([...buildings.beacons, ...pylons.beacons], new THREE.Color(1, 0.12, 0.08), { size: 4, minPx: 2.5, maxPx: 18, blink: true }), 0.6, 1);
  traffic = new Traffic(lines, 2600);
  scene.add(traffic.mesh, traffic.lights);
  const img = groundTex.image as HTMLImageElement;
  mapArt = new MapArt(img, meta);
  buildMapList();
  setProgress(1, '완료'); await frame();
  loading.classList.add('hidden');
}

/** 호수·수로 수면 (자료에서 미리 삼각형으로 나눔) */
function buildWaterAreas(a: import('./data').WaterAreas): THREE.Mesh {
  const pos = new Float32Array(a.n * 9), nor = new Float32Array(a.n * 9);
  for (let i = 0; i < a.n; i++) for (let k = 0; k < 3; k++) {
    pos.set([a.xz[(i * 3 + k) * 2], a.y[i], a.xz[(i * 3 + k) * 2 + 1]], (i * 3 + k) * 3);
    nor[(i * 3 + k) * 3 + 1] = 1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x2d6278, roughness: 0.06, metalness: 0.15 }));
  m.receiveShadow = true;
  m.name = 'inland-water';
  return m;
}

// ───────────────────────── 비행기 / 사람 배치 ─────────────────────────
function makePlane(id: AircraftSpec['id']) {
  if (planeModel) scene.remove(planeModel.root);
  planeModel = id === 'airliner' ? makeAirliner({ livery: 0x0f5aa8, accent: 0x5ec8f2 }) : makeLightPlane();
  scene.add(planeModel.root);
  plane = new Aircraft(SPECS[id]);
}

/** 15L 활주로 시작점 (이륙 방향 남동쪽) */
function runwayStart(): { p: P2; heading: number } {
  const r = runways.find((x) => x.labelA === '15L' || x.labelB === '15L') ?? runways[0];
  const fromA = r.labelA === '15L';
  const s = fromA ? r.a : r.b, e = fromA ? r.b : r.a;
  const dx = (e.x - s.x) / r.len, dz = (e.z - s.z) / r.len;
  return { p: { x: s.x + dx * 180, z: s.z + dz * 180 }, heading: headingOf(dx, dz) };
}

function spawnRunway(id: AircraftSpec['id']) {
  makePlane(id);
  const { p: start, heading } = runwayStart();
  const g = world.ground(start.x, start.z, 1e4);
  plane.place(start.x, g.h + plane.spec.gearH, start.z, heading);
  throttleCmd = 0;
  enterFly();
  showMsg(null);
  chaseYaw = plane.euler().y;
  primeAround();
  toast(`${plane.spec.name} · 인천공항 활주로 15L — W로 추력을 올리세요`, 4);
}

function spawnAir(p: P2, id: AircraftSpec['id']) {
  makePlane(id);
  const target = landmark('posco').at;
  let hdg = (Math.atan2(target.x - p.x, -(target.z - p.z)) * 180) / Math.PI;
  if (Math.hypot(target.x - p.x, target.z - p.z) < 3000) hdg += 180;
  const g = world.ground(p.x, p.z, 1e4);
  const v = id === 'airliner' ? 110 : 45;
  plane.place(p.x, Math.max(g.h, 0) + (id === 'airliner' ? 500 : 300), p.z, hdg, v);
  throttleCmd = 0.6;
  enterFly();
  showMsg(null);
  chaseYaw = plane.euler().y;
  primeAround();
}

function spawnWalk(p: P2) {
  // 가까운 산책로·보행로 위에서 시작 (나무·건물 속 방지)
  let best: THREE.Vector3 | null = null, bd = 160;
  for (const v of paths) {
    const d = Math.hypot(v.x - p.x, v.z - p.z);
    if (d < bd && dryAround(v.x, v.z)) { bd = d; best = v; }
  }
  if (best) p = { x: best.x, z: best.z };
  // 바다면 가까운 땅 찾기
  let q = p;
  const dry = (c: P2) => hf.at(c.x, c.z) > 0.8 && dryAround(c.x, c.z) && !world.hitAt(c.x, hf.at(c.x, c.z) + 1, c.z);
  if (!dry(p)) {
    outer: for (let r = 30; r < 5000; r += 30) for (let a = 0; a < 16; a++) {
      const c = { x: p.x + Math.cos((a / 16) * Math.PI * 2) * r, z: p.z + Math.sin((a / 16) * Math.PI * 2) * r };
      if (dry(c)) { q = c; break outer; }
    }
  }
  // 건물 안이면 밀어내기
  const pp = { x: q.x, z: q.z };
  for (let i = 0; i < 4; i++) world.pushOut(pp, hf.at(pp.x, pp.z), 0.4, 1.8, 0);
  walker.place(pp.x, pp.z, world, world.terrain(pp.x, pp.z) < 0.3 ? 0 : undefined);
  enterWalk();
  showMsg(null);
  primeAround();
}

/** 반경 15m 안이 모두 마른 땅인가 */
function dryAround(x: number, z: number) {
  for (const [dx, dz] of [[0, 0], [15, 0], [-15, 0], [0, 15], [0, -15], [10, 10], [-10, -10], [10, -10], [-10, 10]])
    if (hf.waterAt(x + dx, z + dz) !== 0) return false;
  return true;
}

/** 걷기로 시작할 때 비행기는 공항에 세워 둔다 */
function placeParked() {
  const { p: s, heading } = runwayStart();
  const g = world.ground(s.x, s.z, 1e4);
  plane.place(s.x, g.h + plane.spec.gearH, s.z, heading);
}

/** 순간이동 직후 주변 건물·나무를 한꺼번에 만든다 */
function primeAround() {
  updateCamera(0);
  buildings.prime(camera.position);
  trees.prime(camera.position);
}

function enterFly() {
  mode = 'fly'; piloting = true;
  person.root.visible = false;
  $('#sd-flight').classList.remove('hidden');
  $('#sd-walk').classList.add('hidden');
  ($('#sd-btns [data-k="KeyF"]')).textContent = '🚪 내리기';
  if (document.pointerLockElement) document.exitPointerLock();
  renderTouchButtons();
}
function enterWalk() {
  mode = 'walk';
  person.root.visible = walkCam === 'third';
  $('#sd-flight').classList.add('hidden');
  $('#sd-walk').classList.remove('hidden');
  ($('#sd-btns [data-k="KeyF"]')).textContent = '🚪 탑승';
  renderTouchButtons();
}

function toggleBoard() {
  if (mode === 'fly') {
    // 내리기
    plane.axes();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(plane.q);
    if (plane.crashed || (plane.onGround && plane.speed < 3)) {
      const side = plane.spec.id === 'airliner' ? 8 : 3;
      const p = { x: plane.pos.x - right.x * side, z: plane.pos.z - right.z * side };
      walker.place(p.x, p.z, world, Math.max(plane.groundH, world.ground(p.x, p.z, plane.pos.y).h));
      walker.onGround = true;
      piloting = false;
      camYaw = plane.euler().y + 0.6; camPitch = 0.25;
      enterWalk();
      showMsg(null);
      toast('비행기에서 내렸습니다. F: 다시 타기');
    } else if (plane.onGround) {
      toast('멈춘 뒤에 내릴 수 있습니다 (B: 브레이크)');
    } else {
      // 낙하산 탈출
      const p = plane.pos.clone().addScaledVector(plane.up, -5);
      walker.pos.copy(p);
      walker.vel.copy(plane.vel).multiplyScalar(0.25);
      walker.chute = true;
      walker.onGround = false;
      piloting = false;
      throttleCmd = 0;
      camYaw = plane.euler().y; camPitch = 0.35;
      enterWalk();
      toast('낙하산으로 탈출했습니다! 비행기는 R로 다시 불러올 수 있습니다.', 4);
    }
  } else {
    const d = walker.pos.distanceTo(plane.pos);
    const reach = plane.spec.id === 'airliner' ? 24 : 8;
    if (d < reach) {
      if (plane.crashed) { toast('부서진 비행기입니다. R: 활주로에서 새 비행기'); return; }
      enterFly();
      chaseYaw = plane.euler().y;
      throttleCmd = plane.throttle;
      toast('탑승했습니다');
    } else toast(`비행기가 너무 멉니다 (${fmtDist(d)}). M: 지도에서 활주로로 이동`);
  }
}

// ───────────────────────── 지도 ─────────────────────────
let tpMode: 'walk' | 'air' = 'walk';
function toggleMap() {
  const m = $('#sd-map');
  m.classList.toggle('hidden');
  if (!m.classList.contains('hidden')) drawBigMap();
}
function buildMapList() {
  const list = $('#sd-map .list');
  list.innerHTML = LANDMARKS.map((l) => `<button data-lm="${l.id}">${l.kind === 'airport' ? '✈' : l.kind === 'songdo' ? '🏙' : '📍'} ${l.name}</button>`).join('');
  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    const l = LANDMARKS.find((x) => x.id === b?.dataset.lm);
    if (l) teleport(l.at);
  });
  $('#sd-tpmode').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b?.dataset.m) return;
    tpMode = b.dataset.m as 'walk' | 'air';
    $('#sd-tpmode').querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
  });
  $('#sd-map').querySelectorAll<HTMLButtonElement>('[data-rw]').forEach((b) => b.addEventListener('click', () => { closeOverlays(); spawnRunway(b.dataset.rw as AircraftSpec['id']); }));
  const mc = $('#sd-mapc') as HTMLCanvasElement;
  mc.addEventListener('click', (e) => {
    const r = mc.getBoundingClientRect();
    const v = bigMapView;
    const x = v.x0 + ((e.clientX - r.left) / r.width) * v.w, y = v.y0 + ((e.clientY - r.top) / r.height) * v.h;
    teleport(mapArt.fromPx(x, y));
  });
}
function teleport(p: P2) {
  closeOverlays();
  if (!started) { started = true; $('#sd-start').classList.add('hidden'); $('#sd-hud').classList.remove('hidden'); setupTouch(); }
  if (tpMode === 'air') spawnAir(p, plane?.spec.id ?? 'airliner');
  else { spawnWalk(p); toast(`${placeName(walker.pos)}(으)로 이동했습니다`); }
}
const bigMapView = { x0: 0, y0: 0, w: 1, h: 1 };
function drawBigMap() {
  const mc = $('#sd-mapc') as HTMLCanvasElement;
  // 보여 줄 범위: 영종도~송도 (지도 픽셀)
  const a = mapArt.toPx({ x: -26500, z: -19000 }), b = mapArt.toPx({ x: 12500, z: 11500 });
  Object.assign(bigMapView, { x0: a.x, y0: a.y, w: b.x - a.x, h: b.y - a.y });
  mc.width = 1000; mc.height = Math.round((1000 * bigMapView.h) / bigMapView.w);
  const g = mc.getContext('2d')!;
  g.fillStyle = '#28546d'; g.fillRect(0, 0, mc.width, mc.height);
  g.drawImage(mapArt.canvas, bigMapView.x0, bigMapView.y0, bigMapView.w, bigMapView.h, 0, 0, mc.width, mc.height);
  const s = mc.width / bigMapView.w;
  const P = (p: P2) => { const q = mapArt.toPx(p); return [(q.x - bigMapView.x0) * s, (q.y - bigMapView.y0) * s] as const; };
  g.font = '12px sans-serif';
  for (const l of LANDMARKS) {
    const [x, y] = P(l.at);
    g.fillStyle = '#ffcc33'; g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillText(l.name, x + 6, y + 5);
    g.fillStyle = '#fff'; g.fillText(l.name, x + 5, y + 4);
  }
  const me = mode === 'fly' ? plane.pos : walker.pos;
  const [mx, my] = P({ x: me.x, z: me.z });
  g.fillStyle = '#ff3b30'; g.strokeStyle = '#fff'; g.lineWidth = 2;
  g.beginPath(); g.arc(mx, my, 6, 0, Math.PI * 2); g.fill(); g.stroke();
  if (plane && mode === 'walk') { const [px, py] = P({ x: plane.pos.x, z: plane.pos.z }); g.fillStyle = '#4fc3f7'; g.beginPath(); g.arc(px, py, 5, 0, Math.PI * 2); g.fill(); g.stroke(); }
  g.fillStyle = '#fff'; g.font = 'bold 13px sans-serif';
  g.fillText(`축척: 1 km = ${((1000 / mapArt.scale) * s).toFixed(0)} px`, 10, mc.height - 10);
  g.font = '11px sans-serif'; g.fillStyle = 'rgba(255,255,255,0.8)';
  g.fillText('© OpenStreetMap 기여자, Overture Maps', mc.width - 230, mc.height - 10);
}

// ───────────────────────── 시작 화면 ─────────────────────────
$('#sd-tod').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b?.dataset.t) return;
  env.set(b.dataset.t as TimeOfDay);
  $('#sd-tod').querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
});
$('#sd-start .choices').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  const s = b?.dataset.start;
  if (!s) return;
  audio.unlock();
  started = true;
  $('#sd-start').classList.add('hidden');
  $('#sd-hud').classList.remove('hidden');
  setupTouch();
  if (s === 'airliner' || s === 'light') spawnRunway(s);
  else if (s === 'walk') { spawnWalk(landmark('park').at); camYaw = 2.2; }
  else { spawnWalk(landmark('park').at); toggleMap(); }
});

// ───────────────────────── 매 프레임 ─────────────────────────
const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`);
let hudTimer = 0, placeTimer = 0;
const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler();

function flightInput(): FlightInput {
  const up = k('ArrowUp') ? 1 : 0, down = k('ArrowDown') ? 1 : 0;
  const left = k('ArrowLeft') ? 1 : 0, right = k('ArrowRight') ? 1 : 0;
  const pitch = THREE.MathUtils.clamp(down - up - touch.y, -1, 1);
  const roll = THREE.MathUtils.clamp(right - left + touch.x, -1, 1);
  const yaw = (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0) + (plane.onGround ? touch.x : 0);
  return { pitch: Math.abs(pitch) < 0.08 ? 0 : pitch, roll: Math.abs(roll) < 0.08 ? 0 : roll, yaw: THREE.MathUtils.clamp(yaw, -1, 1), throttle: throttleCmd, brake: k('KeyB') || touch.brake };
}

function physics(dt: number) {
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / steps;
  if (mode === 'fly' && piloting) {
    if (k('KeyW') || touch.thrUp) throttleCmd = Math.min(1, throttleCmd + h * 0.6 * steps);
    if (k('KeyS') || touch.thrDn) throttleCmd = Math.max(0, throttleCmd - h * 0.6 * steps);
  }
  const wasCrashed = !!plane.crashed;
  const inp: FlightInput = mode === 'fly' && piloting ? flightInput() : { pitch: 0, roll: 0, yaw: 0, throttle: piloting ? throttleCmd : 0, brake: !piloting };
  for (let i = 0; i < steps; i++) plane.step(h, inp, world);
  if (!wasCrashed && plane.crashed) onCrash();
  if (mode === 'walk') {
    const fwd = (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0) - touch.y;
    const side = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0) + touch.x;
    for (let i = 0; i < steps; i++) walker.step(h, { fwd, side, run: k('ShiftLeft', 'ShiftRight') || touch.run, jump: k('Space') || touch.jump, camYaw }, world);
  }
}

function onCrash() {
  audio.crash();
  const p = plane.pos.clone();
  const fire = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.95, depthWrite: false }));
  fire.position.copy(p);
  scene.add(fire);
  fx.push({ mesh: fire, t: 0, kind: 'fire' });
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshStandardMaterial({ color: 0x2b2b2b, transparent: true, opacity: 0.7, depthWrite: false, roughness: 1 }));
    s.position.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * 10, Math.random() * 5, (Math.random() - 0.5) * 10));
    scene.add(s);
    fx.push({ mesh: s, t: -i * 0.15, kind: 'smoke' });
  }
  planeModel.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.material = (m.material as THREE.Material).clone(); ((m.material as THREE.MeshStandardMaterial).color)?.multiplyScalar(0.25); } });
  if (mode === 'fly' && piloting) showMsg(`<h2>추락!</h2>${plane.crashed}<br><br><kbd>R</kbd> 활주로에서 다시 시작 · <kbd>F</kbd> 내려서 걷기 · <kbd>M</kbd> 지도`);
  else toast(`비행기가 추락했습니다: ${plane.crashed}`, 4);
}

function updateFx(dt: number) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    f.t += dt;
    if (f.t < 0) continue;
    const m = f.mesh.material as THREE.MeshBasicMaterial;
    if (f.kind === 'fire') {
      f.mesh.scale.setScalar(4 + f.t * 40);
      m.opacity = Math.max(0, 0.95 - f.t * 1.2);
      if (f.t > 0.9) { scene.remove(f.mesh); fx.splice(i, 1); }
    } else {
      f.mesh.scale.setScalar(3 + f.t * 6);
      f.mesh.position.y += dt * 6;
      m.opacity = Math.max(0, 0.7 - f.t * 0.08);
      if (f.t > 9) { scene.remove(f.mesh); fx.splice(i, 1); }
    }
  }
}

function syncModels(dt: number) {
  planeModel.root.position.copy(plane.pos);
  planeModel.root.quaternion.copy(plane.q);
  for (const g of planeModel.gear) g.visible = plane.gearDown;
  if (planeModel.prop) planeModel.prop.rotation.z += dt * (8 + plane.throttle * 120);
  planeModel.root.visible = !(mode === 'fly' && camMode === 'cockpit');
  if (mode === 'walk') {
    walker.animate(person);
    person.root.visible = walkCam === 'third';
  }
}

function updateCamera(dt: number) {
  if (mode === 'fly') {
    const e = plane.euler();
    if (camMode === 'chase') {
      // 기수 방향을 부드럽게 따라가기
      let d = e.y - chaseYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      chaseYaw += d * Math.min(1, dt * 3);
      orbitIdle += dt;
      if (orbitIdle > 2.5 && !dragging) { orbitYaw *= Math.exp(-dt * 1.5); orbitPitch *= Math.exp(-dt * 1.5); }
      const dist = (plane.spec.id === 'airliner' ? 72 : 20) * zoom;
      const yaw = chaseYaw + orbitYaw;
      const pitch = 0.17 + orbitPitch - e.x * 0.35;
      const target = tmpV.copy(plane.pos).add(new THREE.Vector3(0, plane.spec.id === 'airliner' ? 4 : 1.2, 0));
      camera.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * dist, target.y + Math.sin(pitch) * dist, target.z + Math.cos(yaw) * Math.cos(pitch) * dist);
      const gy = Math.max(hf.at(camera.position.x, camera.position.z), 0) + 1.5;
      if (camera.position.y < gy) camera.position.y = gy;
      camera.up.set(0, 1, 0);
      camera.lookAt(target);
    } else {
      plane.axes();
      const seat = plane.spec.id === 'airliner' ? new THREE.Vector3(0, 1.3, -15.2) : new THREE.Vector3(0, 0.75, -0.7);
      camera.position.copy(seat.applyQuaternion(plane.q).add(plane.pos));
      tmpQ.setFromEuler(tmpE.set(-0.08 + orbitPitch * -0.6, orbitYaw, 0, 'YXZ'));
      camera.quaternion.copy(plane.q).multiply(tmpQ);
      orbitIdle += dt;
      if (orbitIdle > 2.5 && !dragging) { orbitYaw *= Math.exp(-dt * 1.5); orbitPitch *= Math.exp(-dt * 1.5); }
    }
    camera.fov = 60;
  } else {
    const head = tmpV.copy(walker.pos).add(new THREE.Vector3(0, walker.swimming ? 0.5 : 1.6, 0));
    if (walkCam === 'third') {
      const dist = (walker.chute ? 14 : 4.5) * zoom;
      camera.position.set(head.x + Math.sin(camYaw) * Math.cos(camPitch) * dist, head.y + Math.sin(camPitch) * dist, head.z + Math.cos(camYaw) * Math.cos(camPitch) * dist);
      const gy = world.ground(camera.position.x, camera.position.z, camera.position.y).h + 0.4;
      if (camera.position.y < gy) camera.position.y = gy;
      camera.lookAt(head);
    } else {
      camera.position.copy(head);
      camera.quaternion.setFromEuler(tmpE.set(camPitch * 1, camYaw, 0, 'YXZ'));
    }
    camera.fov = 70;
  }
  camera.updateProjectionMatrix();
}

// ── HUD ──
const att = ($('#sd-att') as HTMLCanvasElement).getContext('2d')!;
const mini = ($('#sd-mini') as HTMLCanvasElement).getContext('2d')!;
function drawAttitude() {
  const e = plane.euler();
  const S = 260, c = S / 2;
  att.save();
  att.clearRect(0, 0, S, S);
  att.beginPath(); att.arc(c, c, c - 2, 0, Math.PI * 2); att.clip();
  att.translate(c, c);
  att.rotate(e.z);
  const pp = e.x * 260; // 1 rad = 260px
  att.fillStyle = '#3d7fc4'; att.fillRect(-S, -S * 2 + pp, S * 2, S * 2);
  att.fillStyle = '#8a5a32'; att.fillRect(-S, pp, S * 2, S * 2);
  att.strokeStyle = '#fff'; att.lineWidth = 2;
  att.beginPath(); att.moveTo(-S, pp); att.lineTo(S, pp); att.stroke();
  att.font = '16px sans-serif'; att.fillStyle = '#fff'; att.textAlign = 'center';
  for (let d = -30; d <= 30; d += 10) {
    if (!d) continue;
    const y = pp - (d * Math.PI / 180) * 260;
    att.beginPath(); att.moveTo(-30, y); att.lineTo(30, y); att.stroke();
    att.fillText(String(Math.abs(d)), 48, y + 5);
  }
  att.restore();
  att.strokeStyle = '#ffd400'; att.lineWidth = 5;
  att.beginPath(); att.moveTo(c - 70, c); att.lineTo(c - 25, c); att.lineTo(c - 12, c + 14); att.moveTo(c + 70, c); att.lineTo(c + 25, c); att.lineTo(c + 12, c + 14); att.stroke();
  att.beginPath(); att.arc(c, c, 4, 0, Math.PI * 2); att.fillStyle = '#ffd400'; att.fill();
  att.beginPath(); att.arc(c, c, c - 2, 0, Math.PI * 2); att.lineWidth = 3; att.strokeStyle = 'rgba(255,255,255,0.4)'; att.stroke();
}

function updateHud(realDt: number) {
  hudTimer -= realDt; placeTimer -= realDt;
  if (toastTimer > 0) { toastTimer -= realDt; if (toastTimer <= 0) $('#sd-toast').classList.add('hidden'); }
  const me = mode === 'fly' ? plane.pos : walker.pos;
  if (placeTimer <= 0) {
    placeTimer = 0.5;
    $('#sd-top .place').textContent = placeName({ x: me.x, z: me.z }, hf.waterAt(me.x, me.z) === 2);
    $('#sd-top .mode').textContent = `${mode === 'fly' ? '✈ ' + plane.spec.name : walker.chute ? '🪂 낙하산' : walker.swimming ? '🏊 수영' : '🚶 걷기'} · ${TIME_LABEL[env.time]}`;
    const ll = toLatLon({ x: me.x, z: me.z });
    $('#sd-top .coord').textContent = `${ll.lat.toFixed(4)}°N ${ll.lon.toFixed(4)}°E`;
  }
  if (mode === 'fly') drawAttitude();
  const heading = mode === 'fly' ? plane.heading : ((-camYaw * 180) / Math.PI % 360 + 360) % 360;
  const span = mode === 'fly' ? THREE.MathUtils.clamp(3000 + (plane.pos.y - plane.groundH) * 8, 3000, 16000) : 1600;
  const extra = mode === 'walk' && plane ? [{ at: { x: plane.pos.x, z: plane.pos.z }, color: '#4fc3f7' }] : [];
  mapArt.drawMini(mini, { x: me.x, z: me.z }, span, heading, extra);
  if (hudTimer > 0) return;
  hudTimer = 0.1;
  const hint = $('#sd-hint');
  if (mode === 'fly') {
    const v = plane.speed;
    $('#sd-flight .spd').textContent = `${Math.round(v * 3.6)} km/h`;
    $('#sd-flight .spd2').textContent = `${Math.round(v * 1.944)} kt`;
    const agl = plane.pos.y - plane.spec.gearH - plane.groundH;
    $('#sd-flight .alt').textContent = `${Math.round(plane.pos.y - plane.spec.gearH)} m`;
    $('#sd-flight .alt2').textContent = `지면 위 ${Math.max(0, Math.round(agl))} m · ${Math.round((plane.pos.y - plane.spec.gearH) * 3.281)} ft`;
    $('#sd-flight .hdg').textContent = `${String(Math.round(plane.heading) % 360).padStart(3, '0')}°`;
    $('#sd-flight .vs').textContent = `승강 ${plane.vel.y >= 0 ? '+' : ''}${plane.vel.y.toFixed(1)} m/s`;
    ($('#sd-flight .thr span')).style.height = `${Math.round(plane.throttle * 100)}%`;
    const tags: string[] = [];
    tags.push(`<span class="tag ${plane.gearDown ? 'on' : ''}">기어 ${plane.gearDown ? '내림' : '올림'}</span>`);
    tags.push(`<span class="tag">추력 ${Math.round(plane.throttle * 100)}%</span>`);
    if (k('KeyB') || touch.brake) tags.push('<span class="tag on">브레이크</span>');
    if (plane.onGround) tags.push('<span class="tag on">지상</span>');
    if (plane.stall) tags.push('<span class="tag warn">실속!</span>');
    if (!plane.onGround && agl < 150 && plane.vel.y < -12) tags.push('<span class="tag warn">PULL UP</span>');
    if (!plane.onGround && agl < 300 && !plane.gearDown && plane.vel.y < -1 && v < (plane.spec.id === 'airliner' ? 110 : 45)) tags.push('<span class="tag warn">기어!</span>');
    $('#sd-flight .tags').innerHTML = tags.join('');
    let h = '';
    if (plane.crashed) h = '';
    else if (plane.onGround && plane.throttle < 0.05 && v < 1) h = '<kbd>W</kbd> 를 눌러 추력을 올리세요';
    else if (plane.onGround && v > plane.spec.vRot * 0.9) h = '지금 <kbd>↓</kbd> 를 눌러 기수를 드세요!';
    else if (plane.onGround && v > 3) h = `이륙 속도 ${Math.round(plane.spec.vRot * 3.6)} km/h 까지 가속 중…`;
    else if (!plane.onGround && agl < 200 && plane.gearDown && plane.vel.y > 2) h = '<kbd>G</kbd> 로 착륙장치를 올리세요';
    hint.innerHTML = h;
    hint.classList.toggle('hidden', !h);
  } else {
    const d = walker.pos.distanceTo(plane.pos);
    const reach = plane.spec.id === 'airliner' ? 24 : 8;
    const near = d < reach && !plane.crashed;
    $('#sd-walk').innerHTML = `${walker.chute ? '🪂 낙하 중' : walker.swimming ? '🏊 수영 중' : walker.speed > 4 ? '🏃 달리는 중' : '🚶 걷는 중'} · ${(walker.speed * 3.6).toFixed(0)} km/h · 비행기까지 ${fmtDist(d)}`;
    const h = near ? '<kbd>F</kbd> 비행기 타기' : walker.chute ? '방향키로 낙하 방향 조절' : '';
    hint.innerHTML = h;
    hint.classList.toggle('hidden', !h);
  }
}

// ── 루프 ──
let last = performance.now();
function loop(now: number) {
  requestAnimationFrame(loop);
  const realDt = (now - last) / 1000;
  const dt = Math.min(0.05, realDt);
  last = now;
  if (!world) return;
  if (started && !paused) {
    time += dt;
    physics(dt);
  }
  traffic.update(paused ? 0 : dt);
  buildings.update(camera.position);
  trees.update(camera.position);
  seaUpdate(now / 1000);
  updateFx(dt);
  syncModels(dt);
  updateCamera(dt);
  env.follow(camera.position.clone().setY(0).add(new THREE.Vector3(0, mode === 'fly' ? plane.pos.y * 0.5 : walker.pos.y, 0)));
  const vh = renderer.domElement.clientHeight;
  for (const s of lightSets) s.lp.update(now / 1000, s.day + (s.night - s.day) * nightU.value, vh);
  traffic.lights.visible = nightU.value > 0.3;
  if (started) {
    updateHud(realDt);
    audio.update(mode === 'fly' && !plane.crashed ? (plane.spec.id === 'airliner' ? 'jet' : 'prop') : 'none', plane.crashed ? 0 : plane.throttle, mode === 'fly' ? plane.speed : walker.chute ? 20 : 0);
  }
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── 시작 ──
void (async () => {
  env.set('day');
  await load();
  makePlane('airliner');
  placeParked();
  // 시작 화면 배경: 송도 상공에서 내려다보기
  mode = 'fly';
  piloting = false;
  const neatt = landmark('posco').at;
  plane.place(neatt.x - 2200, 380, neatt.z - 1600, 125, 0.0001);
  updateCamera(0);
  buildings.prime(camera.position);
  planeModel.root.visible = false;
  $('#sd-start').classList.remove('hidden');
  const params = new URLSearchParams(location.search);
  const t = params.get('time');
  if (t === 'night' || t === 'sunset') { env.set(t); $('#sd-tod').querySelectorAll<HTMLButtonElement>('button').forEach((x) => x.classList.toggle('sel', x.dataset.t === t)); }
  if (params.has('debug')) {
    (window as unknown as Record<string, unknown>).__sd = {
      THREE, scene, camera, renderer, env, world, get plane() { return plane; }, walker, keys, spawnRunway, spawnAir, spawnWalk, teleport, toggleBoard,
      setThrottle: (v: number) => { throttleCmd = v; }, LANDMARKS, hf, buildings, trees, landmark,
      start: (s: string) => (app.querySelector(`[data-start="${s}"]`) as HTMLButtonElement).click(),
      setCam: (m: 'chase' | 'cockpit') => { camMode = m; }, setWalkCam: (m: 'third' | 'first', yaw?: number, pitch?: number) => { walkCam = m; if (yaw !== undefined) camYaw = yaw; if (pitch !== undefined) camPitch = pitch; },
      setOrbit: (y: number, p: number) => { orbitYaw = y; orbitPitch = p; orbitIdle = -1e9; },
      setZoom: (z: number) => { zoom = z; }, info: () => renderer.info,
    };
  }
  requestAnimationFrame(loop);
})();

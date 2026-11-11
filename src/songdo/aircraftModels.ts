// 비행기·사람 모형 (기본 도형 조합, 창작 디자인). 기수 = 지역 -z, 원점 = 무게중심.
import * as THREE from 'three';

export interface PlaneModel {
  root: THREE.Group;
  gear: THREE.Object3D[];
  prop?: THREE.Object3D;
  /** 바퀴 바닥까지의 높이 (원점 아래) */
  gearH: number;
  /** 날개폭/길이 (충돌 표본점) */
  span: number;
  length: number;
}

const std = (color: number, rough = 0.45, metal = 0.25) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });

/** 여객기 (쌍발 협동체, 길이 38m, 날개폭 34m) */
export function makeAirlinerMesh(opt: { livery: number; accent: number }): THREE.Group {
  return makeAirliner(opt).root;
}

export function makeAirliner(opt: { livery: number; accent: number }): PlaneModel {
  const g = new THREE.Group();
  const body = std(0xf4f6f8, 0.35, 0.2);
  const liv = std(opt.livery, 0.4, 0.2);
  const acc = std(opt.accent, 0.4, 0.3);
  const dark = std(0x2a2d31, 0.6, 0.3);
  const glass = std(0x1c2630, 0.1, 0.6);
  const R = 2.0;
  // 동체
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 28, 20).rotateX(Math.PI / 2), body);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(R, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2).scale(1, 0.92, 2.2), body);
  nose.position.z = -14;
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(R, 0.45, 9, 20).rotateX(Math.PI / 2), body);
  tail.position.set(0, 0.6, 18.5);
  tail.scale.set(1, 1, 1);
  // 도색 띠
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.02, R + 0.02, 30, 20, 1, true, Math.PI * 0.5 - 0.35, 0.7).rotateX(Math.PI / 2), liv);
  const stripe2 = stripe.clone(); stripe2.rotation.z = Math.PI;
  const belly = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.015, R + 0.015, 30, 20, 1, true, Math.PI - 0.9, 1.8).rotateX(Math.PI / 2), liv);
  // 조종석 창
  const wind = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 1.2), glass);
  wind.position.set(0, 1.0, -15.4);
  wind.rotation.x = 0.5;
  // 객실 창 띠
  const wins = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.03, R + 0.03, 24, 20, 1, true, Math.PI / 2 - 0.9, 0.06).rotateX(Math.PI / 2), glass);
  const wins2 = wins.clone(); wins2.rotation.z = Math.PI; wins2.position.y = 0;
  wins.position.z = wins2.position.z = -1;
  g.add(fus, nose, tail, stripe, stripe2, belly, wind, wins, wins2);
  // 주날개 (뒤젖힘)
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0); wingShape.lineTo(17, 6.5); wingShape.lineTo(17, 8.0); wingShape.lineTo(0, 7.2); wingShape.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.45, bevelEnabled: false }).rotateX(Math.PI / 2);
  for (const s of [1, -1]) {
    const w = new THREE.Mesh(wingGeo, body);
    w.scale.x = s;
    w.position.set(0, -0.9, -3.5);
    w.rotation.z = s * 0.06;
    g.add(w);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.2, 1.4), acc);
    tip.position.set(s * 17, 0.2 + 0.0, 4.1);
    g.add(tip);
    // 엔진
    const eng = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 0.95, 4.2, 16).rotateX(Math.PI / 2), liv);
    eng.position.set(s * 5.8, -2.0, -2.2);
    const inlet = new THREE.Mesh(new THREE.CircleGeometry(1.0, 16), dark);
    inlet.position.set(s * 5.8, -2.0, -4.32);
    inlet.rotation.y = Math.PI;
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.2, 2.5), body);
    pylon.position.set(s * 5.8, -1.2, -1.2);
    g.add(eng, inlet, pylon);
  }
  // 수평 꼬리날개
  const hs = new THREE.Shape();
  hs.moveTo(0, 0); hs.lineTo(6.2, 3.0); hs.lineTo(6.2, 4.2); hs.lineTo(0, 4.2); hs.closePath();
  const hsGeo = new THREE.ExtrudeGeometry(hs, { depth: 0.3, bevelEnabled: false }).rotateX(Math.PI / 2);
  for (const s of [1, -1]) {
    const h = new THREE.Mesh(hsGeo, body);
    h.scale.x = s;
    h.position.set(0, 0.8, 17.5);
    g.add(h);
  }
  // 수직 꼬리날개
  const vs = new THREE.Shape();
  vs.moveTo(0, 0); vs.lineTo(5.0, 6.8); vs.lineTo(7.2, 6.8); vs.lineTo(6.5, 0); vs.closePath();
  const vsGeo = new THREE.ExtrudeGeometry(vs, { depth: 0.35, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(0.17, 0, 0);
  const fin = new THREE.Mesh(vsGeo, liv);
  fin.position.set(0, 1.4, 16.0);
  g.add(fin);
  // 착륙장치
  const gear: THREE.Object3D[] = [];
  const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.5, 12).rotateZ(Math.PI / 2);
  const strutGeo = new THREE.CylinderGeometry(0.15, 0.15, 2.2, 6);
  const mk = (x: number, z: number) => {
    const grp = new THREE.Group();
    const st = new THREE.Mesh(strutGeo, dark); st.position.y = -1.9;
    const w1 = new THREE.Mesh(wheelGeo, dark); w1.position.set(0.35, -3.05, 0);
    const w2 = new THREE.Mesh(wheelGeo, dark); w2.position.set(-0.35, -3.05, 0);
    grp.add(st, w1, w2);
    grp.position.set(x, 0, z);
    g.add(grp);
    gear.push(grp);
  };
  mk(0, -11.5); mk(3.0, 0.5); mk(-3.0, 0.5);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; } });
  return { root: g, gear, gearH: 3.6, span: 34, length: 38 };
}

/** 경비행기 (고익 단발, 길이 8m, 날개폭 11m) */
export function makeLightPlane(): PlaneModel {
  const g = new THREE.Group();
  const white = std(0xf6f6f2, 0.4, 0.1);
  const red = std(0xc23b2e, 0.4, 0.15);
  const dark = std(0x26292c, 0.6, 0.2);
  const glass = std(0x26323d, 0.08, 0.5);
  const fus = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.35, 4.2), white);
  fus.position.set(0, 0, -0.4);
  const cowl = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 1.2, 14).rotateX(Math.PI / 2), red);
  cowl.position.set(0, -0.05, -3.0);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.6, 3.6, 10).rotateX(Math.PI / 2), white);
  boom.position.set(0, 0.15, 3.4);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.7, 1.8), glass);
  cabin.position.set(0, 0.75, -0.9);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.18, 4.0), red);
  stripe.position.set(0, -0.15, 0);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(11, 0.18, 1.5), white);
  wing.position.set(0, 1.15, -0.8);
  const wtip = new THREE.Mesh(new THREE.BoxGeometry(11.02, 0.2, 0.3), red);
  wtip.position.set(0, 1.15, -1.4);
  const hs = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.1, 0.9), white);
  hs.position.set(0, 0.3, 4.9);
  const vs = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.5, 1.0), red);
  vs.position.set(0, 1.0, 5.0);
  vs.rotation.x = -0.35;
  // 날개 지주
  for (const s of [1, -1]) {
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.4, 5), dark);
    st.position.set(s * 1.6, 0.35, -0.7);
    st.rotation.z = s * 1.0;
    g.add(st);
  }
  const prop = new THREE.Group();
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.9, 0.05), dark);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.95, 24), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.12, depthWrite: false }));
  prop.add(blade, disc);
  prop.position.set(0, -0.05, -3.65);
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.4, 10).rotateX(-Math.PI / 2), red);
  spinner.position.set(0, -0.05, -3.8);
  g.add(fus, cowl, boom, cabin, stripe, wing, wtip, hs, vs, prop, spinner);
  const gear: THREE.Object3D[] = [];
  const wheelGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.16, 12).rotateZ(Math.PI / 2);
  for (const [x, z] of [[0, -2.6], [1.1, -0.1], [-1.1, -0.1]]) {
    const grp = new THREE.Group();
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.8, 5), dark); st.position.y = -0.85;
    const w = new THREE.Mesh(wheelGeo, dark); w.position.y = -1.15;
    grp.add(st, w);
    grp.position.set(x, 0, z);
    g.add(grp);
    gear.push(grp);
  }
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return { root: g, gear, prop, gearH: 1.43, span: 11, length: 8.2 };
}

export interface PersonModel {
  root: THREE.Group;
  legL: THREE.Object3D; legR: THREE.Object3D; armL: THREE.Object3D; armR: THREE.Object3D;
  chute: THREE.Object3D;
}

/** 사람 (키 1.75m, 원점 = 발) */
export function makePerson(): PersonModel {
  const g = new THREE.Group();
  const skin = std(0xe0b899, 0.7, 0);
  const shirt = std(0x2f6fb3, 0.8, 0);
  const pants = std(0x2b2f3a, 0.8, 0);
  const shoe = std(0x1a1a1a, 0.7, 0);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.6, 0.26), shirt);
  torso.position.y = 1.2;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), skin);
  head.position.y = 1.64;
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.135, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), std(0x1d1a17, 0.9, 0));
  hair.position.y = 1.66;
  const limb = (w: number, h: number, mat: THREE.Material, x: number, y: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mat);
    m.position.y = -h / 2;
    pivot.add(m);
    return pivot;
  };
  const legL = limb(0.17, 0.88, pants, -0.12, 0.9);
  const legR = limb(0.17, 0.88, pants, 0.12, 0.9);
  for (const l of [legL, legR]) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.3), shoe); s.position.set(0, -0.86, -0.05); l.add(s); }
  const armL = limb(0.12, 0.62, shirt, -0.3, 1.47);
  const armR = limb(0.12, 0.62, shirt, 0.3, 1.47);
  for (const a of [armL, armR]) { const h = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 6), skin); h.position.y = -0.66; a.add(h); }
  // 낙하산
  const chute = new THREE.Group();
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(3.2, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2.6).scale(1.3, 0.6, 1),
    new THREE.MeshStandardMaterial({ color: 0xe8492f, side: THREE.DoubleSide, roughness: 0.8 }),
  );
  canopy.position.y = 6.2;
  chute.add(canopy);
  const lineMat = new THREE.LineBasicMaterial({ color: 0x333333 });
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    pts.push(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(Math.cos(a) * 3.0 * 1.3, 7.0, Math.sin(a) * 3.0));
  }
  chute.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
  chute.visible = false;
  g.add(torso, head, hair, legL, legR, armL, armR, chute);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return { root: g, legL, legR, armL, armR, chute };
}

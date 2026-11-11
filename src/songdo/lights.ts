// 불빛 점 (가로등·활주로등·항공장애등). 거리와 상관없이 최소 몇 픽셀은 보이게 그린다.
import * as THREE from 'three';

export class LightPoints {
  readonly points: THREE.Points;
  readonly mat: THREE.ShaderMaterial;
  constructor(pos: THREE.Vector3[], colors: THREE.Color[] | THREE.Color, opt: { size: number; minPx: number; maxPx: number; blink?: boolean }) {
    const n = pos.length;
    const p = new Float32Array(n * 3), c = new Float32Array(n * 3), ph = new Float32Array(n);
    pos.forEach((v, i) => {
      p.set([v.x, v.y, v.z], i * 3);
      const col = Array.isArray(colors) ? colors[i] : colors;
      c.set([col.r, col.g, col.b], i * 3);
      ph[i] = Math.random();
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: opt.size }, uMin: { value: opt.minPx }, uMax: { value: opt.maxPx },
        uScale: { value: 500 }, uOpacity: { value: 1 }, uTime: { value: 0 }, uBlink: { value: opt.blink ? 1 : 0 },
      },
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec3 color;
        attribute float phase;
        uniform float uSize, uMin, uMax, uScale, uTime, uBlink;
        varying vec3 vColor;
        varying float vOn;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float px = uSize * uScale / max(-mv.z, 0.1);
          gl_PointSize = clamp(px, uMin, uMax);
          vColor = color;
          vOn = uBlink > 0.5 ? step(0.55, fract(uTime * 0.75 + phase * 0.15)) : 1.0;
          // 아주 먼 불빛은 흐리게
          vOn *= clamp(1.4 - (-mv.z) / 30000.0, 0.15, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float uOpacity;
        varying vec3 vColor;
        varying float vOn;
        void main() {
          #include <logdepthbuf_fragment>
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d) * 2.0;
          float a = smoothstep(1.0, 0.0, r);
          a = a * a;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor * (1.0 + 2.0 * (1.0 - r)), a * uOpacity * vOn);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
  }
  update(time: number, opacity: number, viewportH: number) {
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uOpacity.value = opacity;
    this.mat.uniforms.uScale.value = viewportH / 2 / Math.tan((30 * Math.PI) / 180);
    this.points.visible = opacity > 0.01;
  }
}

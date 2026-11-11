// 지도 그림: 미니맵과 전체 지도(순간이동) 공용 바탕 그림.
import { HF, type HeightField } from './heightfield';
import { LANDMARKS, RUNWAYS, runwayEnds, type P2 } from './geo';
import type { RoadSeg } from './city';

export const MAP_SCALE = 25; // m / px

export class MapArt {
  readonly canvas: HTMLCanvasElement;
  constructor(hf: HeightField, roads: RoadSeg[], bridge: P2[]) {
    const W = Math.round((HF.x1 - HF.x0) / MAP_SCALE), H = Math.round((HF.z1 - HF.z0) / MAP_SCALE);
    // 높이장 → 작은 그림 → 확대
    const small = document.createElement('canvas');
    small.width = hf.nx; small.height = hf.nz;
    const sg = small.getContext('2d')!;
    const img = sg.createImageData(hf.nx, hf.nz);
    for (let j = 0; j < hf.nz; j++) for (let i = 0; i < hf.nx; i++) {
      const h = hf.h[j * hf.nx + i];
      const k = (j * hf.nx + i) * 4;
      let r: number, g: number, b: number;
      if (h < 0.3) { const d = Math.min(1, -h / 12); r = 40 - d * 12; g = 92 - d * 22; b = 120 - d * 15; }
      else if (h < 8) { r = 196; g = 196; b = 182; }
      else { const t = Math.min(1, h / 250); r = 120 - t * 50; g = 150 - t * 40; b = 100 - t * 40; }
      img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255;
    }
    sg.putImageData(img, 0, 0);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = true;
    g.drawImage(small, 0, 0, W, H);
    const px = (p: P2) => [(p.x - HF.x0) / MAP_SCALE, (p.z - HF.z0) / MAP_SCALE] as const;
    // 도로
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineCap = 'round';
    for (const r of roads) {
      g.lineWidth = Math.max(1, r.width / MAP_SCALE);
      g.beginPath(); g.moveTo(...px(r.a)); g.lineTo(...px(r.b)); g.stroke();
    }
    // 다리
    g.strokeStyle = '#f2f2f2'; g.lineWidth = 2.2;
    g.beginPath(); bridge.forEach((p, i) => (i ? g.lineTo(...px(p)) : g.moveTo(...px(p)))); g.stroke();
    // 활주로
    g.strokeStyle = '#33363b'; g.lineWidth = 3;
    for (const r of RUNWAYS) { const e = runwayEnds(r); g.beginPath(); g.moveTo(...px(e.a)); g.lineTo(...px(e.b)); g.stroke(); }
    this.canvas = c;
  }
  static toPx(p: P2) { return { x: (p.x - HF.x0) / MAP_SCALE, y: (p.z - HF.z0) / MAP_SCALE }; }
  static fromPx(x: number, y: number): P2 { return { x: x * MAP_SCALE + HF.x0, z: y * MAP_SCALE + HF.z0 }; }

  /** 미니맵: 중심 p, 폭 span(m), 북쪽 위 */
  drawMini(ctx: CanvasRenderingContext2D, p: P2, span: number, headingDeg: number, extra: { at: P2; color: string }[] = []) {
    const S = ctx.canvas.width;
    const c = MapArt.toPx(p);
    const srcW = span / MAP_SCALE;
    ctx.fillStyle = '#28546d';
    ctx.fillRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.canvas, c.x - srcW / 2, c.y - srcW / 2, srcW, srcW, 0, 0, S, S);
    const k = S / srcW;
    ctx.font = '10px sans-serif';
    for (const l of LANDMARKS) {
      const q = MapArt.toPx(l.at);
      const x = (q.x - c.x) * k + S / 2, y = (q.y - c.y) * k + S / 2;
      if (x < -20 || y < -20 || x > S + 20 || y > S + 20) continue;
      ctx.fillStyle = '#ffcc33';
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      if (span < 9000) { ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillText(l.name.split(' (')[0], x + 4, y + 3); }
    }
    for (const e of extra) {
      const q = MapArt.toPx(e.at);
      const x = (q.x - c.x) * k + S / 2, y = (q.y - c.y) * k + S / 2;
      ctx.fillStyle = e.color;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    }
    // 내 위치 화살표
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.rotate((headingDeg * Math.PI) / 180);
    ctx.fillStyle = '#ff3b30'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 3); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('N', S / 2 - 4, 12);
  }
}

// 지도 그림: 미니맵과 전체 지도(순간이동). 바탕은 지도 자료로 만든 땅 쓰임새 그림(ground.jpg).
import { LANDMARKS, type P2 } from './geo';
import type { Meta } from './data';

export class MapArt {
  readonly canvas: HTMLCanvasElement;
  readonly scale: number; // m / px
  private x0: number; private z0: number;
  constructor(img: HTMLImageElement | ImageBitmap, meta: Meta) {
    const [x0, z0, x1] = meta.bounds;
    this.x0 = x0; this.z0 = z0;
    this.canvas = document.createElement('canvas');
    this.canvas.width = img.width; this.canvas.height = img.height;
    this.canvas.getContext('2d')!.drawImage(img, 0, 0);
    this.scale = (x1 - x0) / img.width;
  }
  toPx(p: P2) { return { x: (p.x - this.x0) / this.scale, y: (p.z - this.z0) / this.scale }; }
  fromPx(x: number, y: number): P2 { return { x: x * this.scale + this.x0, z: y * this.scale + this.z0 }; }

  /** 미니맵: 중심 p, 폭 span(m), 북쪽 위 */
  drawMini(ctx: CanvasRenderingContext2D, p: P2, span: number, headingDeg: number, extra: { at: P2; color: string }[] = []) {
    const S = ctx.canvas.width;
    const c = this.toPx(p);
    const srcW = span / this.scale;
    ctx.fillStyle = '#2c5a70';
    ctx.fillRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.canvas, c.x - srcW / 2, c.y - srcW / 2, srcW, srcW, 0, 0, S, S);
    const k = S / srcW;
    ctx.font = `${Math.round(S / 26)}px sans-serif`;
    for (const l of LANDMARKS) {
      const q = this.toPx(l.at);
      const x = (q.x - c.x) * k + S / 2, y = (q.y - c.y) * k + S / 2;
      if (x < -20 || y < -20 || x > S + 20 || y > S + 20) continue;
      ctx.fillStyle = '#ffcc33';
      ctx.beginPath(); ctx.arc(x, y, S / 90, 0, Math.PI * 2); ctx.fill();
      if (span < 7000) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillText(l.name.split(' (')[0], x + 5, y + 4);
        ctx.fillStyle = '#fff'; ctx.fillText(l.name.split(' (')[0], x + 4, y + 3);
      }
    }
    for (const e of extra) {
      const q = this.toPx(e.at);
      const x = (q.x - c.x) * k + S / 2, y = (q.y - c.y) * k + S / 2;
      ctx.fillStyle = e.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, S / 50, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.rotate((headingDeg * Math.PI) / 180);
    const a = S / 22;
    ctx.fillStyle = '#ff3b30'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -a * 1.4); ctx.lineTo(a, a); ctx.lineTo(0, a * 0.45); ctx.lineTo(-a, a); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(S / 18)}px sans-serif`; ctx.fillText('N', S / 2 - S / 50, S / 14);
  }
}

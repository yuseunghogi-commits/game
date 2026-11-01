// 전력 배분 (Baseline §10.7, 결정 S-08).
// 지역 허브 = 노드, 지역 간 선로 = 엣지. 손실은 지역 간 선로에만.
// 규칙:
//  - 선로 용량은 송전단(입력) 기준, DI마다 엣지당 순 흐름 한 방향 (§10.8)
//  - 수전 = floor(송전 × (1 − 손실률)), 손실 = 송전 − 수전 (정수 Wh)
//  - 탐욕적 배분: 순가치 = 수요처 가치 × 경로 이득 − 공급 변동비 가 가장 큰 조합부터 (메리트 오더)
//  - 동률은 입력 순서(키 정렬)로 결정 → 결정적
// 이 방식은 최적해를 보장하지 않지만 용량을 넘지 않고 에너지를 보존한다.

import { PPM } from './units';

export const MIN_TRANSFER_WH = 1_000;

export interface Unit { key: string; node: number; availWh: number; cost: number }
export interface Sink { key: string; node: number; capWh: number; value: number; localOnly?: boolean }
export interface Edge { id: number; a: number; b: number; capWh: number; lossPpm: number; usable: boolean }

export interface Flow { unit: string; sink: string; sentWh: number; deliveredWh: number; edges: number[] }
export interface EdgeUse { dir: 1 | -1; sentWh: number; lossWh: number }

export interface AllocResult {
  flows: Flow[];
  edgeUse: Map<number, EdgeUse>;
  unitUsed: Map<string, number>;
  sinkUsed: Map<string, number>;
}

interface Path { gain: number; hops: { edge: Edge; dir: 1 | -1 }[] }

/** src에서 각 노드로 가는 최대 이득 경로 (Dijkstra, 가중치 −log g). */
function bestPaths(src: number, nodeCount: number, edges: Edge[], res: Map<number, number>, dir: Map<number, 0 | 1 | -1>): (Path | null)[] {
  const gain = new Array<number>(nodeCount).fill(0);
  const prev = new Array<{ edge: Edge; dir: 1 | -1; from: number } | null>(nodeCount).fill(null);
  const done = new Array<boolean>(nodeCount).fill(false);
  gain[src] = 1;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodeCount; i++) if (!done[i] && gain[i] > 0 && (u < 0 || gain[i] > gain[u])) u = i;
    if (u < 0) break;
    done[u] = true;
    for (const e of edges) {
      if (!e.usable || (res.get(e.id) ?? 0) <= 0) continue;
      let v = -1, d: 1 | -1 = 1;
      if (e.a === u) { v = e.b; d = 1; } else if (e.b === u) { v = e.a; d = -1; } else continue;
      const locked = dir.get(e.id) ?? 0;
      if (locked !== 0 && locked !== d) continue;
      const g = gain[u] * ((PPM - e.lossPpm) / PPM);
      if (g > gain[v] + 1e-12) { gain[v] = g; prev[v] = { edge: e, dir: d, from: u }; }
    }
  }
  return gain.map((g, v) => {
    if (g <= 0) return null;
    const hops: { edge: Edge; dir: 1 | -1 }[] = [];
    let cur = v;
    while (cur !== src) { const p = prev[cur]!; hops.unshift({ edge: p.edge, dir: p.dir }); cur = p.from; }
    return { gain: g, hops };
  });
}

export function allocate(nodeCount: number, units: Unit[], sinks: Sink[], edges: Edge[]): AllocResult {
  const unitRes = new Map(units.map((u) => [u.key, u.availWh]));
  const sinkRes = new Map(sinks.map((s) => [s.key, s.capWh]));
  const edgeRes = new Map(edges.map((e) => [e.id, e.usable ? e.capWh : 0]));
  const edgeDir = new Map<number, 0 | 1 | -1>(edges.map((e) => [e.id, 0]));
  const blocked = new Set<string>();
  const out: AllocResult = { flows: [], edgeUse: new Map(), unitUsed: new Map(), sinkUsed: new Map() };

  for (let iter = 0; iter < 5000; iter++) {
    const paths = new Map<number, (Path | null)[]>();
    let best: { u: Unit; s: Sink; p: Path; val: number } | null = null;
    for (const u of units) {
      if ((unitRes.get(u.key) ?? 0) <= 0) continue;
      if (!paths.has(u.node)) paths.set(u.node, bestPaths(u.node, nodeCount, edges, edgeRes, edgeDir));
      const ps = paths.get(u.node)!;
      for (const s of sinks) {
        if ((sinkRes.get(s.key) ?? 0) <= 0 || blocked.has(u.key + '|' + s.key)) continue;
        if (s.localOnly && s.node !== u.node) continue;
        const p = ps[s.node];
        if (!p) continue;
        const val = s.value * p.gain - u.cost;
        if (val > 0 && (!best || val > best.val + 1e-9)) best = { u, s, p, val };
      }
    }
    if (!best) break;
    const { u, s, p } = best;
    // 보낼 양 x의 상한: 공급 잔량, 각 엣지 잔여 용량(앞 구간 이득 반영), 수요처 잔량
    let x = unitRes.get(u.key)!;
    let prefix = 1;
    for (const h of p.hops) {
      x = Math.min(x, Math.floor((edgeRes.get(h.edge.id)! ) / prefix));
      prefix *= (PPM - h.edge.lossPpm) / PPM;
    }
    x = Math.min(x, Math.floor(sinkRes.get(s.key)! / p.gain));
    // 1 kWh 미만 잔량은 보내지 않는다 (반올림으로 생기는 미세 흐름·손실 반복 방지)
    if (x < MIN_TRANSFER_WH) { blocked.add(u.key + '|' + s.key); continue; }
    // 정수 구간별 전송
    let amount = x;
    for (const h of p.hops) {
      const e = h.edge;
      const delivered = Math.floor((amount * (PPM - e.lossPpm)) / PPM);
      edgeRes.set(e.id, edgeRes.get(e.id)! - amount);
      edgeDir.set(e.id, h.dir);
      const use = out.edgeUse.get(e.id) ?? { dir: h.dir, sentWh: 0, lossWh: 0 };
      use.sentWh += amount;
      use.lossWh += amount - delivered;
      out.edgeUse.set(e.id, use);
      amount = delivered;
    }
    unitRes.set(u.key, unitRes.get(u.key)! - x);
    sinkRes.set(s.key, sinkRes.get(s.key)! - amount);
    out.unitUsed.set(u.key, (out.unitUsed.get(u.key) ?? 0) + x);
    out.sinkUsed.set(s.key, (out.sinkUsed.get(s.key) ?? 0) + amount);
    out.flows.push({ unit: u.key, sink: s.key, sentWh: x, deliveredWh: amount, edges: p.hops.map((h) => h.edge.id) });
  }
  return out;
}

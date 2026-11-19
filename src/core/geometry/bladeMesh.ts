import type { Stage } from '../types';
import { clamp, v3, type Vec3 } from '../math/vec3';
import { bladeNormalWorld, bladePhaseRad, bladeSurfacePoint } from './airfoil';

export const SPAN_SEGMENTS = 48;
export const CHORD_SEGMENTS = 32;

export interface Triangle {
  a: number;
  b: number;
  c: number;
}

export interface Vertex {
  pos: Vec3;
  spanPct: number;
  chordT: number;
  surface: 0 | 1; // 0 suction, 1 pressure
  bladeIndex: number;
}

export interface BladeMesh {
  vertices: Vertex[];
  triangles: Triangle[];
  bvh: BvhNode[];
  bounds: [Vec3, Vec3];
}

interface BvhNode {
  min: Vec3;
  max: Vec3;
  left: number; // 内部节点：左子；叶子：-1
  right: number; // 内部节点：右子；叶子：-1
  triStart: number; // 叶子：triangles 区间起点
  triCount: number; // 叶子：三角形数
}

function emptyBounds(): [Vec3, Vec3] {
  return [
    [Infinity, Infinity, Infinity],
    [-Infinity, -Infinity, -Infinity],
  ];
}
function expandBounds(b: [Vec3, Vec3], p: Vec3): void {
  for (let i = 0; i < 3; i++) {
    if (p[i] < b[0][i]) b[0][i] = p[i];
    if (p[i] > b[1][i]) b[1][i] = p[i];
  }
}
function rayAabb(origin: Vec3, dir: Vec3, min: Vec3, max: Vec3): boolean {
  let tmin = 0;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-12) {
      if (origin[i] < min[i] || origin[i] > max[i]) return false;
    } else {
      let t1 = (min[i] - origin[i]) / dir[i];
      let t2 = (max[i] - origin[i]) / dir[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}

/** 构建整圈叶片网格（转子按当前盘车角，静子不动） */
export function buildStageMesh(stage: Stage, crankDeg: number): BladeMesh {
  const vertices: Vertex[] = [];
  const triangles: Triangle[] = [];

  for (let blade = 1; blade <= stage.bladeCount; blade++) {
    const phi = bladePhaseRad(stage, blade, crankDeg);
    const cols = CHORD_SEGMENTS + 1;
    const rows = SPAN_SEGMENTS + 1;
    const base = vertices.length;

    // 吸力面 + 压力面
    for (const surf of [0, 1] as const) {
      const surface = surf === 0 ? 'suction' : 'pressure';
      const surfBase = vertices.length;
      for (let i = 0; i <= SPAN_SEGMENTS; i++) {
        const spanPct = i / SPAN_SEGMENTS;
        for (let j = 0; j <= CHORD_SEGMENTS; j++) {
          const chordT = j / CHORD_SEGMENTS;
          const local = bladeSurfacePoint(stage, spanPct, chordT, surface);
          const pos = v3.rotateX(local, phi);
          vertices.push({ pos, spanPct, chordT, surface: surf, bladeIndex: blade });
        }
      }
      for (let i = 0; i < SPAN_SEGMENTS; i++) {
        for (let j = 0; j < CHORD_SEGMENTS; j++) {
          const p00 = surfBase + i * cols + j;
          const p10 = p00 + 1;
          const p01 = p00 + cols;
          const p11 = p01 + 1;
          // 两面统一绕序；正面/背面判定不依赖几何绕序，
          // 而在 raycastBlades 中按顶点 surface 标识与解析外法线比对（见 front-facing 检查）
          triangles.push({ a: p00, b: p01, c: p11 }, { a: p00, b: p11, c: p10 });
        }
      }
    }

    // 叶根/叶尖封口
    const tipBase = base + rows * cols;
    const cap = (spanIdx: number, isTip: boolean) => {
      const suckRow = base + spanIdx * cols;
      const pressRow = tipBase + spanIdx * cols;
      for (let j = 0; j < CHORD_SEGMENTS; j++) {
        const a = suckRow + j;
        const b = suckRow + j + 1;
        const c = pressRow + j;
        const d = pressRow + j + 1;
        if (isTip) triangles.push({ a, b: c, c: b }, { a: b, b: c, c: d });
        else triangles.push({ a, b: b, c }, { a: b, b: d, c });
      }
    };
    cap(0, false);
    cap(SPAN_SEGMENTS, true);
  }

  const bounds = emptyBounds();
  for (const vx of vertices) expandBounds(bounds, vx.pos);
  const bvh = buildBvh(vertices, triangles);
  return { vertices, triangles, bvh, bounds };
}

function triCenter(vertices: Vertex[], tri: Triangle): Vec3 {
  const a = vertices[tri.a].pos, b = vertices[tri.b].pos, c = vertices[tri.c].pos;
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

/**
 * 就地按 BVH 叶子区间重排 triangles，并构建节点数组。
 * 叶子节点 triStart/triCount 直接索引重排后的 triangles。
 * 迭代构建，避免整圈叶栅（数万三角形）深递归爆栈。
 */
function buildBvh(vertices: Vertex[], triangles: Triangle[]): BvhNode[] {
  const nodes: BvhNode[] = [];
  const order = triangles.map((_, i) => i);

  const boundsOf = (start: number, end: number): [Vec3, Vec3] => {
    const b = emptyBounds();
    for (let k = start; k < end; k++) {
      const tri = triangles[order[k]];
      for (const vi of [tri.a, tri.b, tri.c]) expandBounds(b, vertices[vi].pos);
    }
    return b;
  };

  interface Job { start: number; end: number; nodeIdx: number; }
  const rootBounds = boundsOf(0, order.length);
  nodes.push({ min: rootBounds[0], max: rootBounds[1], left: -1, right: -1, triStart: 0, triCount: order.length });
  const stack: Job[] = [{ start: 0, end: order.length, nodeIdx: 0 }];

  while (stack.length) {
    const { start, end, nodeIdx } = stack.pop()!;
    const count = end - start;
    if (count <= 6) continue;

    const node = nodes[nodeIdx];
    const extent: Vec3 = [
      node.max[0] - node.min[0],
      node.max[1] - node.min[1],
      node.max[2] - node.min[2],
    ];
    // 按最长轴排序选择；若该轴退化则依次尝试其它轴
    const axes = [0, 1, 2].sort((a, b) => extent[b] - extent[a]);
    let split = -1;
    for (const axis of axes) {
      if (extent[axis] < 1e-9) continue;
      const mid = (node.min[axis] + node.max[axis]) / 2;
      let i = start, j = end - 1;
      while (i <= j) {
        const c = triCenter(vertices, triangles[order[i]])[axis];
        if (c < mid) i++;
        else {
          const tmp = order[i];
          order[i] = order[j];
          order[j] = tmp;
          j--;
        }
      }
      if (i > start && i < end) {
        split = i;
        break;
      }
    }
    // 三个轴都退化（全部三角形共面/共点）：强制均分
    if (split === -1) split = start + Math.floor(count / 2);

    const [lmin, lmax] = boundsOf(start, split);
    const [rmin, rmax] = boundsOf(split, end);
    const leftIdx = nodes.length;
    nodes.push({ min: lmin, max: lmax, left: -1, right: -1, triStart: start, triCount: split - start });
    const rightIdx = nodes.length;
    nodes.push({ min: rmin, max: rmax, left: -1, right: -1, triStart: split, triCount: end - split });
    node.left = leftIdx;
    node.right = rightIdx;
    node.triStart = -1;
    node.triCount = 0;
    stack.push({ start, end: split, nodeIdx: leftIdx });
    stack.push({ start: split, end, nodeIdx: rightIdx });
  }

  // 按叶子顺序物理重排 triangles，使节点 triStart 直接可用
  const sorted = order.map((idx) => triangles[idx]);
  triangles.length = 0;
  for (const t of sorted) triangles.push(t);
  return nodes;
}

export interface RayHit {
  t: number;
  point: Vec3;
  normal: Vec3;
  spanPct: number;
  chordT: number;
  surface: 'suction' | 'pressure';
  bladeIndex: number;
}

const EPS = 1e-9;

function intersectTri(origin: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const edge1 = v3.sub(b, a);
  const edge2 = v3.sub(c, a);
  const h = v3.cross(dir, edge2);
  const det = v3.dot(edge1, h);
  if (Math.abs(det) < EPS) return null;
  const f = 1 / det;
  const s = v3.sub(origin, a);
  const u = f * v3.dot(s, h);
  if (u < 0 || u > 1) return null;
  const q = v3.cross(s, edge1);
  const v = f * v3.dot(dir, q);
  if (v < 0 || u + v > 1) return null;
  const t = f * v3.dot(edge2, q);
  return t > EPS ? t : null;
}

/** 解析外法线（世界坐标），与三角形绕序解耦，作为正面判定与着色法线的唯一真值 */
function vertexOutwardNormal(stage: Stage, v: Vertex, crankDeg: number): Vec3 {
  return bladeNormalWorld(stage, v.bladeIndex, crankDeg, v.spanPct, v.chordT, v.surface === 0 ? 'suction' : 'pressure');
}

/** 射线求交整圈叶栅，返回最近的正面命中；bladeFilter 限定指定叶片（孔探时已知观察目标） */
export function raycastBlades(
  mesh: BladeMesh,
  origin: Vec3,
  dir: Vec3,
  bladeFilter?: number,
  stage?: Stage,
  crankDeg = 0,
): RayHit | null {
  let bestT = Infinity;
  let best: RayHit | null = null;
  const stack = [0];
  while (stack.length) {
    const node = mesh.bvh[stack.pop()!];
    if (!rayAabb(origin, dir, node.min, node.max)) continue;
    if (node.triCount > 0) {
      for (let k = node.triStart; k < node.triStart + node.triCount; k++) {
        const tri = mesh.triangles[k];
        const va = mesh.vertices[tri.a];
        if (bladeFilter !== undefined && va.bladeIndex !== bladeFilter) continue;
        const vb = mesh.vertices[tri.b], vc = mesh.vertices[tri.c];
        // 正面剔除：用解析外法线（与网格绕序无关），背面不参与孔探可见面命中
        if (stage) {
          const n = vertexOutwardNormal(stage, va, crankDeg);
          if (v3.dot(n, dir) > -1e-9) continue;
        }
        const t = intersectTri(origin, dir, va.pos, vb.pos, vc.pos);
        if (t !== null && t < bestT) {
          bestT = t;
          best = makeHit(mesh, tri, t, origin, dir, stage, crankDeg);
        }
      }
    } else {
      stack.push(node.left, node.right);
    }
  }
  return best;
}

function makeHit(
  mesh: BladeMesh,
  tri: Triangle,
  t: number,
  origin: Vec3,
  dir: Vec3,
  stage?: Stage,
  crankDeg = 0,
): RayHit {
  const va = mesh.vertices[tri.a], vb = mesh.vertices[tri.b], vc = mesh.vertices[tri.c];
  const edge1 = v3.sub(vb.pos, va.pos);
  const edge2 = v3.sub(vc.pos, va.pos);
  const det = v3.dot(edge1, v3.cross(dir, edge2));
  const f = 1 / det;
  const s = v3.sub(origin, va.pos);
  const u = f * v3.dot(s, v3.cross(dir, edge2));
  const v = f * v3.dot(dir, v3.cross(s, edge1));
  const w = 1 - u - v;
  const point = v3.add(origin, v3.scale(dir, t));
  // 优先解析法线（绕序无关、连续光滑）；无 stage 时退回几何法线
  let normal: Vec3;
  if (stage) {
    const na = vertexOutwardNormal(stage, va, crankDeg);
    const nb = vertexOutwardNormal(stage, vb, crankDeg);
    const nc = vertexOutwardNormal(stage, vc, crankDeg);
    normal = v3.normalize(v3.add(v3.add(v3.scale(na, w), v3.scale(nb, u)), v3.scale(nc, v)));
  } else {
    normal = v3.normalize(v3.cross(edge1, edge2));
  }
  return {
    t,
    point,
    normal,
    bladeIndex: va.bladeIndex,
    spanPct: clamp(w * va.spanPct + u * vb.spanPct + v * vc.spanPct, 0, 1),
    chordT: clamp(w * va.chordT + u * vb.chordT + v * vc.chordT, 0, 1),
    surface: va.surface === 0 ? 'suction' : 'pressure',
  };
}

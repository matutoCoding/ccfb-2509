import type { LensView, Probe } from '../types';
import { deg2rad, v3, type Vec3 } from '../math/vec3';
import type { CameraRay } from '../geometry/backprojection';

export interface LensModel {
  fovDeg: number;
  k1: number; // 桶形畸变（通常为负）
  k2: number;
  vignette: number; // 0..1
  view: LensView;
}

export function lensFromProbe(probe: Probe): LensModel {
  return {
    fovDeg: probe.fovDeg,
    k1: probe.distortionK1,
    // 真实广角镜头径向级数：k1 主导桶形（负），k2 为正的小量高阶修正，
    // 保证 r_d(r_n) 在有效成像圈内单调可逆
    k2: Math.abs(probe.distortionK1) * 0.12,
    vignette: probe.vignette,
    view: probe.lens,
  };
}

/** 归一化像面坐标（x,y ∈ [-1,1]，y 向上）→ 带畸变的归一化半径缩放 */
export function distortPoint(lens: LensModel, nx: number, ny: number): [number, number] {
  const r2 = nx * nx + ny * ny;
  const factor = 1 + lens.k1 * r2 + lens.k2 * r2 * r2;
  return [nx * factor, ny * factor];
}

/**
 * 带畸变的像面点 → 无畸变像面坐标。
 * 径向畸变各向同性：r_d = r_n·(1+k1·r_n²+k2·r_n⁴)，方向不变。
 * 对 r_n 做二分求解（在 r_d 的单调包络内保证收敛，不依赖初值）。
 * 若像面点落在镜头单调可逆区之外（强桶形畸变的极端角落，物理上无有效成像），
 * 钳制到可逆边界并返回，避免外推发散。
 */
export function undistortPoint(lens: LensModel, dx: number, dy: number): [number, number] {
  const rd = Math.hypot(dx, dy);
  if (rd < 1e-12) return [dx, dy];
  const g = (rn: number): number => rn * (1 + lens.k1 * rn * rn + lens.k2 * rn ** 4);
  // 单调临界点：g'(r)=1+3k1·r²+5k2·r⁴ = 0（只在负畸变系数下存在）
  let rMax = Infinity;
  if (lens.k1 < 0) {
    const a = 5 * lens.k2;
    const b = 3 * lens.k1;
    if (Math.abs(a) > 1e-12) {
      const disc = b * b - 4 * a;
      if (disc >= 0) rMax = Math.sqrt((-b - Math.sqrt(disc)) / (2 * a));
    } else {
      rMax = Math.sqrt(-1 / b);
    }
  }
  let lo = 0;
  let hi = Number.isFinite(rMax) ? rMax : Math.max(rd, 1);
  const gMax = g(hi);
  if (rd >= gMax) {
    // 超出可逆区：钳制到边界解
    const scale = hi / rd;
    return [dx * scale, dy * scale];
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (g(mid) < rd) lo = mid;
    else hi = mid;
  }
  const rn = (lo + hi) / 2;
  const scale = rn / rd;
  return [dx * scale, dy * scale];
}

/** 当前镜头系数下，像面单调可逆的最大半径（NDC 单位），供 UI 提示有效成像圈 */
export function maxInvertibleRadius(lens: LensModel): number {
  if (lens.k1 >= 0) return Infinity;
  const a = 5 * lens.k2;
  const b = 3 * lens.k1;
  if (Math.abs(a) > 1e-12) {
    const disc = b * b - 4 * a;
    if (disc < 0) return Infinity;
    return Math.sqrt((-b - Math.sqrt(disc)) / (2 * a));
  }
  return Math.sqrt(-1 / b);
}

/** 暗角衰减系数（归一化半径 r ∈ [0,1]） */
export function vignetteFactor(lens: LensModel, rNorm: number): number {
  // cos^4 风格衰减 + 参数强度
  const base = Math.cos((Math.min(1, rNorm) * Math.PI) / 2);
  return 1 - lens.vignette * (1 - base * base * base * base);
}

export interface CameraPose {
  /** 镜头光心（探头头端） */
  position: Vec3;
  /** 光轴方向（单位向量） */
  forward: Vec3;
  /** 像面上"向上"的参考方向（单位向量，与 forward 正交） */
  up: Vec3;
}

function basis(pose: CameraPose): { right: Vec3; up: Vec3; f: Vec3 } {
  const f = v3.normalize(pose.forward);
  const right = v3.normalize(v3.cross(f, pose.up));
  const up = v3.cross(right, f);
  return { right, up, f };
}

/**
 * 像素坐标 → 世界射线。
 * width/height 为视窗分辨率，px/py 为像素（左上原点）。
 * fovDeg 为水平视场角；NDC 两轴均 ∈ [-1,1]，水平方向乘 aspect。
 * 广角 + 桶形畸变在这里反解，保证"点哪里反算哪里"与画面完全一致。
 */
export function pixelToRay(lens: LensModel, pose: CameraPose, width: number, height: number, px: number, py: number): CameraRay {
  const aspect = width / height;
  const tanHalf = Math.tan(deg2rad(lens.fovDeg) / 2);
  // 像素 → 归一化像面（-1..1，y 向上）；fovDeg 为水平 FOV
  const dx = ((px + 0.5) / width) * 2 - 1;
  const dy = 1 - ((py + 0.5) / height) * 2;
  const [nx, ny] = undistortPoint(lens, dx, dy);
  let dirLocal: Vec3 = [nx * tanHalf, (ny * tanHalf) / aspect, 1];
  if (lens.view === 'side') {
    // 侧视镜头：光轴折转 90°，局部 +Z 映射到侧视 +X
    dirLocal = [dirLocal[2], dirLocal[1], -dirLocal[0]];
  }
  const { right, up, f } = basis(pose);
  const dir = v3.normalize(
    v3.add(v3.add(v3.scale(right, dirLocal[0]), v3.scale(up, dirLocal[1])), v3.scale(f, dirLocal[2])),
  );
  return { origin: [...pose.position] as Vec3, dir };
}

/**
 * 世界点 → 无畸变归一化像面坐标 + 轴向深度（NDC 两轴 -1..1）。
 * 标注贴附走"无畸变 NDC"层，与 pixelToRay 的 undistort 严格互逆；
 * 桶形畸变只在最终成像（GPU 后处理 / distortPoint 显式调用）时施加。
 * 调用方需把同一 aspect 传入 ndcToPixel/worldToNdc 配对使用。
 */
export function worldToNdc(lens: LensModel, pose: CameraPose, point: Vec3, aspect = 4 / 3): [number, number, number] {
  const { right, up, f } = basis(pose);
  const rel = v3.sub(point, pose.position);
  let cx = v3.dot(rel, right);
  let cy = v3.dot(rel, up);
  let cz = v3.dot(rel, f);
  if (lens.view === 'side') {
    // 与 pixelToRay 的侧视映射互逆
    const nx = -cz, ny = cy, nz = cx;
    cx = nx; cy = ny; cz = nz;
  }
  if (cz <= 1e-6) return [0, 0, -1];
  const tanHalf = Math.tan(deg2rad(lens.fovDeg) / 2);
  const ux = cx / (cz * tanHalf);
  const uy = (cy * aspect) / (cz * tanHalf);
  return [ux, uy, cz];
}

/** 世界点 → 带畸变的 NDC（用于 GPU 后处理前的像面模拟或调试可视化） */
export function worldToDistortedNdc(lens: LensModel, pose: CameraPose, point: Vec3, aspect = 4 / 3): [number, number, number] {
  const [nx, ny, cz] = worldToNdc(lens, pose, point, aspect);
  const [dx, dy] = distortPoint(lens, nx, ny);
  return [dx, dy, cz];
}

export function ndcToPixel(width: number, height: number, ndcX: number, ndcY: number): [number, number] {
  return [((ndcX + 1) / 2) * width, ((1 - ndcY) / 2) * height];
}

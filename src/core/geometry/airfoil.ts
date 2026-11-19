import type { AirfoilParams, Stage } from '../types';
import { clamp, deg2rad, lerp, normalizeAngle, v3, type Vec3 } from '../math/vec3';

/**
 * 叶片局部坐标系（未盘车、零安装角）：
 *   x = 弦向（0 前缘 → 1 后缘，单位弦长）
 *   y = 厚度方向（+ 吸力面 / - 压力面）
 *   z = 展向（0 叶根 → 1 叶尖，单位展长）
 * 发动机坐标：+X 轴向（向后），Y-Z 为径向平面，+Y 为机匣顶部周向 0°
 */

/** 中弧线（局部 x-y 平面），分段圆弧近似 */
export function camberLine(p: AirfoilParams, t: number): [number, number] {
  const f = p.camber;
  const xf = clamp(p.camberPos, 0.05, 0.95);
  let yc: number;
  if (t < xf) {
    yc = (f / (xf * xf)) * (2 * xf * t - t * t);
  } else {
    yc = (f / ((1 - xf) * (1 - xf))) * ((1 - 2 * xf) + 2 * xf * t - t * t);
  }
  return [t, yc];
}

/** 中弧线切线倾角（rad） */
export function camberAngle(p: AirfoilParams, t: number): number {
  const f = p.camber;
  const xf = clamp(p.camberPos, 0.05, 0.95);
  let dy: number;
  if (t < xf) {
    dy = (2 * f / (xf * xf)) * (xf - t);
  } else {
    dy = (2 * f / ((1 - xf) * (1 - xf))) * (xf - t);
  }
  return Math.atan(dy);
}

/** NACA 风格厚度分布（占弦长比），前缘用给定半径修正 */
export function thicknessAt(p: AirfoilParams, t: number): number {
  const tt = clamp(t, 0, 1);
  const naca =
    5 *
    p.thickness *
    (0.2969 * Math.sqrt(tt) -
      0.126 * tt -
      0.3516 * tt * tt +
      0.2843 * tt * tt * tt -
      0.1036 * tt * tt * tt * tt);
  // 前后缘端点与给定缘半径光滑衔接
  const leCap = p.leadingRadius * (1 - Math.exp(-tt / 0.02));
  const teCap = p.trailingRadius * (1 - Math.exp(-(1 - tt) / 0.02));
  return Math.max(naca, leCap, teCap);
}

export interface BladeLocalPoint {
  /** 局部坐标（mm 尺度，弦向已乘当地弦长） */
  local: Vec3;
  /** 参数坐标 */
  spanPct: number;
  chordT: number;
  surface: 'suction' | 'pressure';
}

/** 展向插值的当地几何参数 */
export function localChord(stage: Stage, spanPct: number): number {
  return lerp(stage.chordRoot, stage.chordTip, spanPct);
}
export function localStaggerRad(stage: Stage, spanPct: number): number {
  return deg2rad(lerp(stage.staggerRoot, stage.staggerTip, spanPct));
}
export function localRadius(stage: Stage, spanPct: number): number {
  return lerp(stage.hubRadius, stage.tipRadius, spanPct);
}

/**
 * 叶型参数坐标 → 叶片局部 3D 点（未盘车的 1 号叶片位置）。
 * 这是"可复现损伤坐标"的正算基准，backproject 是它的逆运算。
 */
export function bladeSurfacePoint(
  stage: Stage,
  spanPct: number,
  chordT: number,
  surface: 'suction' | 'pressure',
): Vec3 {
  const s = clamp(spanPct, 0, 1);
  const t = clamp(chordT, 0, 1);
  const chord = localChord(stage, s);
  const [cx, cy] = camberLine(stage.airfoil, t);
  const theta = camberAngle(stage.airfoil, t);
  const halfThick = thicknessAt(stage.airfoil, t);
  const sign = surface === 'suction' ? 1 : -1;
  // 沿中弧线法向偏移半厚
  const lx = (cx - sign * halfThick * Math.sin(theta)) * chord;
  const ly = (cy + sign * halfThick * Math.cos(theta)) * chord;

  const stagger = localStaggerRad(stage, s);
  // 绕展向轴（局部 z → 发动机径向）转安装角：局部 x 偏向发动机 +X
  const ex = lx * Math.cos(stagger) + ly * Math.sin(stagger);
  const ey = -lx * Math.sin(stagger) + ly * Math.cos(stagger);
  const r = localRadius(stage, s);
  const sweep = stage.sweep * s;
  // 局部 (ex, ey) → 发动机 (轴向 X, 周向 Z)，径向为 Y
  return [ex + sweep + stage.axialX, r, ey];
}

/** 1 号叶片在给定盘车角下的周向相位（rad） */
export function bladePhaseRad(stage: Stage, bladeIndex1: number, crankDeg: number): number {
  const base = deg2rad(stage.indexPhaseDeg) + (2 * Math.PI * (bladeIndex1 - 1)) / stage.bladeCount;
  return stage.kind === 'rotor' ? base + deg2rad(crankDeg) : base;
}

/** 叶片局部点 → 发动机世界坐标 */
export function bladeLocalToWorld(stage: Stage, bladeIndex1: number, crankDeg: number, p: Vec3): Vec3 {
  const phi = bladePhaseRad(stage, bladeIndex1, crankDeg);
  // 先把径向 Y、周向 Z 按相位旋转（绕发动机 X 轴）
  return v3.rotateX(p, phi);
}

/** 叶型参数坐标的一站式正算：span/t/surface → 世界坐标 */
export function bladeParamToWorld(
  stage: Stage,
  bladeIndex1: number,
  crankDeg: number,
  spanPct: number,
  chordT: number,
  surface: 'suction' | 'pressure',
): Vec3 {
  const local = bladeSurfacePoint(stage, spanPct, chordT, surface);
  return bladeLocalToWorld(stage, bladeIndex1, crankDeg, local);
}

/**
 * 叶面解析外法线（发动机坐标，未盘车的 1 号叶）。
 * 取中弧线法向（吸力面 +、压力面 -），再施加安装角旋转。
 */
export function bladeSurfaceNormal(
  stage: Stage,
  spanPct: number,
  chordT: number,
  surface: 'suction' | 'pressure',
): Vec3 {
  const s = clamp(spanPct, 0, 1);
  const t = clamp(chordT, 0, 1);
  const theta = camberAngle(stage.airfoil, t);
  const sign = surface === 'suction' ? 1 : -1;
  // 中弧线法线（局部 x-y 平面）：切线 (cosθ, sinθ) → 法线 (-sinθ, cosθ)
  const nx = -Math.sin(theta) * sign;
  const ny = Math.cos(theta) * sign;
  const stagger = localStaggerRad(stage, s);
  // 与 bladeSurfacePoint 相同的安装角旋转（局部 x→发动机 X，局部 y→发动机 Z 平面）
  const ex = nx * Math.cos(stagger) + ny * Math.sin(stagger);
  const ey = -nx * Math.sin(stagger) + ny * Math.cos(stagger);
  return v3.normalize([ex, 0, ey]);
}

/** 盘车后的世界法线 */
export function bladeNormalWorld(
  stage: Stage,
  bladeIndex1: number,
  crankDeg: number,
  spanPct: number,
  chordT: number,
  surface: 'suction' | 'pressure',
): Vec3 {
  const n = bladeSurfaceNormal(stage, spanPct, chordT, surface);
  const phi = bladePhaseRad(stage, bladeIndex1, crankDeg);
  return v3.rotateX(n, phi);
}

/**
 * 盘车定位：给定目标周向角（rad，Y 轴起算），求把指定叶片转到该角度所需盘车角（deg）。
 * 任务点 1：盘车转多少度 → 按编号定位叶片。
 */
export function crankToAlignBlade(stage: Stage, bladeIndex1: number, targetCircRad: number): number {
  if (stage.kind !== 'rotor') return 0;
  const base = deg2rad(stage.indexPhaseDeg) + (2 * Math.PI * (bladeIndex1 - 1)) / stage.bladeCount;
  return ((targetCircRad - base) * 180) / Math.PI;
}

/** 当前盘车角下，最接近给定周向角的叶片编号 */
export function nearestBladeIndex(stage: Stage, crankDeg: number, circRad: number): number {
  let best = 1;
  let bestDelta = Infinity;
  for (let i = 1; i <= stage.bladeCount; i++) {
    const d = Math.abs(normalizeAngle(bladePhaseRad(stage, i, crankDeg) - circRad));
    if (d < bestDelta) {
      bestDelta = d;
      best = i;
    }
  }
  return best;
}

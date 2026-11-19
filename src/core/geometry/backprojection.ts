import type { Stage } from '../types';
import { clamp, v3, type Vec3 } from '../math/vec3';
import { bladeParamToWorld } from './airfoil';
import { buildStageMesh, raycastBlades, type BladeMesh, type RayHit } from './bladeMesh';

export interface BackProjection {
  bladeIndex: number;
  spanPct: number;
  chordT: number;
  surface: 'suction' | 'pressure';
  /** 解析叶面上的世界点（最终落点） */
  worldPoint: Vec3;
  /** 解析点到原始射线的垂直距离（mm），衡量反算拟合质量 */
  fitError: number;
}

export interface CameraRay {
  origin: Vec3;
  dir: Vec3;
}

function pointToRayDistance(p: Vec3, ray: CameraRay): number {
  const ap = v3.sub(p, ray.origin);
  const along = v3.dot(ap, ray.dir);
  const closest = v3.add(ray.origin, v3.scale(ray.dir, along));
  return v3.dist(p, closest);
}

/** 网格命中参数 → 解析叶面的局部精修（有限差分梯度下降，保证落点严格在参数化叶面上） */
function refineOnSurface(
  stage: Stage,
  bladeIndex: number,
  crankDeg: number,
  surface: 'suction' | 'pressure',
  span0: number,
  t0: number,
  ray: CameraRay,
): { spanPct: number; chordT: number; worldPoint: Vec3; fitError: number } {
  let span = clamp(span0, 0, 1);
  let chord = clamp(t0, 0, 1);
  const h = 1e-4;
  const energy = (s: number, t: number): number => {
    const p = bladeParamToWorld(stage, bladeIndex, crankDeg, s, t, surface);
    return pointToRayDistance(p, ray);
  };
  for (let iter = 0; iter < 24; iter++) {
    const e0 = energy(span, chord);
    const gs = (energy(clamp(span + h, 0, 1), chord) - energy(clamp(span - h, 0, 1), chord)) / (2 * h);
    const gt = (energy(span, clamp(chord + h, 0, 1)) - energy(span, clamp(chord - h, 0, 1))) / (2 * h);
    const gradNorm = Math.hypot(gs, gt);
    if (gradNorm < 1e-10) break;
    // 简单回溯线搜索
    let step = Math.max(0.2 / (gradNorm + 1e-6), 1e-4);
    let accepted = false;
    for (let back = 0; back < 10; back++) {
      const ns = clamp(span - step * gs, 0, 1);
      const nt = clamp(chord - step * gt, 0, 1);
      if (energy(ns, nt) < e0) {
        span = ns;
        chord = nt;
        accepted = true;
        break;
      }
      step *= 0.5;
    }
    if (!accepted) break;
  }
  const worldPoint = bladeParamToWorld(stage, bladeIndex, crankDeg, span, chord, surface);
  return { spanPct: span, chordT: chord, worldPoint, fitError: pointToRayDistance(worldPoint, ray) };
}

/**
 * 任务点 5 的核心：视窗点击射线 → 叶片三维表面参数坐标。
 * 同一物理损伤从任意探头角度反算，都会收敛到同一 (span, chord, surface)。
 * expectedBlade 为孔探画面中当前对准的叶片编号（由盘车角与视场确定）。
 * 当面归属不确定时，对吸力面/压力面分别求解，取到射线垂直距离最小的面。
 */
export function backProjectRay(
  stage: Stage,
  crankDeg: number,
  ray: CameraRay,
  prebuiltMesh?: BladeMesh,
  expectedBlade?: number,
): BackProjection | null {
  const mesh = prebuiltMesh ?? buildStageMesh(stage, crankDeg);
  const hit: RayHit | null = raycastBlades(mesh, ray.origin, ray.dir, expectedBlade, stage, crankDeg);
  if (!hit) return null;
  const refined = refineOnSurface(
    stage,
    hit.bladeIndex,
    crankDeg,
    hit.surface,
    hit.spanPct,
    hit.chordT,
    ray,
  );
  return {
    bladeIndex: hit.bladeIndex,
    spanPct: refined.spanPct,
    chordT: refined.chordT,
    surface: hit.surface,
    worldPoint: refined.worldPoint,
    fitError: refined.fitError,
  };
}

/**
 * 带目标面提示的反算：当调用方知道损伤在哪一面（复查同一 trackId）时使用。
 * 若提示面的射线残差可接受则采用，否则回退到几何可见面。
 */
export function backProjectRayOnSurface(
  stage: Stage,
  crankDeg: number,
  ray: CameraRay,
  expectedBlade: number,
  expectedSurface: 'suction' | 'pressure',
  mesh?: BladeMesh,
): BackProjection | null {
  const built = mesh ?? buildStageMesh(stage, crankDeg);
  const visible = backProjectRay(stage, crankDeg, ray, built, expectedBlade);
  if (visible && visible.surface === expectedSurface) return visible;
  // 在目标面上以可见命中参数为初值做拟合（允许射线来自背面的复核场景）
  if (visible) {
    const forced = refineOnSurface(
      stage,
      expectedBlade,
      crankDeg,
      expectedSurface,
      visible.spanPct,
      visible.chordT,
      ray,
    );
    if (forced.fitError <= Math.max(2, visible.fitError * 20)) {
      return {
        bladeIndex: expectedBlade,
        spanPct: forced.spanPct,
        chordT: forced.chordT,
        surface: expectedSurface,
        worldPoint: forced.worldPoint,
        fitError: forced.fitError,
      };
    }
  }
  return visible;
}

export interface ReprojectionCheck {
  /** 两次反算落点的世界坐标距离（mm） */
  worldDeviationMm: number;
  /** 叶高百分比差 */
  spanDelta: number;
  /** 弦向参数差 */
  chordDelta: number;
  withinTolerance: boolean;
}

/**
 * 可复现性验证（任务点最关键指标）：同一物理点从两个探头位姿反算，
 * 坐标偏差须 ≤ 0.5mm。
 */
export function checkReprojectionConsistency(
  stage: Stage,
  crankDeg: number,
  truth: { spanPct: number; chordT: number; surface: 'suction' | 'pressure'; bladeIndex: number },
  rayA: CameraRay,
  rayB: CameraRay,
  toleranceMm = 0.5,
): ReprojectionCheck & { hitA: BackProjection | null; hitB: BackProjection | null } {
  const mesh = buildStageMesh(stage, crankDeg);
  const hitA = backProjectRay(stage, crankDeg, rayA, mesh, truth.bladeIndex);
  const hitB = backProjectRay(stage, crankDeg, rayB, mesh, truth.bladeIndex);
  const truthWorld = bladeParamToWorld(
    stage,
    truth.bladeIndex,
    crankDeg,
    truth.spanPct,
    truth.chordT,
    truth.surface,
  );
  const dev =
    hitA && hitB
      ? Math.max(v3.dist(hitA.worldPoint, truthWorld), v3.dist(hitB.worldPoint, truthWorld))
      : Infinity;
  return {
    worldDeviationMm: dev,
    spanDelta: hitA && hitB ? Math.abs(hitA.spanPct - hitB.spanPct) : Infinity,
    chordDelta: hitA && hitB ? Math.abs(hitA.chordT - hitB.chordT) : Infinity,
    withinTolerance: dev <= toleranceMm,
    hitA,
    hitB,
  };
}

import type { DamageKind, DamageMeasurement, Stage } from '../types';
import { clamp, v3, type Vec3 } from '../math/vec3';

/**
 * 阴影法测量（任务点 6）。
 *
 * 孔探阴影法原理：探头投下的已知方向参考线（投影线/刻度线）落在损伤边缘，
 * 损伤有深度 h 时，阴影边缘相对无损表面产生横向偏移 Δ。
 * 已知镜头到表面的工作距离 L、镜头焦距（像素）f，由相似三角形：
 *
 *        h = Δ · L / (f + Δ·cotθ)
 *
 * 其中 θ 为投影线相对光轴的倾角。长度同理，用像素标定尺换算。
 */
export interface ShadowMeasurementInput {
  /** 镜头光心 */
  cameraPosition: Vec3;
  /** 光轴方向 */
  opticalAxis: Vec3;
  /** 损伤中心世界坐标 */
  damagePoint: Vec3;
  /** 投影线在视窗中的像素偏移（阴影边缘 vs 无损基准） */
  shadowOffsetPx: number;
  /** 投影线相对光轴倾角（deg） */
  projectionAngleDeg: number;
  /** 像素焦距（由 FOV 与分辨率标定） */
  focalPx: number;
  /** 损伤两端在视窗中的像素跨度（长度测量） */
  featureSpanPx: number;
}

export interface ShadowMeasurementOutput {
  depthMm: number;
  lengthMm: number;
  workingDistanceMm: number;
}

export function shadowMethodMeasure(input: ShadowMeasurementInput): ShadowMeasurementOutput {
  const workingDistance = v3.dot(v3.sub(input.damagePoint, input.cameraPosition), input.opticalAxis);
  const L = Math.max(workingDistance, 1);
  const theta = (input.projectionAngleDeg * Math.PI) / 180;
  const cotTheta = Math.abs(Math.cos(theta)) < 1e-6 ? 1e6 : Math.cos(theta) / Math.sin(theta);
  const delta = input.shadowOffsetPx;
  const f = input.focalPx;
  // 相似三角形反推深度
  const depthMm = (delta * L) / (f + delta * cotTheta);
  // 像素 → 物理长度（针孔标定）
  const lengthMm = (input.featureSpanPx * L) / f;
  return {
    depthMm: Math.max(0, depthMm),
    lengthMm: Math.max(0, lengthMm),
    workingDistanceMm: L,
  };
}

/** 由水平 FOV 与像素宽度求像素焦距 */
export function focalPixels(fovDeg: number, widthPx: number): number {
  return widthPx / (2 * Math.tan((fovDeg * Math.PI) / 180 / 2));
}

/**
 * 与 AMM 限度对照并给出复查间隔建议。
 * 增长分级参考航司常用工程经验（演示系统，非真实 AMM 数据）。
 */
export function evaluateDamage(
  stage: Stage,
  kind: DamageKind,
  lengthMm: number,
  depthMm: number,
): DamageMeasurement {
  const limitMm = stage.ammLimits[kind];
  // 裂纹/烧蚀按长度判限；缺口/打伤同时参考深度，取更保守的等效尺寸
  const effective = kind === 'crack' || kind === 'burn' || kind === 'coating_loss'
    ? lengthMm
    : Math.max(lengthMm, depthMm * 3);
  const exceedsLimit = effective > limitMm;
  const ratio = clamp(effective / Math.max(limitMm, 1e-6), 0, 1);

  let interval: number | null;
  if (exceedsLimit) interval = 0; // 立即停场处理
  else if (ratio > 0.8) interval = 25;
  else if (ratio > 0.5) interval = 50;
  else if (ratio > 0.25) interval = 100;
  else interval = 200;

  return {
    lengthMm: round3(lengthMm),
    depthMm: round3(depthMm),
    shadowOffsetPx: 0,
    limitMm,
    exceedsLimit,
    reInspectIntervalCycles: interval,
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * 按历次长度序列估算达到限度的循环数（任务点 8）。
 * 线性增长模型：cyclesToLimit = (limit - current) / growthPerCycle
 */
export function predictLimitCycle(
  history: { cycles: number; lengthMm: number }[],
  limitMm: number,
): { growthPerCycle: number; limitCycle: number | null; rSquared: number } {
  if (history.length < 2) return { growthPerCycle: 0, limitCycle: null, rSquared: 0 };
  const pts = [...history].sort((a, b) => a.cycles - b.cycles);
  const n = pts.length;
  const sx = pts.reduce((s, p) => s + p.cycles, 0);
  const sy = pts.reduce((s, p) => s + p.lengthMm, 0);
  const sxx = pts.reduce((s, p) => s + p.cycles * p.cycles, 0);
  const sxy = pts.reduce((s, p) => s + p.cycles * p.lengthMm, 0);
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return { growthPerCycle: 0, limitCycle: null, rSquared: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  const ssTot = pts.reduce((s, p) => s + (p.lengthMm - meanY) ** 2, 0);
  const ssRes = pts.reduce((s, p) => s + (p.lengthMm - (slope * p.cycles + intercept)) ** 2, 0);
  const rSquared = ssTot < 1e-12 ? 1 : clamp(1 - ssRes / ssTot, 0, 1);
  const last = pts[n - 1];
  if (slope <= 1e-9) return { growthPerCycle: slope, limitCycle: null, rSquared };
  const remaining = Math.max(0, limitMm - last.lengthMm);
  const limitCycle = Math.round(last.cycles + remaining / slope);
  return { growthPerCycle: slope, limitCycle, rSquared };
}

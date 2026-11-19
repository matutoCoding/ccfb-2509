import type { SurfaceMaterial } from '../types';
import { v3, type Vec3 } from '../math/vec3';

/**
 * 表面外观参数（任务点 4），CPU 与 WGSL 着色器共用同一组数值约定。
 * 颜色为线性 sRGB 基色；金属度/粗糙度驱动 Cook-Torrangce 风格高光；
 * 所有表面噪声用世界坐标确定性哈希，保证回放逐像素一致。
 */
export interface MaterialParams {
  baseColor: Vec3;
  metallic: number;
  roughness: number;
  /** 反射强度（单晶合金的强高光） */
  specular: number;
  /** 噪声幅度 0..1（积碳/变色的不均匀） */
  noiseAmount: number;
}

export const MATERIALS: Record<SurfaceMaterial, MaterialParams> = {
  single_crystal: {
    baseColor: [0.62, 0.6, 0.55],
    metallic: 0.95,
    roughness: 0.18,
    specular: 1.0,
    noiseAmount: 0.04,
  },
  tbc: {
    // 热障涂层：米灰陶瓷感，弱金属
    baseColor: [0.72, 0.68, 0.58],
    metallic: 0.05,
    roughness: 0.55,
    specular: 0.35,
    noiseAmount: 0.12,
  },
  carbon: {
    // 积碳：深黑偏暖，吸光
    baseColor: [0.05, 0.045, 0.04],
    metallic: 0.1,
    roughness: 0.85,
    specular: 0.15,
    noiseAmount: 0.35,
  },
  heat_tint: {
    // 高温变色：蓝紫→褐黄的回火色
    baseColor: [0.42, 0.3, 0.4],
    metallic: 0.8,
    roughness: 0.35,
    specular: 0.8,
    noiseAmount: 0.25,
  },
};

/** 确定性 3D 哈希 → [0,1)，无 Math.random，保证回放一致 */
export function hash3(x: number, y: number, z: number, seed = 0): number {
  let h = seed + 0x9e3779b9;
  h = Math.imul(h ^ Math.round(x * 64), 0x85ebca6b);
  h = Math.imul(h ^ Math.round(y * 64), 0xc2b2ae35);
  h = Math.imul(h ^ Math.round(z * 64), 0x27d4eb2f);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 涂层剥落：剥落区域返回露出的单晶合金底材颜色，与周围涂层明显拉开 */
export function coatingSpallColor(worldPos: Vec3, spallCenter: Vec3, radiusMm: number): MaterialParams | null {
  const d = v3.dist(worldPos, spallCenter);
  if (d > radiusMm) return null;
  const edge = 1 - d / radiusMm;
  const substrate = MATERIALS.single_crystal;
  return {
    ...substrate,
    baseColor: [
      substrate.baseColor[0] * (0.8 + 0.2 * edge),
      substrate.baseColor[1] * (0.75 + 0.2 * edge),
      substrate.baseColor[2] * (0.7 + 0.2 * edge),
    ],
  };
}

/** 回火色带：高温变色沿温度梯度（这里用轴向 + 噪声）在蓝紫与褐黄之间漂移 */
export function heatTintTint(worldPos: Vec3): Vec3 {
  const n = hash3(worldPos[0], worldPos[1], worldPos[2], 7);
  const band = 0.5 + 0.5 * Math.sin(worldPos[0] * 0.05 + n * 3.0);
  return [
    0.35 + 0.35 * band,
    0.22 + 0.2 * (1 - band),
    0.42 - 0.18 * band,
  ];
}

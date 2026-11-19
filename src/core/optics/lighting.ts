import type { Probe } from '../types';
import { clamp, v3, type Vec3 } from '../math/vec3';

/**
 * LED 环形光模型（任务点 3）。
 * 光源贴着镜头、随探头运动；近距过曝、远距发黑；
 * 光强按距离平方衰减 + 角度余弦（环上多颗 LED 的等效）。
 */
export interface LightSample {
  /** 入射辐照度（相对值，可 >1 表示过曝） */
  irradiance: number;
  /** 入射方向（表面点指向光源，单位向量） */
  lightDir: Vec3;
  /** 工作距离 mm */
  distance: number;
  /** 曝光钳制系数 0..1（1 = 正常，<1 表示过曝压缩） */
  exposureCompress: number;
}

const RING_LED_COUNT = 8;
const RING_RADIUS_FACTOR = 0.9; // 相对探头半径

/** 环形 LED 在镜头坐标系（光轴 +Z）上的位置 */
export function ringLedPositions(headPosition: Vec3, forward: Vec3, up: Vec3, probe: Probe): Vec3[] {
  const ringR = (probe.diameter / 2) * RING_RADIUS_FACTOR;
  const right = v3.normalize(v3.cross(forward, up));
  const out: Vec3[] = [];
  for (let i = 0; i < RING_LED_COUNT; i++) {
    const a = (i / RING_LED_COUNT) * Math.PI * 2;
    const offset = v3.add(v3.scale(right, Math.cos(a) * ringR), v3.scale(up, Math.sin(a) * ringR));
    out.push(v3.add(headPosition, offset));
  }
  return out;
}

export function sampleRingLight(
  headPosition: Vec3,
  forward: Vec3,
  up: Vec3,
  surfacePoint: Vec3,
  surfaceNormal: Vec3,
  probe: Probe,
): LightSample {
  const leds = ringLedPositions(headPosition, forward, up, probe);
  let irradiance = 0;
  const accumDir: Vec3 = [0, 0, 0];
  let distance = 0;
  for (const led of leds) {
    const toLed = v3.sub(led, surfacePoint);
    const d = v3.norm(toLed);
    distance += d / leds.length;
    const dir = v3.scale(toLed, 1 / Math.max(d, 1e-6));
    const ndl = Math.max(0, v3.dot(surfaceNormal, dir));
    // 平方反比 + 少量环境补光，功率可调
    const power = probe.ledPower * 9000; // 标定常数，让典型工作距离落在合理曝光区
    irradiance += (power / (d * d)) * (0.25 + 0.75 * ndl);
    accumDir[0] += dir[0]; accumDir[1] += dir[1]; accumDir[2] += dir[2];
  }
  irradiance /= leds.length;
  // 近距过曝：>1 部分软压缩，留给色调映射做高光
  const exposureCompress = irradiance > 1 ? clamp(1 / Math.sqrt(irradiance), 0.15, 1) : 1;
  return {
    irradiance,
    lightDir: v3.normalize(accumDir),
    distance,
    exposureCompress,
  };
}

/** 色调映射：近距过曝 → 白；远距 → 压黑 */
export function toneMap(linear: number): number {
  // Reinhard 扩展，保留高光滚降
  const mapped = linear / (1 + linear);
  return Math.pow(clamp(mapped, 0, 1), 1 / 2.2);
}

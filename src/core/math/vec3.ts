export type Vec3 = [number, number, number];

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  norm: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  normalize(a: Vec3): Vec3 {
    const n = Math.hypot(a[0], a[1], a[2]);
    return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  /** 绕发动机轴向 X 旋转 */
  rotateX(a: Vec3, rad: number): Vec3 {
    const c = Math.cos(rad), s = Math.sin(rad);
    return [a[0], a[1] * c - a[2] * s, a[1] * s + a[2] * c];
  },
  /** 绕 Z 旋转（叶型剖面在局部 x-y 平面内用） */
  rotateZ(a: Vec3, rad: number): Vec3 {
    const c = Math.cos(rad), s = Math.sin(rad);
    return [a[0] * c - a[1] * s, a[0] * s + a[1] * c, a[2]];
  },
  dist: (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  neg: (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]],
  copy: (a: Vec3): Vec3 => [a[0], a[1], a[2]],
};

export const deg2rad = (d: number): number => (d * Math.PI) / 180;
export const rad2deg = (r: number): number => (r * 180) / Math.PI;
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 角度归一化到 [0, 2π) */
export function normalizeAngle(a: number): number {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}

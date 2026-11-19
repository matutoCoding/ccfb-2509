import { describe, expect, it } from 'vitest';
import { distortPoint, lensFromProbe, pixelToRay, undistortPoint, worldToDistortedNdc, worldToNdc, type CameraPose } from './lens';
import { evaluateDamage, focalPixels, predictLimitCycle, shadowMethodMeasure } from './measurement';
import type { Probe, Stage } from '../types';

const probe: Probe = {
  id: 'p', name: 'p', kind: 'rigid', diameter: 8, workingLength: 200,
  bendAngleDeg: 0, minBendRadius: null, lens: 'forward', fovDeg: 90,
  distortionK1: -0.22, vignette: 0.6, ledPower: 1,
};

const pose: CameraPose = {
  position: [0, 0, 0],
  forward: [0, 0, 1],
  up: [0, 1, 0],
};

describe('镜头畸变互逆', () => {
  const lens = lensFromProbe(probe);
  it('distort/undistort 往返误差 < 1e-4（有效成像圈内）', () => {
    // 取在镜头单调可逆区内的像面点（强桶形畸变角落物理上无有效成像）
    for (const [x, y] of [[0.2, 0.1], [-0.5, 0.3], [0.6, -0.4], [0, 0]]) {
      const [dx, dy] = distortPoint(lens, x, y);
      const [nx, ny] = undistortPoint(lens, dx, dy);
      expect(Math.abs(nx - x)).toBeLessThan(1e-4);
      expect(Math.abs(ny - y)).toBeLessThan(1e-4);
    }
  });

  it('超出可逆区时钳制而不发散', () => {
    const [nx, ny] = undistortPoint(lens, 0.99, 0.99);
    expect(Number.isFinite(nx)).toBe(true);
    expect(Number.isFinite(ny)).toBe(true);
    expect(Math.hypot(nx, ny)).toBeLessThan(3);
  });

  it('边缘射线张开到合理角度，且桶形畸变下水平边缘比无畸变看到更宽', () => {
    const w = 1024, h = 768;
    const center = pixelToRay(lens, pose, w, h, w / 2, h / 2);
    expect(center.dir[2]).toBeCloseTo(1, 5);
    const edgeMid = pixelToRay(lens, pose, w, h, 0, h / 2);
    const edgeAngle = Math.acos(Math.min(1, edgeMid.dir[2])) * (180 / Math.PI);
    // 水平边缘半角：无畸变 45°，桶形畸变小幅外扩
    expect(edgeAngle).toBeGreaterThan(44);
    expect(edgeAngle).toBeLessThan(50);
    const noDistortion = { ...lens, k1: 0, k2: 0 };
    const edgeFlat = pixelToRay(noDistortion, pose, w, h, 0, h / 2);
    const flatAngle = Math.acos(Math.min(1, edgeFlat.dir[2]));
    const barrelAngle = Math.acos(Math.min(1, edgeMid.dir[2]));
    expect(flatAngle).toBeCloseTo(Math.PI / 4, 3); // 无畸变恰为半 FOV
    expect(barrelAngle).toBeGreaterThan(flatAngle + 1e-6);
  });

  it('world→无畸变ndc→像素→射线 与原方向一致（标注贴附闭环）', () => {
    const w = 800, h = 600;
    const aspect = w / h;
    const point: [number, number, number] = [12, -8, 55];
    const [nx, ny, cz] = worldToNdc(lens, pose, point, aspect);
    expect(cz).toBeGreaterThan(0);
    const px = ((nx + 1) / 2) * w;
    const py = ((1 - ny) / 2) * h;
    const ray = pixelToRay(lens, pose, w, h, px, py);
    const targetDir = [point[0], point[1], point[2]].map((c) => c / Math.hypot(...point));
    // 像素中心取整带来 ~0.3% 方向残差，工程上远小于一个像素对应的角度
    for (let i = 0; i < 3; i++) {
      expect(ray.dir[i]).toBeCloseTo(targetDir[i], 2);
    }
  });

  it('畸变像面点经 undistort 后射线方向与无畸变投影互逆', () => {
    const w = 800, h = 600;
    const aspect = w / h;
    const point: [number, number, number] = [-20, 14, 60];
    const [dx, dy] = worldToDistortedNdc(lens, pose, point, aspect);
    const px = ((dx + 1) / 2) * w;
    const py = ((1 - dy) / 2) * h;
    const ray = pixelToRay(lens, pose, w, h, px, py);
    const targetDir = [point[0], point[1], point[2]].map((c) => c / Math.hypot(...point));
    for (let i = 0; i < 3; i++) {
      expect(ray.dir[i]).toBeCloseTo(targetDir[i], 2);
    }
  });
});

describe('阴影法测量与限度预测', () => {
  it('零偏移 → 零深度，偏移增大深度单调上升', () => {
    const base = {
      cameraPosition: [0, 0, 0] as [number, number, number],
      opticalAxis: [0, 0, 1] as [number, number, number],
      damagePoint: [0, 0, 40] as [number, number, number],
      projectionAngleDeg: 45,
      focalPx: focalPixels(90, 1024),
      featureSpanPx: 40,
    };
    const d0 = shadowMethodMeasure({ ...base, shadowOffsetPx: 0 });
    expect(d0.depthMm).toBe(0);
    const d1 = shadowMethodMeasure({ ...base, shadowOffsetPx: 10 });
    const d2 = shadowMethodMeasure({ ...base, shadowOffsetPx: 25 });
    expect(d2.depthMm).toBeGreaterThan(d1.depthMm);
    expect(d1.depthMm).toBeGreaterThan(0);
    // 工作距离 40mm 量级合理
    expect(d1.workingDistanceMm).toBeCloseTo(40, 6);
  });

  it('线性增长历史预测到限循环，R² 接近 1', () => {
    const history = [
      { cycles: 100, lengthMm: 0.5 },
      { cycles: 200, lengthMm: 0.9 },
      { cycles: 300, lengthMm: 1.3 },
      { cycles: 400, lengthMm: 1.7 },
    ];
    const r = predictLimitCycle(history, 3.3);
    expect(r.growthPerCycle).toBeCloseTo(0.004, 5);
    expect(r.rSquared).toBeGreaterThan(0.99);
    expect(r.limitCycle).toBe(800);
  });

  it('无增长时不给出到限预测', () => {
    const r = predictLimitCycle(
      [
        { cycles: 100, lengthMm: 1 },
        { cycles: 200, lengthMm: 1 },
      ],
      3,
    );
    expect(r.limitCycle).toBeNull();
  });

  it('AMM 对照：超限标红并要求立即处理', () => {
    const stage = {
      ammLimits: { burn: 3, crack: 1.5, nick: 2, coating_loss: 8, fod: 2.5 },
    } as Stage;
    const ok = evaluateDamage(stage, 'burn', 2.0, 0.5);
    const bad = evaluateDamage(stage, 'burn', 3.6, 1.2);
    expect(ok.exceedsLimit).toBe(false);
    expect(ok.reInspectIntervalCycles).toBeGreaterThan(0);
    expect(bad.exceedsLimit).toBe(true);
    expect(bad.reInspectIntervalCycles).toBe(0);
  });
});

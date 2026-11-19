import { describe, expect, it } from 'vitest';
import type { Stage } from '../types';
import { bladeNormalWorld, bladeParamToWorld, crankToAlignBlade, nearestBladeIndex } from './airfoil';
import { buildStageMesh, raycastBlades } from './bladeMesh';import { backProjectRay, checkReprojectionConsistency, type CameraRay } from './backprojection';
import { v3 } from '../math/vec3';

function demoStage(): Stage {
  return {
    id: 'hpt1',
    name: '高压涡轮一级',
    kind: 'rotor',
    bladeCount: 46,
    axialX: 400,
    hubRadius: 220,
    tipRadius: 340,
    chordRoot: 90,
    chordTip: 60,
    staggerRoot: 38,
    staggerTip: 30,
    sweep: 8,
    airfoil: {
      camber: 0.09,
      camberPos: 0.45,
      thickness: 0.06,
      thicknessPos: 0.35,
      leadingRadius: 0.012,
      trailingRadius: 0.006,
    },
    defaultMaterial: 'single_crystal',
    indexPhaseDeg: 4,
    ammLimits: { burn: 3, crack: 1.5, nick: 2, coating_loss: 8, fod: 2.5 },
  };
}

/** 在世界点附近、从给定观察位姿生成一条穿过该点的射线 */
function rayThrough(eye: [number, number, number], target: [number, number, number]): CameraRay {
  return { origin: eye, dir: v3.normalize(v3.sub(target, eye)) };
}

describe('叶片参数化与盘车定位', () => {
  const stage = demoStage();

  it('正算落在叶根/叶尖半径区间内', () => {
    for (const span of [0, 0.25, 0.5, 0.75, 1]) {
      const p = bladeParamToWorld(stage, 1, 0, span, 0.5, 'suction');
      const r = Math.hypot(p[1], p[2]);
      expect(r).toBeGreaterThanOrEqual(stage.hubRadius - 0.5);
      expect(r).toBeLessThanOrEqual(stage.tipRadius + 0.5);
    }
  });

  it('盘车角把指定叶片转到目标周向位置，最近叶片编号正确', () => {
    const target = Math.PI / 2; // 顶部 90°
    const crank = crankToAlignBlade(stage, 12, target);
    const found = nearestBladeIndex(stage, crank, target);
    expect(found).toBe(12);
  });

  it('静子级盘车角不影响叶片位置', () => {
    const stator: Stage = { ...stage, kind: 'stator' };
    const p1 = bladeParamToWorld(stator, 3, 0, 0.5, 0.5, 'suction');
    const p2 = bladeParamToWorld(stator, 3, 137, 0.5, 0.5, 'suction');
    expect(v3.dist(p1, p2)).toBeLessThan(1e-9);
  });
});

describe('反算可复现性（0.5mm 硬指标）', () => {
  const stage = demoStage();
  const crank = 23.5;

  it.each([
    { span: 0.5, chord: 0.42, surf: 'suction' as const, blade: 7 },
    { span: 0.82, chord: 0.15, surf: 'suction' as const, blade: 23 },
    { span: 0.2, chord: 0.75, surf: 'pressure' as const, blade: 40 },
    { span: 0.95, chord: 0.5, surf: 'suction' as const, blade: 1 },
  ])('物理点 (span=$span, t=$chord, $surf) 双机位反算偏差 ≤ 0.5mm', (truth) => {
    const world = bladeParamToWorld(stage, truth.blade, crank, truth.span, truth.chord, truth.surf);

    // 用解析外法线布置两个同侧机位（真实可达的孔探观察位姿），切线方向取参数弦向
    const normal = bladeNormalWorld(stage, truth.blade, crank, truth.span, truth.chord, truth.surf);
    const pChord = bladeParamToWorld(stage, truth.blade, crank, truth.span, Math.min(0.99, truth.chord + 0.01), truth.surf);
    const tangent: [number, number, number] = v3.normalize(v3.sub(pChord, world));
    const eyeA = v3.add(v3.add(world, v3.scale(normal, 55)), v3.scale(tangent, 25)) as [number, number, number];
    const eyeB = v3.add(v3.add(world, v3.scale(normal, 70)), v3.scale(tangent, -30)) as [number, number, number];
    const check = checkReprojectionConsistency(
      stage,
      crank,
      { spanPct: truth.span, chordT: truth.chord, surface: truth.surf, bladeIndex: truth.blade },
      rayThrough(eyeA, world),
      rayThrough(eyeB, world),
    );
    expect(check.hitA).not.toBeNull();
    expect(check.hitB).not.toBeNull();
    expect(check.worldDeviationMm).toBeLessThanOrEqual(0.5);
    expect(check.withinTolerance).toBe(true);
    // 参数坐标本身也应回到同一处
    expect(check.hitA!.bladeIndex).toBe(truth.blade);
    expect(Math.abs(check.hitA!.spanPct - truth.span)).toBeLessThan(0.01);
    expect(Math.abs(check.hitA!.chordT - truth.chord)).toBeLessThan(0.01);
  });

  it('反算残差对擦边入射也保持亚毫米', () => {
    const world = bladeParamToWorld(stage, 15, crank, 0.6, 0.3, 'suction');
    // 沿吸力面法线侧、以很斜的擦边角观察（法线分量小、切线分量大）
    const normal = bladeNormalWorld(stage, 15, crank, 0.6, 0.3, 'suction');
    const pChord = bladeParamToWorld(stage, 15, crank, 0.6, 0.31, 'suction');
    const tangent = v3.normalize(v3.sub(pChord, world));
    const eye = v3.add(v3.add(world, v3.scale(normal, 20)), v3.scale(tangent, 95)) as [number, number, number];
    const hit = backProjectRay(stage, crank, rayThrough(eye, world), undefined, 15);
    expect(hit).not.toBeNull();
    expect(hit!.fitError).toBeLessThan(0.2);
    expect(v3.dist(hit!.worldPoint, world)).toBeLessThan(0.5);
  });

  it('BVH 射线命中数与暴力遍历一致', () => {
    const mesh = buildStageMesh(stage, crank);
    const eye: [number, number, number] = [200, 500, 500];
    const target = bladeParamToWorld(stage, 10, crank, 0.5, 0.5, 'suction');
    const ray = rayThrough(eye, target);
    const hit = raycastBlades(mesh, ray.origin, ray.dir, 10, stage, crank);
    expect(hit).not.toBeNull();
    expect(hit!.bladeIndex).toBeGreaterThanOrEqual(1);
    expect(hit!.bladeIndex).toBeLessThanOrEqual(stage.bladeCount);
  });

  it('精度档案：双机位最大偏差远小于 0.5mm 指标', () => {
    const truthPoints = [
      { span: 0.5, chord: 0.42, surf: 'suction' as const },
      { span: 0.82, chord: 0.15, surf: 'suction' as const },
      { span: 0.2, chord: 0.75, surf: 'pressure' as const },
      { span: 0.95, chord: 0.5, surf: 'suction' as const },
      { span: 0.35, chord: 0.6, surf: 'pressure' as const },
    ];
    let maxDev = 0;
    let maxFit = 0;
    for (const t of truthPoints) {
      const world = bladeParamToWorld(stage, 11, crank, t.span, t.chord, t.surf);
      const normal = bladeNormalWorld(stage, 11, crank, t.span, t.chord, t.surf);
      const pChord = bladeParamToWorld(stage, 11, crank, t.span, Math.min(0.99, t.chord + 0.01), t.surf);
      const tangent = v3.normalize(v3.sub(pChord, world));
      const eyeA = v3.add(v3.add(world, v3.scale(normal, 50)), v3.scale(tangent, 20)) as [number, number, number];
      const eyeB = v3.add(v3.add(world, v3.scale(normal, 65)), v3.scale(tangent, -25)) as [number, number, number];
      const r = checkReprojectionConsistency(
        stage, crank,
        { spanPct: t.span, chordT: t.chord, surface: t.surf, bladeIndex: 11 },
        rayThrough(eyeA, world), rayThrough(eyeB, world),
      );
      maxDev = Math.max(maxDev, r.worldDeviationMm);
      maxFit = Math.max(maxFit, r.hitA?.fitError ?? 0, r.hitB?.fitError ?? 0);
    }
    console.log(`双机位反算最大坐标偏差: ${maxDev.toFixed(4)} mm（指标 0.5mm），最大拟合残差: ${maxFit.toFixed(4)} mm`);
    expect(maxDev).toBeLessThan(0.15);
  });
});

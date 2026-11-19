import { describe, expect, it } from 'vitest';
import { buildSeedDataset } from '../data/seed';
import { buildStageMesh, raycastBlades } from '../core/geometry/bladeMesh';
import { backProjectRay } from '../core/geometry/backprojection';
import { bladeNormalWorld, bladeParamToWorld } from '../core/geometry/airfoil';
import { v3 } from '../core/math/vec3';

/** 对种子数据里每个转子级、多个参数位做反算，验证整条几何管线在真实数据规模下稳定 */
describe('种子数据全规模反算冒烟', () => {
  const seed = buildSeedDataset();

  it('每个转子级任意参数点都能从外侧射线反算回原点（亚毫米）', () => {
    let samples = 0;
    let maxDev = 0;
    for (const engine of seed.engines) {
      for (const stage of engine.stages.filter((s) => s.kind === 'rotor')) {
        const crank = 37.5;
        const mesh = buildStageMesh(stage, crank);
        for (const span of [0.15, 0.5, 0.85]) {
          for (const chord of [0.2, 0.5, 0.8]) {
            for (const surface of ['suction', 'pressure'] as const) {
              const blade = 3;
              const world = bladeParamToWorld(stage, blade, crank, span, chord, surface);
              const normal = bladeNormalWorld(stage, blade, crank, span, chord, surface);
              // 沿外法线外侧 50mm 打射线
              const eye = v3.add(world, v3.scale(normal, 50));
              const ray = { origin: eye, dir: v3.normalize(v3.sub(world, eye)) };
              const hit = raycastBlades(mesh, ray.origin, ray.dir, blade, stage, crank);
              expect(hit, `${engine.id}/${stage.id} ${surface} ${span}/${chord} 应命中`).not.toBeNull();
              const back = backProjectRay(stage, crank, ray, mesh, blade);
              expect(back).not.toBeNull();
              const dev = v3.dist(back!.worldPoint, world);
              maxDev = Math.max(maxDev, dev);
              expect(dev).toBeLessThan(0.5);
              samples++;
            }
          }
        }
      }
    }
    console.log(`全规模反算 ${samples} 个采样点，最大偏差 ${maxDev.toFixed(4)}mm`);
    expect(samples).toBeGreaterThan(30);
  });
});

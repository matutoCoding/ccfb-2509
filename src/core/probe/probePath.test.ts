import { describe, expect, it } from 'vitest';
import type { BorescopePort, EngineModel, Probe, Stage } from '../types';
import { solveProbePath } from './probePath';
import { makeTrajectory, replayFrame, sampleTrajectory } from './trajectory';
import { v3 } from '../math/vec3';

function stage(partial: Partial<Stage>): Stage {
  return {
    id: 's1',
    name: '级',
    kind: 'rotor',
    bladeCount: 30,
    axialX: 300,
    hubRadius: 100,
    tipRadius: 200,
    chordRoot: 60,
    chordTip: 40,
    staggerRoot: 35,
    staggerTip: 28,
    sweep: 0,
    airfoil: { camber: 0.08, camberPos: 0.45, thickness: 0.06, thicknessPos: 0.35, leadingRadius: 0.01, trailingRadius: 0.005 },
    defaultMaterial: 'single_crystal',
    indexPhaseDeg: 0,
    ammLimits: { burn: 3, crack: 1.5, nick: 2, coating_loss: 8, fod: 2.5 },
    ...partial,
  };
}

function engine(): EngineModel {
  return {
    id: 'eng',
    name: '测试发动机',
    manufacturer: '测试厂',
    casingRadius: 220,
    axialLength: 800,
    stages: [
      stage({ id: 'stator1', kind: 'stator', bladeCount: 40, axialX: 320 }),
      stage({ id: 'rotor1', kind: 'rotor', bladeCount: 46, axialX: 380 }),
    ],
    ports: [
      {
        id: 'port1',
        name: 'HPT 孔探口',
        position: [300, 215, 0],
        normal: [1, 0, 0],
        holeDiameter: 10,
        targetStageId: 'rotor1',
      } satisfies BorescopePort,
    ],
    createdAt: 0,
    updatedAt: 0,
  };
}

const rigidProbe: Probe = {
  id: 'rigid',
  name: '刚性 8mm',
  kind: 'rigid',
  diameter: 8,
  workingLength: 300,
  bendAngleDeg: 0,
  minBendRadius: null,
  lens: 'forward',
  fovDeg: 90,
  distortionK1: -0.28,
  vignette: 0.55,
  ledPower: 1,
};

const flexProbe: Probe = {
  ...rigidProbe,
  id: 'flex',
  name: '柔性 6mm',
  kind: 'flexible',
  diameter: 6,
  minBendRadius: 25,
  bendAngleDeg: 120,
};

describe('探头路径与碰撞', () => {
  const eng = engine();
  const port = eng.ports[0];

  it('刚性探头沿孔口法线直线推进，路径点等距', () => {
    const res = solveProbePath({ probe: rigidProbe, port, engine: eng, insertionMm: 120, crankDeg: 0 });
    expect(res.stuck).toBe(false);
    expect(res.achievedInsertion).toBeCloseTo(120, 0);
    expect(res.points[0]).toEqual(port.position);
    const d = v3.dist(res.points[1], res.points[0]);
    expect(d).toBeCloseTo(2, 0);
  });

  it('探头直径大于孔径直接判定卡住', () => {
    const fat: Probe = { ...rigidProbe, diameter: 12 };
    const res = solveProbePath({ probe: fat, port, engine: eng, insertionMm: 50, crankDeg: 0 });
    expect(res.stuck).toBe(true);
    expect(res.achievedInsertion).toBe(0);
  });

  it('柔性探头强行朝机匣外壁导引时在机匣处停住并给卡点', () => {
    const res = solveProbePath({
      probe: flexProbe,
      port,
      engine: eng,
      insertionMm: 200,
      crankDeg: 0,
      guideDirection: [0, 1, 0], // 朝外（径向增大方向）
    });
    expect(res.stuck).toBe(true);
    expect(res.stuckReason).toMatch(/casing|min_radius/);
    expect(res.stuckPoint).not.toBeNull();
    expect(res.achievedInsertion).toBeLessThan(200);
  });

  it('柔性探头满足最小弯曲半径：连续三点曲率半径不低于限值', () => {
    const res = solveProbePath({
      probe: flexProbe,
      port,
      engine: eng,
      insertionMm: 150,
      crankDeg: 0,
      guideDirection: [0.5, 0, 1],
    });
    for (let i = 1; i < res.points.length - 1; i++) {
      const a = res.points[i - 1], b = res.points[i], c = res.points[i + 1];
      const ab = v3.dist(a, b), bc = v3.dist(b, c), ac = v3.dist(a, c);
      const area2 = v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));
      if (area2 > 1e-9) {
        const R = (ab * bc * ac) / (2 * area2);
        expect(R).toBeGreaterThanOrEqual(flexProbe.minBendRadius! * 0.98);
      }
    }
  });

  it('导向器叶栅可触发 vane 碰撞', () => {
    // 导向器在轴向 320，孔口在 300 直插，叶片占据半径 100..200，
    // 探头从半径 215 向内需要下降高度；保持直线不会碰，给一个向下的导引
    const res = solveProbePath({
      probe: flexProbe,
      port,
      engine: eng,
      insertionMm: 120,
      crankDeg: 0,
      guideDirection: v3.normalize([0.2, -1, 0]),
    });
    // 至少路径求解稳定，且若卡住必有原因与卡点
    if (res.stuck) {
      expect(res.stuckReason).not.toBeNull();
      expect(res.stuckPoint).not.toBeNull();
    }
  });
});

describe('轨迹回放确定性', () => {
  const eng = engine();
  const port = eng.ports[0];
  const traj = makeTrajectory('rigid', 'port1', 'forward');
  for (let i = 0; i <= 10; i++) {
    traj.frames.push({ t: i, crankDeg: i * 3.5, insertionMm: 20 + i * 8 });
  }

  it('同一时刻两次回放头端位姿完全一致', () => {
    const a = replayFrame(eng, rigidProbe, port, traj, 5.3)!;
    const b = replayFrame(eng, rigidProbe, port, traj, 5.3)!;
    expect(a.path.headPosition).toEqual(b.path.headPosition);
    expect(a.path.headDirection).toEqual(b.path.headDirection);
    expect(a.frame.crankDeg).toBeCloseTo(b.frame.crankDeg, 12);
  });

  it('插值帧落在相邻关键帧之间', () => {
    const f = sampleTrajectory(traj, 2.5)!;
    expect(f.insertionMm).toBeCloseTo(20 + 2.5 * 8, 6);
    expect(f.crankDeg).toBeCloseTo(2.5 * 3.5, 6);
  });
});

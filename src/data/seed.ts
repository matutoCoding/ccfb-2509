import type {
  AmmLimits,
  Damage,
  DamageKind,
  EngineModel,
  InspectionRecord,
  Probe,
  Stage,
  Trajectory,
} from '../core/types';
import { bladeParamToWorld } from '../core/geometry/airfoil';
import { solveProbePath } from '../core/probe/probePath';
import { v3 } from '../core/math/vec3';
import { mulberry32, pick, range, uid } from './rng';

const AMM: AmmLimits = { burn: 3, crack: 1.5, nick: 2, coating_loss: 8, fod: 2.5 };

function rotor(id: string, name: string, axialX: number, blades: number, hub: number, tip: number): Stage {
  return {
    id, name, kind: 'rotor', bladeCount: blades, axialX,
    hubRadius: hub, tipRadius: tip, chordRoot: 92, chordTip: 58,
    staggerRoot: 38, staggerTip: 30, sweep: 9,
    airfoil: { camber: 0.09, camberPos: 0.45, thickness: 0.055, thicknessPos: 0.35, leadingRadius: 0.012, trailingRadius: 0.006 },
    defaultMaterial: 'single_crystal', indexPhaseDeg: 4, ammLimits: { ...AMM },
  };
}

function stator(id: string, name: string, axialX: number, vanes: number, hub: number, tip: number): Stage {
  return {
    id, name, kind: 'stator', bladeCount: vanes, axialX,
    hubRadius: hub, tipRadius: tip, chordRoot: 70, chordTip: 52,
    staggerRoot: 25, staggerTip: 22, sweep: 0,
    airfoil: { camber: 0.12, camberPos: 0.5, thickness: 0.05, thicknessPos: 0.4, leadingRadius: 0.01, trailingRadius: 0.005 },
    defaultMaterial: 'tbc', indexPhaseDeg: 0, ammLimits: { ...AMM },
  };
}

/** 演示构型 A：双转子涡扇的高压核心机（虚构型号，尺寸单位 mm） */
export function buildEngineA(): EngineModel {
  const now = Date.UTC(2026, 0, 1);
  return {
    id: 'eng-tf2000',
    name: 'TF-2000 演示构型',
    manufacturer: '演示动力（虚构）',
    casingRadius: 360,
    axialLength: 900,
    stages: [
      stator('stg-hpt-n1', 'HPT 一级导向器', 360, 42, 215, 345),
      rotor('stg-hpt-r1', 'HPT 一级转子', 420, 46, 220, 340),
      stator('stg-hpt-n2', 'HPT 二级导向器', 480, 40, 225, 340),
      rotor('stg-hpt-r2', 'HPT 二级转子', 540, 52, 228, 338),
    ],
    ports: [
      { id: 'port-hpt1', name: 'HPT 一级孔探口（顶部）', position: [395, 352, 0], normal: [1, 0, 0], holeDiameter: 10, targetStageId: 'stg-hpt-r1' },
      { id: 'port-hpt2', name: 'HPT 二级孔探口（45°）', position: [515, 249, 249], normal: [0.6, -0.5, -0.5], holeDiameter: 8.5, targetStageId: 'stg-hpt-r2' },
      { id: 'port-comb', name: '燃烧室观察口', position: [300, 350, 0], normal: [1, 0, 0], holeDiameter: 12, targetStageId: 'stg-hpt-n1' },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

/** 演示构型 B：涡轴发动机高压涡轮（更小、级数更少） */
export function buildEngineB(): EngineModel {
  const now = Date.UTC(2026, 0, 1);
  return {
    id: 'eng-ts800',
    name: 'TS-800 演示构型',
    manufacturer: '演示动力（虚构）',
    casingRadius: 240,
    axialLength: 650,
    stages: [
      stator('stg-gas-n1', '燃气涡轮导向器', 280, 28, 140, 230),
      rotor('stg-gas-r1', '燃气涡轮转子', 330, 34, 145, 226),
    ],
    ports: [
      { id: 'port-gas1', name: '涡轮孔探口（顶部）', position: [310, 234, 0], normal: [1, 0, 0], holeDiameter: 8, targetStageId: 'stg-gas-r1' },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

export function buildProbes(): Probe[] {
  return [
    {
      id: 'probe-rigid-8', name: '刚性直管 8mm / 直视', kind: 'rigid',
      diameter: 8, workingLength: 280, bendAngleDeg: 0, minBendRadius: null,
      lens: 'forward', fovDeg: 90, distortionK1: -0.18, vignette: 0.55, ledPower: 1,
    },
    {
      id: 'probe-rigid-side', name: '刚性侧视 8mm / 90° 弯头', kind: 'rigid',
      diameter: 8, workingLength: 260, bendAngleDeg: 90, minBendRadius: null,
      lens: 'side', fovDeg: 80, distortionK1: -0.15, vignette: 0.5, ledPower: 1,
    },
    {
      id: 'probe-flex-6', name: '柔性导管 6mm / 可弯 120°', kind: 'flexible',
      diameter: 6, workingLength: 600, bendAngleDeg: 120, minBendRadius: 25,
      lens: 'forward', fovDeg: 95, distortionK1: -0.22, vignette: 0.6, ledPower: 0.9,
    },
    {
      id: 'probe-flex-4', name: '柔性细管 4mm / 可弯 150°', kind: 'flexible',
      diameter: 4, workingLength: 800, bendAngleDeg: 150, minBendRadius: 18,
      lens: 'side', fovDeg: 85, distortionK1: -0.2, vignette: 0.62, ledPower: 0.75,
    },
  ];
}

const DAMAGE_KINDS: DamageKind[] = ['burn', 'crack', 'nick', 'coating_loss', 'fod'];
const INSPECTORS = ['王工', '李工', '赵工', '陈工'];
const SERIALS_A = ['TF2-2401', 'TF2-2402', 'TF2-2407'];
const SERIALS_B = ['TS8-1103', 'TS8-1108'];

function makeTrajectory(rng: () => number, probeId: string, portId: string, lens: Probe['lens'], frames: number, brokenCrank: boolean): Trajectory {
  const traj: Trajectory = { probeId, portId, lens, frames: [] };
  for (let i = 0; i < frames; i++) {
    const t = i * 2;
    const crank = brokenCrank && (i === 3 || i === 4) ? Number.NaN : Math.round(range(rng, 0, 180) * 10) / 10;
    traj.frames.push({
      t,
      crankDeg: crank,
      insertionMm: Math.round((20 + i * 9 + range(rng, -2, 2)) * 10) / 10,
    });
  }
  return traj;
}

export interface SeedDataset {
  engines: EngineModel[];
  probes: Probe[];
  records: InspectionRecord[];
  damages: Damage[];
}

/**
 * 生成演示数据集（任务点 9）。
 * 含三类坏记录：探头卡住、盘车角度丢失、标注落在叶片几何外。
 */
export function buildSeedDataset(): SeedDataset {
  const rng = mulberry32(20261120);
  const engines = [buildEngineA(), buildEngineB()];
  const probes = buildProbes();
  const records: InspectionRecord[] = [];
  const damages: Damage[] = [];
  let recSeq = 0;
  let dmgSeq = 0;

  engines.forEach((engine, engineIdx) => {
    const serials = engineIdx === 0 ? SERIALS_A : SERIALS_B;
    const rotorStages = engine.stages.filter((s) => s.kind === 'rotor');
    const recordCount = engineIdx === 0 ? 22 : 12; // 合计 34 条孔探记录
    for (let i = 0; i < recordCount; i++) {
      recSeq++;
      const serial = pick(rng, serials);
      const stage = pick(rng, rotorStages);
      const port = engine.ports.find((p) => p.targetStageId === stage.id) ?? engine.ports[0];
      const probe = pick(rng, probes);
      const cycles = 200 + i * 75 + Math.floor(range(rng, 0, 40));
      // 每台发动机约 1/8 是卡住记录，1/8 是盘车丢数据
      const stuckRecord = i % 8 === 5;
      const brokenCrank = i % 8 === 7;
      const trajectory = makeTrajectory(rng, probe.id, port.id, probe.lens, 8, brokenCrank);
      // 卡住记录：柔性探头强行朝外/侧向导引，求解真实卡点并持久化
      let stuckInfo: InspectionRecord['stuckInfo'] = null;
      if (stuckRecord) {
        const guide: [number, number, number][] = [
          v3.normalize([0, 1, 0]),
          v3.normalize([0.3, 0.7, 0.7]),
          v3.normalize([0, 1, 1]),
        ];
        const stuckPath = solveProbePath({
          probe, port, engine, insertionMm: 320, crankDeg: 0,
          guideDirection: guide[i % guide.length],
        });
        if (stuckPath.stuck) {
          stuckInfo = {
            reason: stuckPath.stuckReason,
            achievedInsertion: stuckPath.achievedInsertion,
            stuckPoint: stuckPath.stuckPoint,
          };
        }
      }
      const record: InspectionRecord = {
        id: uid('rec', recSeq),
        engineModelId: engine.id,
        engineSerial: serial,
        title: `${serial} ${stage.name} 孔探 #${i + 1}`,
        inspector: pick(rng, INSPECTORS),
        cycles,
        date: new Date(Date.UTC(2026, (i % 11), 5 + (i % 20))).toISOString().slice(0, 10),
        crankDeg: trajectory.frames[0]?.crankDeg ?? 0,
        trajectory,
        damageIds: [],
        snapshots: [],
        stuckInfo,
        notes: stuckRecord ? '插入阻力异常，疑似导向器干涉' : brokenCrank ? '盘车角度传感器瞬时丢帧' : '例行孔探',
        createdAt: Date.UTC(2026, (i % 11), 5 + (i % 20)),
      };
      records.push(record);

      // 约 60% 记录带 1~3 条损伤标注
      const damageCount = rng() < 0.6 ? 1 + Math.floor(rng() * 3) : 0;
      for (let k = 0; k < damageCount; k++) {
        dmgSeq++;
        const blade = 1 + Math.floor(rng() * stage.bladeCount);
        const crank = range(rng, 0, 360);
        const kind = pick(rng, DAMAGE_KINDS);
        // 每 12 条造一个落在叶片外的坏标注（span > 1 或 t 越界）
        const outsideBad = dmgSeq % 12 === 0;
        const spanPct = outsideBad ? 1.18 : range(rng, 0.08, 0.92);
        const chordT = outsideBad ? 1.07 : range(rng, 0.1, 0.85);
        const surface = rng() > 0.35 ? 'suction' : 'pressure';
        const worldPoint = bladeParamToWorld(stage, blade, crank, Math.min(1, Math.max(0, spanPct)), Math.min(1, Math.max(0, chordT)), surface);
        const lengthMm = Math.round(range(rng, 0.4, kind === 'coating_loss' ? 9 : 3.4) * 100) / 100;
        const depthMm = kind === 'crack' ? 0 : Math.round(range(rng, 0.1, 1.4) * 100) / 100;
        const limitMm = stage.ammLimits[kind];
        const trackId = `track-${engine.id}-${stage.id}-${blade}-${Math.floor(dmgSeq / 3)}`;
        const damage: Damage = {
          id: uid('dmg', dmgSeq),
          recordId: record.id,
          engineId: engine.id,
          stageId: stage.id,
          crankDeg: crank,
          bladeIndex: blade,
          kind,
          spanPct,
          chordT,
          surface,
          worldPoint,
          fitError: outsideBad ? 1.2 : Math.round(range(rng, 0.002, 0.08) * 1000) / 1000,
          measurement: {
            lengthMm,
            depthMm,
            shadowOffsetPx: Math.round(range(rng, 4, 40)),
            limitMm,
            exceedsLimit: lengthMm > limitMm,
            reInspectIntervalCycles: lengthMm > limitMm ? 0 : pick(rng, [25, 50, 100, 200]),
          },
          trackId,
          note: '',
          createdAt: record.createdAt,
        };
        damages.push(damage);
        record.damageIds.push(damage.id);
      }
    }
  });

  return { engines, probes, records, damages };
}

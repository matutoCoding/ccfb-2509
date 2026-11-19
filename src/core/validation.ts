import type {
  Damage,
  EngineModel,
  InspectionRecord,
  Probe,
  ProbePathResult,
  ValidationIssue,
} from './types';
import { bladeParamToWorld } from './geometry/airfoil';
import { v3 } from './math/vec3';

/** 盘车角度数据是否缺失（任务点 9 坏记录之一） */
export function isCrankDataMissing(record: InspectionRecord): boolean {
  if (record.trajectory.frames.length === 0) return true;
  return record.trajectory.frames.some(
    (f) => f.crankDeg === null || f.crankDeg === undefined || Number.isNaN(f.crankDeg),
  );
}

/** 标注是否落在叶片几何外面（参数越界或世界坐标不在叶尖/叶根半径内） */
export function isDamageOutsideBlade(engine: EngineModel, d: Damage): boolean {
  if (d.spanPct < 0 || d.spanPct > 1 || d.chordT < 0 || d.chordT > 1) return true;
  const stage = engine.stages.find((s) => s.id === d.stageId);
  if (!stage) return true;
  const world = bladeParamToWorld(stage, d.bladeIndex, d.crankDeg, d.spanPct, d.chordT, d.surface);
  const radial = Math.hypot(world[1], world[2]);
  // 允许 0.5mm 容差
  return radial < stage.hubRadius - 0.5 || radial > stage.tipRadius + 0.5;
}

/** 整条数据集校验，产出问题清单（页面用红色徽标展示） */
export function validateAll(input: {
  engines: EngineModel[];
  probes: Probe[];
  records: InspectionRecord[];
  damages: Damage[];
  pathByRecord?: Map<string, ProbePathResult>;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const engineIds = new Set(input.engines.map((e) => e.id));

  for (const record of input.records) {
    if (!engineIds.has(record.engineModelId)) {
      issues.push({
        level: 'error',
        code: 'ORPHAN_REF',
        message: `记录「${record.title}」引用了不存在的发动机构型`,
        entityId: record.id,
      });
    }
    if (isCrankDataMissing(record)) {
      issues.push({
        level: 'error',
        code: 'CRANK_DATA_MISSING',
        message: `记录「${record.title}」存在盘车角度缺失帧，轨迹无法完整回放`,
        entityId: record.id,
      });
    }
    const path = input.pathByRecord?.get(record.id);
    const stuck = path?.stuck ? path : record.stuckInfo
      ? { stuck: true, stuckReason: record.stuckInfo.reason, achievedInsertion: record.stuckInfo.achievedInsertion }
      : null;
    if (stuck) {
      const reasonText: Record<string, string> = {
        casing: '机匣内壁',
        vane: '导向器叶片',
        hub: '轮毂',
        min_radius: '超过最小弯曲半径',
      };
      issues.push({
        level: 'warning',
        code: 'PROBE_STUCK',
        message: `记录「${record.title}」探头在 ${reasonText[stuck.stuckReason ?? 'casing'] ?? '障碍'} 处卡住（插入 ${stuck.achievedInsertion.toFixed(1)}mm）`,
        entityId: record.id,
      });
    }
  }

  for (const d of input.damages) {
    const engine = input.engines.find((e) => e.id === d.engineId);
    if (!engine) {
      issues.push({
        level: 'error',
        code: 'ORPHAN_REF',
        message: '标注引用了不存在的发动机',
        entityId: d.id,
      });
      continue;
    }
    if (isDamageOutsideBlade(engine, d)) {
      issues.push({
        level: 'error',
        code: 'DAMAGE_OUTSIDE_BLADE',
        message: `标注 ${d.id} 落在叶片几何范围外（span=${(d.spanPct * 100).toFixed(1)}%, t=${d.chordT.toFixed(3)}）`,
        entityId: d.id,
      });
    }
    if (d.fitError > 0.5) {
      issues.push({
        level: 'warning',
        code: 'FIT_ERROR_HIGH',
        message: `标注 ${d.id} 反算残差 ${d.fitError.toFixed(2)}mm 超过 0.5mm`,
        entityId: d.id,
      });
    }
    if (d.measurement?.exceedsLimit) {
      issues.push({
        level: 'warning',
        code: 'LIMIT_EXCEEDED',
        message: `标注 ${d.id} 测量值 ${d.measurement.lengthMm.toFixed(2)}mm 超过 AMM 限度 ${d.measurement.limitMm.toFixed(2)}mm`,
        entityId: d.id,
      });
    }
  }
  return issues;
}

/** 单次标注的即时校验（视窗点击后给用户反馈） */
export function validateDamagePlacement(engine: EngineModel, d: Damage): ValidationIssue | null {
  if (isDamageOutsideBlade(engine, d)) {
    return {
      level: 'error',
      code: 'DAMAGE_OUTSIDE_BLADE',
      message: '标注点落在叶片几何范围外，已拒绝保存',
      entityId: d.id,
    };
  }
  if (d.fitError > 0.5) {
    return {
      level: 'warning',
      code: 'FIT_ERROR_HIGH',
      message: `反算残差 ${d.fitError.toFixed(2)}mm 偏大`,
      entityId: d.id,
    };
  }
  return null;
}

export function worldRadial(p: { x: number; y: number; z: number } | number[]): number {
  const q = p as number[];
  return Math.hypot(q[1], q[2]);
}

export function assertCloseEnough(a: number[], b: number[], tolMm: number): boolean {
  return v3.dist(a as [number, number, number], b as [number, number, number]) <= tolMm;
}

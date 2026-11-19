import { describe, expect, it } from 'vitest';
import { buildSeedDataset } from '../data/seed';
import { replayFrame, sampleTrajectory } from '../core/probe/trajectory';
import { bladeParamToWorld } from '../core/geometry/airfoil';
import { isCrankDataMissing } from '../core/validation';

/**
 * 任务点 7/最关键指标的端到端验证：
 * 画面只由确定性输入决定，同一轨迹任意时刻重建，相机位姿与损伤世界坐标必须逐位一致，
 * 因此回放截图与历史截图叠加不存在可量化的、更不用说肉眼可见的错位。
 */
describe('回放确定性（叠图无错位的数学保证）', () => {
  const seed = buildSeedDataset();

  it('有效记录：同一轨迹时刻两次回放的头端位姿逐位相等', () => {
    const goodRecord = seed.records.find((r) => !isCrankDataMissing(r) && r.trajectory.frames.length >= 4)!;
    const engine = seed.engines.find((e) => e.id === goodRecord.engineModelId)!;
    const probe = seed.probes.find((p) => p.id === goodRecord.trajectory.probeId)!;
    const port = engine.ports.find((p) => p.id === goodRecord.trajectory.portId)!;
    const t = goodRecord.trajectory.frames[3].t - 0.37;

    const a = replayFrame(engine, probe, port, goodRecord.trajectory, t)!;
    const b = replayFrame(engine, probe, port, goodRecord.trajectory, t)!;
    expect(a.frame).toEqual(b.frame);
    expect(a.path.headPosition).toEqual(b.path.headPosition);
    expect(a.path.headDirection).toEqual(b.path.headDirection);
    // 路径采样点也完全一致（导管渲染几何相同）
    expect(a.path.points).toEqual(b.path.points);
  });

  it('跨"保存→重新加载"重建：用记录里的纯数据再次求解结果相同', () => {
    const rec = seed.records.find((r) => !isCrankDataMissing(r))!;
    const engine = seed.engines.find((e) => e.id === rec.engineModelId)!;
    const probe = seed.probes.find((p) => p.id === rec.trajectory.probeId)!;
    const port = engine.ports.find((p) => p.id === rec.trajectory.portId)!;
    // 模拟序列化往返（IndexedDB 存读）
    const serialized = JSON.parse(JSON.stringify(rec.trajectory));
    const t = serialized.frames[2].t;
    const before = replayFrame(engine, probe, port, rec.trajectory, t)!;
    const after = replayFrame(engine, probe, port, serialized, t)!;
    expect(after.path.headPosition).toEqual(before.path.headPosition);
    expect(after.path.headDirection).toEqual(before.path.headDirection);
  });

  it('损伤世界坐标只依赖参数坐标与盘车角：同 trackId 标注换会话重建位置不变', () => {
    const d = seed.damages.find((x) => x.spanPct <= 1 && x.chordT <= 1)!;
    const stage = seed.engines
      .find((e) => e.id === d.engineId)!
      .stages.find((s) => s.id === d.stageId)!;
    const rebuilt = bladeParamToWorld(stage, d.bladeIndex, d.crankDeg, d.spanPct, d.chordT, d.surface);
    expect(rebuilt).toEqual(d.worldPoint);
  });

  it('盘车丢帧记录在缺失时刻被识别，不会产生伪画面', () => {
    const broken = seed.records.find(isCrankDataMissing)!;
    const badFrame = broken.trajectory.frames.find((f) => Number.isNaN(f.crankDeg))!;
    const sampled = sampleTrajectory(broken.trajectory, badFrame.t);
    expect(sampled).not.toBeNull();
    expect(Number.isNaN(sampled!.crankDeg)).toBe(true);
  });
});

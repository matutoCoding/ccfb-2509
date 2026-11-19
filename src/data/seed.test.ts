import { describe, expect, it } from 'vitest';
import { buildSeedDataset } from './seed';
import { isCrankDataMissing, isDamageOutsideBlade, validateAll } from '../core/validation';

describe('种子数据集（任务点 9）', () => {
  const seed = buildSeedDataset();

  it('包含两种发动机构型', () => {
    expect(seed.engines).toHaveLength(2);
    expect(seed.engines[0].stages.length).toBeGreaterThanOrEqual(3);
    expect(seed.engines[1].stages.length).toBeGreaterThanOrEqual(2);
  });

  it('孔探记录数量达到几十条规模', () => {
    expect(seed.records.length).toBeGreaterThanOrEqual(30);
    expect(seed.damages.length).toBeGreaterThan(20);
  });

  it('确定性生成：两次构建数据完全一致', () => {
    const again = buildSeedDataset();
    expect(JSON.stringify(again)).toBe(JSON.stringify(seed));
  });

  it('存在盘车角度丢失的坏记录且能被识别', () => {
    const broken = seed.records.filter(isCrankDataMissing);
    expect(broken.length).toBeGreaterThan(0);
  });

  it('存在落在叶片几何外的坏标注且能被识别', () => {
    let outsideCount = 0;
    for (const d of seed.damages) {
      const engine = seed.engines.find((e) => e.id === d.engineId)!;
      if (isDamageOutsideBlade(engine, d)) outsideCount++;
    }
    expect(outsideCount).toBeGreaterThan(0);
  });

  it('存在探头卡住的坏记录且能被识别', () => {
    // 种子记录里持久化了真实求解得到的卡住信息
    const stuckRecords = seed.records.filter((r) => r.stuckInfo !== null);
    expect(stuckRecords.length).toBeGreaterThan(0);
    const issues = validateAll({
      engines: seed.engines, probes: seed.probes, records: seed.records, damages: seed.damages,
    });
    expect(issues.some((i) => i.code === 'PROBE_STUCK')).toBe(true);
  });

  it('validateAll 能同时报出三类问题', () => {
    const issues = validateAll({
      engines: seed.engines,
      probes: seed.probes,
      records: seed.records,
      damages: seed.damages,
    });
    const codes = new Set(issues.map((i) => i.code));
    expect(codes.has('CRANK_DATA_MISSING')).toBe(true);
    expect(codes.has('DAMAGE_OUTSIDE_BLADE')).toBe(true);
    expect(codes.has('LIMIT_EXCEEDED')).toBe(true);
  });
});

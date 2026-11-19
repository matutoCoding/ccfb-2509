import type { Damage, EngineModel, InspectionRecord, Probe } from '../core/types';
import { exportAll, importAll, STORES } from './db';

/** 导出文件封装格式（带版本与时间戳，质量部归档用） */
export interface ExportEnvelope {
  format: 'borescope-planner-export';
  version: 1;
  exportedAt: string;
  engineSerial?: string;
  engines: EngineModel[];
  probes: Probe[];
  records: InspectionRecord[];
  damages: Damage[];
}

export async function buildExportEnvelope(engineSerial?: string): Promise<ExportEnvelope> {
  const all = await exportAll();
  return {
    format: 'borescope-planner-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    engineSerial,
    engines: all[STORES.engines] as EngineModel[],
    probes: all[STORES.probes] as Probe[],
    records: all[STORES.records] as InspectionRecord[],
    damages: all[STORES.damages] as Damage[],
  };
}

export function downloadJson(envelope: ExportEnvelope, filename: string): void {
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 质量部复查用 CSV：损伤测量明细（Excel 可直接打开，带 UTF-8 BOM） */
export function damagesToCsv(damages: Damage[], engines: EngineModel[]): string {
  const header = [
    '损伤ID', '跟踪ID', '发动机', '序号级', '叶片号', '盘车角(°)', '类型',
    '叶高(%)', '距前缘(t)', '表面', '长度(mm)', '深度(mm)', 'AMM限度(mm)',
    '是否超限', '建议复查间隔(循环)', '反算残差(mm)', '世界坐标X', '世界坐标Y', '世界坐标Z', '标注时间',
  ];
  const engineName = (id: string) => engines.find((e) => e.id === id)?.name ?? id;
  const rows = damages.map((d) => [
    d.id, d.trackId, engineName(d.engineId), d.stageId, d.bladeIndex, d.crankDeg.toFixed(2),
    d.kind, (d.spanPct * 100).toFixed(2), d.chordT.toFixed(4), d.surface,
    d.measurement?.lengthMm ?? '', d.measurement?.depthMm ?? '', d.measurement?.limitMm ?? '',
    d.measurement?.exceedsLimit ? '是' : '否',
    d.measurement?.reInspectIntervalCycles ?? '',
    d.fitError.toFixed(4),
    d.worldPoint[0].toFixed(3), d.worldPoint[1].toFixed(3), d.worldPoint[2].toFixed(3),
    new Date(d.createdAt).toISOString(),
  ]);
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function csvCell(v: unknown): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importEnvelopeFile(file: File): Promise<ExportEnvelope> {
  const text = await file.text();
  const data = JSON.parse(text) as Partial<ExportEnvelope>;
  if (data.format !== 'borescope-planner-export') {
    throw new Error('文件格式不匹配：不是本系统导出的孔探数据包');
  }
  await importAll({
    engines: data.engines,
    probes: data.probes,
    records: data.records,
    damages: data.damages,
  });
  return data as ExportEnvelope;
}

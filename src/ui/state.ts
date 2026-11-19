import type { Damage, EngineModel, InspectionRecord, Probe } from '../core/types';
import { idbBulkPut, idbClear, idbGetAll, idbDelete, STORES } from '../data/db';
import { buildSeedDataset } from '../data/seed';
import { validateAll } from '../core/validation';
import type { ValidationIssue } from '../core/types';

export interface AppState {
  engines: EngineModel[];
  probes: Probe[];
  records: InspectionRecord[];
  damages: Damage[];
  issues: ValidationIssue[];
  loaded: boolean;
}

type Listener = (state: AppState) => void;

class Store {
  state: AppState = { engines: [], probes: [], records: [], damages: [], issues: [], loaded: false };
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.state.issues = validateAll({
      engines: this.state.engines,
      probes: this.state.probes,
      records: this.state.records,
      damages: this.state.damages,
    });
    for (const fn of this.listeners) fn(this.state);
  }

  async load(): Promise<void> {
    const [engines, probes, records, damages] = await Promise.all([
      idbGetAll<EngineModel>(STORES.engines),
      idbGetAll<Probe>(STORES.probes),
      idbGetAll<InspectionRecord>(STORES.records),
      idbGetAll<Damage>(STORES.damages),
    ]);
    this.state = { ...this.state, engines, probes, records, damages, loaded: true };
    this.emit();
  }

  async seedDemo(): Promise<void> {
    const seed = buildSeedDataset();
    await idbBulkPut(STORES.engines, seed.engines);
    await idbBulkPut(STORES.probes, seed.probes);
    await idbBulkPut(STORES.records, seed.records);
    await idbBulkPut(STORES.damages, seed.damages);
    await this.load();
  }

  async resetAll(): Promise<void> {
    await Promise.all(Object.values(STORES).map((s) => idbClear(s)));
    await this.load();
  }

  async saveEngine(engine: EngineModel): Promise<void> {
    engine.updatedAt = Date.now();
    const idx = this.state.engines.findIndex((e) => e.id === engine.id);
    if (idx >= 0) this.state.engines[idx] = engine;
    else this.state.engines.push(engine);
    await idbBulkPut(STORES.engines, [engine]);
    this.emit();
  }

  async deleteEngine(id: string): Promise<void> {
    this.state.engines = this.state.engines.filter((e) => e.id !== id);
    // 用顶层静态导入的 idbDelete
    await idbDelete(STORES.engines, id);
    this.emit();
  }

  async saveProbe(probe: Probe): Promise<void> {
    const idx = this.state.probes.findIndex((p) => p.id === probe.id);
    if (idx >= 0) this.state.probes[idx] = probe;
    else this.state.probes.push(probe);
    await idbBulkPut(STORES.probes, [probe]);
    this.emit();
  }

  async deleteProbe(id: string): Promise<void> {
    this.state.probes = this.state.probes.filter((p) => p.id !== id);
    // 用顶层静态导入的 idbDelete
    await idbDelete(STORES.probes, id);
    this.emit();
  }

  async saveRecord(record: InspectionRecord): Promise<void> {
    const idx = this.state.records.findIndex((r) => r.id === record.id);
    if (idx >= 0) this.state.records[idx] = record;
    else this.state.records.push(record);
    await idbBulkPut(STORES.records, [record]);
    this.emit();
  }

  async deleteRecord(id: string): Promise<void> {
    this.state.records = this.state.records.filter((r) => r.id !== id);
    const linked = this.state.damages.filter((d) => d.recordId === id);
    this.state.damages = this.state.damages.filter((d) => d.recordId !== id);
    // 用顶层静态导入的 idbDelete
    await idbDelete(STORES.records, id);
    for (const d of linked) await idbDelete(STORES.damages, d.id);
    this.emit();
  }

  async saveDamage(damage: Damage): Promise<void> {
    const idx = this.state.damages.findIndex((d) => d.id === damage.id);
    if (idx >= 0) this.state.damages[idx] = damage;
    else this.state.damages.push(damage);
    await idbBulkPut(STORES.damages, [damage]);
    this.emit();
  }

  async deleteDamage(id: string): Promise<void> {
    this.state.damages = this.state.damages.filter((d) => d.id !== id);
    // 用顶层静态导入的 idbDelete
    await idbDelete(STORES.damages, id);
    this.emit();
  }

  issuesFor(entityId: string): ValidationIssue[] {
    return this.state.issues.filter((i) => i.entityId === entityId);
  }
}

export const store = new Store();

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
}

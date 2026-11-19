import type { Damage } from '../../core/types';
import { predictLimitCycle } from '../../core/optics/measurement';
import { buildExportEnvelope, downloadJson, importEnvelopeFile } from '../../data/export';
import { store } from '../state';
import { el, toast } from '../dom';
import { damageKindLabel } from './damagesPage';
import type { PageHandle } from '../pageHandle';

interface TrackGroup {
  trackId: string;
  engineId: string;
  stageId: string;
  bladeIndex: number;
  kind: Damage['kind'];
  items: Damage[];
}

export function renderReviewPage(): PageHandle {
  const page = el('div', { class: 'page' });
  page.appendChild(el('h1', {}, '复查对比与趋势预测'));

  const toolbar = el('div', { class: 'toolbar' });
  const serialSel = el('select');
  const exportBtn = el('button', { class: 'primary' }, '导出完整数据包（JSON，交质量部）');
  const importBtn = el('button', {}, '导入数据包');
  const fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = '.json'; fileIn.style.display = 'none';
  toolbar.append(el('label', {}, '发动机序号 ', serialSel), exportBtn, importBtn, fileIn);
  page.appendChild(toolbar);

  const summary = el('div', { class: 'grid cols-4 mb' });
  page.appendChild(summary);
  const content = el('div', {});
  page.append(content);

  exportBtn.onclick = async () => {
    const env = await buildExportEnvelope(serialSel.value || undefined);
    downloadJson(env, `孔探数据包_${serialSel.value || '全量'}_${new Date().toISOString().slice(0, 10)}.json`);
    toast('数据包已导出（构型+探头+记录+标注，含校验所需全部数据）');
  };
  importBtn.onclick = () => fileIn.click();
  fileIn.onchange = async () => {
    const file = fileIn.files?.[0];
    if (!file) return;
    try {
      await importEnvelopeFile(file);
      toast('数据包已导入并合并到本地 IndexedDB');
    } catch (err) {
      toast(`导入失败：${(err as Error).message}`);
    }
  };

  function groupsFor(serial: string): TrackGroup[] {
    const records = store.state.records.filter((r) => r.engineSerial === serial);
    const recIds = new Set(records.map((r) => r.id));
    const damages = store.state.damages.filter((d) => recIds.has(d.recordId));
    const map = new Map<string, TrackGroup>();
    for (const d of damages) {
      const key = d.trackId;
      let g = map.get(key);
      if (!g) {
        g = { trackId: d.trackId, engineId: d.engineId, stageId: d.stageId, bladeIndex: d.bladeIndex, kind: d.kind, items: [] };
        map.set(key, g);
      }
      g.items.push(d);
    }
    for (const g of map.values()) {
      g.items.sort((a, b) => recordCycle(a.recordId) - recordCycle(b.recordId));
    }
    return [...map.values()].sort((a, b) => b.items.length - a.items.length);
  }

  function recordCycle(recordId: string): number {
    return store.state.records.find((r) => r.id === recordId)?.cycles ?? 0;
  }
  function recordDate(recordId: string): string {
    return store.state.records.find((r) => r.id === recordId)?.date ?? '';
  }

  function draw(): void {
    const serials = [...new Set(store.state.records.map((r) => r.engineSerial))];
    const prev = serialSel.value;
    serialSel.innerHTML = '<option value="">全部序号</option>' + serials.map((s) => `<option>${s}</option>`).join('');
    if (prev) serialSel.value = prev;

    const allGroups = serialSel.value
      ? groupsFor(serialSel.value)
      : [...new Set(store.state.records.map((r) => r.engineSerial))].flatMap((s) => groupsFor(s));

    // 汇总卡片
    summary.innerHTML = '';
    const tracked = allGroups.filter((g) => g.items.length >= 2);
    const exceeding = store.state.damages.filter((d) => d.measurement?.exceedsLimit).length;
    const issueCount = store.state.issues.length;
    const stat = (label2: string, value: string | number, tone = ''): HTMLElement => {
      const c = el('div', { class: 'card' });
      c.append(el('div', { class: `muted` }, label2), el('div', { style: `font-size:22px;margin-top:6px;${tone ? `color:var(--${tone})` : ''}` }, String(value)));
      return c;
    };
    summary.append(
      stat('跟踪损伤链', tracked.length),
      stat('累计标注', store.state.damages.length),
      stat('超限损伤', exceeding, exceeding ? 'error' : 'ok'),
      stat('数据质量问题', issueCount, issueCount ? 'warn' : 'ok'),
    );

    content.innerHTML = '';
    if (allGroups.length === 0) {
      content.appendChild(el('div', { class: 'card muted' }, '暂无复查数据。请先在孔探视窗页生成标注与记录。'));
      return;
    }

    // 时间轴（按发动机序号分组展示历次孔探）
    const timelineCard = el('div', { class: 'card mb' });
    timelineCard.appendChild(el('h3', {}, '孔探时间轴'));
    const tl = el('div', { class: 'timeline' });
    const shownRecords = new Set<string>();
    const sortedRecs = [...store.state.records]
      .filter((r) => !serialSel.value || r.engineSerial === serialSel.value)
      .sort((a, b) => a.cycles - b.cycles);
    for (const r of sortedRecs.slice(-14)) {
      shownRecords.add(r.id);
      const hasIssue = store.issuesFor(r.id).some((i) => i.level === 'error');
      const item = el('div', { class: `timeline-item ${hasIssue ? 'bad' : ''}` });
      const dmgCount = r.damageIds.length;
      item.append(
        el('div', {}, el('strong', {}, `${r.engineSerial} · ${r.cycles} 循环 · ${r.date}`)),
        el('div', { class: 'muted' }, `${r.title}｜${r.inspector}｜${dmgCount} 条标注${hasIssue ? '｜⚠ 含坏数据' : ''}`),
      );
      tl.appendChild(item);
    }
    timelineCard.appendChild(tl);
    content.appendChild(timelineCard);

    // 每条跟踪损伤的增长曲线
    for (const g of tracked.length ? tracked : allGroups.slice(0, 6)) {
      const chart = el('div', { class: 'chart-wrap mb' });
      const history = g.items.map((d) => ({
        cycles: recordCycle(d.recordId),
        lengthMm: d.measurement?.lengthMm ?? 0,
        date: recordDate(d.recordId),
      }));
      const limit = g.items[0].measurement?.limitMm ?? 3;
      const prediction = predictLimitCycle(history, limit);
      const head = el('div', { class: 'row spread' },
        el('strong', {}, `${damageKindLabel(g.kind)}｜${g.stageId}｜${g.bladeIndex} 号叶片（${g.items.length} 次复查）`),
        el('span', { class: prediction.limitCycle === null ? 'badge info' : 'badge warning' },
          prediction.limitCycle === null
            ? '当前无明显增长趋势'
            : `预计第 ${prediction.limitCycle} 循环达到限度（R²=${prediction.rSquared.toFixed(3)}）`),
      );
      chart.appendChild(head);
      chart.appendChild(renderGrowthChart(history, limit, prediction.limitCycle));
      const detail = el('div', { class: 'muted mt mono' }, history
        .map((h) => `${h.cycles}循环:${h.lengthMm.toFixed(2)}mm`)
        .join('  →  '));
      chart.appendChild(detail);
      content.appendChild(chart);
    }
  }

  const unsubscribe = store.subscribe(draw);
  serialSel.onchange = draw;
  return { element: page, dispose: unsubscribe };
}

/** 纯 SVG 折线图：历史长度、AMM 限度横线、预测到限点 */
function renderGrowthChart(
  history: { cycles: number; lengthMm: number; date: string }[],
  limitMm: number,
  limitCycle: number | null,
): SVGElement {
  const W = 640, H = 220, PAD = 46;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.width = '100%';
  const maxCycle = Math.max(history.at(-1)!.cycles * 1.15, limitCycle ?? 0);
  const maxLen = Math.max(limitMm * 1.15, ...history.map((h) => h.lengthMm)) * 1.1;
  const x = (c: number): number => PAD + (c / maxCycle) * (W - PAD * 2);
  const y = (v: number): number => H - PAD - (v / maxLen) * (H - PAD * 2);

  // 坐标轴
  const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, dash = ''): void => {
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', String(x1)); l.setAttribute('y1', String(y1));
    l.setAttribute('x2', String(x2)); l.setAttribute('y2', String(y2));
    l.setAttribute('stroke', stroke);
    if (dash) l.setAttribute('stroke-dasharray', dash);
    svg.appendChild(l);
  };
  line(PAD, H - PAD, W - PAD, H - PAD, '#3a4656');
  line(PAD, PAD, PAD, H - PAD, '#3a4656');
  // 限度线
  line(PAD, y(limitMm), W - PAD, y(limitMm), '#e5604f', '6 4');
  const limitLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  limitLabel.setAttribute('x', String(W - PAD - 120));
  limitLabel.setAttribute('y', String(y(limitMm) - 6));
  limitLabel.setAttribute('fill', '#ff9b8e');
  limitLabel.setAttribute('font-size', '11');
  limitLabel.textContent = `AMM 限度 ${limitMm}mm`;
  svg.appendChild(limitLabel);

  // 数据折线
  const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', '#4da3ff');
  poly.setAttribute('stroke-width', '2');
  poly.setAttribute('points', history.map((h) => `${x(h.cycles)},${y(h.lengthMm)}`).join(' '));
  svg.appendChild(poly);
  for (const h of history) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', String(x(h.cycles)));
    c.setAttribute('cy', String(y(h.lengthMm)));
    c.setAttribute('r', '4');
    c.setAttribute('fill', h.lengthMm > limitMm ? '#e5604f' : '#7fe0b0');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${h.date} / ${h.cycles}循环 / ${h.lengthMm}mm`;
    c.appendChild(title);
    svg.appendChild(c);
  }
  // 预测到限点
  if (limitCycle !== null) {
    const px = x(limitCycle), py = y(limitMm);
    line(history[0] ? x(history[0].cycles) : PAD, y(history[0]?.lengthMm ?? 0), px, py, '#e8a94d', '3 3');
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', String(px)); dot.setAttribute('cy', String(py));
    dot.setAttribute('r', '5'); dot.setAttribute('fill', '#e8a94d');
    svg.appendChild(dot);
  }
  // 轴标签
  const xLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  xLabel.setAttribute('x', String(W / 2 - 30)); xLabel.setAttribute('y', String(H - 12));
  xLabel.setAttribute('fill', '#8a94a3'); xLabel.setAttribute('font-size', '11');
  xLabel.textContent = '发动机循环数';
  svg.appendChild(xLabel);
  return svg;
}

import type { Damage, DamageKind } from '../../core/types';
import { damagesToCsv, downloadCsv } from '../../data/export';
import { store } from '../state';
import { el, toast } from '../dom';
import type { PageHandle } from '../pageHandle';

const KIND_LABEL: Record<DamageKind, string> = {
  burn: '烧蚀', crack: '裂纹', nick: '缺口', coating_loss: '涂层剥落', fod: '外物打伤',
};

export function renderDamagesPage(): PageHandle {
  const page = el('div', { class: 'page' });
  page.appendChild(el('h1', {}, '损伤标注与数据质量'));

  // 数据质量总览（任务点 9 的坏记录面板）
  const issueCard = el('div', { class: 'card mb' });
  page.appendChild(issueCard);
  const toolbar = el('div', { class: 'toolbar' });
  const engineFilter = el('select');
  const kindFilter = el('select');
  kindFilter.innerHTML = '<option value="">全部类型</option>' +
    Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const onlyBad = el('input'); onlyBad.type = 'checkbox'; onlyBad.id = 'only-bad';
  const badLabel = el('label', {}, '只看问题数据 ');
  badLabel.appendChild(onlyBad);
  const exportBtn = el('button', { class: 'primary' }, '导出质量部 CSV');
  toolbar.append(el('label', {}, '机型 ', engineFilter), el('label', {}, '类型 ', kindFilter), badLabel, exportBtn);
  page.appendChild(toolbar);

  const tableCard = el('div', { class: 'card scroll-x' });
  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th>损伤ID</th><th>机型/级</th><th>叶片</th><th>盘车角</th><th>类型</th>
    <th>叶高%</th><th>弦向t</th><th>表面</th><th>长度mm</th><th>深度mm</th>
    <th>AMM限度</th><th>判定</th><th>残差mm</th><th>复查间隔</th><th>操作</th>
  </tr></thead>`;
  const tbody = el('tbody');
  table.appendChild(tbody);
  tableCard.appendChild(table);
  page.appendChild(tableCard);

  function engineName(id: string): string {
    return store.state.engines.find((e) => e.id === id)?.name ?? id;
  }
  function stageName(engineId: string, stageId: string): string {
    return store.state.engines.find((e) => e.id === engineId)?.stages.find((s) => s.id === stageId)?.name ?? stageId;
  }

  function drawIssues(): void {
    issueCard.innerHTML = '';
    const issues = store.state.issues;
    const head = el('div', { class: 'row spread' },
      el('strong', {}, `数据质量校验：${issues.length} 条问题`),
      el('span', { class: 'muted' }, '探头卡住 / 盘车丢帧 / 标注越界 / 超限 自动识别'),
    );
    issueCard.appendChild(head);
    if (issues.length === 0) {
      issueCard.appendChild(el('div', { class: 'badge ok mt' }, '✓ 未发现数据质量问题'));
      return;
    }
    const list = el('div', { class: 'mt' });
    for (const issue of issues.slice(0, 12)) {
      list.appendChild(el('div', { class: 'mt' },
        el('span', { class: `badge ${issue.level === 'error' ? 'error' : 'warning'}` }, issue.level === 'error' ? '错误' : '警告'),
        ' ', issue.message,
      ));
    }
    if (issues.length > 12) list.appendChild(el('div', { class: 'muted mt' }, `…另有 ${issues.length - 12} 条，导出 CSV 可查看全部`));
    issueCard.appendChild(list);
  }

  function drawRows(): void {
    tbody.innerHTML = '';
    const rows = store.state.damages.filter((d) => {
      if (engineFilter.value && d.engineId !== engineFilter.value) return false;
      if (kindFilter.value && d.kind !== kindFilter.value) return false;
      if (onlyBad.checked) {
        const issue = store.issuesFor(d.id);
        if (issue.length === 0 && !d.measurement?.exceedsLimit) return false;
      }
      return true;
    });
    if (rows.length === 0) {
      tbody.appendChild(el('tr', {}, el('td', { colspan: '15', class: 'muted' }, '无匹配标注')));
      return;
    }
    for (const d of rows) {
      const issues = store.issuesFor(d.id);
      const tr = el('tr');
      const verdict = d.measurement?.exceedsLimit
        ? el('span', { class: 'badge error' }, '超限')
        : el('span', { class: 'badge ok' }, '合格');
      tr.append(
        el('td', { class: 'mono' }, d.id.slice(-8)),
        el('td', {}, `${engineName(d.engineId)} / ${stageName(d.engineId, d.stageId)}`),
        el('td', {}, String(d.bladeIndex)),
        el('td', {}, d.crankDeg.toFixed(1)),
        el('td', {}, KIND_LABEL[d.kind]),
        el('td', {}, (d.spanPct * 100).toFixed(1)),
        el('td', {}, d.chordT.toFixed(3)),
        el('td', {}, d.surface === 'suction' ? '吸力面' : '压力面'),
        el('td', {}, String(d.measurement?.lengthMm ?? '—')),
        el('td', {}, String(d.measurement?.depthMm ?? '—')),
        el('td', {}, String(d.measurement?.limitMm ?? '—')),
        el('td', {}, verdict),
        el('td', {}, d.fitError.toFixed(3)),
        el('td', {}, d.measurement ? (d.measurement.reInspectIntervalCycles === 0 ? '立即处理' : `${d.measurement.reInspectIntervalCycles} 循环`) : '—'),
      );
      const ops = el('td');
      const del = el('button', { class: 'danger' }, '删除');
      del.onclick = async () => {
        if (confirm('删除该损伤标注？')) await store.deleteDamage(d.id);
      };
      if (issues.length) {
        ops.appendChild(el('div', { class: `badge ${issues[0].level === 'error' ? 'error' : 'warning'}` }, issues[0].code));
      }
      ops.appendChild(del);
      tr.appendChild(ops);
      tbody.appendChild(tr);
    }
  }

  function syncEngines(): void {
    const prev = engineFilter.value;
    engineFilter.innerHTML = '<option value="">全部机型</option>';
    for (const e of store.state.engines) engineFilter.appendChild(el('option', { value: e.id }, e.name));
    engineFilter.value = prev;
  }
  engineFilter.onchange = drawRows;
  kindFilter.onchange = drawRows;
  onlyBad.onchange = drawRows;
  exportBtn.onclick = () => {
    if (store.state.damages.length === 0) return toast('暂无标注可导出');
    const csv = damagesToCsv(store.state.damages, store.state.engines);
    downloadCsv(csv, `孔探损伤明细_${new Date().toISOString().slice(0, 10)}.csv`);
    toast('CSV 已导出，可直接交质量部归档');
  };

  const unsubscribe = store.subscribe(() => { syncEngines(); drawIssues(); drawRows(); });
  return { element: page, dispose: unsubscribe };
}

export function damageKindLabel(k: DamageKind): string {
  return KIND_LABEL[k];
}
export type { Damage };

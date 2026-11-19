import type { EngineModel, Probe, ProbePathResult } from '../../core/types';
import { solveProbePath } from '../../core/probe/probePath';
import { rad2deg, v3 } from '../../core/math/vec3';
import { newId, store } from '../state';
import { el, field, modal, numInput, textInput, toast } from '../dom';
import type { PageHandle } from '../pageHandle';

export function renderProbesPage(): PageHandle {
  const page = el('div', { class: 'page' });
  page.appendChild(el('h1', {}, '探头库与路径规划'));

  const toolbar = el('div', { class: 'toolbar' });
  const addBtn = el('button', { class: 'primary' }, '＋ 新建探头');
  toolbar.appendChild(addBtn);
  page.appendChild(toolbar);
  addBtn.onclick = () => openProbeEditor(null);

  const tableCard = el('div', { class: 'card' });
  page.appendChild(tableCard);
  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th>名称</th><th>类型</th><th>直径</th><th>工作长度</th><th>弯曲角/半径</th><th>镜头</th><th>FOV</th><th>操作</th>
  </tr></thead>`;
  const tbody = el('tbody');
  table.appendChild(tbody);
  tableCard.appendChild(table);

  const drawProbes = (): void => {
    tbody.innerHTML = '';
    for (const p of store.state.probes) {
      const tr = el('tr');
      tr.append(
        el('td', {}, p.name),
        el('td', {}, p.kind === 'rigid' ? '刚性' : '柔性'),
        el('td', {}, `${p.diameter}mm`),
        el('td', {}, `${p.workingLength}mm`),
        el('td', {}, p.kind === 'flexible' ? `${p.bendAngleDeg}° / R${p.minBendRadius}mm` : `${p.bendAngleDeg}°`),
        el('td', {}, p.lens === 'forward' ? '直视' : '侧视'),
        el('td', {}, `${p.fovDeg}°`),
      );
      const ops = el('td');
      const edit = el('button', {}, '编辑');
      edit.onclick = () => openProbeEditor(p);
      const del = el('button', { class: 'danger' }, '删除');
      del.onclick = async () => {
        if (confirm(`删除探头 ${p.name}？`)) await store.deleteProbe(p.id);
      };
      ops.append(edit, del);
      tr.appendChild(ops);
      tbody.appendChild(tr);
    }
  };

  page.appendChild(el('h2', {}, '路径规划与碰撞检测'));
  const plannerCard = el('div', { class: 'card' });
  page.appendChild(plannerCard);
  buildPlanner(plannerCard);

  const unsubList: (() => void)[] = [];
  unsubList.push(store.subscribe(drawProbes));
  unsubList.push(buildPlanner(plannerCard));
  return { element: page, dispose: () => unsubList.forEach((u) => u()) };
}

function openProbeEditor(existing: Probe | null): void {
  const probe: Probe = existing
    ? structuredClone(existing)
    : {
        id: newId('probe'), name: '新探头', kind: 'flexible', diameter: 6, workingLength: 500,
        bendAngleDeg: 120, minBendRadius: 25, lens: 'forward', fovDeg: 90,
        distortionK1: -0.2, vignette: 0.6, ledPower: 1,
      };
  const body = el('div');
  const nameIn = textInput(probe.name);
  const kindSel = el('select');
  kindSel.innerHTML = `<option value="flexible">柔性导管</option><option value="rigid">刚性导管</option>`;
  kindSel.value = probe.kind;
  const lensSel = el('select');
  lensSel.innerHTML = `<option value="forward">直视镜头</option><option value="side">侧视镜头</option>`;
  lensSel.value = probe.lens;
  const mk = (label2: string, key: keyof Probe, step: number): HTMLElement => {
    const inp = numInput(Number(probe[key]) || 0, step);
    inp.onchange = () => { (probe[key] as number) = Number(inp.value); };
    return field(label2, inp);
  };
  const g = el('div', { class: 'grid cols-3' });
  g.append(
    field('探头名称', nameIn), field('类型', kindSel), field('镜头', lensSel),
    mk('直径 mm', 'diameter', 0.1), mk('工作长度 mm', 'workingLength', 1),
    mk('头端弯曲角 °', 'bendAngleDeg', 1),
    mk('最小弯曲半径 mm（刚性留 0）', 'minBendRadius', 1),
    mk('水平视场角 °', 'fovDeg', 1), mk('桶形畸变 k1', 'distortionK1', 0.01),
    mk('暗角强度 0~1', 'vignette', 0.05), mk('LED 功率', 'ledPower', 0.1),
  );
  body.appendChild(g);
  const actions = el('div', { class: 'row mt spread' });
  const save = el('button', { class: 'primary' }, '保存');
  const cancel = el('button', {}, '取消');
  actions.append(cancel, save);
  body.appendChild(actions);
  const close = modal(body);
  cancel.onclick = close;
  save.onclick = async () => {
    probe.name = nameIn.value;
    probe.kind = kindSel.value as Probe['kind'];
    probe.lens = lensSel.value as Probe['lens'];
    if (probe.kind === 'rigid') probe.minBendRadius = null;
    if (probe.minBendRadius !== null && probe.minBendRadius <= 0) probe.minBendRadius = null;
    await store.saveProbe(probe);
    toast('探头已保存');
    close();
  };
}

function buildPlanner(card: HTMLElement): () => void {
  const engineSel = el('select');
  const probeSel = el('select');
  const portSel = el('select');
  const insertIn = numInput(150, 1);
  const crankIn = numInput(0, 0.1);
  const guideSel = el('select');
  guideSel.innerHTML = `
    <option value="none">沿孔口法线（默认）</option>
    <option value="inward">指向轴心（向内观察）</option>
    <option value="aft">向后（气流下游）</option>
    <option value="outward">指向机匣外壁（碰撞测试）</option>`;
  const resultBox = el('div', { class: 'mt' });
  const canvas = el('canvas', { width: '760', height: '320' }) as HTMLCanvasElement;
  canvas.style.width = '100%';
  canvas.style.background = '#0c0f14';
  canvas.style.borderRadius = '7px';

  function refreshSelectors(): void {
    engineSel.innerHTML = '';
    for (const e of store.state.engines) engineSel.appendChild(el('option', { value: e.id }, e.name));
    probeSel.innerHTML = '';
    for (const p of store.state.probes) probeSel.appendChild(el('option', { value: p.id }, p.name));
    syncPorts();
  }
  function syncPorts(): void {
    const engine = currentEngine();
    portSel.innerHTML = '';
    if (!engine) return;
    for (const p of engine.ports) portSel.appendChild(el('option', { value: p.id }, p.name));
  }
  function currentEngine(): EngineModel | undefined {
    return store.state.engines.find((e) => e.id === engineSel.value);
  }

  engineSel.onchange = syncPorts;
  const run = el('button', { class: 'primary' }, '求解路径');
  const head = el('div', { class: 'grid cols-3 mb' });
  head.append(
    field('机型', engineSel), field('探头', probeSel), field('孔探口', portSel),
    field('请求插入深度 mm', insertIn), field('盘车角 °', crankIn), field('柔性导引方向', guideSel),
  );
  card.append(head, run, resultBox, canvas);

  let lastResult: ProbePathResult | null = null;
  run.onclick = () => {
    const engine = currentEngine();
    const probe = store.state.probes.find((p) => p.id === probeSel.value);
    const port = engine?.ports.find((p) => p.id === portSel.value);
    if (!engine || !probe || !port) return toast('请先选择机型、探头与孔探口');
    const guideMap: Record<string, [number, number, number] | undefined> = {
      none: undefined,
      inward: v3.normalize(v3.scale(port.position, -1)),
      aft: [1, 0, 0],
      outward: [0, 1, 0],
    };
    const result = solveProbePath({
      probe, port, engine,
      insertionMm: Number(insertIn.value),
      crankDeg: Number(crankIn.value),
      guideDirection: guideMap[guideSel.value],
    });
    lastResult = result;
    resultBox.innerHTML = '';
    const status = result.stuck
      ? el('span', { class: 'badge error' }, `卡住：${reasonText(result.stuckReason)}，实际插入 ${result.achievedInsertion.toFixed(1)}mm`)
      : el('span', { class: 'badge ok' }, `顺利到达，插入 ${result.achievedInsertion.toFixed(1)}mm`);
    const headDir = result.headDirection.map((x) => x.toFixed(3)).join(', ');
    resultBox.append(
      el('div', { class: 'row spread' }, status, el('span', { class: 'muted mono' }, `头端方向 [${headDir}]`)),
    );
    drawPath(canvas, engine, result);
  };

  const unsubSelector = store.subscribe(refreshSelectors);
  refreshSelectors();
  void lastResult;
  return unsubSelector;
}

function reasonText(reason: ProbePathResult['stuckReason']): string {
  const map: Record<string, string> = {
    casing: '机匣内壁', vane: '导向器叶片', hub: '轮毂', min_radius: '超过最小弯曲半径',
  };
  return (reason && map[reason]) || '未知';
}

/** 2D 俯视图投影（X 轴向 vs 径向高度），画出机匣边界、路径与卡点 */
function drawPath(canvas: HTMLCanvasElement, engine: EngineModel, result: ProbePathResult): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const xs = result.points.map((p) => p[0]);
  const minX = Math.min(...xs, engine.axialLength * 0.1) - 20;
  const maxX = Math.max(...xs, engine.axialLength * 0.95) + 20;
  const maxR = engine.casingRadius + 20;
  const sx = (x: number): number => ((x - minX) / (maxX - minX)) * (W - 80) + 40;
  const sy = (r: number): number => H - 40 - (r / maxR) * (H - 80);

  // 机匣与轮毂参考线
  ctx.strokeStyle = '#3a4656';
  ctx.setLineDash([6, 5]);
  line(ctx, sx(minX), sy(engine.casingRadius), sx(maxX), sy(engine.casingRadius));
  const hubR = Math.min(...engine.stages.map((s) => s.hubRadius));
  line(ctx, sx(minX), sy(hubR), sx(maxX), sy(hubR));
  ctx.setLineDash([]);
  ctx.fillStyle = '#8a94a3';
  ctx.font = '11px Consolas';
  ctx.fillText(`机匣 R${engine.casingRadius}`, sx(maxX) - 90, sy(engine.casingRadius) - 5);
  ctx.fillText(`轮毂 R${hubR}`, sx(maxX) - 70, sy(hubR) + 14);

  // 路径
  ctx.strokeStyle = result.stuck ? '#e5604f' : '#4da3ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  result.points.forEach((p, i) => {
    const x = sx(p[0]);
    const y = sy(Math.hypot(p[1], p[2]));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // 头端
  const head = result.points[result.points.length - 1];
  if (head) {
    ctx.fillStyle = '#7fe0b0';
    ctx.beginPath();
    ctx.arc(sx(head[0]), sy(Math.hypot(head[1], head[2])), 4, 0, Math.PI * 2);
    ctx.fill();
  }
  // 卡点
  if (result.stuck && result.stuckPoint) {
    const sp = result.stuckPoint;
    ctx.fillStyle = '#ff6b5e';
    ctx.beginPath();
    ctx.arc(sx(sp[0]), sy(Math.hypot(sp[1], sp[2])), 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff9b8e';
    ctx.fillText('▲ 卡点', sx(sp[0]) + 8, sy(Math.hypot(sp[1], sp[2])) - 6);
  }
  // 各级位置刻度
  ctx.fillStyle = '#5a6675';
  for (const st of engine.stages) {
    const x = sx(st.axialX);
    ctx.fillText(`${st.name}(${st.bladeCount})`, x - 30, H - 18);
    ctx.strokeStyle = '#262e39';
    line(ctx, x, 30, x, H - 40);
  }
  void rad2deg;
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

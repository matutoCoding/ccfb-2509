import type { BorescopePort, EngineModel, Stage } from '../../core/types';
import { crankToAlignBlade, nearestBladeIndex } from '../../core/geometry/airfoil';
import { newId, store } from '../state';
import { el, field, modal, numInput, textInput, toast } from '../dom';
import type { PageHandle } from '../pageHandle';

export function renderEnginesPage(): PageHandle {
  const page = el('div', { class: 'page' });
  page.appendChild(el('h1', {}, '发动机构型'));

  const toolbar = el('div', { class: 'toolbar' });
  const newBtn = el('button', { class: 'primary' }, '＋ 新建机型');
  const seedBtn = el('button', {}, '载入演示数据（两种机型 + 34 条记录）');
  const resetBtn = el('button', { class: 'danger' }, '清空全部数据');
  toolbar.append(newBtn, seedBtn, resetBtn);
  page.appendChild(toolbar);

  newBtn.onclick = () => openEngineEditor(null);
  seedBtn.onclick = async () => {
    await store.seedDemo();
    toast('演示数据已生成（含探头卡住、盘车丢帧、标注越界三类坏记录）');
  };
  resetBtn.onclick = async () => {
    if (confirm('确认清空 IndexedDB 中的全部构型与记录？')) {
      await store.resetAll();
      toast('已清空');
    }
  };

  const list = el('div', { class: 'grid cols-2' });
  page.appendChild(list);

  const draw = (): void => {
    list.innerHTML = '';
    if (store.state.engines.length === 0) {
      list.appendChild(el('div', { class: 'card muted' }, '暂无构型，点击「新建机型」或「载入演示数据」开始。'));
      return;
    }
    for (const engine of store.state.engines) {
      const card = el('div', { class: 'card clickable' });
      card.appendChild(el('div', { class: 'row spread' },
        el('strong', {}, engine.name),
        el('span', { class: 'badge info' }, `${engine.stages.length} 级 / ${engine.ports.length} 孔探口`),
      ));
      card.appendChild(el('div', { class: 'muted mt' },
        `${engine.manufacturer} · 机匣半径 ${engine.casingRadius}mm · 轴向长度 ${engine.axialLength}mm`));
      const stageLine = engine.stages
        .map((s) => `${s.kind === 'rotor' ? '转' : '导'}「${s.name}」×${s.bladeCount}片`)
        .join('　');
      card.appendChild(el('div', { class: 'mt' }, stageLine));
      const btnRow = el('div', { class: 'row mt' });
      const edit = el('button', {}, '编辑构型');
      const crank = el('button', {}, '盘车定位计算');
      const del = el('button', { class: 'danger' }, '删除');
      btnRow.append(edit, crank, del);
      card.appendChild(btnRow);
      edit.onclick = (e) => { e.stopPropagation(); openEngineEditor(engine); };
      crank.onclick = (e) => { e.stopPropagation(); openCrankTool(engine); };
      del.onclick = async (e) => {
        e.stopPropagation();
        if (confirm(`删除机型 ${engine.name}？`)) await store.deleteEngine(engine.id);
      };
      list.appendChild(card);
    }
  };
  const unsubscribe = store.subscribe(draw);
  return { element: page, dispose: unsubscribe };
}

function openEngineEditor(existing: EngineModel | null): void {
  const isNew = !existing;
  const engine: EngineModel = existing
    ? structuredClone(existing)
    : {
        id: newId('eng'), name: '新机型', manufacturer: '', casingRadius: 300, axialLength: 700,
        stages: [], ports: [], createdAt: Date.now(), updatedAt: Date.now(),
      };

  const body = el('div');
  const head = el('div', { class: 'grid cols-2 mb' });
  const nameIn = textInput(engine.name);
  const makerIn = textInput(engine.manufacturer);
  const casingIn = numInput(engine.casingRadius);
  const lengthIn = numInput(engine.axialLength);
  head.append(
    field('机型名称', nameIn), field('制造商', makerIn),
    field('机匣内壁半径 mm', casingIn), field('轴向长度 mm', lengthIn),
  );
  body.appendChild(head);

  // 级列表
  body.appendChild(el('h3', {}, '压气机/涡轮级'));
  const stageBox = el('div', { class: 'grid' });
  body.appendChild(stageBox);
  const addStage = el('button', {}, '＋ 添加级');
  body.appendChild(addStage);

  function redrawStages(): void {
    stageBox.innerHTML = '';
    engine.stages.forEach((stage, idx) => {
      const row = el('div', { class: 'card' });
      row.appendChild(el('div', { class: 'row spread' },
        el('strong', {}, `${idx + 1}. ${stage.name}`),
        el('span', { class: 'badge info' }, stage.kind === 'rotor' ? '转子' : '静子'),
      ));
      const g = el('div', { class: 'grid cols-4 mt' });
      const bind = (label2: string, key: keyof Stage, step = 1): HTMLElement => {
        const cur = stage[key] as number;
        const inp = typeof cur === 'number' ? numInput(cur, step) : textInput(String(cur));
        inp.onchange = () => {
          (stage[key] as number | string) = typeof cur === 'number' ? Number(inp.value) : inp.value;
        };
        return field(label2, inp);
      };
      g.append(
        bind('叶片/导叶数', 'bladeCount'),
        bind('轴向位置 mm', 'axialX'),
        bind('叶根半径 mm', 'hubRadius'),
        bind('叶尖半径 mm', 'tipRadius'),
        bind('叶根弦长 mm', 'chordRoot'),
        bind('叶尖弦长 mm', 'chordTip'),
        bind('根安装角 °', 'staggerRoot'),
        bind('尖安装角 °', 'staggerTip'),
        bind('后掠 mm', 'sweep'),
        bind('1号叶相位 °', 'indexPhaseDeg'),
      );
      const nameF = textInput(stage.name);
      nameF.onchange = () => { stage.name = nameF.value; };
      g.prepend(field('级名称', nameF));
      row.appendChild(g);
      const del = el('button', { class: 'danger mt' }, '删除该级');
      del.onclick = () => { engine.stages.splice(idx, 1); redrawStages(); };
      row.appendChild(del);
      stageBox.appendChild(row);
    });
  }
  addStage.onclick = () => {
    engine.stages.push({
      id: newId('stg'), name: `新级 ${engine.stages.length + 1}`, kind: 'rotor',
      bladeCount: 40, axialX: 400, hubRadius: 200, tipRadius: 290,
      chordRoot: 80, chordTip: 50, staggerRoot: 35, staggerTip: 28, sweep: 0,
      airfoil: { camber: 0.09, camberPos: 0.45, thickness: 0.06, thicknessPos: 0.35, leadingRadius: 0.012, trailingRadius: 0.006 },
      defaultMaterial: 'single_crystal', indexPhaseDeg: 0,
      ammLimits: { burn: 3, crack: 1.5, nick: 2, coating_loss: 8, fod: 2.5 },
    });
    redrawStages();
  };
  redrawStages();

  // 孔探口
  body.appendChild(el('h3', { class: 'mt' }, '孔探口'));
  const portBox = el('div', { class: 'grid' });
  body.appendChild(portBox);
  const addPort = el('button', {}, '＋ 添加孔探口');
  body.appendChild(addPort);
  function redrawPorts(): void {
    portBox.innerHTML = '';
    engine.ports.forEach((port, idx) => {
      const row = el('div', { class: 'card' });
      row.appendChild(el('strong', {}, `${idx + 1}. ${port.name}`));
      const g = el('div', { class: 'grid cols-4 mt' });
      const mk = (label2: string, get: () => number, set: (v: number) => void): HTMLElement => {
        const inp = numInput(get(), 0.1);
        inp.onchange = () => set(Number(inp.value));
        return field(label2, inp);
      };
      const nameF = textInput(port.name);
      nameF.onchange = () => { port.name = nameF.value; };
      g.append(
        field('孔口名称', nameF),
        mk('位置 X mm', () => port.position[0], (v) => (port.position[0] = v)),
        mk('位置 Y mm', () => port.position[1], (v) => (port.position[1] = v)),
        mk('位置 Z mm', () => port.position[2], (v) => (port.position[2] = v)),
        mk('法线 X', () => port.normal[0], (v) => (port.normal[0] = v)),
        mk('法线 Y', () => port.normal[1], (v) => (port.normal[1] = v)),
        mk('法线 Z', () => port.normal[2], (v) => (port.normal[2] = v)),
        mk('孔径 mm', () => port.holeDiameter, (v) => (port.holeDiameter = v)),
      );
      const targetSel = el('select');
      for (const s of engine.stages) {
        const o = el('option', { value: s.id }, s.name);
        if (port.targetStageId === s.id) o.selected = true;
        targetSel.appendChild(o);
      }
      targetSel.onchange = () => { port.targetStageId = targetSel.value; };
      g.appendChild(field('目标级', targetSel));
      row.appendChild(g);
      const del = el('button', { class: 'danger mt' }, '删除孔探口');
      del.onclick = () => { engine.ports.splice(idx, 1); redrawPorts(); };
      row.appendChild(del);
      portBox.appendChild(row);
    });
  }
  addPort.onclick = () => {
    const port: BorescopePort = {
      id: newId('port'), name: `新孔探口 ${engine.ports.length + 1}`,
      position: [350, engine.casingRadius - 6, 0], normal: [1, 0, 0],
      holeDiameter: 10, targetStageId: engine.stages[0]?.id ?? '',
    };
    engine.ports.push(port);
    redrawPorts();
  };
  redrawPorts();

  const actions = el('div', { class: 'row mt spread' });
  const save = el('button', { class: 'primary' }, '保存构型');
  const cancel = el('button', {}, '取消');
  actions.append(cancel, save);
  body.appendChild(actions);

  const close = modal(body);
  cancel.onclick = close;
  save.onclick = async () => {
    engine.name = nameIn.value || '未命名机型';
    engine.manufacturer = makerIn.value;
    engine.casingRadius = Number(casingIn.value);
    engine.axialLength = Number(lengthIn.value);
    if (engine.stages.length === 0) return toast('至少需要一个级');
    await store.saveEngine(engine);
    toast(isNew ? '机型已创建' : '构型已更新');
    close();
  };
}

/** 盘车定位工具：输入叶片编号与目标周向角，输出盘车角并反向验证 */
function openCrankTool(engine: EngineModel): void {
  const body = el('div');
  body.appendChild(el('h3', {}, `盘车定位 — ${engine.name}`));
  const stageSel = el('select');
  for (const s of engine.stages.filter((x) => x.kind === 'rotor')) {
    stageSel.appendChild(el('option', { value: s.id }, `${s.name}（${s.bladeCount} 片）`));
  }
  const bladeIn = numInput(1);
  const targetIn = numInput(90);
  const out = el('div', { class: 'card mt mono' });
  const calc = (): void => {
    const stage = engine.stages.find((s) => s.id === stageSel.value);
    if (!stage) return;
    const blade = Math.max(1, Math.min(stage.bladeCount, Math.round(Number(bladeIn.value))));
    const targetDeg = Number(targetIn.value);
    const crank = crankToAlignBlade(stage, blade, (targetDeg * Math.PI) / 180);
    const verify = nearestBladeIndex(stage, crank, (targetDeg * Math.PI) / 180);
    out.innerHTML = '';
    out.append(
      el('div', {}, `将 ${blade} 号叶片转到周向 ${targetDeg}° 所需盘车角：`),
      el('div', { class: 'mt' }, `盘车 ${crank.toFixed(3)}°`),
      el('div', { class: 'mt' }, `反向验证：该角度下 ${targetDeg}° 位置最近叶片 = ${verify} 号 ${verify === blade ? '✅ 一致' : '❌ 偏差'}`),
    );
  };
  const run = el('button', { class: 'primary mt' }, '计算');
  run.onclick = calc;
  body.append(
    field('转子级', stageSel),
    el('div', { class: 'grid cols-2 mt' }, field('叶片编号', bladeIn), field('目标周向角 °（顶部=90）', targetIn)),
    run, out,
  );
  modal(body);
  calc();
}

import type { Damage, DamageKind, EngineModel, InspectionRecord, Probe, ProbePathResult, SurfaceMaterial } from '../../core/types';
import { solveProbePath } from '../../core/probe/probePath';
import { makeTrajectory, sampleTrajectory, appendFrame } from '../../core/probe/trajectory';
import { lensFromProbe, pixelToRay, worldToNdc, type CameraPose } from '../../core/optics/lens';
import { backProjectRay } from '../../core/geometry/backprojection';
import { buildStageMesh } from '../../core/geometry/bladeMesh';
import { bladeParamToWorld } from '../../core/geometry/airfoil';
import { evaluateDamage, focalPixels, shadowMethodMeasure } from '../../core/optics/measurement';
import { v3, type Vec3 } from '../../core/math/vec3';
import { WebGpuRenderer, type RenderView } from '../../render/WebGpuRenderer';
import { buildCasingGeometry, buildProbeTubeGeometry, buildStageGpuGeometry } from '../../render/geometryGpu';
import { newId, store } from '../state';
import { el, field, numInput, toast } from '../dom';
import type { PageHandle } from '../pageHandle';

const KIND_LABEL: Record<DamageKind, string> = {
  burn: '烧蚀', crack: '裂纹', nick: '缺口', coating_loss: '涂层剥落', fod: '外物打伤',
};
const MATERIAL_LABEL: Record<SurfaceMaterial, string> = {
  single_crystal: '单晶合金', tbc: '热障涂层', carbon: '积碳', heat_tint: '高温变色',
};

interface ViewportSession {
  engine: EngineModel;
  probe: Probe;
  record: InspectionRecord;
  stageId: string;
  portId: string;
  crankDeg: number;
  insertionMm: number;
  path: ProbePathResult | null;
  recording: boolean;
  replaying: boolean;
  compareMode: boolean;
  lastSnapshot?: string;
}

export function renderViewportPage(initialRecordId?: string): PageHandle {
  const page = el('div', { class: 'page' });
  page.appendChild(el('h1', {}, '孔探视窗'));
  const notice = el('div', { class: 'card muted mb' },
    '在视窗中点击叶片表面即可反算三维坐标并标注；画面由盘车角、插入深度与探头定义确定性生成，同一轨迹回放逐帧一致。');
  page.appendChild(notice);

  const layout = el('div', { class: 'viewport-layout' });
  const main = el('div', { class: 'viewport-main' });
  const panel = el('div', { class: 'side-panel' });
  layout.append(main, panel);
  page.appendChild(layout);

  const canvas = el('canvas', { id: 'scene' }) as HTMLCanvasElement;
  const overlay = el('div', { class: 'overlay-wrap' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'overlay-svg');
  overlay.append(canvas, svg);
  main.appendChild(overlay);

  const renderer = new WebGpuRenderer();
  let session: ViewportSession | null = null;
  let rafId = 0;
  let meshCache: ReturnType<typeof buildStageMesh> | null = null;
  let currentPose: CameraPose | null = null;
  let pendingDamageKind: DamageKind = 'burn';

  // ---------- 控制面板 ----------
  const engineSel = el('select');
  const probeSel = el('select');
  const portSel = el('select');
  const stageSel = el('select');
  const serialIn = el('input'); serialIn.placeholder = '发动机序号，如 TF2-2401';
  const crankIn = numInput(0, 0.1);
  const insertIn = numInput(120, 1);
  const bladeIn = numInput(1);
  const matSel = el('select');
  for (const [k, label2] of Object.entries(MATERIAL_LABEL)) matSel.appendChild(el('option', { value: k }, label2));
  const kindSel = el('select');
  for (const [k, label2] of Object.entries(KIND_LABEL)) kindSel.appendChild(el('option', { value: k }, label2));
  const shadowOffsetIn = numInput(12, 1);
  const featureSpanIn = numInput(30, 1);

  const statusLine = el('div', { class: 'badge info' }, '未开始');
  const coordLine = el('div', { class: 'mono muted' }, '点击画面后显示反算坐标');
  const stuckLine = el('div', {});

  function panelSection(title: string): HTMLElement {
    const h = el('h3', {}, title);
    panel.appendChild(h);
    return h;
  }
  panelSection('会话配置');
  panel.append(
    field('机型', engineSel), field('探头', probeSel), field('孔探口', portSel),
    field('观察级', stageSel), field('发动机序号', serialIn),
  );
  const startBtn = el('button', { class: 'primary' }, '开始孔探会话');
  panel.appendChild(startBtn);

  panelSection('探头控制');
  panel.append(
    field('盘车角 °', crankIn), field('插入深度 mm', insertIn),
    field('对准叶片编号（反算目标）', bladeIn),
  );
  const applyBtn = el('button', {}, '应用位姿');
  panel.appendChild(applyBtn);
  panel.append(statusLine, stuckLine, coordLine);

  panelSection('损伤标注（点击画面）');
  panel.append(field('损伤类型', kindSel), field('观察面材质', matSel));
  const measureBox = el('div', { class: 'grid cols-2' });
  measureBox.append(field('阴影偏移 px', shadowOffsetIn), field('损伤像素跨度 px', featureSpanIn));
  panel.appendChild(measureBox);
  const markBtn = el('button', { class: 'primary' }, '启用点击标注');
  const snapBtn = el('button', {}, '保存当前截图');
  panel.append(markBtn, snapBtn);

  panelSection('轨迹与回放');
  const recBtn = el('button', {}, '● 开始记录轨迹');
  const stopRecBtn = el('button', {}, '■ 停止并保存记录');
  const replayTime = el('input'); replayTime.type = 'range'; replayTime.min = '0'; replayTime.value = '0';
  const replayBtn = el('button', {}, '▶ 回放（叠图复核）');
  const recordSel = el('select');
  panel.append(recBtn, stopRecBtn, field('回放时间 t', replayTime), replayBtn, field('加载历史记录', recordSel));

  function syncSelectors(): void {
    const prevEngine = engineSel.value;
    engineSel.innerHTML = '';
    for (const e of store.state.engines) engineSel.appendChild(el('option', { value: e.id }, e.name));
    if (prevEngine) engineSel.value = prevEngine;
    probeSel.innerHTML = '';
    for (const p of store.state.probes) probeSel.appendChild(el('option', { value: p.id }, p.name));
    syncEngineChildren();
    recordSel.innerHTML = '<option value="">— 选择历史记录加载轨迹 —</option>';
    for (const r of store.state.records) recordSel.appendChild(el('option', { value: r.id }, r.title));
    if (initialRecordId) recordSel.value = initialRecordId;
  }
  function syncEngineChildren(): void {
    const engine = store.state.engines.find((e) => e.id === engineSel.value);
    portSel.innerHTML = '';
    stageSel.innerHTML = '';
    if (!engine) return;
    for (const p of engine.ports) portSel.appendChild(el('option', { value: p.id }, p.name));
    for (const s of engine.stages) stageSel.appendChild(el('option', { value: s.id }, `${s.name}（${s.bladeCount}片）`));
  }
  engineSel.onchange = syncEngineChildren;

  // ---------- 会话与渲染 ----------
  startBtn.onclick = () => {
    const engine = store.state.engines.find((e) => e.id === engineSel.value);
    const probe = store.state.probes.find((p) => p.id === probeSel.value);
    if (!engine || !probe) return toast('请先选择机型与探头');
    const record: InspectionRecord = {
      id: newId('rec'), engineModelId: engine.id, engineSerial: serialIn.value || '未登记序号',
      title: `${serialIn.value || '临时'} 孔探 ${new Date().toLocaleString('zh-CN')}`,
      inspector: '当前用户', cycles: 0, date: new Date().toISOString().slice(0, 10),
      crankDeg: Number(crankIn.value), trajectory: makeTrajectory(probe.id, portSel.value, probe.lens),
      damageIds: [], snapshots: [], stuckInfo: null, notes: '', createdAt: Date.now(),
    };
    session = {
      engine, probe, record, stageId: stageSel.value, portId: portSel.value,
      crankDeg: Number(crankIn.value), insertionMm: Number(insertIn.value),
      path: null, recording: false, replaying: false, compareMode: false,
    };
    meshCache = buildStageMesh(engine.stages.find((s) => s.id === stageSel.value)!, Number(crankIn.value));
    uploadScene();
    statusLine.textContent = '会话进行中';
    statusLine.className = 'badge ok';
    updatePath();
  };

  function uploadScene(): void {
    if (!session) return;
    const stage = session!.engine.stages.find((s) => s.id === session!.stageId)!;
    // 涂层剥落标注 → GPU 剥落区（露出合金底材，与周围 TBC 颜色拉开）
    const spallZones = store.state.damages
      .filter((d) => d.engineId === session!.engine.id && d.stageId === stage.id && d.kind === 'coating_loss')
      .map((d) => ({
        bladeIndex: d.bladeIndex,
        surface: (d.surface === 'suction' ? 0 : 1) as 0 | 1,
        spanPct: d.spanPct,
        chordT: d.chordT,
        spanRadius: 0.04 + (d.measurement?.lengthMm ?? 2) / stage.tipRadius,
        chordRadius: 0.05 + (d.measurement?.lengthMm ?? 2) / (stage.chordTip * 2),
      }));
    const geo = buildStageGpuGeometry(stage, session!.crankDeg, undefined, spallZones);
    renderer.uploadStage('stage', geo);
    const casing = buildCasingGeometry(session.engine);
    renderer.uploadIndexedMesh('casing', casing.vertexData, casing.indices, false);
  }

  function updatePath(): void {
    if (!session) return;
    const port = session!.engine.ports.find((p) => p.id === session!.portId)!;
    session!.path = solveProbePath({
      probe: session!.probe, port, engine: session!.engine,
      insertionMm: session!.insertionMm, crankDeg: session!.crankDeg,
    });
    const tube = buildProbeTubeGeometry(session.path.points, session.probe.diameter);
    renderer.uploadIndexedMesh('probe', tube.vertexData, tube.indices, true);
    stuckLine.innerHTML = '';
    if (session.path.stuck) {
      stuckLine.className = 'stuck-flash mt';
      stuckLine.textContent = `⚠ 探头卡住：${session.path.stuckReason} @ 插入 ${session.path.achievedInsertion.toFixed(1)}mm`;
      // 回写到记录，保存后即被数据质量校验识别为 PROBE_STUCK
      session.record.stuckInfo = {
        reason: session.path.stuckReason,
        achievedInsertion: session.path.achievedInsertion,
        stuckPoint: session.path.stuckPoint,
      };
    } else {
      stuckLine.className = 'muted mt';
      stuckLine.textContent = `已插入 ${session.path.achievedInsertion.toFixed(1)}mm，路径通畅`;
      session.record.stuckInfo = null;
    }
    renderFrame();
  }

  applyBtn.onclick = () => {
    if (!session) return toast('请先开始会话');
    session.crankDeg = Number(crankIn.value);
    session!.insertionMm = Number(insertIn.value);
    const stage = session!.engine.stages.find((s) => s.id === session!.stageId)!;
    meshCache = buildStageMesh(stage, session!.crankDeg);
    uploadScene();
    updatePath();
  };

  function currentCameraPose(): CameraPose | null {
    if (!session?.path) return null;
    const p = session.path;
    const forward = p.headDirection;
    let upHint: Vec3 = [0, 1, 0];
    if (Math.abs(v3.dot(forward, upHint)) > 0.92) upHint = [1, 0, 0];
    return { position: p.headPosition, forward, up: upHint };
  }

  function renderFrame(): void {
    if (!session?.path) return;
    const pose = currentCameraPose()!;
    currentPose = pose;
    const target = v3.add(pose.position, pose.forward);
    const view: RenderView = {
      eye: pose.position, target, up: pose.up,
      lightPos: pose.position, lightPower: session.probe.ledPower,
      lens: lensFromProbe(session.probe),
    };
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width));
    const h = Math.max(240, Math.round(rect.height));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    renderer.render(view, w, h);
    drawDamageOverlays(w, h, pose);
  }

  function drawDamageOverlays(w: number, h: number, pose: CameraPose): void {
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    if (!session) return;
    const stage = session!.engine.stages.find((s) => s.id === session!.stageId)!;
    const lens = lensFromProbe(session!.probe);
    const aspect = w / h;
    const related = store.state.damages.filter(
      (d) => d.engineId === session!.engine.id && d.stageId === stage.id && d.crankDeg === session!.crankDeg,
    );
    for (const d of related) {
      const world = bladeParamToWorld(stage, d.bladeIndex, d.crankDeg, d.spanPct, d.chordT, d.surface);
      const [nx, ny, cz] = worldToNdc(lens, pose, world, aspect);
      if (cz <= 0 || Math.abs(nx) > 1.1 || Math.abs(ny) > 1.1) continue;
      const px = ((nx + 1) / 2) * w;
      const py = ((1 - ny) / 2) * h;
      const color = d.measurement?.exceedsLimit ? '#ff6b5e' : '#ffd24d';
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', String(px));
      circle.setAttribute('cy', String(py));
      circle.setAttribute('r', '9');
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', color);
      circle.setAttribute('stroke-width', '2');
      circle.setAttribute('class', 'clickable');
      circle.onclick = () => toast(`${KIND_LABEL[d.kind]} @ 叶高${(d.spanPct * 100).toFixed(1)}% t=${d.chordT.toFixed(3)} ${d.measurement?.exceedsLimit ? '【超限】' : ''}`);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String(px + 12));
      text.setAttribute('y', String(py + 4));
      text.setAttribute('fill', color);
      text.setAttribute('font-size', '11');
      text.textContent = KIND_LABEL[d.kind];
      svg.append(circle, text);
    }
  }

  // ---------- 点击反算标注 ----------
  let marking = false;
  markBtn.onclick = () => {
    marking = !marking;
    markBtn.textContent = marking ? '标注中…再次点击关闭' : '启用点击标注';
    markBtn.classList.toggle('primary', marking);
  };
  kindSel.onchange = () => { pendingDamageKind = kindSel.value as DamageKind; };

  canvas.addEventListener('click', async (ev) => {
    if (!marking || !session || !currentPose || !meshCache) return;
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const lens = lensFromProbe(session!.probe);
    const ray = pixelToRay(lens, currentPose, canvas.width, canvas.height, px, py);
    const stage = session!.engine.stages.find((s) => s.id === session!.stageId)!;
    const expectedBlade = Math.max(1, Math.min(stage.bladeCount, Math.round(Number(bladeIn.value))));
    const back = backProjectRay(stage, session!.crankDeg, ray, meshCache, expectedBlade);
    if (!back) {
      toast('未命中目标叶片，请调整对准叶片编号或探头位姿');
      return;
    }
    coordLine.textContent = `叶${back.bladeIndex} 叶高${(back.spanPct * 100).toFixed(2)}% t=${back.chordT.toFixed(4)} ${back.surface} 残差${back.fitError.toFixed(3)}mm`;

    // 阴影法测量
    const fpx = focalPixels(session.probe.fovDeg, canvas.width);
    const measured = shadowMethodMeasure({
      cameraPosition: currentPose.position,
      opticalAxis: currentPose.forward,
      damagePoint: back.worldPoint,
      shadowOffsetPx: Number(shadowOffsetIn.value),
      projectionAngleDeg: 45,
      focalPx: fpx,
      featureSpanPx: Number(featureSpanIn.value),
    });
    const evaluation = evaluateDamage(stage, pendingDamageKind, measured.lengthMm, measured.depthMm);
    evaluation.shadowOffsetPx = Number(shadowOffsetIn.value);

    const damage: Damage = {
      id: newId('dmg'), recordId: session.record.id, engineId: session.engine.id,
      stageId: stage.id, crankDeg: session.crankDeg, bladeIndex: back.bladeIndex,
      kind: pendingDamageKind, spanPct: back.spanPct, chordT: back.chordT,
      surface: back.surface, worldPoint: back.worldPoint, fitError: back.fitError,
      measurement: evaluation, trackId: newId('track'), note: '', createdAt: Date.now(),
    };
    await store.saveDamage(damage);
    session.record.damageIds.push(damage.id);
    if (evaluation.exceedsLimit) toast(`超限！${KIND_LABEL[pendingDamageKind]} ${evaluation.lengthMm.toFixed(2)}mm > 限度 ${evaluation.limitMm}mm，建议立即处理`);
    else toast(`已标注：${KIND_LABEL[pendingDamageKind]}，建议复查间隔 ${evaluation.reInspectIntervalCycles} 循环`);
    drawDamageOverlays(canvas.width, canvas.height, currentPose);
  });

  snapBtn.onclick = async () => {
    if (!session) return;
    const dataUrl = await renderer.snapshot();
    session.record.snapshots.push({ frameT: session.record.trajectory.frames.at(-1)?.t ?? 0, dataUrl });
    session.lastSnapshot = dataUrl;
    toast('截图已附加到当前记录');
  };

  // ---------- 轨迹记录/回放 ----------
  recBtn.onclick = () => {
    if (!session) return toast('请先开始会话');
    session.recording = true;
    recBtn.textContent = '● 记录中…位姿变化将自动写入';
    toast('轨迹记录已开始');
  };
  stopRecBtn.onclick = async () => {
    if (!session) return;
    session.recording = false;
    recBtn.textContent = '● 开始记录轨迹';
    await store.saveRecord(session.record);
    syncSelectors();
    toast(`记录已保存（${session.record.trajectory.frames.length} 帧，${session.record.damageIds.length} 条标注）`);
  };

  // 位姿变化时若在记录则追加轨迹帧
  const watchAndAppend = (): void => {
    if (session?.recording && session.path) {
      const t = session.record.trajectory.frames.length * 2;
      appendFrame(session.record.trajectory, { t, crankDeg: session.crankDeg, insertionMm: session.insertionMm });
    }
  };
  const origApply = applyBtn.onclick;
  applyBtn.onclick = (ev) => { (origApply as (e: MouseEvent) => void)(ev); watchAndAppend(); };

  recordSel.onchange = async () => {
    const rec = store.state.records.find((r) => r.id === recordSel.value);
    if (!rec || !session) {
      if (rec) toast('请先开始与该记录同机型的会话，再加载轨迹');
      return;
    }
    session.record = structuredClone(rec);
    const last = rec.trajectory.frames.at(-1);
    if (last) {
      replayTime.max = String(last.t);
      replayTime.value = '0';
    }
    toast(`已加载记录 ${rec.title} 的轨迹，可拖动回放`);
  };

  replayBtn.onclick = () => {
    if (!session) return;
    const traj = session.record.trajectory;
    if (traj.frames.length === 0) return toast('该记录没有轨迹帧');
    const last = traj.frames.at(-1)!;
    replayTime.max = String(last.t);
    let t = 0;
    cancelAnimationFrame(rafId);
    const step = (): void => {
      const frame = sampleTrajectory(traj, t);
      if (!frame) return;
      crankIn.value = String(frame.crankDeg);
      insertIn.value = String(frame.insertionMm.toFixed(1));
      session!.crankDeg = frame.crankDeg;
      session!.insertionMm = frame.insertionMm;
      const stage = session!.engine.stages.find((s) => s.id === session!.stageId)!;
      meshCache = buildStageMesh(stage, frame.crankDeg);
      uploadScene();
      updatePath();
      replayTime.value = String(t);
      t += 0.4;
      if (t <= last.t) rafId = requestAnimationFrame(step);
      else toast('回放完成：位姿与截图应无肉眼错位');
    };
    step();
  };
  replayTime.oninput = () => {
    if (!session) return;
    const frame = sampleTrajectory(session.record.trajectory, Number(replayTime.value));
    if (!frame || Number.isNaN(frame.crankDeg)) {
      if (frame && Number.isNaN(frame.crankDeg)) toast('该帧盘车角度数据缺失（坏记录），无法重建画面');
      return;
    }
    session!.crankDeg = frame.crankDeg;
    session!.insertionMm = frame.insertionMm;
    crankIn.value = String(frame.crankDeg);
    insertIn.value = String(frame.insertionMm.toFixed(1));
    const stage = session!.engine.stages.find((s) => s.id === session!.stageId)!;
    meshCache = buildStageMesh(stage, frame.crankDeg);
    uploadScene();
    updatePath();
  };

  // ---------- 初始化 ----------
  const unsubscribe = store.subscribe(syncSelectors);
  syncSelectors();
  if (store.state.engines.length === 0) {
    main.appendChild(el('div', { class: 'card' }, '请先在「发动机构型」页载入演示数据或新建机型。'));
  }
  renderer.init(canvas).then(() => {
    const resize = () => renderFrame();
    new ResizeObserver(resize).observe(canvas);
  }).catch((err: Error) => {
    main.appendChild(el('div', { class: 'card stuck-flash' }, `WebGPU 初始化失败：${err.message}`));
  });

  return {
    element: page,
    dispose: () => {
      cancelAnimationFrame(rafId);
      unsubscribe();
      renderer.destroy();
    },
  };
}

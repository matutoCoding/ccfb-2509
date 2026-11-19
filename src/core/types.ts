import type { Vec3 } from './math/vec3';

/** 表面材质类型（任务点 4） */
export type SurfaceMaterial =
  | 'single_crystal' // 新件单晶合金
  | 'tbc' // 热障涂层
  | 'carbon' // 积碳
  | 'heat_tint'; // 高温变色

export type DamageKind = 'burn' | 'crack' | 'nick' | 'coating_loss' | 'fod';

export type ProbeKind = 'rigid' | 'flexible';
export type LensView = 'forward' | 'side';

/** 叶型参数（二维叶型，单位 mm，参数沿弦向 t∈[0,1]） */
export interface AirfoilParams {
  /** 中弧线弯度：最大弯度（占弦长比） */
  camber: number;
  /** 最大弯度位置 t */
  camberPos: number;
  /** 最大厚度（占弦长比） */
  thickness: number;
  /** 最大厚度位置 t */
  thicknessPos: number;
  /** 前缘半径（占弦长比） */
  leadingRadius: number;
  /** 后缘半径（占弦长比） */
  trailingRadius: number;
}

/** AMM 可接受限度（mm），按损伤类别给出 */
export interface AmmLimits {
  burn: number;
  crack: number;
  nick: number;
  coating_loss: number;
  fod: number;
}

export interface Stage {
  id: string;
  name: string;
  kind: 'rotor' | 'stator';
  /** 叶片数（导向器为导叶数） */
  bladeCount: number;
  /** 轮盘轴向位置（发动机坐标，mm） */
  axialX: number;
  /** 叶根半径 */
  hubRadius: number;
  /** 叶尖半径（= 机匣内壁半径） */
  tipRadius: number;
  /** 叶根弦长 / 叶尖弦长 */
  chordRoot: number;
  chordTip: number;
  /** 安装角（deg，叶型弦线相对发动机周向的夹角） */
  staggerRoot: number;
  staggerTip: number;
  /** 后掠（叶尖相对叶根的轴向偏移，mm） */
  sweep: number;
  airfoil: AirfoilParams;
  /** 默认材质，可被单叶覆盖 */
  defaultMaterial: SurfaceMaterial;
  /** 1 号叶片相对周向 0° 的初始相位角（deg） */
  indexPhaseDeg: number;
  ammLimits: AmmLimits;
}

/** 孔探口（机匣上的观察孔） */
export interface BorescopePort {
  id: string;
  name: string;
  /** 孔口中心（发动机坐标，应在机匣外壁附近） */
  position: Vec3;
  /** 孔口朝内的法线方向（单位向量） */
  normal: Vec3;
  /** 孔径（mm），决定可通过的最大探头直径 */
  holeDiameter: number;
  /** 推荐到达的级 id */
  targetStageId: string;
}

export interface EngineModel {
  id: string;
  name: string;
  manufacturer: string;
  /** 机匣内壁半径（mm） */
  casingRadius: number;
  /** 机匣轴向范围 */
  axialLength: number;
  stages: Stage[];
  ports: BorescopePort[];
  createdAt: number;
  updatedAt: number;
}

export interface Probe {
  id: string;
  name: string;
  kind: ProbeKind;
  /** 直径 mm */
  diameter: number;
  /** 工作长度 mm */
  workingLength: number;
  /** 头端最大弯曲角 deg（刚性探头为固定弯头角度；柔性为可达弯曲角） */
  bendAngleDeg: number;
  /** 柔性探头最小弯曲半径 mm；刚性为 null */
  minBendRadius: number | null;
  lens: LensView;
  /** 镜头水平视场角 deg */
  fovDeg: number;
  /** 桶形畸变系数 k1（负值为桶形） */
  distortionK1: number;
  /** 暗角强度 0..1 */
  vignette: number;
  /** LED 环形光功率（相对值） */
  ledPower: number;
}

/** 一次探头插入的求解结果（任务点 2） */
export interface ProbePathResult {
  probeId: string;
  portId: string;
  insertionMm: number;
  /** 路径采样折线（发动机坐标） */
  points: Vec3[];
  /** 头端位置/朝向 */
  headPosition: Vec3;
  headDirection: Vec3;
  /** 是否卡住 */
  stuck: boolean;
  /** 卡住位置（null = 未卡） */
  stuckPoint: Vec3 | null;
  /** 卡住原因 */
  stuckReason: 'casing' | 'vane' | 'hub' | 'min_radius' | null;
  /** 实际可插入深度（卡住时小于请求值） */
  achievedInsertion: number;
}

/** 损伤标注（任务点 5/6），坐标全部可复现地存"叶型参数坐标 + 世界坐标双份" */
export interface Damage {
  id: string;
  recordId: string;
  engineId: string;
  stageId: string;
  /** 盘车角度（deg），标注时的角度 */
  crankDeg: number;
  /** 叶片编号（1 起） */
  bladeIndex: number;
  kind: DamageKind;
  /** 叶高百分比 0=叶根 1=叶尖 */
  spanPct: number;
  /** 距前缘距离（占当地弦长比）t，0=前缘 1=后缘 */
  chordT: number;
  /** 吸力面 / 压力面 */
  surface: 'suction' | 'pressure';
  /** 反算得到的世界坐标（标注当时，mm） */
  worldPoint: Vec3;
  /** 反算残差（mm） */
  fitError: number;
  /** 阴影法测量结果 */
  measurement: DamageMeasurement | null;
  /** 与历次同处损伤的关联 id（复查链路） */
  trackId: string;
  note: string;
  createdAt: number;
}

export interface DamageMeasurement {
  /** 阴影法估计长度 mm */
  lengthMm: number;
  /** 估计深度 mm（烧蚀/缺口/打伤） */
  depthMm: number;
  /** 投影偏移像素 */
  shadowOffsetPx: number;
  /** AMM 限度 mm */
  limitMm: number;
  /** 是否超限 */
  exceedsLimit: boolean;
  /** 建议复查间隔（循环数） */
  reInspectIntervalCycles: number | null;
}

/** 轨迹帧：盘车角 + 插入深度 + 探头配置即可确定性复现画面（任务点 7） */
export interface TrajectoryFrame {
  t: number;
  crankDeg: number;
  insertionMm: number;
}

export interface Trajectory {
  frames: TrajectoryFrame[];
  probeId: string;
  portId: string;
  lens: LensView;
}

export interface InspectionRecord {
  id: string;
  engineModelId: string;
  engineSerial: string;
  title: string;
  inspector: string;
  /** 累积循环数 */
  cycles: number;
  date: string;
  crankDeg: number;
  trajectory: Trajectory;
  damageIds: string[];
  /** 关键帧截图（JPEG dataURL，用于叠图复核） */
  snapshots: { frameT: number; dataUrl: string }[];
  /** 路径求解时若发生卡滞，记录原因与实际插入深度（确定性，随记录持久化） */
  stuckInfo: { reason: ProbePathResult['stuckReason']; achievedInsertion: number; stuckPoint: Vec3 | null } | null;
  notes: string;
  createdAt: number;
}

/** 数据校验结果（任务点 9 坏记录） */
export interface ValidationIssue {
  level: 'error' | 'warning';
  code:
    | 'PROBE_STUCK'
    | 'CRANK_DATA_MISSING'
    | 'DAMAGE_OUTSIDE_BLADE'
    | 'FIT_ERROR_HIGH'
    | 'LIMIT_EXCEEDED'
    | 'ORPHAN_REF';
  message: string;
  entityId: string;
}

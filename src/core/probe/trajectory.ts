import type { ProbePathResult, Trajectory, TrajectoryFrame } from '../types';
import { solveProbePath, type PathRequest } from '../probe/probePath';
import type { EngineModel, Probe } from '../types';
import type { BorescopePort } from '../types';

/**
 * 轨迹（任务点 7）。
 * 复现性的关键：画面只由 (发动机几何版本, 探头定义, 孔探口, 盘车角, 插入深度) 决定，
 * 不存任何派生网格/随机状态。材质噪声全部用世界坐标哈希（见 materials.ts），
 * 因此同一轨迹任意时刻回放，画面像素确定。
 */
export function makeTrajectory(probeId: string, portId: string, lens: Trajectory['lens']): Trajectory {
  return { frames: [], probeId, portId, lens };
}

export function appendFrame(traj: Trajectory, frame: TrajectoryFrame): void {
  const last = traj.frames[traj.frames.length - 1];
  if (last && frame.t <= last.t) return;
  traj.frames.push({ ...frame });
}

export function sampleTrajectory(traj: Trajectory, t: number): TrajectoryFrame | null {
  if (traj.frames.length === 0) return null;
  if (t <= traj.frames[0].t) return { ...traj.frames[0] };
  const last = traj.frames[traj.frames.length - 1];
  if (t >= last.t) return { ...last };
  for (let i = 0; i < traj.frames.length - 1; i++) {
    const a = traj.frames[i], b = traj.frames[i + 1];
    if (t >= a.t && t <= b.t) {
      const k = (t - a.t) / Math.max(1e-9, b.t - a.t);
      return {
        t,
        crankDeg: a.crankDeg + (b.crankDeg - a.crankDeg) * k,
        insertionMm: a.insertionMm + (b.insertionMm - a.insertionMm) * k,
      };
    }
  }
  return null;
}

export interface ReplayState {
  frame: TrajectoryFrame;
  path: ProbePathResult;
}

/** 确定性回放：任意轨迹时刻 → 同一位姿的探头路径 */
export function replayFrame(
  engine: EngineModel,
  probe: Probe,
  port: BorescopePort,
  traj: Trajectory,
  t: number,
  guideDirection?: PathRequest['guideDirection'],
): ReplayState | null {
  const frame = sampleTrajectory(traj, t);
  if (!frame) return null;
  const path = solveProbePath({
    probe,
    port,
    engine,
    insertionMm: frame.insertionMm,
    crankDeg: frame.crankDeg,
    guideDirection,
  });
  return { frame, path };
}

/** 两次回放的位姿一致性检查（叠图无错位的数学保证） */
export function poseDifference(a: ReplayState, b: ReplayState): { positionMm: number; angleDeg: number } {
  const pa = a.path.headPosition, pb = b.path.headPosition;
  const da = a.path.headDirection, db = b.path.headDirection;
  const cosA = Math.min(1, Math.abs(da[0] * db[0] + da[1] * db[1] + da[2] * db[2]));
  return {
    positionMm: Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]),
    angleDeg: (Math.acos(cosA) * 180) / Math.PI,
  };
}

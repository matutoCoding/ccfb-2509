import type { BorescopePort, EngineModel, Probe, ProbePathResult } from '../types';
import { clamp, v3, type Vec3 } from '../math/vec3';
import { buildStageMesh, raycastBlades } from '../geometry/bladeMesh';
import type { Stage } from '../types';

const STEP_MM = 2.0;
const RADIUS_SAFETY = 0.5; // 探头表面与障碍的安全间隙 mm

export interface PathRequest {
  probe: Probe;
  port: BorescopePort;
  engine: EngineModel;
  insertionMm: number;
  /** 柔性探头目标导引方向（头端期望朝向，单位向量） */
  guideDirection?: Vec3;
  /** 侧视/直视镜头在头端的朝向偏转（deg），由探头 bendAngle 决定 */
  headBendDeg?: number;
  crankDeg: number;
}

interface Collider {
  kind: 'casing' | 'hub' | 'vane';
  radius?: number; // casing/hub 圆柱面半径
  mesh?: ReturnType<typeof buildStageMesh>;
  stage?: Stage;
  crankDeg?: number;
}

function buildColliders(engine: EngineModel, crankDeg: number): Collider[] {
  const list: Collider[] = [{ kind: 'casing', radius: engine.casingRadius }];
  const hubRadii = new Set<number>();
  for (const stage of engine.stages) {
    hubRadii.add(stage.hubRadius);
    if (stage.kind === 'stator') {
      list.push({ kind: 'vane', mesh: buildStageMesh(stage, crankDeg), stage, crankDeg });
    }
  }
  for (const r of hubRadii) list.push({ kind: 'hub', radius: r });
  return list;
}

function pointCollides(colliders: Collider[], p: Vec3, probeRadius: number): ProbePathResult['stuckReason'] {
  const radial = Math.hypot(p[1], p[2]);
  for (const c of colliders) {
    if (c.kind === 'casing' && radial + probeRadius + RADIUS_SAFETY >= c.radius!) {
      return 'casing';
    }
    if (c.kind === 'hub' && radial - probeRadius - RADIUS_SAFETY <= c.radius!) {
      return 'hub';
    }
    if (c.kind === 'vane' && c.mesh) {
      // 以点为中心、探头半径为半径做最近相交近似：沿六个方向短射线
      const dirs: Vec3[] = [
        [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
      ];
      for (const d of dirs) {
        const hit = raycastBlades(
          c.mesh,
          v3.sub(p, v3.scale(d, probeRadius + RADIUS_SAFETY)),
          d,
          undefined,
          c.stage,
          0,
        );
        if (hit && hit.t <= (probeRadius + RADIUS_SAFETY) * 2 + 0.01) return 'vane';
      }
    }
  }
  return null;
}

/** 三点折线的曲率半径（mm），共线时返回 Infinity */
function curvatureRadius(p0: Vec3, p1: Vec3, p2: Vec3): number {
  const a = v3.dist(p0, p1);
  const b = v3.dist(p1, p2);
  const c = v3.dist(p0, p2);
  const area4 = v3.norm(v3.cross(v3.sub(p1, p0), v3.sub(p2, p0))); // 2*面积
  if (area4 < 1e-9) return Infinity;
  return (a * b * c) / (2 * area4);
}

/**
 * 刚性探头：沿孔口法线直线推进，头端带固定弯头。
 */
function solveRigid(req: PathRequest, colliders: Collider[]): ProbePathResult {
  const { probe, port, insertionMm } = req;
  const dir = v3.normalize(port.normal);
  const probeRadius = probe.diameter / 2;
  const points: Vec3[] = [];
  const total = Math.min(insertionMm, probe.workingLength);
  let stuck: ProbePathResult['stuckReason'] = null;
  let stuckPoint: Vec3 | null = null;
  let achieved = 0;

  for (let d = 0; d <= total + 1e-6; d += STEP_MM) {
    const p = v3.add(port.position, v3.scale(dir, Math.min(d, total)));
    const hit = pointCollides(colliders, p, probeRadius);
    if (hit) {
      stuck = hit;
      stuckPoint = p;
      break;
    }
    points.push(p);
    achieved = Math.min(d, total);
  }

  const head = bendHead(points, dir, probe);
  return result(req, points, head.position, head.direction, stuck, stuckPoint, achieved);
}

/** 按头端弯曲角求头端位置与光轴方向 */
function bendHead(points: Vec3[], entryDir: Vec3, probe: Probe): { position: Vec3; direction: Vec3 } {
  if (points.length === 0) return { position: [0, 0, 0], direction: entryDir };
  const tip = points[points.length - 1];
  if (probe.bendAngleDeg === 0) {
    return { position: tip, direction: entryDir };
  }
  // 弯头简化：在最后一段方向上按弯曲角偏转（刚性固定弯角）
  const prev = points[Math.max(0, points.length - 2)];
  const segDir = v3.normalize(v3.sub(tip, prev));
  const axis = Math.abs(segDir[0]) < 0.9 ? v3.normalize(v3.cross(segDir, [1, 0, 0])) : v3.normalize(v3.cross(segDir, [0, 1, 0]));
  const bent = v3.normalize(rotateAroundAxis(segDir, axis, (probe.bendAngleDeg * Math.PI) / 180));
  const neck = probe.diameter * 1.2;
  return { position: v3.add(tip, v3.scale(bent, neck * 0.3)), direction: bent };
}

function rotateAroundAxis(v: Vec3, axis: Vec3, rad: number): Vec3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  const dot = v3.dot(v, axis);
  const cross = v3.cross(axis, v);
  return v3.add(v3.add(v3.scale(v, c), v3.scale(cross, s)), v3.scale(axis, dot * (1 - c)));
}

/**
 * 柔性探头：逐段生长的常曲率链。
 * 每步在"最小弯曲半径约束"内向导引方向偏转；碰撞即停。
 */
function solveFlexible(req: PathRequest, colliders: Collider[]): ProbePathResult {
  const { probe, port, insertionMm, guideDirection } = req;
  const probeRadius = probe.diameter / 2;
  const minR = probe.minBendRadius ?? Infinity;
  const total = Math.min(insertionMm, probe.workingLength);
  const points: Vec3[] = [port.position];
  let dir = v3.normalize(port.normal);
  let stuck: ProbePathResult['stuckReason'] = null;
  let stuckPoint: Vec3 | null = null;
  let achieved = 0;

  for (let d = STEP_MM; d <= total + 1e-6; d += STEP_MM) {
    const remaining = Math.min(STEP_MM, total - (d - STEP_MM));
    let candidate = v3.add(points[points.length - 1], v3.scale(dir, remaining));

    if (guideDirection) {
      const target = v3.normalize(guideDirection);
      // 受最小弯曲半径限制的最大转角：theta <= step / R
      const maxTurn = minR === Infinity ? Math.PI : remaining / minR;
      const cosA = clamp(v3.dot(dir, target), -1, 1);
      const turn = Math.min(Math.acos(cosA), maxTurn);
      if (turn > 1e-9) {
        const ax = v3.normalize(v3.cross(dir, target));
        if (v3.norm(ax) > 1e-9) dir = v3.normalize(rotateAroundAxis(dir, ax, turn));
        else dir = target;
      } else {
        dir = target;
      }
      candidate = v3.add(points[points.length - 1], v3.scale(dir, remaining));
    }

    // 曲率半径约束复核
    if (points.length >= 2 && minR !== Infinity) {
      const r = curvatureRadius(points[points.length - 2], points[points.length - 1], candidate);
      if (r < minR) {
        stuck = 'min_radius';
        stuckPoint = candidate;
        break;
      }
    }

    const hit = pointCollides(colliders, candidate, probeRadius);
    if (hit) {
      stuck = hit;
      stuckPoint = candidate;
      break;
    }
    points.push(candidate);
    achieved = d;
  }

  const head = bendHead(points, dir, probe);
  return result(req, points, head.position, head.direction, stuck, stuckPoint, achieved);
}

function result(
  req: PathRequest,
  points: Vec3[],
  headPosition: Vec3,
  headDirection: Vec3,
  stuck: ProbePathResult['stuckReason'],
  stuckPoint: Vec3 | null,
  achievedInsertion: number,
): ProbePathResult {
  return {
    probeId: req.probe.id,
    portId: req.port.id,
    insertionMm: req.insertionMm,
    points,
    headPosition,
    headDirection: v3.normalize(headDirection),
    stuck: stuck !== null,
    stuckPoint,
    stuckReason: stuck,
    achievedInsertion,
  };
}

export function solveProbePath(req: PathRequest): ProbePathResult {
  if (req.probe.diameter > req.port.holeDiameter) {
    return {
      probeId: req.probe.id,
      portId: req.port.id,
      insertionMm: req.insertionMm,
      points: [req.port.position],
      headPosition: req.port.position,
      headDirection: v3.normalize(req.port.normal),
      stuck: true,
      stuckPoint: req.port.position,
      stuckReason: 'casing',
      achievedInsertion: 0,
    };
  }
  const colliders = buildColliders(req.engine, req.crankDeg);
  return req.probe.kind === 'rigid' ? solveRigid(req, colliders) : solveFlexible(req, colliders);
}

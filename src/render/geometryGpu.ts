import type { EngineModel, Stage, SurfaceMaterial } from '../core/types';
import type { Vec3 } from '../core/math/vec3';
import { buildStageMesh, type BladeMesh, SPAN_SEGMENTS, CHORD_SEGMENTS } from '../core/geometry/bladeMesh';
import { bladeNormalWorld } from '../core/geometry/airfoil';
import { MATERIALS } from '../core/geometry/materials';

/** 交错顶点：position(3) normal(3) material(4) = 10 floats */
export const VERTEX_STRIDE_FLOATS = 10;
export const VERTEX_STRIDE_BYTES = VERTEX_STRIDE_FLOATS * 4;

const MATERIAL_ID: Record<SurfaceMaterial, number> = {
  single_crystal: 0,
  tbc: 1,
  carbon: 2,
  heat_tint: 3,
};

export interface SpallZone {
  bladeIndex: number;
  surface: 0 | 1;
  spanPct: number;
  chordT: number;
  /** 参数空间半径（span 与 t 量纲不同，用各自阈值） */
  spanRadius: number;
  chordRadius: number;
}

export interface GpuStageGeometry {
  stageId: string;
  vertexData: Float32Array;
  indexCount: number;
  mesh: BladeMesh;
}

/**
 * 构建一级叶栅的 GPU 顶点缓冲数据。
 * 法线用解析外法线（光滑、与反算同源），材质按级默认值，
 * 单叶材质覆盖通过 bladeMaterials 映射传入；
 * spallZones 内的顶点强制改为单晶合金材质，呈现涂层剥落露出的底材。
 */
export function buildStageGpuGeometry(
  stage: Stage,
  crankDeg: number,
  bladeMaterials?: Map<number, SurfaceMaterial>,
  spallZones: SpallZone[] = [],
): GpuStageGeometry {
  const mesh = buildStageMesh(stage, crankDeg);
  const substrate = MATERIALS.single_crystal;
  const floats: number[] = [];
  for (const v of mesh.vertices) {
    let matKey = bladeMaterials?.get(v.bladeIndex) ?? stage.defaultMaterial;
    let mat = MATERIALS[matKey];
    let matId = MATERIAL_ID[matKey];
    // 涂层剥落区：底材颜色与周围 TBC 明显拉开
    const inSpall = spallZones.some(
      (z) => z.bladeIndex === v.bladeIndex && z.surface === v.surface &&
        Math.abs(v.spanPct - z.spanPct) <= z.spanRadius &&
        Math.abs(v.chordT - z.chordT) <= z.chordRadius,
    );
    if (inSpall) {
      matKey = 'single_crystal';
      mat = substrate;
      matId = MATERIAL_ID.single_crystal;
    }
    const n = bladeNormalWorld(
      stage, v.bladeIndex, crankDeg, v.spanPct, v.chordT,
      v.surface === 0 ? 'suction' : 'pressure',
    );
    floats.push(
      v.pos[0], v.pos[1], v.pos[2],
      n[0], n[1], n[2],
      matId, mat.metallic, mat.roughness, mat.noiseAmount,
    );
  }
  return {
    stageId: stage.id,
    vertexData: Float32Array.from(floats),
    indexCount: mesh.triangles.length * 3,
    mesh,
  };
}

/** 机匣内壁（半透明暗色圆柱）+ 轮毂，给画面深度参照 */
export function buildCasingGeometry(engine: EngineModel): { vertexData: Float32Array; indexCount: number; indices: number[] } {
  const segments = 64;
  const floats: number[] = [];
  const indices: number[] = [];
  const rings = [
    { x: engine.axialLength * 0.1, r: engine.casingRadius, casing: true },
    { x: engine.axialLength * 0.95, r: engine.casingRadius, casing: true },
  ];
  rings.forEach((ring, ri) => {
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const y = Math.cos(a) * ring.r;
      const z = Math.sin(a) * ring.r;
      const ny = Math.cos(a), nz = Math.sin(a);
      const normal: Vec3 = ring.casing ? [0, -ny, -nz] : [0, ny, nz];
      floats.push(ring.x, y, z, normal[0], normal[1], normal[2], 5, 0.3, 0.7, 0.2);
      if (ri === 0 && i < segments) {
        const a0 = i, a1 = i + 1, b0 = (segments + 1) + i, b1 = b0 + 1;
        indices.push(a0, b0, a1, a1, b0, b1);
      }
    }
  });
  return { vertexData: Float32Array.from(floats), indexCount: indices.length, indices };
}

/** 探头导管折线 → 圆管网格（沿路径分段，环截面 8 边） */
export function buildProbeTubeGeometry(points: Vec3[], diameter: number): { vertexData: Float32Array; indexCount: number; indices: number[] } {
  if (points.length < 2) return { vertexData: new Float32Array(0), indexCount: 0, indices: [] };
  const radialSegments = 8;
  const radius = diameter / 2;
  const floats: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const tangent = normalize3(sub3(next, prev));
    const ref: Vec3 = Math.abs(tangent[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const side = normalize3(cross3(tangent, ref));
    const up = cross3(side, tangent);
    for (let j = 0; j <= radialSegments; j++) {
      const a = (j / radialSegments) * Math.PI * 2;
      const offset = add3(scale3(side, Math.cos(a) * radius), scale3(up, Math.sin(a) * radius));
      const n = normalize3(offset);
      const q = add3(p, offset);
      floats.push(q[0], q[1], q[2], n[0], n[1], n[2], 6, 0.6, 0.4, 0.05);
      if (i < points.length - 1 && j < radialSegments) {
        const ring = radialSegments + 1;
        const a0 = i * ring + j, a1 = a0 + 1;
        const b0 = (i + 1) * ring + j, b1 = b0 + 1;
        indices.push(a0, b0, a1, a1, b0, b1);
      }
    }
  }
  return { vertexData: Float32Array.from(floats), indexCount: indices.length, indices };
}

function sub3(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add3(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale3(a: Vec3, s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s]; }
function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize3(a: Vec3): Vec3 {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
}

export { SPAN_SEGMENTS, CHORD_SEGMENTS };

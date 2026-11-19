/**
 * WGSL 着色器源码（任务点 3、4）。
 * 前向渲染：每个叶片片段按材质做 Cook-Torrance 风格高光 + LED 环形光衰减；
 * 后处理：桶形畸变、暗角、近距过曝/远距压黑的色调映射。
 * 所有噪声用世界坐标哈希，与 CPU 端 hash3 同思路，保证回放逐帧确定。
 */

export const SCENE_WGSL = /* wgsl */ `
struct CameraUniform {
  viewProj: mat4x4<f32>,
  eye: vec3<f32>,
  _pad0: f32,
  lightPos: vec3<f32>,
  lightPower: f32,
  forward: vec3<f32>,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;

struct VSIn {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) material: vec4<f32>, // x=材质id, y=metallic, z=roughness, w=噪声量
  @location(3) worldPos: vec3<f32>,
};

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) material: vec4<f32>,
  @location(2) worldPos: vec3<f32>,
  @location(3) viewDir: vec3<f32>,
};

@vertex
fn vs_main(in: VSIn) -> VSOut {
  var out: VSOut;
  out.clip = camera.viewProj * vec4<f32>(in.position, 1.0);
  out.normal = normalize(in.normal);
  out.material = in.material;
  out.worldPos = in.worldPos;
  out.viewDir = normalize(camera.eye - in.worldPos);
  return out;
}

fn hash31(p: vec3<f32>) -> f32 {
  var x = p * 64.0;
  var h = dot(x, vec3<f32>(127.1, 311.7, 74.7));
  h = fract(sin(h) * 43758.5453123);
  return h;
}

// 材质基色（与 CPU MATERIALS 数值约定一致）
fn baseColorOf(matId: f32, p: vec3<f32>, noiseAmt: f32) -> vec3<f32> {
  let n = hash31(p);
  var c: vec3<f32>;
  if (matId < 0.5) {            // single_crystal 单晶合金
    c = vec3<f32>(0.62, 0.60, 0.55);
  } else if (matId < 1.5) {     // tbc 热障涂层
    c = vec3<f32>(0.72, 0.68, 0.58);
  } else if (matId < 2.5) {     // carbon 积碳
    c = vec3<f32>(0.05, 0.045, 0.04);
  } else if (matId < 3.5) {     // heat_tint 高温变色（蓝紫-褐黄漂移）
    let band = 0.5 + 0.5 * sin(p.x * 0.05 + n * 3.0);
    c = vec3<f32>(0.35 + 0.35 * band, 0.22 + 0.20 * (1.0 - band), 0.42 - 0.18 * band);
  } else {                      // 机匣内壁：暗灰哑光金属
    c = vec3<f32>(0.13, 0.14, 0.16);
  }
  return c * (1.0 - noiseAmt * 0.5 + noiseAmt * n);
}

fn fresnelSchlick(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn distributionGGX(nDotH: f32, rough: f32) -> f32 {
  let a = rough * rough;
  let a2 = a * a;
  let d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / max(3.14159265 * d * d, 1e-7);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let matId = in.material.x;
  let metallic = in.material.y;
  let rough = clamp(in.material.z, 0.05, 1.0);
  let noiseAmt = in.material.w;

  let N = normalize(in.normal);
  let V = normalize(in.viewDir);
  let L = normalize(camera.lightPos - in.worldPos);
  let H = normalize(V + L);
  let dist = distance(camera.lightPos, in.worldPos);

  let baseColor = baseColorOf(matId, in.worldPos, noiseAmt);
  // 环形 LED 平方反比衰减 + 余弦入射
  let nDotL = max(dot(N, L), 0.0);
  let irradiance = camera.lightPower * 9000.0 / max(dist * dist, 1.0) * (0.25 + 0.75 * nDotL);

  // Cook-Torrance 微表面高光：单晶合金强、随探头角度明显晃动
  let f0 = mix(vec3<f32>(0.04), baseColor, metallic);
  let nDotV = max(dot(N, V), 1e-4);
  let nDotH = max(dot(N, H), 0.0);
  let hDotV = max(dot(H, V), 0.0);
  let D = distributionGGX(nDotH, rough);
  let F = fresnelSchlick(hDotV, f0);
  let k = (rough + 1.0) * (rough + 1.0) / 8.0;
  let geoV = nDotV / (nDotV * (1.0 - k) + k);
  let geoL = nDotL / (nDotL * (1.0 - k) + k);
  let spec = (D * geoV * geoL * F) / max(4.0 * nDotV * nDotL, 1e-4);

  let kd = (vec3<f32>(1.0) - F) * (1.0 - metallic);
  let ambient = vec3<f32>(0.035);
  let linear = (ambient + kd * baseColor / 3.14159265) * irradiance + spec * irradiance;

  // 近距过曝软压缩（Reinhard 在 post 阶段统一做，这里输出线性 HDR）
  return vec4<f32>(linear, 1.0);
}

// 探头导管：暗红哑光金属，单独材质
@fragment
fn fs_probe(in: VSOut) -> @location(0) vec4<f32> {
  let N = normalize(in.normal);
  let V = normalize(in.viewDir);
  let L = normalize(camera.lightPos - in.worldPos);
  let diff = max(dot(N, L), 0.0);
  let col = vec3<f32>(0.22, 0.06, 0.05) * (0.15 + 0.85 * diff);
  return vec4<f32>(col, 1.0);
}
`;

export const POST_WGSL = /* wgsl */ `
struct PostUniform {
  k1: f32,
  k2: f32,
  vignette: f32,
  aspect: f32,
};
@group(0) @binding(0) var<uniform> u: PostUniform;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var sceneSampler: sampler;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_quad(@builtin(vertex_index) idx: u32) -> VSOut {
  var out: VSOut;
  let p = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  );
  let xy = p[idx];
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, (xy.y + 1.0) * 0.5);
  return out;
}

@fragment
fn fs_post(in: VSOut) -> @location(0) vec4<f32> {
  // 输出像素 NDC → 反桶形畸变采样坐标（边缘向内压缩产生桶形）
  let ndc = vec2<f32>(in.uv.x * 2.0 - 1.0, in.uv.y * 2.0 - 1.0);
  let r2 = dot(ndc, ndc);
  let factor = 1.0 + u.k1 * r2 + u.k2 * r2 * r2;
  let sampleNdc = ndc * factor;
  let sampleUv = vec2<f32>((sampleNdc.x + 1.0) * 0.5, (sampleNdc.y + 1.0) * 0.5);

  var color: vec3<f32>;
  if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) {
    color = vec3<f32>(0.0); // 畸变后画面外为黑
  } else {
    color = textureSample(sceneTex, sceneSampler, sampleUv).rgb;
  }

  // 暗角（cos^4 风格）
  let rNorm = clamp(length(ndc) * 0.7071, 0.0, 1.0);
  let vigBase = cos(rNorm * 3.14159265 * 0.5);
  let vig = 1.0 - u.vignette * (1.0 - pow(vigBase, 4.0));
  color *= vig;

  // Reinhard 色调映射 + gamma：近距过曝滚白、远距压黑
  let mapped = color / (1.0 + color);
  color = pow(clamp(mapped, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2));
  return vec4<f32>(color, 1.0);
}
`;

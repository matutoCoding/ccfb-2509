import { mat4LookAt, mat4Multiply, mat4Perspective, type Mat4 } from '../core/math/mat4';
import { deg2rad, v3, type Vec3 } from '../core/math/vec3';
import type { LensModel } from '../core/optics/lens';
import { POST_WGSL, SCENE_WGSL } from './shaders';
import { VERTEX_STRIDE_BYTES, type GpuStageGeometry } from './geometryGpu';

export interface RenderView {
  eye: Vec3;
  target: Vec3;
  up: Vec3;
  lightPos: Vec3;
  lightPower: number;
  lens: LensModel;
}

interface MeshBuffers {
  vertex: GPUBuffer;
  index: GPUBuffer;
  indexCount: number;
  probe: boolean;
}

export class WebGpuRenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private scenePipeline!: GPURenderPipeline;
  private probePipeline!: GPURenderPipeline;
  private postPipeline!: GPURenderPipeline;
  private cameraBuffer!: GPUBuffer;
  private postBuffer!: GPUBuffer;
  private sceneTexture!: GPUTexture;
  private sceneView!: GPUTextureView;
  private depthTexture!: GPUTexture;
  private sampler!: GPUSampler;
  private bindGroup!: GPUBindGroup;
  private meshes = new Map<string, MeshBuffers>();
  private width = 0;
  private height = 0;

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (!WebGpuRenderer.isSupported()) {
      throw new Error('当前浏览器不支持 WebGPU，请使用 Chrome/Edge 114+ 并在 chrome://gpu 确认 WebGPU 已启用');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('未找到可用的 GPU 适配器');
    this.device = await adapter.requestDevice();
    this.device.lost.then((info) => {
      console.error('WebGPU device lost:', info.message);
    });
    this.context = canvas.getContext('webgpu')!;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });

    // CameraUniform: mat4(64) + eye(12)+pad(4) + lightPos(12)+power(4) + forward(12)+pad(4) = 112
    this.cameraBuffer = this.device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // PostUniform: 4 个 f32 = 16
    this.postBuffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const sceneModule = this.device.createShaderModule({ code: SCENE_WGSL });
    const vertexLayout: GPUVertexBufferLayout = {
      arrayStride: VERTEX_STRIDE_BYTES,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x4' },
      ],
    };
    const depthStencil: GPUDepthStencilState = {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less',
    };
    this.scenePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: sceneModule, entryPoint: 'vs_main', buffers: [vertexLayout] },
      fragment: { module: sceneModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });
    this.probePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: sceneModule, entryPoint: 'vs_main', buffers: [vertexLayout] },
      fragment: { module: sceneModule, entryPoint: 'fs_probe', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });
    const postModule = this.device.createShaderModule({ code: POST_WGSL });
    this.postPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: postModule, entryPoint: 'vs_quad' },
      fragment: { module: postModule, entryPoint: 'fs_post', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.sceneTexture?.destroy();
    this.depthTexture?.destroy();
    this.sceneTexture = this.device.createTexture({
      size: { width, height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.sceneView = this.sceneTexture.createView();
    this.depthTexture = this.device.createTexture({
      size: { width, height },
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.bindGroup = this.device.createBindGroup({
      layout: this.postPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.postBuffer } },
        { binding: 1, resource: this.sceneView },
        { binding: 2, resource: this.sampler },
      ],
    });
  }

  /** 上传/替换一级叶栅几何 */
  uploadStage(key: string, geo: GpuStageGeometry): void {
    const indexData = new Uint32Array(geo.indexCount);
    for (let i = 0; i < geo.indexCount; i++) {
      const tri = Math.floor(i / 3);
      const corner = i % 3;
      const t = geo.mesh.triangles[tri];
      indexData[i] = corner === 0 ? t.a : corner === 1 ? t.b : t.c;
    }
    this.uploadIndexedMesh(key, geo.vertexData, Array.from(indexData), false);
  }

  private writeF32(buffer: GPUBuffer, data: Float32Array): void {
    this.device.queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  }

  /** 通用索引网格上传（机匣、探头管复用） */
  uploadIndexedMesh(key: string, vertexData: Float32Array, indices: number[], isProbe: boolean): void {
    const old = this.meshes.get(key);
    old?.vertex.destroy();
    old?.index.destroy();
    if (indices.length === 0 || vertexData.length === 0) {
      this.meshes.delete(key);
      return;
    }
    const vertex = this.device.createBuffer({
      size: Math.max(16, vertexData.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.writeF32(vertex, vertexData);
    const indexData = Uint32Array.from(indices);
    const index = this.device.createBuffer({
      size: Math.max(16, indexData.byteLength),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(index, 0, indexData.buffer as ArrayBuffer, indexData.byteOffset, indexData.byteLength);
    this.meshes.set(key, { vertex, index, indexCount: indices.length, probe: isProbe });
  }

  clearProbeTube(key: string): void {
    const old = this.meshes.get(key);
    if (old) {
      old.vertex.destroy();
      old.index.destroy();
      this.meshes.delete(key);
    }
  }

  render(view: RenderView, width: number, height: number): void {
    this.resize(width, height);
    const aspect = width / height;
    const proj = mat4Perspective(deg2rad(view.lens.fovDeg), aspect, 1, 5000);
    const cam = mat4LookAt(view.eye, view.target, view.up);
    const viewProj = mat4Multiply(proj, cam) as Mat4;

    // WGSL 布局：viewProj(0..15) eye(16..18) pad(19) lightPos(20..22) power(23) forward(24..26) pad(27)
    const cameraData = new Float32Array(28);
    cameraData.set(viewProj, 0);
    cameraData.set(view.eye, 16);
    cameraData.set(view.lightPos, 20);
    cameraData[23] = view.lightPower;
    cameraData.set(v3.normalize(v3.sub(view.target, view.eye)), 24);
    this.writeF32(this.cameraBuffer, cameraData);

    const postData = new Float32Array([view.lens.k1, view.lens.k2, view.lens.vignette, aspect]);
    this.writeF32(this.postBuffer, postData);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.sceneView,
        clearValue: { r: 0.02, g: 0.02, b: 0.025, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    for (const mesh of this.meshes.values()) {
      const pipeline = mesh.probe ? this.probePipeline : this.scenePipeline;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
      }));
      pass.setVertexBuffer(0, mesh.vertex);
      pass.setIndexBuffer(mesh.index, 'uint32');
      pass.drawIndexed(mesh.indexCount);
    }
    pass.end();

    const postPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    postPass.setPipeline(this.postPipeline);
    postPass.setBindGroup(0, this.bindGroup);
    postPass.draw(6);
    postPass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** 截帧（用于轨迹快照与叠图复核） */
  async snapshot(): Promise<string> {
    await this.device.queue.onSubmittedWorkDone();
    const canvas = this.context.canvas as HTMLCanvasElement;
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  destroy(): void {
    for (const m of this.meshes.values()) {
      m.vertex.destroy();
      m.index.destroy();
    }
    this.meshes.clear();
    this.sceneTexture?.destroy();
    this.depthTexture?.destroy();
    this.cameraBuffer?.destroy();
    this.postBuffer?.destroy();
  }
}

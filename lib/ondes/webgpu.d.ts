/**
 * Types WebGPU minimaux (déclarations ambiantes) — le DOM lib de
 * TypeScript n'expose pas encore `navigator.gpu`. Seul le sous-ensemble
 * réellement utilisé par `moteur-webgpu.ts` est déclaré : compute
 * shaders, storage/uniform buffers, staging MAP_READ.
 *
 * Source de vérité : https://gpuweb.github.io/gpuweb/ (spécification
 * WebGPU). À remplacer par @webgpu/types si le projet intègre un jour
 * un rendu GPU complet (render pipelines).
 */

type GPUBufferUsageFlags = number;
type GPUShaderStageFlags = number;
type GPUSize64 = number;
type GPUIndex32 = number;

interface GPURequestAdapterOptions {
  powerPreference?: "low-power" | "high-performance";
  forceFallbackAdapter?: boolean;
}

interface GPUAdapter {
  readonly features: ReadonlySet<string>;
  readonly limits: Record<string, number>;
  requestDevice(options?: { label?: string }): Promise<GPUDevice>;
}

interface GPUDeviceLostInfo {
  readonly reason: "unknown" | "destroyed";
  readonly message: string;
}

interface GPUDevice {
  readonly label: string;
  readonly queue: GPUQueue;
  readonly limits: Record<string, number>;
  readonly lost: Promise<GPUDeviceLostInfo>;
  createBuffer(descriptor: {
    label?: string;
    size: GPUSize64;
    usage: GPUBufferUsageFlags;
    mappedAtCreation?: boolean;
  }): GPUBuffer;
  createShaderModule(descriptor: { label?: string; code: string }): GPUShaderModule;
  createComputePipeline(descriptor: {
    label?: string;
    layout: "auto" | unknown;
    compute: { module: GPUShaderModule; entryPoint?: string; constants?: Record<string, number> };
  }): GPUComputePipeline;
  createBindGroup(descriptor: {
    label?: string;
    layout: GPUBindGroupLayout;
    entries: Array<{ binding: GPUIndex32; resource: { buffer: GPUBuffer; offset?: GPUSize64; size?: GPUSize64 } }>;
  }): GPUBindGroup;
  createCommandEncoder(descriptor?: { label?: string }): GPUCommandEncoder;
  destroy(): void;
}

interface GPUShaderModule {
  readonly label: string;
  getCompilationInfo(): Promise<{ messages: Array<{ type: "error" | "warning" | "info"; message: string }> }>;
}

interface GPUComputePipeline {
  readonly label: string;
  getBindGroupLayout(index: GPUIndex32): GPUBindGroupLayout;
}

interface GPUBindGroupLayout {
  readonly label: string;
}

interface GPUBindGroup {
  readonly label: string;
}

interface GPUCommandEncoder {
  beginComputePass(descriptor?: { label?: string }): GPUComputePassEncoder;
  copyBufferToBuffer(
    source: GPUBuffer,
    sourceOffset: GPUSize64,
    destination: GPUBuffer,
    destinationOffset: GPUSize64,
    size: GPUSize64,
  ): void;
  finish(descriptor?: { label?: string }): GPUCommandBuffer;
}

interface GPUCommandBuffer {
  readonly label: string;
}

interface GPUComputePassEncoder {
  setPipeline(pipeline: GPUComputePipeline): void;
  setBindGroup(index: GPUIndex32, bindGroup: GPUBindGroup): void;
  dispatchWorkgroups(x: GPUIndex32, y?: GPUIndex32, z?: GPUIndex32): void;
  end(): void;
}

interface GPUBuffer {
  readonly label: string;
  readonly size: GPUSize64;
  readonly usage: GPUBufferUsageFlags;
  readonly mapState: "unmapped" | "pending" | "mapped";
  mapAsync(mode: GPUMapModeFlags, offset?: GPUSize64, size?: GPUSize64): Promise<void>;
  getMappedRange(offset?: GPUSize64): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

interface GPUQueue {
  readonly label: string;
  writeBuffer(buffer: GPUBuffer, bufferOffset: GPUSize64, data: BufferSource, dataOffset?: GPUSize64, size?: GPUSize64): void;
  submit(commandBuffers: GPUCommandBuffer[]): void;
}

// Constantes d'usage et de mapping (valeurs exactes de la spécification).
declare const GPUBufferUsage_symbol: unique symbol;
interface GPUBufferUsageConstant {
  readonly MAP_READ: GPUBufferUsageFlags; // 0x0001
  readonly MAP_WRITE: GPUBufferUsageFlags; // 0x0002
  readonly COPY_SRC: GPUBufferUsageFlags; // 0x0004
  readonly COPY_DST: GPUBufferUsageFlags; // 0x0008
  readonly INDEX: GPUBufferUsageFlags; // 0x0010
  readonly VERTEX: GPUBufferUsageFlags; // 0x0020
  readonly UNIFORM: GPUBufferUsageFlags; // 0x0040
  readonly STORAGE: GPUBufferUsageFlags; // 0x0080
  readonly INDIRECT: GPUBufferUsageFlags; // 0x0100
  readonly QUERY_RESOLVE: GPUBufferUsageFlags; // 0x0200
}
declare const GPUBufferUsage: GPUBufferUsageConstant;

declare const GPUMapMode_symbol: unique symbol;
interface GPUMapModeConstant {
  readonly READ: GPUMapModeFlags; // 0x0001
  readonly WRITE: GPUMapModeFlags; // 0x0002
}
declare const GPUMapMode: GPUMapModeConstant;

type GPUMapModeFlags = number;

interface Navigator {
  readonly gpu?: {
    requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
    getPreferredCanvasFormat(): string;
  };
}

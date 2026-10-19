/**
 * Moteur WebGPU du champ d'ondes — le GPU de l'utilisateur exécute la
 * physique d'ondes (`SHADER_ONDES`) sur la grille d'oscillateurs :
 * propagation (d'Alembert), couplage de Kuramoto, gain cohérent et
 * injection d'impulsions, le tout en compute shaders.
 *
 * Stratégie mémoire :
 *  · triple bufferisation des amplitudes (actuel / passé / suivant)
 *    reliée par 3 bind groups en cycle — zéro copie GPU par pas ;
 *  · phases et fréquences dans des buffers persistants read_write ;
 *  · readback throttlé : toutes les `periodeReadback` images, les
 *    amplitudes et les phases du dernier tampon écrit sont copiées
 *    vers un staging buffer mappable, puis analysées côté CPU
 *    (détection de pics, paramètre d'ordre r, énergie).
 */

import { SHADER_ONDES } from "./shader";
import type { LectureChamp, MoteurOndes } from "./champ";
import { MAX_IMPULSIONS_PAR_PAS } from "./champ";
import type { ConfigOndes, Impulsion, PaquetOnde, Pic } from "./types";

const TAILLE_IMPRESSION = 16 * 4; // 16 vec4<f32> = 256 octets

export class MoteurWebGPU implements MoteurOndes {
  readonly type = "webgpu" as const;

  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private bindGroups: GPUBindGroup[] = [];
  private tamponsAmp: GPUBuffer[] = [];
  private tamponPhase: GPUBuffer;
  private tamponFreq: GPUBuffer;
  private tamponParams: GPUBuffer;
  private tamponImpulsions: GPUBuffer;
  private stagingAmp: GPUBuffer;
  private stagingPhase: GPUBuffer;

  private cfg: ConfigOndes;
  private freqCpu: Float32Array;
  private ampCpu: Float32Array;
  private phaseCpu: Float32Array;
  private fileImpulsions: Impulsion[] = [];
  private indexCycle = 0;
  private compteurPas = 0;

  /** Nombre total de pas GPU exécutés (métrique temps réel). */
  get pasTotaux(): number {
    return this.compteurPas;
  }

  private constructor(
    device: GPUDevice,
    cfg: ConfigOndes,
    pipeline: GPUComputePipeline,
    bindGroups: GPUBindGroup[],
    tamponsAmp: GPUBuffer[],
    tamponPhase: GPUBuffer,
    tamponFreq: GPUBuffer,
    tamponParams: GPUBuffer,
    tamponImpulsions: GPUBuffer,
    stagingAmp: GPUBuffer,
    stagingPhase: GPUBuffer,
  ) {
    this.device = device;
    this.cfg = cfg;
    this.pipeline = pipeline;
    this.bindGroups = bindGroups;
    this.tamponsAmp = tamponsAmp;
    this.tamponPhase = tamponPhase;
    this.tamponFreq = tamponFreq;
    this.tamponParams = tamponParams;
    this.tamponImpulsions = tamponImpulsions;
    this.stagingAmp = stagingAmp;
    this.stagingPhase = stagingPhase;
    const n = cfg.largeur * cfg.hauteur;
    this.freqCpu = new Float32Array(n);
    this.ampCpu = new Float32Array(n);
    this.phaseCpu = new Float32Array(n);
  }

  /**
   * Construit le moteur : adapter → device → buffers → pipeline →
   * 3 bind groups (cycle de triple bufferisation). Lève si WebGPU est
   * indisponible — l'appelant retombe sur le moteur CPU.
   */
  static async creer(cfg: ConfigOndes): Promise<MoteurWebGPU> {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      throw new Error("WebGPU indisponible dans ce navigateur.");
    }
    const adaptateur = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adaptateur) throw new Error("Aucun adaptateur GPU accepté.");
    const device = await adaptateur.requestDevice();

    const { largeur: w, hauteur: h } = cfg;
    const n = w * h;
    const octets = n * 4;

    const usageStockage =
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const tamponsAmp = [0, 1, 2].map(() =>
      device.createBuffer({ size: octets, usage: usageStockage }),
    );
    const tamponPhase = device.createBuffer({
      size: octets,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const tamponFreq = device.createBuffer({
      size: octets,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const tamponParams = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const tamponImpulsions = device.createBuffer({
      size: TAILLE_IMPRESSION,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const stagingAmp = device.createBuffer({
      size: octets,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const stagingPhase = device.createBuffer({
      size: octets,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const module_ = device.createShaderModule({ code: SHADER_ONDES });
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: module_, entryPoint: "principal" },
    });

    const layout = pipeline.getBindGroupLayout(0);
    // Cycle de triple bufferisation : (actuel, passé, suivant) tourne.
    const cycles: Array<[number, number, number]> = [
      [0, 1, 2],
      [2, 0, 1],
      [1, 2, 0],
    ];
    const bindGroups = cycles.map(([actuel, passe, suivant]) =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: tamponsAmp[actuel] } },
          { binding: 1, resource: { buffer: tamponsAmp[passe] } },
          { binding: 2, resource: { buffer: tamponsAmp[suivant] } },
          { binding: 3, resource: { buffer: tamponPhase } },
          { binding: 4, resource: { buffer: tamponFreq } },
          { binding: 5, resource: { buffer: tamponParams } },
          { binding: 6, resource: { buffer: tamponImpulsions } },
        ],
      }),
    );

    const moteur = new MoteurWebGPU(
      device,
      cfg,
      pipeline,
      bindGroups,
      tamponsAmp,
      tamponPhase,
      tamponFreq,
      tamponParams,
      tamponImpulsions,
      stagingAmp,
      stagingPhase,
    );
    moteur.initialiserFrequences();
    return moteur;
  }

  /** Carte de fréquences propres initiale (bruit lent, graine 42). */
  private initialiserFrequences(): void {
    let graine = 42;
    const alea = () => {
      graine = (graine * 1664525 + 1013904223) >>> 0;
      return graine / 0xffffffff;
    };
    const borneMin = 0.02;
    const borneMax = 0.2;
    for (let i = 0; i < this.freqCpu.length; i++) {
      this.freqCpu[i] = borneMin + alea() * (borneMax - borneMin);
    }
    this.device.queue.writeBuffer(this.tamponFreq, 0, this.freqCpu);
  }

  get largeur(): number {
    return this.cfg.largeur;
  }

  get hauteur(): number {
    return this.cfg.hauteur;
  }

  injecter(impulsions: Impulsion[]): void {
    for (const imp of impulsions) {
      if (this.fileImpulsions.length >= MAX_IMPULSIONS_PAR_PAS * 8) break;
      this.fileImpulsions.push(imp);
    }
  }

  injecterPaquet(paquet: PaquetOnde): void {
    const att = 0.82;
    this.injecter([
      {
        x: paquet.p[0],
        y: paquet.p[1],
        amplitude: Math.min(5, paquet.a * att),
        frequence: paquet.f,
        phase: paquet.th,
        rayon: 2.2,
      },
    ]);
  }

  avancer(): void {
    const pas = Math.max(1, this.cfg.pasParImage);
    for (let k = 0; k < pas; k++) this.unPas();
  }

  /** Un pas de calcul GPU : uniforms → dispatch → cycle de buffers. */
  private unPas(): void {
    const { largeur: w, hauteur: h } = this.cfg;

    // Impulsions de ce pas (max 16, buffer uniform).
    const lot = this.fileImpulsions.splice(0, MAX_IMPULSIONS_PAR_PAS);
    const donneesImpulsions = new Float32Array(64);
    for (let i = 0; i < lot.length; i++) {
      donneesImpulsions[i * 4 + 0] = lot[i].x;
      donneesImpulsions[i * 4 + 1] = lot[i].y;
      donneesImpulsions[i * 4 + 2] = lot[i].amplitude;
      donneesImpulsions[i * 4 + 3] = lot[i].frequence;
    }
    this.device.queue.writeBuffer(this.tamponImpulsions, 0, donneesImpulsions);

    // Paramètres (12 scalaires × 4 = 48 octets, alignement uniform OK).
    const params = new ArrayBuffer(48);
    const vue = new DataView(params);
    vue.setUint32(0, w, true);
    vue.setUint32(4, h, true);
    vue.setUint32(8, lot.length, true);
    vue.setUint32(12, this.pasTotaux, true);
    vue.setFloat32(16, this.cfg.c2, true);
    vue.setFloat32(20, this.cfg.amortissement, true);
    vue.setFloat32(24, this.cfg.couplage, true);
    vue.setFloat32(28, this.cfg.dt, true);
    vue.setFloat32(32, this.cfg.gain, true);
    this.device.queue.writeBuffer(this.tamponParams, 0, params);

    // Dispatch 8×8 par workgroup.
    const groupesX = Math.ceil(w / 8);
    const groupesY = Math.ceil(h / 8);
    const encodeur = this.device.createCommandEncoder();
    const passe = encodeur.beginComputePass();
    passe.setPipeline(this.pipeline);
    passe.setBindGroup(0, this.bindGroups[this.indexCycle]);
    passe.dispatchWorkgroups(groupesX, groupesY);
    passe.end();
    this.device.queue.submit([encodeur.finish()]);

    this.indexCycle = (this.indexCycle + 1) % 3;
    this.compteurPas++;
  }

  /**
   * Readback throttlé du dernier tampon écrit : détection de pics,
   * paramètre d'ordre r et énergie. `tamponsAmp[cible]` est le tampon
   * qui a servi d'« amp_suivant » au dernier pas.
   */
  async lire(): Promise<LectureChamp> {
    const { largeur: w, hauteur: h } = this.cfg;
    const cible = (this.indexCycle + 2) % 3; // dernier tampon « suivant »
    const tampon = this.tamponsAmp[cible];
    const octets = w * h * 4;

    const encodeur = this.device.createCommandEncoder();
    encodeur.copyBufferToBuffer(tampon, 0, this.stagingAmp, 0, octets);
    encodeur.copyBufferToBuffer(this.tamponPhase, 0, this.stagingPhase, 0, octets);
    this.device.queue.submit([encodeur.finish()]);

    await this.stagingAmp.mapAsync(GPUMapMode.READ);
    const amp = new Float32Array(this.stagingAmp.getMappedRange());
    this.ampCpu.set(amp.subarray(0, this.ampCpu.length));
    this.stagingAmp.unmap();

    await this.stagingPhase.mapAsync(GPUMapMode.READ);
    const ph = new Float32Array(this.stagingPhase.getMappedRange());
    this.phaseCpu.set(ph.subarray(0, this.phaseCpu.length));
    this.stagingPhase.unmap();

    return analyserChamp(this.ampCpu, this.phaseCpu, w, h);
  }

  amplitudes(): Float32Array {
    return this.ampCpu;
  }

  phases(): Float32Array {
    return this.phaseCpu;
  }

  frequences(): Float32Array {
    return this.freqCpu;
  }

  /** Writeback de la carte de fréquences évoluée (GPU ← CPU, synchrone). */
  remplacerFrequences(frequences: Float32Array): void {
    if (frequences.length === this.freqCpu.length) {
      this.freqCpu.set(frequences);
    }
    this.device.queue.writeBuffer(this.tamponFreq, 0, this.freqCpu);
  }

  config(): ConfigOndes {
    return this.cfg;
  }

  /** Changement d'effort : reconstruction complète via la fabrique —
   *  ce chemin synchrone n'ajuste que les paramètres scalaires. */
  reconfigurer(cfg: ConfigOndes): void {
    this.cfg = cfg;
  }

  detruire(): void {
    for (const t of this.tamponsAmp) t.destroy();
    this.tamponPhase.destroy();
    this.tamponFreq.destroy();
    this.tamponParams.destroy();
    this.tamponImpulsions.destroy();
    this.stagingAmp.destroy();
    this.stagingPhase.destroy();
    this.device.destroy();
    this.bindGroups = [];
    this.tamponsAmp = [];
  }
}

/**
 * Analyse CPU d'un état de champ (utilisé par le readback WebGPU et
 * disponible pour les tests) : pics de résonance (maxima locaux 4-
 * connexes sur échantillonnage pair), paramètre d'ordre de Kuramoto r,
 * énergie moyenne.
 */
export function analyserChamp(
  amp: Float32Array,
  phase: Float32Array,
  w: number,
  h: number,
): LectureChamp {
  const pics: Pic[] = [];
  const seuil = 0.35;
  let sommeCos = 0;
  let sommeSin = 0;
  let energieSomme = 0;
  let echantillons = 0;

  for (let y = 2; y < h - 2; y += 2) {
    for (let x = 2; x < w - 2; x += 2) {
      const i = y * w + x;
      const a = Math.abs(amp[i]);
      energieSomme += a;
      sommeCos += Math.cos(phase[i]);
      sommeSin += Math.sin(phase[i]);
      echantillons++;
      if (a < seuil) continue;
      if (
        a >= Math.abs(amp[i - 1]) &&
        a >= Math.abs(amp[i + 1]) &&
        a >= Math.abs(amp[i - w]) &&
        a > Math.abs(amp[i + w])
      ) {
        pics.push({ x, y, amplitude: a, phase: phase[i] });
      }
    }
  }

  pics.sort((p1, p2) => p2.amplitude - p1.amplitude);
  const ordreR = echantillons > 0 ? Math.hypot(sommeCos, sommeSin) / echantillons : 0;
  const energie = echantillons > 0 ? energieSomme / echantillons : 0;
  return { pics: pics.slice(0, 12), ordreR, energie };
}

/**
 * ENTRAÎNEUR D'ONDES WEBGPU — portage fidèle de `gen3Trainer.ts` : le
 * GPU de l'utilisateur exécute `SHADER_ENTRAINEMENT_RPIA` (waveTrainer)
 * sur les N nœuds, la lecture des poids finaux passe par un buffer
 * staging mappable (export « poids d'ondes prêts pour le packaging »).
 *
 * CORRECTIONS apportées au portage par rapport à la source :
 *  · `commandEncoder.finishing ? finish() : finish()` (ternaire sans
 *    effet de la source) → un simple `commandEncoder.finish()` ;
 *  · `trainEpoch(...): void` sur une méthode async → `Promise<number>` ;
 *  · vérification de la taille de la cible AVANT écriture buffer.
 *
 * FABRIQUE `creerEntraineurRPIA` : tente WebGPU, retombe proprement sur
 * le miroir CPU (`EntraineurRPIA`) — la même physique partout, seule la
 * vélocité change (même contrat que la fabrique du champ d'ondes).
 */

import { EntraineurRPIA } from "./entrainement-rpia";
import { SHADER_ENTRAINEMENT_RPIA } from "./shaders-rpia";
import { RPIA_DEFAUTS, rapportDepuisHistorique } from "./types-entrainement";
import type { ConfigRPIA, OndeCible, RapportEntrainement } from "./types-entrainement";
import { webgpuDisponible } from "./moteur";

/** Contrat commun CPU / GPU — la couche appelante ignore le moteur. */
export interface EntraineurOndes {
  readonly type: "webgpu" | "cpu";
  readonly nbNoeuds: number;
  /** Un pas d'entraînement. @returns erreur d'interférence moyenne après pas. */
  pasEntrainement(cible: OndeCible, config?: ConfigRPIA): Promise<number>;
  /** Entraînement complet avec courbe d'erreur. */
  entrainer(
    cible: OndeCible,
    epoques: number,
    config?: ConfigRPIA,
  ): Promise<RapportEntrainement>;
  /** Export des poids appris ([amplitude, fréquence, phase, amortissement] × N). */
  exporterPoids(): Promise<Float32Array>;
  /** Libère les ressources GPU éventuelles. */
  detruire(): void;
}

/** Adaptateur CPU : le miroir pur, exposé sous le contrat async commun. */
export class EntraineurCpu implements EntraineurOndes {
  readonly type = "cpu" as const;
  readonly nbNoeuds: number;

  constructor(private readonly interne: EntraineurRPIA) {
    this.nbNoeuds = interne.nbNoeuds;
  }

  async pasEntrainement(cible: OndeCible, config: ConfigRPIA = RPIA_DEFAUTS): Promise<number> {
    return this.interne.pasEntrainement(cible, config);
  }

  async entrainer(
    cible: OndeCible,
    epoques: number,
    config: ConfigRPIA = RPIA_DEFAUTS,
  ): Promise<RapportEntrainement> {
    return this.interne.entrainer(cible, epoques, config);
  }

  async exporterPoids(): Promise<Float32Array> {
    return this.interne.exporterPoids();
  }

  detruire(): void {
    // Rien à libérer côté CPU (GC).
  }
}

/** Entraineur GPU interne (détails WebGPU), exposé via EntraineurCpu-like contract. */
export class EntraineurWebGPU implements EntraineurOndes {
  readonly type = "webgpu" as const;
  readonly nbNoeuds: number;

  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private tamponNoeuds: GPUBuffer;
  private tamponCible: GPUBuffer;
  private tamponParametres: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private compteurPas = 0;

  private constructor(
    device: GPUDevice,
    pipeline: GPUComputePipeline,
    tamponNoeuds: GPUBuffer,
    tamponCible: GPUBuffer,
    tamponParametres: GPUBuffer,
    bindGroup: GPUBindGroup,
    nbNoeuds: number,
  ) {
    this.device = device;
    this.pipeline = pipeline;
    this.tamponNoeuds = tamponNoeuds;
    this.tamponCible = tamponCible;
    this.tamponParametres = tamponParametres;
    this.bindGroup = bindGroup;
    this.nbNoeuds = nbNoeuds;
  }

  /**
   * Construit l'entraîneur : adapter → device → buffers → pipeline →
   * bind group. Lève si WebGPU est indisponible — l'appelant retombe
   * sur le miroir CPU via `creerEntraineurRPIA`.
   */
  static async creer(nbNoeuds: number, codeShader?: string): Promise<EntraineurWebGPU> {
    const gpu = webgpuDisponible() ? navigator.gpu : undefined;
    if (!gpu) {
      throw new Error("WebGPU non disponible sur cet environnement.");
    }
    if (!Number.isInteger(nbNoeuds) || nbNoeuds < 1) {
      throw new Error(`Nombre de nœuds invalide : ${nbNoeuds} (entier ≥ 1 requis).`);
    }
    const adaptateur = await gpu.requestAdapter();
    if (!adaptateur) {
      throw new Error("Aucun adaptateur GPU accepté.");
    }
    const device = await adaptateur.requestDevice();

    const moduleShader = device.createShaderModule({ code: codeShader ?? SHADER_ENTRAINEMENT_RPIA });
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: moduleShader, entryPoint: "principal" },
    });

    // Buffers : nœuds (4 f32/nœud, read_write), cible (f32/nœud), uniformes.
    const tailleNoeuds = nbNoeuds * 16;
    const tailleCible = nbNoeuds * 4;
    const tamponNoeuds = device.createBuffer({
      size: tailleNoeuds,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const tamponCible = device.createBuffer({
      size: tailleCible,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const tamponParametres = device.createBuffer({
      size: 16, // 3 f32 utiles + pad (alignement 16 octets)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: tamponNoeuds } },
        { binding: 1, resource: { buffer: tamponCible } },
        { binding: 2, resource: { buffer: tamponParametres } },
      ],
    });

    // État initial des nœuds sur GPU : identique au miroir CPU (graine 42),
    // pour que GPU et CPU partent du même point (parité physique).
    const initial = new EntraineurRPIA(nbNoeuds);
    const poidsInitiaux = initial.exporterPoids();
    device.queue.writeBuffer(tamponNoeuds, 0, poidsInitiaux);

    return new EntraineurWebGPU(
      device,
      pipeline,
      tamponNoeuds,
      tamponCible,
      tamponParametres,
      bindGroup,
      nbNoeuds,
    );
  }

  async pasEntrainement(cible: OndeCible, config: ConfigRPIA = RPIA_DEFAUTS): Promise<number> {
    if (cible.length !== this.nbNoeuds) {
      throw new Error(
        `Cible incompatible : ${cible.length} valeurs reçues, ${this.nbNoeuds} nœuds.`,
      );
    }
    // Uniformes : [tauxApprentissage, interfCible (réservé), pasDeTemps, pad]
    // — ordre fidèle à la source (learningRate, targetInterference, timeStep).
    const uniformes = new Float32Array([
      config.tauxApprentissage,
      0.0,
      config.pasDeTemps,
      0.0,
    ]);
    const donnees = cible instanceof Float32Array ? cible : Float32Array.from(cible);
    this.device.queue.writeBuffer(this.tamponCible, 0, donnees);
    this.device.queue.writeBuffer(this.tamponParametres, 0, uniformes);

    const encodeur = this.device.createCommandEncoder();
    const passe = encodeur.beginComputePass();
    passe.setPipeline(this.pipeline);
    passe.setBindGroup(0, this.bindGroup);
    passe.dispatchWorkgroups(Math.ceil(this.nbNoeuds / 256));
    passe.end();
    this.device.queue.submit([encodeur.finish()]);
    await this.device.queue.onSubmittedWorkDone();

    this.compteurPas++;
    // Erreur mesurée sur CPU via l'export des poids (lecture déférée,
    // throttlable par l'appelant) — ici au pas courant :
    const poids = await this.exporterPoids();
    return this.erreurDepuisPoids(poids, cible, config.pasDeTemps * (this.compteurPas - 1));
  }

  async entrainer(
    cible: OndeCible,
    epoques: number,
    config: ConfigRPIA = RPIA_DEFAUTS,
  ): Promise<RapportEntrainement> {
    if (cible.length !== this.nbNoeuds) {
      throw new Error(
        `Cible incompatible : ${cible.length} valeurs reçues, ${this.nbNoeuds} nœuds.`,
      );
    }
    if (!Number.isInteger(epoques) || epoques < 1) {
      throw new Error(`Nombre d'époques invalide : ${epoques} (entier ≥ 1 requis).`);
    }
    const historique: number[] = [];
    const donnees = cible instanceof Float32Array ? cible : Float32Array.from(cible);
    for (let e = 0; e < epoques; e++) {
      const uniformes = new Float32Array([config.tauxApprentissage, 0.0, config.pasDeTemps, 0.0]);
      this.device.queue.writeBuffer(this.tamponCible, 0, donnees);
      this.device.queue.writeBuffer(this.tamponParametres, 0, uniformes);

      const encodeur = this.device.createCommandEncoder();
      const passe = encodeur.beginComputePass();
      passe.setPipeline(this.pipeline);
      passe.setBindGroup(0, this.bindGroup);
      passe.dispatchWorkgroups(Math.ceil(this.nbNoeuds / 256));
      passe.end();
      this.device.queue.submit([encodeur.finish()]);
      await this.device.queue.onSubmittedWorkDone();

      this.compteurPas++;
      const poids = await this.exporterPoids();
      historique.push(
        this.erreurDepuisPoids(poids, cible, config.pasDeTemps * (this.compteurPas - 1)),
      );
    }
    return rapportDepuisHistorique(historique);
  }

  /**
   * Exporte les poids finaux : copie GPU → staging mappable → lecture
   * (portage fidèle de `exportWeights`, bugs de la source corrigés).
   */
  async exporterPoids(): Promise<Float32Array> {
    const taille = this.nbNoeuds * 16;
    const staging = this.device.createBuffer({
      size: taille,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encodeur = this.device.createCommandEncoder();
    encodeur.copyBufferToBuffer(this.tamponNoeuds, 0, staging, 0, taille);
    this.device.queue.submit([encodeur.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const plage = staging.getMappedRange();
    const poids = new Float32Array(plage.slice(0));
    staging.unmap();
    staging.destroy();
    return poids;
  }

  /** Erreur d'interférence moyenne recalculée depuis les poids GPU. */
  private erreurDepuisPoids(
    poids: Float32Array,
    cible: OndeCible,
    temps: number,
  ): number {
    let somme = 0;
    for (let i = 0; i < this.nbNoeuds; i++) {
      const onde = poids[i * 4] * Math.cos(poids[i * 4 + 1] * temps + poids[i * 4 + 2]);
      somme += Math.abs(onde - cible[i]);
    }
    return somme / this.nbNoeuds;
  }

  detruire(): void {
    this.tamponNoeuds.destroy();
    this.tamponCible.destroy();
    this.tamponParametres.destroy();
  }

  /** Nombre de pas GPU exécutés (métrique). */
  get pasTotaux(): number {
    return this.compteurPas;
  }
}

/** Résultat de la fabrique (même forme que la fabrique du champ). */
export interface ResultatFabriqueEntraineur {
  entraineur: EntraineurOndes;
  type: "webgpu" | "cpu";
  /** Raison du repli CPU (affichable dans l'UI). */
  raison?: string;
}

/**
 * Fabrique : WebGPU si disponible (physique RPIA sur le GPU de
 * l'utilisateur), sinon miroir CPU universel — jamais d'échec propre
 * transformé en erreur bloquante.
 */
export async function creerEntraineurRPIA(
  nbNoeuds: number,
  options?: { codeShader?: string; graine?: number },
): Promise<ResultatFabriqueEntraineur> {
  if (webgpuDisponible()) {
    try {
      const entraineur = await EntraineurWebGPU.creer(nbNoeuds, options?.codeShader);
      return { entraineur, type: "webgpu" };
    } catch (erreur) {
      return {
        entraineur: new EntraineurCpu(new EntraineurRPIA(nbNoeuds, { graine: options?.graine })),
        type: "cpu",
        raison:
          erreur instanceof Error
            ? `WebGPU refusé (${erreur.message}) — miroir CPU actif`
            : "WebGPU refusé — miroir CPU actif",
      };
    }
  }
  return {
    entraineur: new EntraineurCpu(new EntraineurRPIA(nbNoeuds, { graine: options?.graine })),
    type: "cpu",
    raison: "Environnement sans WebGPU — miroir CPU actif",
  };
}

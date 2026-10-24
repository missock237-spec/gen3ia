/**
 * MOTEURS WEBGPU RÉSIDENTS — portage fidèle de `Gen3VideoEngine.ts` et
 * `Gen3AudioEngine.ts` (sources utilisateur) : la DYNAMIQUE des nœuds
 * d'ondes (guidage RPIA vidéo / acoustique) vit sur le GPU, avec des
 * uniformes par trame (temps, dimensions, guidage 0.8) et par bloc
 * (blockStep 1024, temps d'échantillon, guidage 0.7) — comme les sources.
 *
 * CORRECTIONS DOCUMENTÉES par rapport aux sources :
 *  · VIDEO — `extractFramePixels` copiait le tampon de nœuds (N×24 octets,
 *    ex. 196 608 o) vers une trame de largeur×hauteur×4 (3 686 400 o en
 *    720p) : tailles INÉGALES, `copyBufferToBuffer` est impossible. La
 *    projection réelle est implémentée en DEUX passes de compute shaders
 *    (SHADER_RASTERISATION_VIDEO + SHADER_FINALISATION_VIDEO) : éclatement
 *    gaussien en virgule fixe ENTIÈRE (atomicAdd) — l'addition entière est
 *    associative, donc le rendu est déterministe même exécuté en parallèle.
 *  · AUDIO — le PCM de la source était rempli par le placeholder
 *    `sin(t × 440)` (son propre commentaire demandait « Remplacement par le
 *    mix des nœuds GPU ») : le mix RÉEL des oscillateurs est maintenant
 *    calculé sur GPU (SHADER_MIX_AUDIO), même formule que le miroir CPU.
 *
 * FABRIQUES `creerMoteurVideoRPIA` / `creerMoteurAudioRPIA` : WebGPU si
 * disponible, sinon miroir CPU (même contrat, même physique — la vitesse
 * change, pas le résultat). Modules PUR côté CPU : testables partout.
 */

import { webgpuDisponible } from "./moteur";
import {
  SHADER_FINALISATION_VIDEO,
  SHADER_MIX_AUDIO,
  SHADER_RASTERISATION_VIDEO,
  SHADER_RENDU_SPATIOTEMPOREL,
  SHADER_SYNTHESE_ACOUSTIQUE,
} from "./shaders-rpia";
import { MoteurRenduSpatiotemporel } from "./rendu-spatiotemporel";
import type { NoeudOnde3D } from "./types-entrainement";
import { SynthetiseurAcoustique } from "./synthese-acoustique";
import type { NoeudAcoustique, OndeCible } from "./types-entrainement";

/** Taille de bloc audio de la source (`blockStep = 1024` échantillons). */
export const BLOC_ECHANTILLONS = 1024;

/** Guidage par défaut de la source vidéo (uniforme `guidanceScale = 0.8`). */
export const GUIDAGE_VIDEO_DEFAUT = 0.8;

/** Guidage par défaut de la source audio (uniforme `guidanceScale = 0.7`). */
export const GUIDAGE_AUDIO_DEFAUT = 0.7;

/* ------------------------------------------------------------------ */
/* CONTRATS COMMUNS CPU / GPU — la couche appelante ignore le moteur.  */
/* ------------------------------------------------------------------ */

/** Résultat du rendu d'une trame vidéo (format identique au miroir). */
export interface ResultatTrameVideo {
  /** Trame RGBA (largeur × hauteur × 4, canaux 0–255) prête pour un encodeur. */
  trame: Float32Array;
  /** Erreur d'interférence moyenne après la passe de guidage (mesurée). */
  erreur: number;
}

export interface MoteurVideoOndes {
  readonly type: "webgpu" | "cpu";
  readonly largeur: number;
  readonly hauteur: number;
  readonly nbNoeuds: number;
  /** Guidage vers la cible de mouvement PUIS rendu de la trame à `temps`. */
  rendreTrame(
    temps: number,
    cibleMouvement: OndeCible,
    guidage?: number,
  ): Promise<ResultatTrameVideo>;
  /** Libère les ressources GPU éventuelles. */
  detruire(): void;
}

/** Résultat d'une génération audio traitée par blocs. */
export interface ResultatBufferAudio {
  /** PCM mono Float32 borné [-1, 1] (durée × fréquence d'échantillonnage). */
  pcm: Float32Array;
  /** Erreur d'interférence moyenne après le DERNIER bloc de guidage. */
  erreur: number;
  /** Nombre de blocs réellement traités (blockStep 1024 de la source). */
  blocs: number;
}

export interface MoteurAudioOndes {
  readonly type: "webgpu" | "cpu";
  readonly nbNoeuds: number;
  readonly frequenceEchantillonnage: number;
  /** Guidage par blocs PUIS mix réel des oscillateurs sur la durée. */
  genererBuffer(
    dureeSecondes: number,
    cible: OndeCible,
    guidage?: number,
  ): Promise<ResultatBufferAudio>;
  /** Libère les ressources GPU éventuelles. */
  detruire(): void;
}

/* ------------------------------------------------------------------ */
/* MOTEUR VIDÉO — adaptation CPU (miroir pur, spec exécutable).        */
/* ------------------------------------------------------------------ */

export class MoteurVideoCpu implements MoteurVideoOndes {
  readonly type = "cpu" as const;
  readonly largeur: number;
  readonly hauteur: number;
  readonly nbNoeuds: number;
  private readonly interne: MoteurRenduSpatiotemporel;

  constructor(
    largeur = 1280,
    hauteur = 720,
    nbNoeuds = 8192,
    graine = 42,
  ) {
    this.interne = new MoteurRenduSpatiotemporel(largeur, hauteur, nbNoeuds, { graine });
    this.largeur = largeur;
    this.hauteur = hauteur;
    this.nbNoeuds = nbNoeuds;
  }

  async rendreTrame(
    temps: number,
    cibleMouvement: OndeCible,
    guidage = GUIDAGE_VIDEO_DEFAUT,
  ): Promise<ResultatTrameVideo> {
    const erreur = this.interne.pasGuidage(cibleMouvement, guidage, temps);
    return { trame: this.interne.rendreTrame(temps), erreur };
  }

  detruire(): void {
    // Rien à libérer côté CPU (GC).
  }
}

/* ------------------------------------------------------------------ */
/* MOTEUR AUDIO — adaptation CPU (miroir pur, spec exécutable).        */
/* ------------------------------------------------------------------ */

export class MoteurAudioCpu implements MoteurAudioOndes {
  readonly type = "cpu" as const;
  readonly nbNoeuds: number;
  readonly frequenceEchantillonnage: number;
  private readonly interne: SynthetiseurAcoustique;

  constructor(nbNoeuds = 2048, frequenceEchantillonnage = 44100, graine = 42) {
    this.interne = new SynthetiseurAcoustique(nbNoeuds, {
      graine,
      frequenceEchantillonnage,
    });
    this.nbNoeuds = nbNoeuds;
    this.frequenceEchantillonnage = frequenceEchantillonnage;
  }

  async genererBuffer(
    dureeSecondes: number,
    cible: OndeCible,
    guidage = GUIDAGE_AUDIO_DEFAUT,
  ): Promise<ResultatBufferAudio> {
    if (!Number.isFinite(dureeSecondes) || dureeSecondes <= 0 || dureeSecondes > 60) {
      throw new Error(`Durée invalide : ${dureeSecondes} (0 < durée ≤ 60 s).`);
    }
    const total = Math.round(dureeSecondes * this.frequenceEchantillonnage);
    const pcm = new Float32Array(total);
    let erreur = 0;
    let blocs = 0;
    // Traitement PAR BLOCS de la source : guidage des oscillateurs vers la
    // cible (temps = début du bloc), puis mix réel de l'intervalle.
    for (let debut = 0; debut < total; debut += BLOC_ECHANTILLONS) {
      const tailleBloc = Math.min(BLOC_ECHANTILLONS, total - debut);
      const tempsBloc = debut / this.frequenceEchantillonnage;
      erreur = this.interne.pasGuidage(cible, guidage, tempsBloc);
      pcm.set(this.interne.mixerIntervalle(debut, tailleBloc), debut);
      blocs++;
    }
    return { pcm, erreur, blocs };
  }

  detruire(): void {
    // Rien à libérer côté CPU (GC).
  }
}

/* ------------------------------------------------------------------ */
/* Sérialisation des nœuds (structures host ↔ tampons f32 packs).      */
/* ------------------------------------------------------------------ */

/** NoeudOnde3D[] → Float32Array [a, f, φ, d, posX, posY] × N (pack GPU). */
export function noeuds3DVersTampon(noeuds: readonly NoeudOnde3D[]): Float32Array {
  const tampon = new Float32Array(noeuds.length * 6);
  for (let i = 0; i < noeuds.length; i++) {
    const n = noeuds[i];
    const o = i * 6;
    tampon[o] = n.amplitude;
    tampon[o + 1] = n.frequence;
    tampon[o + 2] = n.phase;
    tampon[o + 3] = n.amortissement;
    tampon[o + 4] = n.posX;
    tampon[o + 5] = n.posY;
  }
  return tampon;
}

/** Float32Array pack [a, f, φ, d, posX, posY] × N → NoeudOnde3D[]. */
export function tamponVersNoeuds3D(tampon: Float32Array): NoeudOnde3D[] {
  if (tampon.length % 6 !== 0) {
    throw new Error(`Tampon vidéo invalide : ${tampon.length} f32 (multiple de 6 requis).`);
  }
  const noeuds: NoeudOnde3D[] = new Array(tampon.length / 6);
  for (let i = 0; i < noeuds.length; i++) {
    const o = i * 6;
    noeuds[i] = {
      amplitude: tampon[o],
      frequence: tampon[o + 1],
      phase: tampon[o + 2],
      amortissement: tampon[o + 3],
      posX: tampon[o + 4],
      posY: tampon[o + 5],
    };
  }
  return noeuds;
}

/** NoeudAcoustique[] → Float32Array [a, f, φ, d] × N (pack GPU). */
export function noeudsAcoustiquesVersTampon(noeuds: readonly NoeudAcoustique[]): Float32Array {
  const tampon = new Float32Array(noeuds.length * 4);
  for (let i = 0; i < noeuds.length; i++) {
    const n = noeuds[i];
    const o = i * 4;
    tampon[o] = n.amplitude;
    tampon[o + 1] = n.frequence;
    tampon[o + 2] = n.phase;
    tampon[o + 3] = n.amortissement;
  }
  return tampon;
}

/** Float32Array pack [a, f, φ, d] × N → NoeudAcoustique[]. */
export function tamponVersNoeudsAcoustiques(tampon: Float32Array): NoeudAcoustique[] {
  if (tampon.length % 4 !== 0) {
    throw new Error(`Tampon audio invalide : ${tampon.length} f32 (multiple de 4 requis).`);
  }
  const noeuds: NoeudAcoustique[] = new Array(tampon.length / 4);
  for (let i = 0; i < noeuds.length; i++) {
    const o = i * 4;
    noeuds[i] = {
      amplitude: tampon[o],
      frequence: tampon[o + 1],
      phase: tampon[o + 2],
      amortissement: tampon[o + 3],
    };
  }
  return noeuds;
}

/* ------------------------------------------------------------------ */
/* MOTEUR VIDÉO WebGPU — dynamique + rasterisation sur le GPU.         */
/* ------------------------------------------------------------------ */

export class MoteurVideoWebGPU implements MoteurVideoOndes {
  readonly type = "webgpu" as const;
  readonly largeur: number;
  readonly hauteur: number;
  readonly nbNoeuds: number;

  private device: GPUDevice;
  private pipelineDynamique!: GPUComputePipeline;
  private pipelineRaster!: GPUComputePipeline;
  private pipelineFinal!: GPUComputePipeline;
  private tamponNoeuds: GPUBuffer;
  private tamponCible: GPUBuffer;
  private tamponUniformes: GPUBuffer;
  private tamponRasterUniformes: GPUBuffer;
  private tamponAccumulateur: GPUBuffer;
  private tamponPoids: GPUBuffer;
  private tamponFinalUniformes: GPUBuffer;
  private tamponTrame: GPUBuffer;
  private groupeDynamique: GPUBindGroup;
  private groupeRaster: GPUBindGroup;
  private groupeFinal: GPUBindGroup;
  private accumulateurZero: ArrayBuffer;

  private constructor(
    device: GPUDevice,
    largeur: number,
    hauteur: number,
    nbNoeuds: number,
    buffers: {
      tamponNoeuds: GPUBuffer;
      tamponCible: GPUBuffer;
      tamponUniformes: GPUBuffer;
      tamponRasterUniformes: GPUBuffer;
      tamponAccumulateur: GPUBuffer;
      tamponPoids: GPUBuffer;
      tamponFinalUniformes: GPUBuffer;
      tamponTrame: GPUBuffer;
      groupeDynamique: GPUBindGroup;
      groupeRaster: GPUBindGroup;
      groupeFinal: GPUBindGroup;
    },
  ) {
    this.device = device;
    this.largeur = largeur;
    this.hauteur = hauteur;
    this.nbNoeuds = nbNoeuds;
    this.tamponNoeuds = buffers.tamponNoeuds;
    this.tamponCible = buffers.tamponCible;
    this.tamponUniformes = buffers.tamponUniformes;
    this.tamponRasterUniformes = buffers.tamponRasterUniformes;
    this.tamponAccumulateur = buffers.tamponAccumulateur;
    this.tamponPoids = buffers.tamponPoids;
    this.tamponFinalUniformes = buffers.tamponFinalUniformes;
    this.tamponTrame = buffers.tamponTrame;
    this.groupeDynamique = buffers.groupeDynamique;
    this.groupeRaster = buffers.groupeRaster;
    this.groupeFinal = buffers.groupeFinal;
    this.accumulateurZero = new ArrayBuffer(largeur * hauteur * 4);
  }

  /**
   * Construit le moteur : device → pipelines (dynamique, rasterisation,
   * finalisation) → buffers → bind groups. L'état initial des nœuds est
   * EXACTEMENT celui du miroir CPU (même graine) : parité physique.
   */
  static async creer(
    largeur = 1280,
    hauteur = 720,
    nbNoeuds = 8192,
    graine = 42,
  ): Promise<MoteurVideoWebGPU> {
    const gpu = webgpuDisponible() ? navigator.gpu : undefined;
    if (!gpu) throw new Error("WebGPU non disponible sur cet environnement.");
    if (!Number.isInteger(largeur) || largeur < 16 || largeur > 3840) {
      throw new Error(`Largeur invalide : ${largeur} (16 – 3840).`);
    }
    if (!Number.isInteger(hauteur) || hauteur < 16 || hauteur > 2160) {
      throw new Error(`Hauteur invalide : ${hauteur} (16 – 2160).`);
    }
    if (!Number.isInteger(nbNoeuds) || nbNoeuds < 1 || nbNoeuds > 65536) {
      throw new Error(`Nombre de nœuds invalide : ${nbNoeuds} (1 – 65536).`);
    }
    const adaptateur = await gpu.requestAdapter();
    if (!adaptateur) throw new Error("Aucun adaptateur GPU accepté.");
    const device = await adaptateur.requestDevice();

    const moduleDynamique = device.createShaderModule({ code: SHADER_RENDU_SPATIOTEMPOREL });
    const moduleRaster = device.createShaderModule({ code: SHADER_RASTERISATION_VIDEO });
    const moduleFinal = device.createShaderModule({ code: SHADER_FINALISATION_VIDEO });

    const pipelineDynamique = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: moduleDynamique, entryPoint: "principal" },
    });
    const pipelineRaster = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: moduleRaster, entryPoint: "principal" },
    });
    const pipelineFinal = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: moduleFinal, entryPoint: "principal" },
    });

    const tailleNoeuds = nbNoeuds * 24; // 6 f32 par nœud 3D
    const tailleCible = nbNoeuds * 4;
    const taillePixel = largeur * hauteur * 4; // i32 ou u32 par pixel

    const tamponNoeuds = device.createBuffer({
      size: tailleNoeuds,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const tamponCible = device.createBuffer({
      size: tailleCible,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const tamponUniformes = device.createBuffer({
      size: 16, // temps f32 + largeur u32 + hauteur u32 + guidage f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const tamponRasterUniformes = device.createBuffer({
      size: 16, // temps f32 + largeur u32 + hauteur u32 + pad f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const tamponAccumulateur = device.createBuffer({
      size: taillePixel,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const tamponPoids = device.createBuffer({
      size: taillePixel,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const tamponFinalUniformes = device.createBuffer({
      size: 16, // largeur u32 + hauteur u32 + pad ×2
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const tamponTrame = device.createBuffer({
      size: taillePixel,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    // État initial IDENTIQUE au miroir CPU (même graine) : parité physique.
    const initial = new MoteurRenduSpatiotemporel(largeur, hauteur, nbNoeuds, { graine });
    device.queue.writeBuffer(tamponNoeuds, 0, noeuds3DVersTampon(initial.etat()));

    const groupeDynamique = device.createBindGroup({
      layout: pipelineDynamique.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: tamponNoeuds } },
        { binding: 1, resource: { buffer: tamponCible } },
        { binding: 2, resource: { buffer: tamponUniformes } },
      ],
    });
    const groupeRaster = device.createBindGroup({
      layout: pipelineRaster.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: tamponNoeuds } },
        { binding: 1, resource: { buffer: tamponRasterUniformes } },
        { binding: 2, resource: { buffer: tamponAccumulateur } },
        { binding: 3, resource: { buffer: tamponPoids } },
      ],
    });
    const groupeFinal = device.createBindGroup({
      layout: pipelineFinal.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: tamponAccumulateur } },
        { binding: 1, resource: { buffer: tamponPoids } },
        { binding: 2, resource: { buffer: tamponFinalUniformes } },
        { binding: 3, resource: { buffer: tamponTrame } },
      ],
    });

    return new MoteurVideoWebGPU(device, largeur, hauteur, nbNoeuds, {
      tamponNoeuds,
      tamponCible,
      tamponUniformes,
      tamponRasterUniformes,
      tamponAccumulateur,
      tamponPoids,
      tamponFinalUniformes,
      tamponTrame,
      groupeDynamique,
      groupeRaster,
      groupeFinal,
    });
  }

  async rendreTrame(
    temps: number,
    cibleMouvement: OndeCible,
    guidage = GUIDAGE_VIDEO_DEFAUT,
  ): Promise<ResultatTrameVideo> {
    if (cibleMouvement.length !== this.nbNoeuds) {
      throw new Error(
        `Cible incompatible : ${cibleMouvement.length} valeurs reçues, ${this.nbNoeuds} nœuds.`,
      );
    }
    const donnees =
      cibleMouvement instanceof Float32Array
        ? cibleMouvement
        : Float32Array.from(cibleMouvement);

    // Uniformes dynamique : [temps, largeur, hauteur, guidage] (source).
    const uniformes = new ArrayBuffer(16);
    const vue = new DataView(uniformes);
    vue.setFloat32(0, temps, true);
    vue.setUint32(4, this.largeur, true);
    vue.setUint32(8, this.hauteur, true);
    vue.setFloat32(12, guidage, true);
    this.device.queue.writeBuffer(this.tamponCible, 0, donnees);
    this.device.queue.writeBuffer(this.tamponUniformes, 0, uniformes);

    // Uniforme rasterisation : même temps + dimensions (rayon recalculé).
    const uniformesRaster = new ArrayBuffer(16);
    const vueRaster = new DataView(uniformesRaster);
    vueRaster.setFloat32(0, temps, true);
    vueRaster.setUint32(4, this.largeur, true);
    vueRaster.setUint32(8, this.hauteur, true);
    vueRaster.setFloat32(12, 0, true);
    this.device.queue.writeBuffer(this.tamponRasterUniformes, 0, uniformesRaster);

    // Uniforme finalisation : dimensions seulement.
    const uniformesFinal = new ArrayBuffer(16);
    const vueFinal = new DataView(uniformesFinal);
    vueFinal.setUint32(0, this.largeur, true);
    vueFinal.setUint32(4, this.hauteur, true);
    this.device.queue.writeBuffer(this.tamponFinalUniformes, 0, uniformesFinal);

    // Remise à zéro des accumulateurs ENTIERS (préalable à chaque trame).
    this.device.queue.writeBuffer(this.tamponAccumulateur, 0, this.accumulateurZero);
    this.device.queue.writeBuffer(this.tamponPoids, 0, this.accumulateurZero);

    // Passe 1 : dynamique RPIA (guidage des nœuds vers la cible).
    // Passe 2 : rasterisation (accumulation entière atomique).
    // Passe 3 : finalisation (normalisation → RGBA packé).
    const encodeur = this.device.createCommandEncoder();
    const passe = encodeur.beginComputePass();
    passe.setPipeline(this.pipelineDynamique);
    passe.setBindGroup(0, this.groupeDynamique);
    passe.dispatchWorkgroups(Math.ceil(this.nbNoeuds / 256));
    passe.setPipeline(this.pipelineRaster);
    passe.setBindGroup(0, this.groupeRaster);
    passe.dispatchWorkgroups(Math.ceil(this.nbNoeuds / 256));
    passe.setPipeline(this.pipelineFinal);
    passe.setBindGroup(0, this.groupeFinal);
    passe.dispatchWorkgroups(Math.ceil((this.largeur * this.hauteur) / 256));
    passe.end();
    this.device.queue.submit([encodeur.finish()]);
    await this.device.queue.onSubmittedWorkDone();

    // Lecture de la trame (staging mappable) → RGBA Float32 (miroir).
    const tramePacked = await this.lireTrame();
    const trame = new Float32Array(this.largeur * this.hauteur * 4);
    const octets = new Uint8Array(tramePacked.buffer);
    for (let p = 0; p < tramePacked.length; p++) {
      const o = p * 4;
      trame[o] = octets[o];
      trame[o + 1] = octets[o + 1];
      trame[o + 2] = octets[o + 2];
      trame[o + 3] = octets[o + 3];
    }

    // Erreur honnête : mesurée sur l'état FINAL des nœuds (après guidage).
    const poids = await this.exporterPoids();
    const erreur = this.erreurDepuisPoids(poids, donnees, temps);
    return { trame, erreur };
  }

  /** Lecture GPU → staging de la trame packée RGBA (u32 par pixel). */
  private async lireTrame(): Promise<Uint32Array> {
    const taille = this.largeur * this.hauteur * 4;
    const staging = this.device.createBuffer({
      size: taille,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encodeur = this.device.createCommandEncoder();
    encodeur.copyBufferToBuffer(this.tamponTrame, 0, staging, 0, taille);
    this.device.queue.submit([encodeur.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const plage = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return plage;
  }

  /** Export des poids nœuds (staging) — télémétrie d'erreur post-guidage. */
  private async exporterPoids(): Promise<Float32Array> {
    const taille = this.nbNoeuds * 24;
    const staging = this.device.createBuffer({
      size: taille,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encodeur = this.device.createCommandEncoder();
    encodeur.copyBufferToBuffer(this.tamponNoeuds, 0, staging, 0, taille);
    this.device.queue.submit([encodeur.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const poids = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return poids;
  }

  /** Erreur d'interférence moyenne (formule du miroir, état final). */
  private erreurDepuisPoids(poids: Float32Array, cible: OndeCible, temps: number): number {
    let somme = 0;
    for (let i = 0; i < this.nbNoeuds; i++) {
      const o = i * 6;
      const onde =
        poids[o] * Math.cos(poids[o + 1] * temps + poids[o + 2] + poids[o + 4] * 0.01 + poids[o + 5] * 0.01);
      somme += Math.abs(onde - cible[i]);
    }
    return somme / this.nbNoeuds;
  }

  detruire(): void {
    this.tamponNoeuds.destroy();
    this.tamponCible.destroy();
    this.tamponUniformes.destroy();
    this.tamponRasterUniformes.destroy();
    this.tamponAccumulateur.destroy();
    this.tamponPoids.destroy();
    this.tamponFinalUniformes.destroy();
    this.tamponTrame.destroy();
  }
}

/* ------------------------------------------------------------------ */
/* MOTEUR AUDIO WebGPU — guidage par blocs + mix réel sur le GPU.      */
/* ------------------------------------------------------------------ */

export class MoteurAudioWebGPU implements MoteurAudioOndes {
  readonly type = "webgpu" as const;
  readonly nbNoeuds: number;
  readonly frequenceEchantillonnage: number;

  private device: GPUDevice;
  private pipelineGuidage!: GPUComputePipeline;
  private pipelineMix!: GPUComputePipeline;
  private tamponNoeuds: GPUBuffer;
  private tamponCible: GPUBuffer;
  private tamponUniformesGuidage: GPUBuffer;
  private tamponUniformesMix: GPUBuffer;
  private tamponPcm: GPUBuffer;
  private groupeGuidage: GPUBindGroup;
  private groupeMix: GPUBindGroup;

  private constructor(
    device: GPUDevice,
    nbNoeuds: number,
    frequenceEchantillonnage: number,
    buffers: {
      tamponNoeuds: GPUBuffer;
      tamponCible: GPUBuffer;
      tamponUniformesGuidage: GPUBuffer;
      tamponUniformesMix: GPUBuffer;
      tamponPcm: GPUBuffer;
      groupeGuidage: GPUBindGroup;
      groupeMix: GPUBindGroup;
    },
  ) {
    this.device = device;
    this.nbNoeuds = nbNoeuds;
    this.frequenceEchantillonnage = frequenceEchantillonnage;
    this.tamponNoeuds = buffers.tamponNoeuds;
    this.tamponCible = buffers.tamponCible;
    this.tamponUniformesGuidage = buffers.tamponUniformesGuidage;
    this.tamponUniformesMix = buffers.tamponUniformesMix;
    this.tamponPcm = buffers.tamponPcm;
    this.groupeGuidage = buffers.groupeGuidage;
    this.groupeMix = buffers.groupeMix;
  }

  /**
   * Construit le moteur audio : device → pipelines (guidage, mix) →
   * buffers → bind groups. État initial IDENTIQUE au miroir CPU (graine).
   */
  static async creer(
    nbNoeuds = 2048,
    frequenceEchantillonnage = 44100,
    graine = 42,
  ): Promise<MoteurAudioWebGPU> {
    const gpu = webgpuDisponible() ? navigator.gpu : undefined;
    if (!gpu) throw new Error("WebGPU non disponible sur cet environnement.");
    if (!Number.isInteger(nbNoeuds) || nbNoeuds < 1 || nbNoeuds > 65536) {
      throw new Error(`Nombre de nœuds invalide : ${nbNoeuds} (1 – 65536).`);
    }
    if (!Number.isFinite(frequenceEchantillonnage) || frequenceEchantillonnage < 8000 || frequenceEchantillonnage > 96000) {
      throw new Error(`Fréquence d'échantillonnage invalide : ${frequenceEchantillonnage} (8 000 – 96 000 Hz).`);
    }
    const adaptateur = await gpu.requestAdapter();
    if (!adaptateur) throw new Error("Aucun adaptateur GPU accepté.");
    const device = await adaptateur.requestDevice();

    const pipelineGuidage = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: SHADER_SYNTHESE_ACOUSTIQUE }), entryPoint: "principal" },
    });
    const pipelineMix = await device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: SHADER_MIX_AUDIO }), entryPoint: "principal" },
    });

    const tailleNoeuds = nbNoeuds * 16; // 4 f32 par nœud acoustique
    const tamponNoeuds = device.createBuffer({
      size: tailleNoeuds,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const tamponCible = device.createBuffer({
      size: nbNoeuds * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const tamponUniformesGuidage = device.createBuffer({
      size: 16, // tempsEchantillon f32 + frequenceEchantillonnage f32 + guidage f32 + pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const tamponUniformesMix = device.createBuffer({
      size: 16, // tempsDebutBloc f32 + frequenceEchantillonnage f32 + indexSortie u32 + nbEchantillonsBloc u32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const tamponPcm = device.createBuffer({
      size: Math.round(60 * frequenceEchantillonnage) * 4, // plafond 60 s (miroir)
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    // État initial IDENTIQUE au miroir CPU (même graine) : parité physique.
    const initial = new SynthetiseurAcoustique(nbNoeuds, { graine, frequenceEchantillonnage });
    device.queue.writeBuffer(tamponNoeuds, 0, noeudsAcoustiquesVersTampon(initial.etat()));

    const groupeGuidage = device.createBindGroup({
      layout: pipelineGuidage.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: tamponNoeuds } },
        { binding: 1, resource: { buffer: tamponCible } },
        { binding: 2, resource: { buffer: tamponUniformesGuidage } },
      ],
    });
    const groupeMix = device.createBindGroup({
      layout: pipelineMix.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: tamponNoeuds } },
        { binding: 1, resource: { buffer: tamponUniformesMix } },
        { binding: 2, resource: { buffer: tamponPcm } },
      ],
    });

    return new MoteurAudioWebGPU(device, nbNoeuds, frequenceEchantillonnage, {
      tamponNoeuds,
      tamponCible,
      tamponUniformesGuidage,
      tamponUniformesMix,
      tamponPcm,
      groupeGuidage,
      groupeMix,
    });
  }

  async genererBuffer(
    dureeSecondes: number,
    cible: OndeCible,
    guidage = GUIDAGE_AUDIO_DEFAUT,
  ): Promise<ResultatBufferAudio> {
    if (!Number.isFinite(dureeSecondes) || dureeSecondes <= 0 || dureeSecondes > 60) {
      throw new Error(`Durée invalide : ${dureeSecondes} (0 < durée ≤ 60 s).`);
    }
    if (cible.length !== this.nbNoeuds) {
      throw new Error(
        `Cible incompatible : ${cible.length} valeurs reçues, ${this.nbNoeuds} oscillateurs.`,
      );
    }
    const total = Math.round(dureeSecondes * this.frequenceEchantillonnage);

    // La cible est constante sur la génération : une seule écriture.
    const donnees = cible instanceof Float32Array ? cible : Float32Array.from(cible);
    this.device.queue.writeBuffer(this.tamponCible, 0, donnees);

    // PAR BLOC (blockStep 1024 de la source) : guidage des oscillateurs au
    // temps du début du bloc, puis mix réel de l'intervalle sur le GPU.
    let blocs = 0;
    let dernierTempsBloc = 0;
    for (let debut = 0; debut < total; debut += BLOC_ECHANTILLONS) {
      const tailleBloc = Math.min(BLOC_ECHANTILLONS, total - debut);
      const tempsBloc = debut / this.frequenceEchantillonnage;
      dernierTempsBloc = tempsBloc;

      const uniformesGuidage = new Float32Array([
        tempsBloc,
        this.frequenceEchantillonnage,
        guidage,
        0,
      ]);
      this.device.queue.writeBuffer(this.tamponUniformesGuidage, 0, uniformesGuidage);

      const uniformesMix = new ArrayBuffer(16);
      const vue = new DataView(uniformesMix);
      vue.setFloat32(0, tempsBloc, true);
      vue.setFloat32(4, this.frequenceEchantillonnage, true);
      vue.setUint32(8, debut, true);
      vue.setUint32(12, tailleBloc, true);
      this.device.queue.writeBuffer(this.tamponUniformesMix, 0, uniformesMix);

      const encodeur = this.device.createCommandEncoder();
      const passe = encodeur.beginComputePass();
      passe.setPipeline(this.pipelineGuidage);
      passe.setBindGroup(0, this.groupeGuidage);
      passe.dispatchWorkgroups(Math.ceil(this.nbNoeuds / 256));
      passe.setPipeline(this.pipelineMix);
      passe.setBindGroup(0, this.groupeMix);
      passe.dispatchWorkgroups(Math.ceil(tailleBloc / 256));
      passe.end();
      this.device.queue.submit([encodeur.finish()]);
      await this.device.queue.onSubmittedWorkDone();
      blocs++;
    }

    // Lecture finale du PCM (un seul staging pour tout le tampon).
    const taillePcm = total * 4;
    const staging = this.device.createBuffer({
      size: taillePcm,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encodeur = this.device.createCommandEncoder();
    encodeur.copyBufferToBuffer(this.tamponPcm, 0, staging, 0, taillePcm);
    this.device.queue.submit([encodeur.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const pcm = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();

    // Erreur honnête : mesurée sur l'état FINAL des oscillateurs.
    const poids = await this.exporterPoids();
    const erreur = this.erreurDepuisPoids(poids, donnees, dernierTempsBloc);
    return { pcm, erreur, blocs };
  }

  /** Export des poids oscillateurs (staging) — télémétrie d'erreur finale. */
  private async exporterPoids(): Promise<Float32Array> {
    const taille = this.nbNoeuds * 16;
    const staging = this.device.createBuffer({
      size: taille,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encodeur = this.device.createCommandEncoder();
    encodeur.copyBufferToBuffer(this.tamponNoeuds, 0, staging, 0, taille);
    this.device.queue.submit([encodeur.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const poids = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return poids;
  }

  /** Erreur d'interférence moyenne (formule du miroir, état final). */
  private erreurDepuisPoids(poids: Float32Array, cible: OndeCible, temps: number): number {
    let somme = 0;
    for (let i = 0; i < this.nbNoeuds; i++) {
      const o = i * 4;
      const onde =
        poids[o] * Math.sin(2.0 * Math.PI * poids[o + 1] * temps + poids[o + 2]);
      somme += Math.abs(onde - cible[i]);
    }
    return somme / this.nbNoeuds;
  }

  detruire(): void {
    this.tamponNoeuds.destroy();
    this.tamponCible.destroy();
    this.tamponUniformesGuidage.destroy();
    this.tamponUniformesMix.destroy();
    this.tamponPcm.destroy();
  }
}

/* ------------------------------------------------------------------ */
/* FABRIQUES — WebGPU si disponible, sinon miroir CPU universel.       */
/* ------------------------------------------------------------------ */

export interface ResultatFabriqueMoteurVideo {
  moteur: MoteurVideoOndes;
  type: "webgpu" | "cpu";
  /** Raison du repli CPU (affichable dans l'UI). */
  raison?: string;
}

export interface ResultatFabriqueMoteurAudio {
  moteur: MoteurAudioOndes;
  type: "webgpu" | "cpu";
  /** Raison du repli CPU (affichable dans l'UI). */
  raison?: string;
}

/** Fabrique vidéo : dynamique + raster sur le GPU de l'utilisateur, sinon CPU. */
export async function creerMoteurVideoRPIA(options?: {
  largeur?: number;
  hauteur?: number;
  nbNoeuds?: number;
  graine?: number;
}): Promise<ResultatFabriqueMoteurVideo> {
  const { largeur = 1280, hauteur = 720, nbNoeuds = 8192, graine = 42 } = options ?? {};
  if (webgpuDisponible()) {
    try {
      const moteur = await MoteurVideoWebGPU.creer(largeur, hauteur, nbNoeuds, graine);
      return { moteur, type: "webgpu" };
    } catch (erreur) {
      return {
        moteur: new MoteurVideoCpu(largeur, hauteur, nbNoeuds, graine),
        type: "cpu",
        raison:
          erreur instanceof Error
            ? `WebGPU refusé (${erreur.message}) — miroir CPU actif`
            : "WebGPU refusé — miroir CPU actif",
      };
    }
  }
  return {
    moteur: new MoteurVideoCpu(largeur, hauteur, nbNoeuds, graine),
    type: "cpu",
    raison: "Environnement sans WebGPU — miroir CPU actif",
  };
}

/** Fabrique audio : guidage par blocs + mix réel sur le GPU, sinon CPU. */
export async function creerMoteurAudioRPIA(options?: {
  nbNoeuds?: number;
  frequenceEchantillonnage?: number;
  graine?: number;
}): Promise<ResultatFabriqueMoteurAudio> {
  const { nbNoeuds = 2048, frequenceEchantillonnage = 44100, graine = 42 } = options ?? {};
  if (webgpuDisponible()) {
    try {
      const moteur = await MoteurAudioWebGPU.creer(nbNoeuds, frequenceEchantillonnage, graine);
      return { moteur, type: "webgpu" };
    } catch (erreur) {
      return {
        moteur: new MoteurAudioCpu(nbNoeuds, frequenceEchantillonnage, graine),
        type: "cpu",
        raison:
          erreur instanceof Error
            ? `WebGPU refusé (${erreur.message}) — miroir CPU actif`
            : "WebGPU refusé — miroir CPU actif",
      };
    }
  }
  return {
    moteur: new MoteurAudioCpu(nbNoeuds, frequenceEchantillonnage, graine),
    type: "cpu",
    raison: "Environnement sans WebGPU — miroir CPU actif",
  };
}

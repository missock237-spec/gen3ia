/**
 * GÉNÉRATEUR MULTIMODAL PAR ONDES — Phase 4 : la logique PURE derrière
 * l'API de génération légère (`/api/ondes/generer`).
 *
 * Le contrat de l'API : l'utilisateur envoie une INTENTION textuelle (ou
 * bientôt un vecteur d'état), le serveur :
 *  1. encode l'intention dans le tenseur d'onde commun (manifold, Phase 1) ;
 *  2. exécute le MIROIR CPU du décodeur demandé (Phase 2) comme preuve
 *     de reproductibilité — le serveur n'a pas de GPU utilisateur, il
 *     garantit que le rendu local produira le même résultat (empreinte
 *     de cohérence) ;
 *  3. renvoie le FLUX D'ONDES compact (tenseur quantifié en base64,
 *     ~4 octets/état) + les INSTRUCTIONS DE RENDU LOCAL (point d'entrée
 *     WGSL, workgroup, uniformes) — c'est le CLIENT qui rend sur son
 *     propre GPU, en zéro-copie (Phase 3), à l'énergie la plus basse.
 *
 * Honnêteté structurelle : le champ `moteur` vaut toujours "cpu" côté
 * serveur (miroir), `latenceMs` est MESURÉ, les watts sont ESTIMÉS
 * (méthode étiquetée), et l'empreinte de cohérence est une somme
 * modulaire — pas un haché cryptographique.
 */

import {
  texteVersTenseur,
  type TenseurOnde,
} from "./manifold";
import {
  DecodeurAudioPhase,
  DecodeurImageWavelet,
  DecodeurVideoDerive,
} from "./micro-decodeurs";
import {
  budgetVram,
  compterActivationSparse,
  economieZeroCopie,
} from "./optimisation";
import {
  comparerOndesVsDense,
  estimerEnergie,
  mesurerLatence,
} from "./performance";

export type ModaliteGeneration = "image" | "audio" | "video";

export interface DemandeGeneration {
  /** Intention textuelle (le prompt qui module le manifold). */
  intention: string;
  readonly modalite: ModaliteGeneration;
  /** Image/vidéo : dimensions (défaut 256×256, max 512). */
  largeur?: number;
  hauteur?: number;
  /** Taille du tenseur (défaut 256 harmoniques, max 1024). */
  nbNoeuds?: number;
  /** Audio : échantillons (défaut 22 050, max 44 100 = 1 s). */
  nbEchantillons?: number;
}

export interface InstructionsRenduLocal {
  /** Nom du shader WGSL à compiler côté client (shaders-manifold.ts). */
  readonly shader: string;
  /** Point d'entrée du compute shader. */
  readonly entryPoint: string;
  readonly workgroupSize: readonly [number, number];
  /** Uniformes à pousser (ordre des champs de la struct WGSL). */
  readonly uniformes: Record<string, number>;
  /** Mode de présentation locale (zéro-copie, Phase 3). */
  readonly presentation: "canvas-gpu" | "audio-worklet";
}

export interface VerifServeur {
  /** Le serveur exécute le miroir CPU — honnêteté : pas de GPU ici. */
  readonly moteur: "cpu";
  readonly latenceMs: number;
  /** Empreinte de cohérence du rendu (somme modulaire 32 bits). */
  readonly empreinte: number;
  /** Métriques propres à la modalité. */
  readonly detail: Record<string, number>;
}

export interface OffreGeneration {
  readonly modalite: ModaliteGeneration;
  readonly nbNoeuds: number;
  readonly fondamentale: number;
  /** Le flux d'ondes compact — amplitudes et phases quantifiées (base64). */
  readonly tenseur: {
    readonly amplitudesBase64: string;
    readonly phasesBase64: string;
    readonly octets: number;
  };
  readonly renduLocal: InstructionsRenduLocal;
  readonly verifServeur: VerifServeur;
  readonly metriques: {
    /** Nœuds actifs / total (activation sparse, Phase 3). */
    readonly noeudsActifs: number;
    readonly noeudsTotaux: number;
    readonly tauxActivation: number;
    /** Latence mesurée du miroir CPU (ms). */
    readonly latenceMs: number;
    /** Watts estimés du rendu local GPU (estimation calibrée). */
    readonly wattsEstimes: number;
    readonly methodeEnergie: "estimation-calibree";
    /** Ratio d'opérations contre le pipeline dense de référence. */
    readonly ratioVsDense: number;
    /** Octets économisés sur le bus GPU→CPU par image (zéro-copie). */
    readonly octetsEconomisesParImage: number;
    /** Budget VRAM de l'offre. */
    readonly budgetVram: { octetsTotalParImage: number; tient: boolean };
  };
}

/* ------------------------------------------------------------------ */
/* Utilitaires (purs, portables — pas de Buffer)                       */
/* ------------------------------------------------------------------ */

const ALPHABET_BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode des octets en base64 — implémentation pure (Node + navigateur). */
export function tamponVersBase64(octets: Uint8Array): string {
  let sortie = "";
  for (let i = 0; i < octets.length; i += 3) {
    const b0 = octets[i];
    const b1 = i + 1 < octets.length ? octets[i + 1] : 0;
    const b2 = i + 2 < octets.length ? octets[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    sortie += ALPHABET_BASE64[(triple >> 18) & 63];
    sortie += ALPHABET_BASE64[(triple >> 12) & 63];
    sortie += i + 1 < octets.length ? ALPHABET_BASE64[(triple >> 6) & 63] : "=";
    sortie += i + 2 < octets.length ? ALPHABET_BASE64[triple & 63] : "=";
  }
  return sortie;
}

/** Empreinte de cohérence : somme modulaire 32 bits (PAS cryptographique). */
export function empreinteModulaire(donnees: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < donnees.length; i++) {
    h = (h + donnees[i] * (i + 1)) >>> 0;
  }
  return h >>> 0;
}

/** Sérialise le tenseur en paires base64 (le flux d'ondes de l'API). */
export function serialiserTenseur(t: TenseurOnde): {
  amplitudesBase64: string;
  phasesBase64: string;
  octets: number;
} {
  const a = new Uint8Array(t.amplitudes.buffer, t.amplitudes.byteOffset, t.amplitudes.byteLength);
  const p = new Uint8Array(t.phases.buffer, t.phases.byteOffset, t.phases.byteLength);
  return {
    amplitudesBase64: tamponVersBase64(a),
    phasesBase64: tamponVersBase64(p),
    octets: t.nbNoeuds * 4,
  };
}

/* ------------------------------------------------------------------ */
/* Génération (logique pure — testée, appelée par la route)            */
/* ------------------------------------------------------------------ */

export const BORNES_GENERATION = {
  intentionMax: 2000,
  nbNoeudsDefaut: 256,
  nbNoeudsMax: 1024,
  dimensionMax: 512,
  nbEchantillonsDefaut: 22050,
  nbEchantillonsMax: 44100,
} as const;

/**
 * Génère l'offre multimodale complète pour une intention — pure,
 * déterministe (hors latence mesurée), sans accès réseau ni disque.
 */
export function genererDepuisIntention(
  demande: DemandeGeneration,
): OffreGeneration {
  const intention = demande.intention.trim();
  if (intention.length === 0) {
    throw new Error("Intention vide : rien à mettre en résonance.");
  }
  if (intention.length > BORNES_GENERATION.intentionMax) {
    throw new Error(
      `Intention trop longue : ${intention.length} > ${BORNES_GENERATION.intentionMax} caractères.`,
    );
  }

  const nbNoeuds = demande.nbNoeuds ?? BORNES_GENERATION.nbNoeudsDefaut;
  if (!Number.isInteger(nbNoeuds) || nbNoeuds < 16 || nbNoeuds > BORNES_GENERATION.nbNoeudsMax) {
    throw new Error(`Nombre de nœuds invalide : ${nbNoeuds} (16..${BORNES_GENERATION.nbNoeudsMax}).`);
  }

  const tenseur = texteVersTenseur(intention, nbNoeuds);
  const sparse = compterActivationSparse(tenseur);

  // Vérification serveur : le miroir CPU du décodeur demandé.
  if (demande.modalite === "image" || demande.modalite === "video") {
    const largeur = Math.min(demande.largeur ?? 256, BORNES_GENERATION.dimensionMax);
    const hauteur = Math.min(demande.hauteur ?? 256, BORNES_GENERATION.dimensionMax);
    if (!Number.isInteger(largeur) || largeur < 16 || !Number.isInteger(hauteur) || hauteur < 16) {
      throw new Error(`Dimensions invalides : ${largeur}×${hauteur} (≥ 16).`);
    }

    if (demande.modalite === "image") {
      const decodeur = new DecodeurImageWavelet(largeur, hauteur);
      const mesure = mesurerLatence(() => decodeur.rendre(tenseur), 3);
      const rendu = decodeur.rendre(tenseur);
      const empreinte = empreinteModulaire(rendu.pixels);
      const comparaison = comparerOndesVsDense(tenseur, largeur * hauteur, "image");
      const energie = estimerEnergie(comparaison.opsOndes, "webgpu", mesure.latenceMs);
      const eco = economieZeroCopie("image", { largeur, hauteur, nbNoeuds });
      const budget = budgetVram(nbNoeuds, "image", { largeur, hauteur });

      return {
        modalite: "image",
        nbNoeuds,
        fondamentale: tenseur.fondamentale,
        tenseur: serialiserTenseur(tenseur),
        renduLocal: {
          shader: "SHADER_DECODE_IMAGE_WAVELET",
          entryPoint: "decoderImage",
          workgroupSize: [8, 8],
          uniformes: {
            largeur,
            hauteur,
            nbNoeuds,
            fondamentale: tenseur.fondamentale,
            seuilSparse: 0.02,
            echelleEspace: 96,
            gainLumiere: 0.45,
          },
          presentation: "canvas-gpu",
        },
        verifServeur: {
          moteur: "cpu",
          latenceMs: mesure.latenceMs,
          empreinte,
          detail: {
            harmoniquesActives: rendu.nbHarmoniquesActives,
            harmoniquesSautees: rendu.nbHarmoniquesSautees,
            pixels: largeur * hauteur,
          },
        },
        metriques: {
          noeudsActifs: sparse.actifs,
          noeudsTotaux: sparse.total,
          tauxActivation: sparse.tauxActivation,
          latenceMs: mesure.latenceMs,
          wattsEstimes: energie.wattsMoyens,
          methodeEnergie: energie.methode,
          ratioVsDense: comparaison.ratio,
          octetsEconomisesParImage: eco.octetsEconomisesParImage,
          budgetVram: { octetsTotalParImage: budget.octetsTotalParImage, tient: budget.tient },
        },
      };
    }

    // VIDÉO : la trame T0 de référence est un gris moyen — le client
    // itère ensuite localement (dérive de phase trame après trame).
    const decodeur = new DecodeurVideoDerive(largeur, hauteur);
    const t0 = new Uint8ClampedArray(largeur * hauteur * 4);
    for (let p = 0; p < t0.length; p += 4) {
      t0[p] = 128;
      t0[p + 1] = 128;
      t0[p + 2] = 128;
      t0[p + 3] = 255;
    }
    const mesure = mesurerLatence(() => decodeur.trameSuivante(t0, tenseur), 3);
    const propagation = decodeur.trameSuivante(t0, tenseur);
    const empreinte = empreinteModulaire(propagation.trame);
    const comparaison = comparerOndesVsDense(tenseur, largeur * hauteur, "video");
    const energie = estimerEnergie(comparaison.opsOndes, "webgpu", mesure.latenceMs);
    const eco = economieZeroCopie("video", { largeur, hauteur, nbNoeuds });
    const budget = budgetVram(nbNoeuds, "video", { largeur, hauteur });

    return {
      modalite: "video",
      nbNoeuds,
      fondamentale: tenseur.fondamentale,
      tenseur: serialiserTenseur(tenseur),
      renduLocal: {
        shader: "SHADER_DECODE_VIDEO_DERIVE",
        entryPoint: "deriverTrame",
        workgroupSize: [8, 8],
        uniformes: {
          largeur,
          hauteur,
          nbNoeuds,
          coteGrille: Math.round(Math.sqrt(nbNoeuds)),
          amplitudeDerive: 8,
          gainResurrection: 0.15,
          seuilSparse: 0.02,
        },
        presentation: "canvas-gpu",
      },
      verifServeur: {
        moteur: "cpu",
        latenceMs: mesure.latenceMs,
        empreinte,
        detail: {
          deriveMoyenne: propagation.deriveMoyenne,
          deriveMaximale: propagation.deriveMaximale,
          pixels: largeur * hauteur,
        },
      },
      metriques: {
        noeudsActifs: sparse.actifs,
        noeudsTotaux: sparse.total,
        tauxActivation: sparse.tauxActivation,
        latenceMs: mesure.latenceMs,
        wattsEstimes: energie.wattsMoyens,
        methodeEnergie: energie.methode,
        ratioVsDense: comparaison.ratio,
        octetsEconomisesParImage: eco.octetsEconomisesParImage,
        budgetVram: { octetsTotalParImage: budget.octetsTotalParImage, tient: budget.tient },
      },
    };
  }

  // AUDIO : synthèse pilotée par phase, vérifiée côté serveur (miroir).
  const nbEchantillons = Math.min(
    demande.nbEchantillons ?? BORNES_GENERATION.nbEchantillonsDefaut,
    BORNES_GENERATION.nbEchantillonsMax,
  );
  if (!Number.isInteger(nbEchantillons) || nbEchantillons < 256) {
    throw new Error(`Nombre d'échantillons invalide : ${nbEchantillons} (≥ 256).`);
  }
  const decodeur = new DecodeurAudioPhase();
  const mesure = mesurerLatence(() => decodeur.synthetiser(tenseur, nbEchantillons), 3);
  const pcm = decodeur.synthetiser(tenseur, nbEchantillons);
  let energieCarree = 0;
  let crete = 0;
  for (let s = 0; s < pcm.length; s++) {
    energieCarree += pcm[s] * pcm[s];
    crete = Math.max(crete, Math.abs(pcm[s]));
  }
  const rms = Math.sqrt(energieCarree / pcm.length);
  const empreinte = empreinteModulaire(pcm);
  const comparaison = comparerOndesVsDense(tenseur, nbEchantillons, "audio");
  const energie = estimerEnergie(comparaison.opsOndes, "webgpu", mesure.latenceMs);
  const eco = economieZeroCopie("audio", { nbEchantillons, nbNoeuds });
  const budget = budgetVram(nbNoeuds, "audio", { tailleBloc: 1024 });

  return {
    modalite: "audio",
    nbNoeuds,
    fondamentale: tenseur.fondamentale,
    tenseur: serialiserTenseur(tenseur),
    renduLocal: {
      shader: "SHADER_DECODE_AUDIO_PHASE",
      entryPoint: "decoderAudio",
      workgroupSize: [256, 1],
      uniformes: {
        nbEchantillons,
        nbNoeuds,
        fondamentale: tenseur.fondamentale,
        freqEchantillonnage: 44100,
        f0Audible: 110,
        etendueOctaves: 3,
        seuilSparse: 0.02,
      },
      presentation: "audio-worklet",
    },
    verifServeur: {
      moteur: "cpu",
      latenceMs: mesure.latenceMs,
      empreinte,
      detail: {
        rms: Math.round(rms * 1e4) / 1e4,
        crete: Math.round(crete * 1e4) / 1e4,
        echantillons: nbEchantillons,
        frequenceOscillateur0: Math.round(decodeur.frequenceOscillateur(tenseur, 0) * 10) / 10,
      },
    },
    metriques: {
      noeudsActifs: sparse.actifs,
      noeudsTotaux: sparse.total,
      tauxActivation: sparse.tauxActivation,
      latenceMs: mesure.latenceMs,
      wattsEstimes: energie.wattsMoyens,
      methodeEnergie: energie.methode,
      ratioVsDense: comparaison.ratio,
      octetsEconomisesParImage: eco.octetsEconomisesParImage,
      budgetVram: { octetsTotalParImage: budget.octetsTotalParImage, tient: budget.tient },
    },
  };
}

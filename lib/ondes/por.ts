/**
 * PROOF-OF-RESONANCE (PoR) — le consensus cryptographique de l'essaim.
 *
 * Lorsqu'un nœud effectue un calcul ou un entraînement par ondes sur son
 * WebGPU, il ne renvoie pas le résultat brut : il génère une EMPREINTE
 * SPECTRALE DE PHASE — une signature mathématique issue de
 * l'interférence elle-même.
 *
 * L'INFALSIFIABILITÉ repose sur trois piliers :
 *
 *  1. LA PHYSIQUE EST DÉTERMINISTE — le champ W-DNN (grille d'oscillateurs,
 *     équation d'onde + couplage de Kuramoto, carte de fréquences graine 42)
 *     produit EXACTEMENT le même état à partir des mêmes impulsions. Un
 *     défi (graine fraîche) fixe les impulsions : connaître l'empreinte
 *     sans avoir réellement PROPAGÉ L'ONDE est impossible sans recalculer
 *     toute la simulation — il n'existe aucune formule fermée du système
 *     couplé, et sauter des pas déplace les secteurs de phase.
 *  2. L'EMPREINTE LIE TOUT — défi, version du protocole, dimension de
 *     grille, paramètres physiques, énergie moyenne, ordre de Kuramoto et
 *     secteurs de phase quantifiés de CHAQUE cellule. Un tricheur qui
 *     devine doit tomber juste sur un vecteur multidimensionnel flou
 *     (spectre + métriques) en même temps que sur le haché exact.
 *  3. LA VÉRIFICATION EST UNE RÉSONANCE — un nœud voisin rejoue le MÊME
 *     défi dans SON champ (CPU ou GPU, quelques dizaines de millisecondes)
 *     et compare : empreinte exacte (moteur identique) OU cohérence
 *     spectrale ≥ seuil (moteurs différents, dérive flottante absorbée
 *     par la quantification). Trois réponses déphasées s'annulent —
 *     voir lib/ondes/consensus-essaim.ts.
 *
 * Garantie honnête : le PoR lie le travail RÉEL de simulation (impossible
 * à court-circuiter) à une empreinte multicritère. Le haché est FNV-1a
 * double voie 64 bits — rapide sur des grilles de 16 000 à 102 000
 * cellules, sans dépendance — et la force anti-triche vient du
 * CROISEMENT empreinte exacte + spectre + métriques, rejouable par
 * n'importe quel voisin. Ce n'est pas une signature RSA ; c'est une
 * preuve de travail physique vérifiable localement, par résonance.
 */

import { fnv1a } from "./encodeur";
import { MoteurCpu, type MoteurOndes } from "./champ";
import type { ConfigOndes, Impulsion } from "./types";

/** Version du protocole PoR (traçabilité des empreintes). */
export const VERSION_POR = 1;

/** Secteurs de phase : θ ∈ [0, 2π[ est quantifié en 128 secteurs. */
export const SECTEURS_PHASE = 128;

/** Pas de quantification des amplitudes (absorbe la dérive GPU/CPU). */
export const PAS_AMPLITUDE = 0.05;

/** Bandes d'énergie du spectre résumé (comparaison floue inter-moteurs). */
export const BANDES_SPECTRE = 16;

/** Secteurs de phase résumés dans le spectre (organisation de la phase). */
export const SECTEURS_SPECTRE_PHASE = 16;

/** Longueur du spectre : bandes d'énergie + secteurs de phase. */
export const LONGUEUR_SPECTRE = BANDES_SPECTRE + SECTEURS_SPECTRE_PHASE;

/** Seuil de cohérence spectrale entre deux empreintes (cosinus des bandes). */
export const SEUIL_COHERENCE_SPECTRALE = 0.92;

/** Tolérance relative sur énergie et ordre r (dérive flottante tolérée). */
export const TOLERANCE_METRIQUES = 0.15;

/** TTL d'un défi (ms) : une preuve rejouée plus tard est morte. */
export const DEFI_TTL_MS = 2 * 60 * 1000;

/** Empreinte spectrale complète d'un état de champ. */
export interface EmpreinteSpectrale {
  v: 1;
  /** Haché double voie 64 bits (hex 16) de l'état quantifié complet. */
  empreinte: string;
  /** Spectre résumé (LONGUEUR_SPECTRE valeurs quantifiées) : bandes
   *  d'énergie puis histogramme de secteurs de phase. Un calcul tronqué
   *  garde des bandes d'énergie proches mais une organisation de phase
   *  différente — le spectre le trahit. */
  spectre: number[];
  /** Énergie moyenne |amplitude| (quantifiée). */
  energie: number;
  /** Paramètre d'ordre de Kuramoto r (quantifié). */
  ordreR: number;
  /** Nombre de cellules de la grille. */
  cellules: number;
  /** Clé de configuration physique (paramètres de propagation). */
  config: string;
  /** Défi lié (graine du protocole défi-réponse), si applicable. */
  defi?: string;
  /** Horodatage (ms, epoch émetteur). */
  ts: number;
}

/** Attestation compacte transportée DANS un micro-paquet d'ondes P2P. */
export interface AttestationOnde {
  /** Haché (hex 16). */
  e: string;
  /** Spectre (bandes). */
  s: number[];
  /** Énergie moyenne. */
  g: number;
  /** Ordre de Kuramoto. */
  r: number;
  /** Cellules de la grille. */
  c: number;
}

/* ------------------------------------------------------------------ */
/* Quantification et empreinte                                         */
/* ------------------------------------------------------------------ */

/** Quantifie une amplitude sur la grille PAS_AMPLITUDE (entier). */
export function quantifierAmplitude(a: number): number {
  return Math.round(a / PAS_AMPLITUDE);
}

/** Quantifie une phase en secteur ∈ [0, SECTEURS_PHASE[. */
export function quantifierPhase(th: number): number {
  const deuxPi = Math.PI * 2;
  let t = th % deuxPi;
  if (t < 0) t += deuxPi;
  return Math.floor((t / deuxPi) * SECTEURS_PHASE) % SECTEURS_PHASE;
}

/** Clé stable d'une configuration physique (les paramètres qui comptent). */
export function cleConfiguration(cfg: ConfigOndes): string {
  const r = (x: number): string => x.toFixed(6);
  return [r(cfg.c2), r(cfg.amortissement), r(cfg.couplage), r(cfg.dt), r(cfg.gain)].join("|");
}

/**
 * Haché double voie 64 bits d'une suite d'entiers — deux FNV-1a 32 bits
 * à graines distinctes entrelacées. Plus robuste qu'une seule voie contre
 * les collisions construites, tout en restant O(n) et sans allocation.
 */
export function hacherEntrees(entrees: ArrayLike<number>): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < entrees.length; i++) {
    const v = entrees[i] | 0;
    h1 ^= v & 0xff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h1 ^= (v >>> 8) & 0xff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (v >>> 16) & 0xff;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    h2 ^= (v >>> 24) | 0x80;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export interface OptionsEmpreinte {
  /** Défi lié (graine du protocole défi-réponse). */
  defi?: string;
  /** Configuration physique (défaut : configuration de l'arène). */
  config?: ConfigOndes;
}

/**
 * EMPREINTE SPECTRALE DE PHASE d'un état de champ.
 *
 * Parcours déterministe (ligne à ligne) de TOUTES les cellules : chaque
 * cellule contribue son couple (amplitude quantifiée, secteur de phase).
 * Toute altération — un pas sauté, une impulsion changée, un paramètre
 * modifié, une région inventée — déplace des secteurs et casse le haché.
 */
export function empreinteSpectrale(
  amplitudes: ArrayLike<number>,
  phases: ArrayLike<number>,
  options?: OptionsEmpreinte,
): EmpreinteSpectrale {
  const n = Math.min(amplitudes.length, phases.length);
  const cfg: ConfigOndes = options?.config ?? {
    largeur: 0,
    hauteur: 0,
    pasParImage: 1,
    periodeReadback: 1,
    c2: 0.25,
    amortissement: 0.985,
    couplage: 0.1,
    dt: 0.12,
    gain: 0.016,
  };
  const entetes = [
    VERSION_POR,
    options?.defi ? fnv1a(options.defi) : 0,
    n,
    ...cleConfiguration(cfg)
      .split("|")
      .map((x) => Math.round(Number(x) * 1e6)),
  ];

  // Spectre résumé : bandes d'énergie (part relative) + histogramme de
  // secteurs de phase (organisation réelle de l'onde).
  const bandes = new Float64Array(BANDES_SPECTRE);
  const histogrammePhase = new Float64Array(SECTEURS_SPECTRE_PHASE);
  let sommeEnergie = 0;
  let sommeCos = 0;
  let sommeSin = 0;

  // Haché principal : entrelacement amplitude/phase cellule par cellule.
  const flux = new Int32Array(n * 2 + entetes.length);
  for (let i = 0; i < entetes.length; i++) flux[i] = entetes[i];
  let curseur = entetes.length;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(amplitudes[i]);
    sommeEnergie += a;
    const th = phases[i];
    sommeCos += Math.cos(th);
    sommeSin += Math.sin(th);
    flux[curseur++] = quantifierAmplitude(amplitudes[i]);
    const secteur = quantifierPhase(th);
    flux[curseur++] = secteur;
    bandes[Math.min(BANDES_SPECTRE - 1, Math.floor((i / n) * BANDES_SPECTRE))] += a;
    histogrammePhase[Math.min(SECTEURS_SPECTRE_PHASE - 1, Math.floor(secteur / (SECTEURS_PHASE / SECTEURS_SPECTRE_PHASE)))] += 1;
  }
  const empreinte = hacherEntrees(flux);

  const ordreR = n > 0 ? Math.hypot(sommeCos, sommeSin) / n : 0;
  // Part d'énergie de chaque bande (0..1000) puis part de chaque secteur
  // de phase (0..1000) — comparables entre nœuds quelle que soit l'énergie
  // absolue du champ.
  const spectre = [
    ...Array.from(bandes, (e) => (sommeEnergie > 0 ? Math.round((e / sommeEnergie) * 1000) : 0)),
    ...Array.from(histogrammePhase, (c) => (n > 0 ? Math.round((c / n) * 1000) : 0)),
  ];
  const energieMoyenne = n > 0 ? sommeEnergie / n : 0;
  return {
    v: 1,
    empreinte,
    spectre,
    energie: Math.round(energieMoyenne * 1000) / 1000,
    ordreR: Math.round(ordreR * 1000) / 1000,
    cellules: n,
    config: cleConfiguration(cfg),
    ...(options?.defi ? { defi: options.defi } : {}),
    ts: Date.now(),
  };
}

/** Spectre quantifié d'une empreinte (comparaison floue). */
function spectreQuantifie(e: EmpreinteSpectrale): number[] {
  return e.spectre.map((x) => Math.round(x));
}

/**
 * Cohérence spectrale entre deux empreintes : cosinus des bandes d'énergie.
 * 1 = ondes identiques, ≈0 = champs sans rapport (ou inventés).
 */
export function coherenceSpectrale(a: EmpreinteSpectrale, b: EmpreinteSpectrale): number {
  if (a.spectre.length !== b.spectre.length || a.spectre.length === 0) return 0;
  const sa = spectreQuantifie(a);
  const sb = spectreQuantifie(b);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < sa.length; i++) {
    ab += sa[i] * sb[i];
    aa += sa[i] * sa[i];
    bb += sb[i] * sb[i];
  }
  if (aa === 0 || bb === 0) return 0;
  return ab / Math.sqrt(aa * bb);
}

/* ------------------------------------------------------------------ */
/* Protocole défi-réponse                                              */
/* ------------------------------------------------------------------ */

export interface DefiOndes {
  /** Graine du défi (hex) — fixe les impulsions à propager. */
  defi: string;
  /** Expiration (epoch ms). */
  echeance: number;
  /** Émetteur du défi (nœud vérificateur). */
  emetteur: string;
}

/**
 * Crée un défi frais : une graine qu'aucun nœud ne peut anticiper et à
 * laquelle seule une propagation RÉELLE d'ondes répond correctement.
 */
export function creerDefi(emetteur: string, aleatoire: () => number = Math.random): DefiOndes {
  const defi = `${emetteur.slice(0, 8)}-${Math.floor(aleatoire() * 0xffffffff).toString(16).padStart(8, "0")}${Math.floor(aleatoire() * 0xffffffff).toString(16).padStart(8, "0")}`;
  return { defi, echeance: Date.now() + DEFI_TTL_MS, emetteur };
}

/** Nombre d'impulsions d'un défi (assez pour toucher tout le champ). */
export const IMPULSIONS_DEFI = 6;

/** Nombre de pas de propagation d'un défi (suffisant pour lier l'état). */
export const PAS_DEFI = 24;

/**
 * Les impulsions DÉTERMINISTES d'un défi : la graine fixe positions,
 * fréquences, phases et amplitudes. Deux nœuds qui rejouent le même défi
 * injectent EXACTEMENT les mêmes ondes dans EXACTEMENT le même champ
 * (carte de fréquences graine 42) — leurs empreintes doivent coïncider.
 */
export function impulsionsDuDefi(defi: string, dim: number): Impulsion[] {
  const base = fnv1a(`por-defi|${defi}`);
  const impulsions: Impulsion[] = [];
  let graine = base >>> 0;
  const alea = (): number => {
    graine = (Math.imul(graine, 1664525) + 1013904223) >>> 0;
    return graine / 0xffffffff;
  };
  for (let k = 0; k < IMPULSIONS_DEFI; k++) {
    impulsions.push({
      x: 4 + alea() * (dim - 8),
      y: 4 + alea() * (dim - 8),
      amplitude: (0.6 + alea() * 1.8) * (alea() < 0.5 ? -1 : 1) * 3,
      frequence: 0.03 + alea() * 0.14,
      phase: alea() * Math.PI * 2,
      rayon: 2.5,
    });
  }
  return impulsions;
}

export interface OptionsExecuterDefi {
  /** Moteur à utiliser (défaut : un champ CPU neuf — grille dim×dim). */
  moteur?: MoteurOndes;
  /** Dimension de la grille (défaut 128 — la grille de l'arène). */
  dim?: number;
  /** Configuration physique (défaut : celle de l'arène). */
  config?: ConfigOndes;
}

/**
 * RÉPOND à un défi : propage réellement les ondes du défi dans un champ
 * neuf et en extrait l'empreinte spectrale. C'est ce calcul — et lui seul
 * — qui produit la bonne réponse : le travail est la preuve.
 */
export function executerDefi(defi: string, options?: OptionsExecuterDefi): EmpreinteSpectrale {
  const dim = options?.dim ?? 128;
  const cfg: ConfigOndes = options?.config ?? {
    largeur: dim,
    hauteur: dim,
    pasParImage: 1,
    periodeReadback: 1,
    c2: 0.25,
    amortissement: 0.985,
    couplage: 0.1,
    dt: 0.12,
    gain: 0.016,
  };
  const moteur = options?.moteur ?? new MoteurCpu({ ...cfg, largeur: dim, hauteur: dim });
  try {
    moteur.injecter(impulsionsDuDefi(defi, dim));
    for (let k = 0; k < PAS_DEFI; k++) moteur.avancer();
    return empreinteSpectrale(moteur.amplitudes(), moteur.phases(), {
      defi,
      config: moteur.config(),
    });
  } finally {
    if (!options?.moteur) moteur.detruire();
  }
}

/* ------------------------------------------------------------------ */
/* Vérification                                                        */
/* ------------------------------------------------------------------ */

export type VerdictPOR =
  | { valide: true; mode: "empreinte_exacte" | "coherence_spectrale"; coherence: number }
  | { valide: false; raison: "empreinte" | "spectre" | "metriques" | "grille" | "expire"; coherence: number };

/**
 * Vérifie une réponse à un défi en la comparant à une référence LOCALE
 * (le vérificateur a lui-même exécuté le défi) :
 *
 *  - empreinte EXACTE → preuve valide (moteur identique) ;
 *  - sinon cohérence spectrale ≥ seuil ET métriques proches → preuve
 *    valide (moteur différent — WebGPU vs CPU — dérive flottante
 *    absorbée par la quantification) ;
 *  - sinon REJET : le nœud n'a pas réellement propagé l'onde.
 */
export function verifierReponseDefi(
  declaree: EmpreinteSpectrale,
  reference: EmpreinteSpectrale,
): VerdictPOR {
  if (declaree.cellules !== reference.cellules) {
    return { valide: false, raison: "grille", coherence: 0 };
  }
  // LIAISON AU DÉFI — non négociable : une réponse au défi DOIT porter le
  // défi exact (sinon n'importe quel état de champ « passerait » le filtre
  // flou). Une empreinte qui « oublie » son défi est un rejet immédiat.
  if (reference.defi && declaree.defi !== reference.defi) {
    return { valide: false, raison: "empreinte", coherence: 0 };
  }
  const coherence = coherenceSpectrale(declaree, reference);
  if (declaree.empreinte === reference.empreinte) {
    return { valide: true, mode: "empreinte_exacte", coherence: 1 };
  }
  const energieOk =
    reference.energie === 0
      ? declaree.energie === 0
      : Math.abs(declaree.energie - reference.energie) / reference.energie <= TOLERANCE_METRIQUES;
  const ordreOk =
    reference.ordreR === 0
      ? declaree.ordreR === 0
      : Math.abs(declaree.ordreR - reference.ordreR) / reference.ordreR <= TOLERANCE_METRIQUES;
  if (!energieOk || !ordreOk) {
    return { valide: false, raison: "metriques", coherence };
  }
  if (coherence < SEUIL_COHERENCE_SPECTRALE) {
    return { valide: false, raison: "spectre", coherence };
  }
  return { valide: true, mode: "coherence_spectrale", coherence };
}

/* ------------------------------------------------------------------ */
/* Attestations de paquets (essaim P2P)                                */
/* ------------------------------------------------------------------ */

/** Réduit une empreinte complète en attestation compacte (paquet P2P). */
export function attestationPourPaquet(e: EmpreinteSpectrale): AttestationOnde {
  return { e: e.empreinte, s: e.spectre, g: e.energie, r: e.ordreR, c: e.cellules };
}

export type VerdictAttestation =
  | { valide: true; attestation: AttestationOnde }
  | { valide: false; raison: "format" | "plausibilite" };

/**
 * Contrôle d'intégrité d'une attestation reçue dans un paquet :
 * format (types, bornes) et plausibilité physique (une vraie onde
 * propagée a une énergie et un ordre de Kuramoto dans les gammes
 * réalistes du moteur — une invention éhontée non).
 *
 * C'est le premier filtre, gratuit, appliqué à CHAQUE paquet ; la
 * vérification complète (rejeu du défi) reste disponible pour les
 * sessions consensus (consensus-essaim.ts).
 */
export function verifierAttestation(attestation: unknown): VerdictAttestation {
  if (!attestation || typeof attestation !== "object") return { valide: false, raison: "format" };
  const a = attestation as Partial<AttestationOnde>;
  if (
    typeof a.e !== "string" ||
    !/^[0-9a-f]{16}$/.test(a.e) ||
    !Array.isArray(a.s) ||
    a.s.length !== LONGUEUR_SPECTRE ||
    a.s.some((x) => typeof x !== "number" || !Number.isFinite(x) || x < -1 || x > 1600) ||
    typeof a.g !== "number" ||
    !Number.isFinite(a.g) ||
    a.g < 0 ||
    a.g > 50 ||
    typeof a.r !== "number" ||
    !Number.isFinite(a.r) ||
    a.r < 0 ||
    a.r > 1.01 ||
    typeof a.c !== "number" ||
    !Number.isInteger(a.c) ||
    a.c < 64 ||
    a.c > 4 * 1024 * 1024
  ) {
    return { valide: false, raison: "format" };
  }
  // Plausibilité : énergie moyenne > 0 dès qu'un paquet transporte une
  // amplitude ; ordre de Kuramoto strictement positif pour un champ vivant.
  if (a.g <= 0 || a.r <= 0) return { valide: false, raison: "plausibilite" };
  return { valide: true, attestation: a as AttestationOnde };
}

/* ------------------------------------------------------------------ */
/* Vérificateur de session (défis courants, anti-rejeu)                */
/* ------------------------------------------------------------------ */

/**
 * VerificateurPor — tient les défis actifs d'une session d'essaim,
 * répond aux défis des voisins et vérifie les réponses entrantes.
 * Les défis sont à usage unique : une preuve rejouée est refusée.
 */
export class VerificateurPor {
  private defisRecus = new Map<string, DefiOndes>();
  private defisEmis = new Map<string, DefiOndes>();
  private reponsesVues = new Set<string>();

  /** Émet un défi à propager aux voisins. */
  emettreDefi(emetteur: string, aleatoire: () => number = Math.random): DefiOndes {
    const defi = creerDefi(emetteur, aleatoire);
    this.defisEmis.set(defi.defi, defi);
    return defi;
  }

  /** Enregistre un défi reçu d'un voisin et prépare sa réponse. */
  recevoirDefi(defi: DefiOndes): EmpreinteSpectrale | null {
    if (!defi?.defi || typeof defi.defi !== "string") return null;
    if (defi.echeance <= Date.now()) return null;
    if (this.defisRecus.has(defi.defi)) return null;
    this.defisRecus.set(defi.defi, defi);
    return executerDefi(defi.defi);
  }

  /**
   * Vérifie la réponse d'un nœud à un défi QUE NOUS AVONS ÉMIS :
   * rejeu local + comparaison + anti-rejeu (une preuve déjà vue est morte).
   */
  verifier(reponse: EmpreinteSpectrale): VerdictPOR {
    if (!reponse?.empreinte || !reponse.defi) {
      return { valide: false, raison: "empreinte", coherence: 0 };
    }
    const defi = this.defisEmis.get(reponse.defi);
    if (!defi) return { valide: false, raison: "empreinte", coherence: 0 };
    if (defi.echeance <= Date.now()) {
      this.defisEmis.delete(reponse.defi);
      return { valide: false, raison: "expire", coherence: 0 };
    }
    const cleReponse = `${reponse.defi}|${reponse.empreinte}`;
    if (this.reponsesVues.has(cleReponse)) {
      return { valide: false, raison: "expire", coherence: 0 };
    }
    this.reponsesVues.add(cleReponse);
    if (this.reponsesVues.size > 256) this.reponsesVues = new Set([...this.reponsesVues].slice(-128));
    const reference = executerDefi(reponse.defi);
    const verdict = verifierReponseDefi(reponse, reference);
    if (verdict.valide) this.defisEmis.delete(reponse.defi);
    return verdict;
  }

  /** Purge les défis expirés (à appeler périodiquement). */
  purger(maintenant = Date.now()): void {
    for (const [cle, defi] of this.defisRecus) if (defi.echeance <= maintenant) this.defisRecus.delete(cle);
    for (const [cle, defi] of this.defisEmis) if (defi.echeance <= maintenant) this.defisEmis.delete(cle);
  }

  get nbDefisActifs(): number {
    return this.defisRecus.size + this.defisEmis.size;
  }
}

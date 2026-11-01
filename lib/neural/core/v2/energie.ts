/**
 * ÉNERGIE GEN3 (it.73 — demande propriétaire : « cherche un moyen de
 * diminuer la consommation d'énergie de gen3 tout en gardant sa qualité
 * de réponse et son efficacité pour que gen3 puisse fonctionner même sur
 * un téléphone tout en gardant sa qualité de compétences »).
 *
 * TROIS PROFILS, UNE RÈGLE D'HONNÊTETÉ : le profil « plein » est le
 * comportement historique BIT À BIT (défaut — zéro régression possible) ;
 * « eco » et « telephone » ne font que des économies MESURÉES et
 * déclarées, jamais une dégradation silencieuse :
 *
 *  - PLEIN     : fenêtre neuronale complète (RPIA + 4 cycles + cortex v2),
 *                horloges f64, poids f32 — production par défaut ;
 *  - ECO       : le PONT VOCATION (lexical, pur, même qualité de réponse
 *                PAR CONSTRUCTION) court-circuite la fenêtre neuronale
 *                pour les questions du cadre — zéro RPIA, zéro cycle ;
 *                horloges compactes u32 (exact < 2^32, −8 Mo à 2^20) ;
 *  - TELEPHONE : comme eco pour le serveur, PLUS le moteur compact
 *                EMBARQUÉ (cortex-telephone.ts) : 2^17 colonnes, poids
 *                quantifiés u8 (erreur ≤ 1/510 par poids, mesurée),
 *                lecture seule — le SNN tourne DANS le navigateur du
 *                téléphone, zéro requête serveur par question.
 *
 * Module PUR — aucune dépendance Node, utilisable côté client.
 */

/** Profils d'énergie (défaut : plein — comportement historique exact). */
export type ProfilEnergie = "plein" | "eco" | "telephone";

/** Description déclarée de chaque profil (garde 42ᵉ). */
export interface DescriptionProfilEnergie {
  /** Fenêtre neuronale complète (RPIA + cycles) pour chaque tour ? */
  fenetreNeuronaleComplete: boolean;
  /** Le pont vocation court-circuite-t-il la fenêtre quand il répond ? */
  vocationDAabord: boolean;
  /** Horloges u32 (exact < 2^32) sur le cortex de production ? */
  horlogesCompactes: boolean;
  /** Phrase honnête pour les surfaces publiques. */
  description: string;
}

export const PROFILS_ENERGIE: Record<ProfilEnergie, DescriptionProfilEnergie> = {
  plein: {
    fenetreNeuronaleComplete: true,
    vocationDAabord: false,
    horlogesCompactes: false,
    description:
      "Profil historique complet — RPIA + 4 cycles du noyau + cortex v2 à chaque tour, horloges f64, poids f32. Aucune économie, aucune différence.",
  },
  eco: {
    fenetreNeuronaleComplete: false,
    vocationDAabord: true,
    horlogesCompactes: true,
    description:
      "Sobriété serveur — les questions du cadre d'apprentissage sont répondues par le pont vocation (lexical, même texte) SANS fenêtre neuronale : zéro RPIA, zéro cycle, horloges u32 exactes (−8 Mo à 2^20).",
  },
  telephone: {
    fenetreNeuronaleComplete: false,
    vocationDAabord: true,
    horlogesCompactes: true,
    description:
      "Sobriété embarquée — comme eco côté serveur, PLUS le cortex compact (2^17 colonnes, poids u8, lecture seule) exécuté dans le navigateur du téléphone : zéro requête serveur par question après chargement du snapshot.",
  },
};

/** Variable d'environnement du profil. */
export const VAR_ENV_PROFIL_ENERGIE = "GEN3_PROFIL_ENERGIE";

/**
 * Lit le profil depuis l'environnement (défaut honnête : "plein" —
 * toute valeur inconnue retombe sur le comportement historique exact,
 * jamais sur une économie silencieuse).
 */
export function profilEnergieDepuisEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ProfilEnergie {
  const brut = env[VAR_ENV_PROFIL_ENERGIE]?.trim().toLowerCase();
  if (brut === "eco" || brut === "telephone") return brut;
  return "plein";
}

/** Échelle de quantification u8 (255 niveaux — erreur max 1/510 ≈ 0.00196). */
export const ECHELLE_QUANTISATION_U8 = 255;

/**
 * QUANTISATION U8 DES POIDS (it.73) : Float32Array → Uint8Array (×4 moins
 * de mémoire et d'octets déplacés). Poids bornés [0, 1] par construction
 * (init [0.1, 0.5], cap 1.0, plancher 0) — erreur maximale par poids
 * 1/(2×255). Le déquant passe VIT É sur le u8 (aucune copie f32 résidente).
 */
export function quantiserPoidsU8(poids: Float32Array): Uint8Array {
  const u8 = new Uint8Array(poids.length);
  for (let i = 0; i < poids.length; i++) {
    const v = poids[i] ?? 0;
    const borne = v < 0 ? 0 : v > 1 ? 1 : v;
    u8[i] = Math.round(borne * ECHELLE_QUANTISATION_U8);
  }
  return u8;
}

/** Erreur maximale théorique d'un poids quantifié (1/510). */
export function erreurMaxQuantisation(): number {
  return 1 / (2 * ECHELLE_QUANTISATION_U8);
}

// ---------------------------------------------------------------------------
// SNAPSHOT TÉLÉPHONE — format binaire compact (poids u8) chargé par le
// navigateur. Petit, autosuffisant, auto-validé (magie + version + longueur).
// ---------------------------------------------------------------------------

/** Magie ASCII du snapshot (8 octets, complétée par un 0). */
export const MAGIE_SNAPSHOT_TELEPHONE = "G3TEL73";
/** Version du format (évolution future = +1, lecture refusée si ≠). */
export const VERSION_SNAPSHOT_TELEPHONE = 1;

/** En-tête du snapshot (entiers u32, flottants f32, little-endian). */
export interface EnteteSnapshotTelephone {
  colonnes: number;
  voisins: number;
  bandes: number;
  bandesLecture: number;
  seed: number;
  seuil: number;
  decroissance: number;
  plasticiteFenetre: number;
  /** Nombre d'arêtes (doit valoir colonnes × voisins — auto-cohérence). */
  aretes: number;
}

/** Taille fixe de l'en-tête : magie 8 + version 4 + 5×u32 + 3×f32 + aretes 4. */
export const TAILLE_ENTETE_SNAPSHOT = 8 + 4 + 5 * 4 + 3 * 4 + 4; // 48

/**
 * Sérialise un snapshot téléphone : [magie 8o][version u32][en-tête]
 * [poids u8 × aretes]. Le navigateur lit ce fichier UNE fois (cacheable),
 * puis répond localement.
 */
export function exporterSnapshotTelephone(
  entete: EnteteSnapshotTelephone,
  poidsU8: Uint8Array,
): Uint8Array {
  if (poidsU8.length !== entete.aretes) {
    throw new Error(
      `Snapshot : ${poidsU8.length} poids ≠ ${entete.aretes} arêtes déclarées.`,
    );
  }
  const total = TAILLE_ENTETE_SNAPSHOT + poidsU8.length;
  const tampon = new Uint8Array(total);
  const vue = new DataView(tampon.buffer);
  // Magie ASCII (7 caractères + 0).
  for (let i = 0; i < 7; i++) {
    tampon[i] = MAGIE_SNAPSHOT_TELEPHONE.charCodeAt(i);
  }
  tampon[7] = 0;
  vue.setUint32(8, VERSION_SNAPSHOT_TELEPHONE, true);
  vue.setUint32(12, entete.colonnes, true);
  vue.setUint32(16, entete.voisins, true);
  vue.setUint32(20, entete.bandes, true);
  vue.setUint32(24, entete.bandesLecture, true);
  vue.setUint32(28, entete.seed, true);
  vue.setFloat32(32, entete.seuil, true);
  vue.setFloat32(36, entete.decroissance, true);
  vue.setFloat32(40, entete.plasticiteFenetre, true);
  vue.setUint32(44, entete.aretes, true);
  tampon.set(poidsU8, TAILLE_ENTETE_SNAPSHOT);
  return tampon;
}

/**
 * Lit et VALIDE un snapshot : magie, version, auto-cohérence aretes =
 * colonnes × voisins, longueur exacte. Toute anomalie → exception honnête
 * (jamais un cortex silencieusement corrompu).
 */
export function importerSnapshotTelephone(bytes: Uint8Array): {
  entete: EnteteSnapshotTelephone;
  poidsU8: Uint8Array;
} {
  if (bytes.length < TAILLE_ENTETE_SNAPSHOT) {
    throw new Error("Snapshot téléphone tronqué (< en-tête).");
  }
  const vue = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 7; i++) {
    if (bytes[i] !== MAGIE_SNAPSHOT_TELEPHONE.charCodeAt(i)) {
      throw new Error("Snapshot téléphone : magie invalide (pas G3TEL73).");
    }
  }
  const version = vue.getUint32(8, true);
  if (version !== VERSION_SNAPSHOT_TELEPHONE) {
    throw new Error(`Snapshot téléphone : version ${version} non supportée.`);
  }
  const entete: EnteteSnapshotTelephone = {
    colonnes: vue.getUint32(12, true),
    voisins: vue.getUint32(16, true),
    bandes: vue.getUint32(20, true),
    bandesLecture: vue.getUint32(24, true),
    seed: vue.getUint32(28, true),
    seuil: vue.getFloat32(32, true),
    decroissance: vue.getFloat32(36, true),
    plasticiteFenetre: vue.getFloat32(40, true),
    aretes: vue.getUint32(44, true),
  };
  if (entete.aretes !== entete.colonnes * entete.voisins) {
    throw new Error(
      `Snapshot téléphone incohérent : ${entete.aretes} arêtes ≠ ${entete.colonnes}×${entete.voisins}.`,
    );
  }
  if (bytes.length !== TAILLE_ENTETE_SNAPSHOT + entete.aretes) {
    throw new Error(
      `Snapshot téléphone : ${bytes.length} octets ≠ ${TAILLE_ENTETE_SNAPSHOT + entete.aretes} attendus.`,
    );
  }
  return {
    entete,
    poidsU8: bytes.slice(TAILLE_ENTETE_SNAPSHOT),
  };
}

// ---------------------------------------------------------------------------
// ESTIMATION MÉMOIRE (re-dérivable — la garde 42ᵉ verrouille les formules)
// ---------------------------------------------------------------------------

/** Paramètres mémoire d'un cortex (production, éco ou embarqué). */
export interface ParamsMemoireCortex {
  colonnes: number;
  voisins: number;
  /** Horloges u32 (compactes) au lieu de f64 ? */
  horlogesCompactes?: boolean;
  /** Poids u8 (moteur embarqué) au lieu de f32 ? Implique l'horloge de
   *  dernier spike ABSENTE (lecture seule — la plasticité qui la lirait
   *  n'écrit jamais). */
  poidsU8?: boolean;
}

/**
 * Mémoire résidente EXACTE en octets (même layout que les typed arrays
 * réels) :
 *  - par colonne : énergies f32 (4) + dernierSpike (f64 8 | u32 4 | ABSENT
 *    pour le moteur embarqué) + dernierTouche (8 | 4) + flagSpike u8 (1) +
 *    enFile u8 (1) ;
 *  - offsets CSR : (colonnes + 1) × 4 (la borne finale est stockée) ;
 *  - par arête : cible u32 (4) + poids (f32 4 | u8 1).
 */
export function estimerMemoireCortexOctets(params: ParamsMemoireCortex): number {
  const compactes = params.horlogesCompactes === true;
  const embarque = params.poidsU8 === true;
  const horlogeSpike = embarque ? 0 : compactes ? 4 : 8;
  const horlogeTouche = compactes || embarque ? 4 : 8;
  const parColonne = 4 + horlogeSpike + horlogeTouche + 1 + 1;
  const offsets = (params.colonnes + 1) * 4;
  const parArete = 4 + (embarque ? 1 : 4);
  return (
    params.colonnes * parColonne + offsets + params.colonnes * params.voisins * parArete
  );
}

// ---------------------------------------------------------------------------
// COMPTEUR D'ÉNERGIE — accumulation mesurée (jamais estimée)
// ---------------------------------------------------------------------------

/**
 * Compteur d'énergie d'une session (question unique ou série) : il somme
 * le métabolisme RÉEL des pas exécutés et déclare les fenêtres évitées
 * par le court-circuit éco. Chaque champ est une somme d'entiers mesurés.
 */
export class CompteurEnergie {
  /** Fenêtres neuronales exécutées (RPIA + cycles). */
  fenetresExecutees = 0;
  /** Fenêtres évitées par le court-circuit du pont (eco/telephone). */
  fenetresEvitees = 0;
  /** Époques RPIA évitées (12 par fenêtre évitée — EPOQUES_RPIA_CHAT). */
  epoquesRPIAEvitees = 0;
  /** Cycles du noyau évités (4 par fenêtre évitée). */
  cyclesNoyauEvites = 0;
  /** Colonnes réellement évaluées (somme des métabolismes). */
  evaluees = 0;
  /** Colonnes restées au repos (coût zéro). */
  reposes = 0;
  /** Spikes émis. */
  spikes = 0;
  /** Transmissions CSR réelles. */
  transmissions = 0;
  /** Temps réel cumulé des pas (ms, performance.now). */
  ms = 0;

  /** Enregistre le métabolisme d'un pas columnnaire réel. */
  enregistrerPas(m: { evaluees: number; reposes: number; transmissions: number; ms: number }, spikes: number): void {
    this.fenetresExecutees += 1;
    this.evaluees += m.evaluees;
    this.reposes += m.reposes;
    this.spikes += spikes;
    this.transmissions += m.transmissions;
    this.ms += m.ms;
  }

  /** Enregistre une fenêtre évitée par le court-circuit éco. */
  enregistrerFenetreEvitee(epoquesRPIA: number, cyclesNoyau: number): void {
    this.fenetresEvitees += 1;
    this.epoquesRPIAEvitees += epoquesRPIA;
    this.cyclesNoyauEvites += cyclesNoyau;
  }

  /** Rapport honnête (chiffres mesurés, jamais arrondis au maquillage). */
  rapport(): {
    fenetresExecutees: number;
    fenetresEvitees: number;
    epoquesRPIAEvitees: number;
    cyclesNoyauEvites: number;
    evaluees: number;
    reposes: number;
    spikes: number;
    transmissions: number;
    ms: number;
  } {
    return {
      fenetresExecutees: this.fenetresExecutees,
      fenetresEvitees: this.fenetresEvitees,
      epoquesRPIAEvitees: this.epoquesRPIAEvitees,
      cyclesNoyauEvites: this.cyclesNoyauEvites,
      evaluees: this.evaluees,
      reposes: this.reposes,
      spikes: this.spikes,
      transmissions: this.transmissions,
      ms: Math.round(this.ms * 1000) / 1000,
    };
  }
}

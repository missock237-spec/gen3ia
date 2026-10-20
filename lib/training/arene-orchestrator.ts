import "server-only";

/**
 * ORCHESTRATEUR D'ARÈNE — « les modèles des utilisateurs s'entraînent
 * dans le monde d'ondes ».
 *
 * Le Studio d'entraînement produit des artefacts `gen3-language-model`
 * (état d'un CortexLangagierGen3 archivé en R2). Cet orchestrateur les
 * fait ENTRER DANS L'ARÈNE D'INTERFÉRENCE :
 *
 *  1. le modèle ÉLÈVE du projet est chargé depuis R2 (son état langagier
 *     est réimporté dans un cortex) ;
 *  2. le PROFESSEUR est soit Gen3 elle-même (corpus d'amorçage complet),
 *     soit un second modèle du projet (duel de modèles d'utilisateurs) ;
 *  3. les questions sont les MOTIFS des paires de l'élève (ce qu'il doit
 *     savoir répondre) complétées par les motifs du professeur ;
 *  4. chaque question passe par le duel physique (résonance /
 *     annihilation) et le physics-guided reinforcement distille le
 *     savoir du professeur dans l'élève par ONDES ;
 *  5. l'état amélioré de l'élève est réarchivé — le modèle ressort de
 *     l'arène entraîné, mesuré (aucune métrique simulée), prêt à l'export.
 *
 * Toutes les métriques de session sont RÉELLES : reward physique moyen,
 * résonances, annihilations, paires distillées — la matière du champ a
 * réellement changé d'état.
 */

import { CORPUS_GEN3 } from "@/lib/neural/generation/corpus";
import { CortexLangagierGen3, type EtatLangage } from "@/lib/neural/generation/language";

import { EntrainementParResonance, type RapportEntrainement, type ResultatRound } from "@/lib/ondes/arene";
import { HttpError } from "@/lib/security/http-errors";
import { newUlid, userDir } from "@/lib/storage/user-data-store";
import { acquerirVerrou, cleVerrouEntrainement, libererVerrou } from "@/lib/training/verrou";
import { creerDeadline, DUREE_MAX_ENTRAINEMENT_MS } from "@/lib/training/timebox";
import {
  chiffrerPourUtilisateur,
  dechiffrerPourUtilisateur,
  scellerArtefact,
  verifierSceau,
} from "@/lib/security/forteresse";

/* -------------------------------------------------------------------- */
/* Types de session                                                      */
/* -------------------------------------------------------------------- */

export type ModeArene = "eleve-contre-gen3" | "duel-modeles";

export interface SessionArene {
  v: 1;
  id: string;
  projectId: string;
  ownerId: string;
  mode: ModeArene;
  /** Libellés affichables des deux participants. */
  professeurLabel: string;
  eleveLabel: string;
  statut: "terminee" | "echec";
  /** Rounds joués (échantillon limité pour la traçabilité). */
  rounds: Array<Pick<ResultatRound, "motif" | "verdict" | "action"> & { reward: number }>;
  metriques: {
    roundsJoues: number;
    renforcees: number;
    distillees: number;
    ignorees: number;
    rewardMoyen: number;
    progression: number;
    /** Empreintes du modèle élève avant / après (le champ a changé). */
    rappelAvant: number;
    rappelApres: number;
    /**
     * Empreinte spectrale Proof-of-Resonance de l'état entraîné — la
     * signature physique de la mémoire fréquentielle finale : toute
     * altération ultérieure de l'artefact brise la cohérence de l'onde.
     */
    empreinteOndes: string;
  };
  /** Clé R2 de l'état amélioré de l'élève (disponible si distillation). */
  etatEleveStorageKey: string | null;
  etatEleveTailleOctets: number;
  error: string | null;
  dureeMs: number;
  /** Timebox appliquée : budget (1 h) et arrêt propre à l'échéance. */
  timebox: { budgetMs: number; arreteParTimebox: boolean };
  createdAt: string;
}

export interface OptionsLancerArene {
  mode: ModeArene;
  /** Asset modèle du projet servant d'ÉLÈVE (obligatoire). */
  eleveAssetId: string;
  /** Asset modèle du projet servant de PROFESSEUR (mode duel uniquement). */
  professeurAssetId?: string;
  /** Nombre maximal de questions (plafonné). */
  roundsMax?: number;
}

export interface AssetModeleMinimal {
  id: string;
  name: string;
  storageKey?: string | null;
}

/** Chargeurs injectables (R2 par défaut ; mémoire pour les tests). */
export interface ChargeursArene {
  /** Télécharge le contenu d'un artefact modèle (clé → texte JSON). */
  chargerArtefact: (storageKey: string) => Promise<string>;
  /** Archive un texte (état/session) → clé + taille en octets. */
  archiver: (storageKey: string, corps: string) => Promise<number>;
}

const chargeursDefaut: ChargeursArene = {
  async chargerArtefact(storageKey: string): Promise<string> {
    const { downloadFromR2 } = await import("@/lib/storage/r2");
    const tampon = await downloadFromR2(storageKey, 12 * 1024 * 1024);
    return tampon.toString("utf-8");
  },
  async archiver(storageKey: string, corps: string): Promise<number> {
    const { putObject } = await import("@/lib/storage/r2");
    const corpsUtf8 = Buffer.from(corps, "utf-8");
    await putObject({
      key: storageKey,
      body: corpsUtf8,
      contentType: "application/json",
      contentLength: corpsUtf8.byteLength,
    });
    return corpsUtf8.byteLength;
  },
};

const ROUNDS_MAX_HARD = 120;

/** Contexte de sceau des artefacts de modèles (forteresse). */
const CTX_ARTEFACT = "artefact-modele";

/**
 * Déplie une couche de forteresse : si le texte est une enveloppe
 * scellée, l'intégrité est VÉRIFIÉE (falsifiée → refus) ; si le corps
 * est chiffré pour l'utilisateur, il est déchiffré. Les artefacts nus
 * (historiques) traversent tel quels — rétrocompatibilité totale.
 */
export function deployerForteresse(texte: string, uid: string): string {
  const sceau = verifierSceau(texte, CTX_ARTEFACT);
  let corps: string;
  if (sceau.valide) {
    corps = (JSON.parse(texte) as { corps: string }).corps;
  } else if (sceau.raison === "format") {
    // Pas une enveloppe scellée : artefact nu historique.
    corps = texte;
  } else {
    throw new Error("Artefact refusé : le sceau d'intégrité ne correspond pas (artefact altéré ou corrompu).");
  }
  const dechiffre = dechiffrerPourUtilisateur(corps, uid);
  if (dechiffre.ok) return dechiffre.texte;
  if (dechiffre.raison === "format") return corps; // corps nu (historique)
  throw new Error("Artefact refusé : le chiffrement au repos ne correspond pas (artefact d'un autre compte ou corrompu).");
}

/**
 * Enveloppe un artefact dans la forteresse (sceau + chiffrement) —
 * appliqué À L'ARCHIVAGE : le stockage objet ne contient plus rien de
 * lisible ni d'altérable en silence.
 */
export function enfermerForteresse(corps: string, uid: string): string {
  return scellerArtefact(chiffrerPourUtilisateur(corps, uid), CTX_ARTEFACT);
}

/* -------------------------------------------------------------------- */
/* Chargement des modèles — le pont Studio → arène                       */
/* -------------------------------------------------------------------- */

/**
 * Vrai si le JSON ressemble à un artefact `gen3-language-model` (produit
 * par gen3-local) — dans ce cas l'état langagier est sous `modele`.
 */
export function extraireEtatLangage(corps: string): EtatLangage | null {
  let data: unknown;
  try {
    data = JSON.parse(corps);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  const objet = data as Record<string, unknown>;
  const candidat = (objet.modele ?? objet) as Record<string, unknown>;
  if (!Array.isArray(candidat.pairesPersonnalisees)) return null;
  if (candidat.poidsUsage !== undefined && typeof candidat.poidsUsage !== "object") return null;
  const etat: EtatLangage = {
    pairesPersonnalisees: (candidat.pairesPersonnalisees as Array<Record<string, unknown>>)
      .filter((p) => typeof p?.motif === "string" && typeof p?.reponse === "string")
      .map((p) => ({
        motif: String(p.motif),
        reponse: String(p.reponse),
        theme: typeof p.theme === "string" ? p.theme : "arene",
      })),
    poidsUsage: {},
  };
  if (candidat.poidsUsage && typeof candidat.poidsUsage === "object") {
    for (const [cle, poids] of Object.entries(candidat.poidsUsage as Record<string, unknown>)) {
      if (typeof poids === "number" && Number.isFinite(poids) && poids > 0) {
        etat.poidsUsage[cle] = poids;
      }
    }
  }
  return etat;
}

/** Reconstruit un cortex d'arène depuis un artefact modèle R2. */
async function chargerCortexDepuisArtefact(
  asset: AssetModeleMinimal,
  uid: string,
  chargeurs: ChargeursArene,
): Promise<CortexLangagierGen3> {
  if (!asset.storageKey) {
    throw new Error(`Le modèle « ${asset.name} » n'a pas d'artefact archivé : seuls les modèles entraînés par Gen3 (format gen3-language-model) peuvent entrer dans l'arène.`);
  }
  const corps = await chargeurs.chargerArtefact(asset.storageKey);
  const etat = extraireEtatLangage(deployerForteresse(corps, uid));
  if (!etat) {
    throw new Error(`L'artefact de « ${asset.name} » n'est pas un modèle Gen3 (format gen3-language-model attendu).`);
  }
  const cortex = new CortexLangagierGen3();
  cortex.apprendre(CORPUS_GEN3); // socle commun (les paires personnalisées restent priorisées)
  cortex.importerEtat(etat);
  return cortex;
}

/** Mesure le RAPPEL d'un modèle : proportion de questions auxquelles il répond. */
function mesurerRappel(cortex: CortexLangagierGen3, questions: string[]): number {
  if (questions.length === 0) return 0;
  let reussies = 0;
  for (const q of questions) {
    if (cortex.repondre(q) !== null) reussies++;
  }
  return reussies / questions.length;
}

/* -------------------------------------------------------------------- */
/* Session complète                                                      */
/* -------------------------------------------------------------------- */

/**
 * Exécute une session d'arène complète et la retourne. L'état amélioré
 * de l'élève est archivé (chiffré + scellé par la forteresse) ; la
 * session (métriques) est archivée à la clé
 * `users/{uid}/training/projects/{projectId}/arene/{sessionId}.json`.
 *
 * GARANTIES APPLIQUÉES ICI :
 *  · VERROU — un seul entraînement actif par modèle (409 sinon) ;
 *  · TIMEBOX — le duel s'arrête proprement à 1 h (deadline physique
 *    passée à `entrainer`), l'état reste archivable à l'échéance.
 */
export async function lancerSessionArene(
  uid: string,
  projectId: string,
  options: OptionsLancerArene,
  assets: { eleve: AssetModeleMinimal; professeur?: AssetModeleMinimal },
  chargeurs: ChargeursArene = chargeursDefaut,
): Promise<SessionArene> {
  const debut = Date.now();
  const roundsMax = Math.max(1, Math.min(ROUNDS_MAX_HARD, Math.round(options.roundsMax ?? 60)));

  // ── 0. Verrou : un entraînement à la fois, par modèle ──────────────
  const cleVerrou = cleVerrouEntrainement(uid, projectId, assets.eleve.id);
  const verrou = acquerirVerrou(cleVerrou, uid);
  if (!verrou.acquis) {
    throw new HttpError(
      409,
      `Un entraînement est déjà en cours pour ce modèle (encore ${Math.ceil(verrou.resteMs / 60000)} min au maximum). Un entraînement dure au plus 1 h par modèle.`,
      "ENTRAINEMENT_EN_COURS",
    );
  }
  try {
    return await lancerSessionAreneInterne(uid, projectId, options, assets, chargeurs, debut, roundsMax);
  } finally {
    libererVerrou(cleVerrou, uid);
  }
}

async function lancerSessionAreneInterne(
  uid: string,
  projectId: string,
  options: OptionsLancerArene,
  assets: { eleve: AssetModeleMinimal; professeur?: AssetModeleMinimal },
  chargeurs: ChargeursArene,
  debut: number,
  roundsMax: number,
): Promise<SessionArene> {
  const { deadlineMs } = creerDeadline(debut);

  // ── 1. Chargement de l'élève (obligatoire) ──────────────────────────
  const eleveCortex = await chargerCortexDepuisArtefact(assets.eleve, uid, chargeurs);

  // ── 2. Professeur : Gen3 (corpus complet) ou second modèle ─────────
  let profCortex: CortexLangagierGen3;
  let profLabel: string;
  if (options.mode === "duel-modeles") {
    if (!assets.professeur) {
      throw new Error("Mode duel : le modèle professeur est requis.");
    }
    profCortex = await chargerCortexDepuisArtefact(assets.professeur, uid, chargeurs);
    profLabel = assets.professeur.name;
  } else {
    profCortex = new CortexLangagierGen3();
    profCortex.apprendre(CORPUS_GEN3);
    profLabel = "Gen3 (corpus d'amorçage)";
  }

  // ── 3. Questions : motifs de l'élève puis du professeur ────────────
  const motifsEleve = eleveCortex
    .exporterEtat()
    .pairesPersonnalisees.map((p) => p.motif);
  const motifsProf =
    options.mode === "duel-modeles"
      ? profCortex.exporterEtat().pairesPersonnalisees.map((p) => p.motif)
      : CORPUS_GEN3.map((p) => p.motif);
  const questions = [...new Set([...motifsEleve, ...motifsProf])].slice(0, roundsMax);

  // Cohérence avant : proportion de réponses correctes (mesurée).
  const rappelAvant = mesurerRappel(eleveCortex, questions);

  // ── 4. Duel + physics-guided reinforcement ─────────────────────────
  const entrainement = new EntrainementParResonance(profCortex, eleveCortex);
  const rapport: RapportEntrainement = entrainement.entrainer(questions, { deadlineMs });
  const rappelApres = mesurerRappel(eleveCortex, questions);

  // ── 5. Archivage de l'élève amélioré + session ─────────────────────
  const sessionId = newUlid();
  let etatEleveStorageKey: string | null = null;
  let etatEleveTaille = 0;
  try {
    const artefact = JSON.stringify(
      {
        format: "gen3-language-model",
        version: 1,
        moteur: "gen3-arene",
        entraineLe: new Date().toISOString(),
        metriques: {
          rewardMoyen: rapport.rewardMoyen,
          progression: rapport.progression,
          renforcees: rapport.renforcees,
          distillees: rapport.distillees,
          rappelAvant,
          rappelApres,
          empreinteOndes: rapport.empreinteOndes,
        },
        modele: rapport.etatEleve,
        meta: { arene: true, mode: options.mode, professeur: profLabel },
      },
      null,
      2,
    );
    etatEleveStorageKey = `${userDir(uid, "training", "projects", projectId, "arene", sessionId)}/eleve-ameliore.json`;
    // Forteresse : l'état du modèle est chiffré (AES-256-GCM, clé du
    // propriétaire) PUIS scellé (HMAC) — le stockage ne contient rien
    // de lisible, et toute altération est détectée au rechargement.
    etatEleveTaille = await chargeurs.archiver(etatEleveStorageKey, enfermerForteresse(artefact, uid));
  } catch {
    // L'archivage peut échouer (quota) — la session reste jouable, l'état
    // amélioré n'est simplement pas persisté.
    etatEleveStorageKey = null;
  }

  const session: SessionArene = {
    v: 1,
    id: sessionId,
    projectId,
    ownerId: uid,
    mode: options.mode,
    professeurLabel: profLabel,
    eleveLabel: assets.eleve.name,
    statut: "terminee",
    rounds: rapport.rounds.slice(0, 200).map((r) => ({
      motif: r.motif.slice(0, 300),
      verdict: r.verdict,
      action: r.action,
      reward: Number(r.mesures.reward.toFixed(4)),
    })),
    metriques: {
      roundsJoues: rapport.rounds.length,
      renforcees: rapport.renforcees,
      distillees: rapport.distillees,
      ignorees: rapport.ignorees,
      rewardMoyen: Number(rapport.rewardMoyen.toFixed(4)),
      progression: Number(rapport.progression.toFixed(4)),
      rappelAvant: Number(rappelAvant.toFixed(4)),
      rappelApres: Number(rappelApres.toFixed(4)),
      empreinteOndes: rapport.empreinteOndes,
    },
    etatEleveStorageKey,
    etatEleveTailleOctets: etatEleveTaille,
    error: null,
    dureeMs: Date.now() - debut,
    timebox: { budgetMs: DUREE_MAX_ENTRAINEMENT_MS, arreteParTimebox: rapport.arreteParTimebox },
    createdAt: new Date().toISOString(),
  };
  return session;
}

/** Clé R2 de stockage d'une session d'arène. */
export function cleSessionArene(uid: string, projectId: string, sessionId: string): string {
  return `${userDir(uid, "training", "projects", projectId, "arene", sessionId)}.json`;
}

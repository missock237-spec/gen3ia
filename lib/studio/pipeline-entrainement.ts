import "server-only";

import { writeJson, userKey, readJsonIfExists } from "@/lib/storage/user-data-store";

import {
  extraireUnitesConnaissance,
  fusionnerExtractions,
  htmlVersTexte,
  type OrigineRessource,
  type UniteConnaissance,
} from "./extraction-corpus";
import { evaluerCorpus, type RapportEvaluation } from "./evaluation";
import {
  ingererUnitesDansMemoireUtilisateur,
  cleMemoireDomaineUtilisateur,
  lireDocumentMemoireUtilisateur,
  memoireDepuisDocument,
} from "./memoire-utilisateur";
import {
  construireFichierFinal,
  lienDurableFichierFinal,
  nomFichierFinal,
  persisterFichierFinal,
} from "./fichier-final";

/**
 * PIPELINE D'ENTRAÎNEMENT RÉEL DU STUDIO (demande propriétaire : « gen3 doit
 * RÉELLEMENT entraîner l'IA de l'utilisateur sur un domaine choisi et livrer
 * le FICHIER FINAL »).
 *
 * DÉROULÉ (chaque étape produit des données mesurées, aucune simulée) :
 *   1. EXTRACTION — chaque ressource (texte collé, dataset du projet, page
 *      URL) est découpée en unités de connaissance Q/A + faits + code
 *      (lib/studio/extraction-corpus.ts) ;
 *   2. BASELINE — l'état ANTÉRIEUR de la mémoire de domaine du compte est
 *      chargé ; les questions du domaine (générées depuis les unités) sont
 *      posées à la mécanique de consultation SANS les nouvelles unités ;
 *   3. INGESTION PERSISTÉE — les unités sont ingérées dans la mémoire de
 *      domaine PAR UTILISATEUR (plafonds honnêtes, dédup, écriture R2) ;
 *   4. MESURE APRÈS — les MÊMES questions sont posées à la mémoire rechargée
 *      depuis la persistance (exactement ce que le cerveau consulte à la
 *      réponse) ; le score APRÈS doit dépasser le score AVANT ;
 *   5. NON-RÉGRESSION — les questions de contrôle hors domaine doivent
 *      rester NON servies après ingestion ;
 *   6. LIVRAISON — le fichier final `gen3iac-entrainement-<projet>.json`
 *      (identité, domaine, corpus, métriques avant/après, SHA-256 du pack,
 *      date, version) est écrit dans l'ESPACE PERMANENT du compte et servi
 *      par le lien durable canonique.
 *
 * Garde d'honnêteté : si l'ingestion n'améliore pas le score du domaine
 * (corpus vide, unités refusées, seuils non atteints), le pipeline ÉCHOUE —
 * jamais de rapport trompeur ni de livrable sans gain mesuré.
 */

// ─── ERREURS MÉTIER (codes pilotant le statut HTTP) ─────────────────────────

export type CodeErreurEntrainementStudio =
  | "ressources-manquantes"
  | "aucune-unite"
  | "aucun-gain-mesure"
  | "regression-hors-domaine";

export class ErreurEntrainementStudio extends Error {
  readonly code: CodeErreurEntrainementStudio;

  constructor(code: CodeErreurEntrainementStudio, message: string) {
    super(message);
    this.name = "ErreurEntrainementStudio";
    this.code = code;
  }
}

// ─── RAPPORT ─────────────────────────────────────────────────────────────────

/** Étiquette d'origine d'une ressource du rapport. */
export interface RessourceRapport {
  readonly titre: string;
  readonly origine: OrigineRessource;
  readonly elements: number;
  readonly ignores: number;
  readonly unites: number;
  readonly avertissements: readonly string[];
}

/** Rapport complet d'un entraînement du Studio (forme persistée). */
export interface RapportEntrainementStudio {
  readonly v: 1;
  readonly projetId: string;
  readonly projetNom: string;
  readonly domaine: string;
  readonly lanceLe: string;
  readonly ressources: readonly RessourceRapport[];
  readonly corpus: {
    readonly unites: number;
    readonly parType: Record<string, number>;
    readonly octets: number;
    readonly elements: number;
    readonly ignores: number;
    readonly doublons: number;
  };
  readonly evaluation: RapportEvaluation;
  readonly memoire: {
    readonly cleStockage: string;
    readonly unitesAjoutees: number;
    readonly doublons: number;
    readonly refuseesCap: number;
    readonly totalUnites: number;
    readonly octetsUnites: number;
  };
  readonly fichierFinal: {
    readonly nom: string;
    readonly cle: string;
    readonly taille: number;
    readonly lienDurable: string | null;
    readonly packSha256: string;
  };
}

/** Clé du rapport d'entraînement d'un projet (dernier état). */
function cleRapportEntrainement(uid: string, projetId: string): string {
  return userKey(uid, "studio", "entrainement", projetId);
}

/** Lit le DERNIER rapport d'entraînement d'un projet (null si jamais lancé). */
export async function lireRapportEntrainement(
  uid: string,
  projetId: string,
): Promise<RapportEntrainementStudio | null> {
  const doc = await readJsonIfExists<RapportEntrainementStudio>(
    cleRapportEntrainement(uid, projetId),
  );
  return doc && doc.v === 1 ? doc : null;
}

// ─── RESSOURCE URL (téléchargement réel, borné, anti-SSRF) ───────────────────

/** Plafond de téléchargement d'une page URL (octets). */
export const MAX_OCTETS_URL = 1024 * 1024;
/** Délai maximal de téléchargement d'une page URL (ms). */
export const DELAI_URL_MS = 10_000;

/** Télécharge une page web publique et retourne son texte extrait.
 * SSRF : URL publique vérifiée (assertPublicHttpUrl) avant toute connexion. */
export async function telechargerRessourceUrl(urlBrute: string): Promise<{ titre: string; contenu: string }> {
  const { assertPublicHttpUrl } = await import("@/lib/security/url-safety");
  const url = await assertPublicHttpUrl(urlBrute);
  const controle = new AbortController();
  const minuteur = setTimeout(() => controle.abort(), DELAI_URL_MS);
  try {
    const reponse = await fetch(url, {
      signal: controle.signal,
      redirect: "follow",
      headers: { "user-agent": "Gen3ia-Studio-Entrainement/1.0 (+https://gen3ia.online)" },
    });
    if (!reponse.ok) {
      throw new ErreurEntrainementStudio(
        "ressources-manquantes",
        `URL ${url.host} a répondu ${reponse.status} — ressource ignorée.`,
      );
    }
    const typeBrut = reponse.headers.get("content-type") ?? "";
    const tampon = await reponse.arrayBuffer();
    if (tampon.byteLength > MAX_OCTETS_URL) {
      throw new ErreurEntrainementStudio(
        "ressources-manquantes",
        `URL ${url.host} dépasse le plafond ${Math.round(MAX_OCTETS_URL / 1024)} Ko — ressource ignorée.`,
      );
    }
    const brut = new TextDecoder("utf-8").decode(tampon);
    const contenu = typeBrut.includes("html") ? htmlVersTexte(brut) : brut;
    const titre = `URL ${url.host}${url.pathname.slice(0, 60)}`;
    return { titre, contenu };
  } finally {
    clearTimeout(minuteur);
  }
}

// ─── PIPELINE ────────────────────────────────────────────────────────────────

/** Ressource chargée prête à l'extraction (texte déjà en mémoire). */
export interface RessourceChargee {
  readonly titre: string;
  readonly contenu: string;
  readonly origine: OrigineRessource;
}

/** Résultat complet d'un entraînement exécuté. */
export interface ResultatEntrainementStudio {
  readonly rapport: RapportEntrainementStudio;
  readonly fichier: {
    readonly nom: string;
    readonly cle: string;
    readonly taille: number;
    readonly lienDurable: string | null;
  };
}

/**
 * Exécute le pipeline complet pour un projet (voir le déroulé ci-dessus).
 * `ressources` doit être CHARGÉ (textes collés, contenus de datasets lus,
 * pages URL téléchargées) — le chargement I/O est du ressort de la route.
 */
export async function executerEntrainementStudio(
  uid: string,
  params: {
    projet: { id: string; nom: string };
    domaine: string;
    ressources: readonly RessourceChargee[];
  },
): Promise<ResultatEntrainementStudio> {
  const { projet, domaine } = params;
  const ressources = params.ressources.filter((r) => r.contenu.trim().length > 0);
  if (ressources.length === 0) {
    throw new ErreurEntrainementStudio(
      "ressources-manquantes",
      "Aucune ressource exploitable : fournissez au moins un texte, un dataset ou une URL.",
    );
  }

  // 1. EXTRACTION (déterministe, compteurs honnêtes par ressource).
  const extractions = ressources.map((r) => ({
    ressource: r,
    resultat: extraireUnitesConnaissance({ titre: r.titre, contenu: r.contenu, origine: r.origine }),
  }));
  const fusion = fusionnerExtractions(extractions.map((e) => e.resultat));
  if (fusion.unites.length === 0) {
    throw new ErreurEntrainementStudio(
      "aucune-unite",
      `Aucune unité de connaissance extraite des ${ressources.length} ressource(s) : ${fusion.avertissements.slice(0, 4).join(" ")}`,
    );
  }

  // 2. BASELINE — mémoire ANTÉRIEURE du compte (vide au premier entraînement).
  const memoireAvant = memoireDepuisDocument(await lireDocumentMemoireUtilisateur(uid, domaine));

  // 3. INGESTION PERSISTÉE (plafonds honnêtes + écriture R2 + invalidation cache).
  const ingestion = await ingererUnitesDansMemoireUtilisateur(uid, domaine, fusion.unites);

  // 4. MÉMOIRE APRÈS = état RÉELLEMENT persisté (ce que le cerveau consulte).
  const memoireApres = memoireDepuisDocument(await lireDocumentMemoireUtilisateur(uid, domaine));

  // 5. MESURE AVANT/APRÈS (mêmes questions, même mécanique de consultation).
  const evaluation = evaluerCorpus({
    unites: fusion.unites,
    repondreAvant: (q) => memoireAvant.repondre(q)?.texte ?? null,
    repondreApres: (q) => memoireApres.repondre(q)?.texte ?? null,
  });

  // GARDES D'HONNÊTETÉ : gain mesurable sur le domaine, zéro débordement hors domaine.
  if (evaluation.apres.scoreGlobal <= evaluation.avant.scoreGlobal) {
    throw new ErreurEntrainementStudio(
      "aucun-gain-mesure",
      `Aucun gain mesurable sur le domaine (score ${evaluation.avant.scoreGlobal} → ${evaluation.apres.scoreGlobal}) : vérifiez que vos ressources portent bien ce domaine.`,
    );
  }
  if (evaluation.horsDomaine.regression) {
    throw new ErreurEntrainementStudio(
      "regression-hors-domaine",
      "Régression hors domaine détectée (questions de contrôle servies après ingestion) : entraînement refusé.",
    );
  }

  // 6. LIVRAISON — fichier final dans l'espace PERMANENT + lien durable.
  const cleMemoire = cleMemoireDomaineUtilisateur(uid, domaine);
  const contenuFichier = construireFichierFinal({
    projet,
    domaine,
    unites: fusion.unites,
    ressources: ressources.length,
    evaluation,
    cleStockageMemoire: cleMemoire,
    unitesPersistees: ingestion.totalUnites,
  });
  const nom = nomFichierFinal(projet.nom);
  const fichier = await persisterFichierFinal(uid, contenuFichier, nom);
  const lienDurable = lienDurableFichierFinal(fichier.cle);

  // Rapport persisté (petit : compteurs + métriques, jamais le pack entier).
  const rapport: RapportEntrainementStudio = {
    v: 1,
    projetId: projet.id,
    projetNom: projet.nom,
    domaine,
    lanceLe: contenuFichier.genereeLe,
    ressources: extractions.map((e) => ({
      titre: e.ressource.titre.slice(0, 180),
      origine: e.ressource.origine,
      elements: e.resultat.elements,
      ignores: e.resultat.ignores,
      unites: e.resultat.unites.length,
      avertissements: e.resultat.avertissements.slice(0, 12),
    })),
    corpus: {
      unites: fusion.unites.length,
      parType: parTypeDesUnites(fusion.unites),
      octets: fusion.unites.reduce((s, u) => s + u.octets, 0),
      elements: fusion.elements,
      ignores: fusion.ignores,
      doublons: fusion.doublons,
    },
    evaluation,
    memoire: {
      cleStockage: cleMemoire,
      unitesAjoutees: ingestion.unitesAjoutees,
      doublons: ingestion.doublons,
      refuseesCap: ingestion.refuseesCap,
      totalUnites: ingestion.totalUnites,
      octetsUnites: ingestion.octetsUnites,
    },
    fichierFinal: {
      nom,
      cle: fichier.cle,
      taille: fichier.taille,
      lienDurable,
      packSha256: contenuFichier.packSha256,
    },
  };
  await writeJson(cleRapportEntrainement(uid, projet.id), rapport);

  return {
    rapport,
    fichier: { nom, cle: fichier.cle, taille: fichier.taille, lienDurable },
  };
}

// ─── AIDES (en bas : lisibilité du déroulé) ──────────────────────────────────

function parTypeDesUnites(
  unites: readonly UniteConnaissance[],
): Record<string, number> {
  const parType: Record<string, number> = { qa: 0, fait: 0, code: 0 };
  for (const u of unites) parType[u.type] = (parType[u.type] ?? 0) + 1;
  return parType;
}

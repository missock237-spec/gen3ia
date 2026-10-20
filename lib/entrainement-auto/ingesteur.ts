import "server-only";

import type { PaireLangage } from "@/lib/neural/generation/corpus";
import {
  LABELS_INTENTION,
  labelText,
  type TrainingSample,
} from "@/lib/neural/training/dataset";
import { csvPreviewToRows, parseCsvPreview, selectFilesForImport } from "@/lib/training/hub/common";

import type { ClientHubAuto, DatasetChoisi } from "./types";
import type { PlafondsAuto } from "./plafonds";

/**
 * L'INGESTEUR — transforme des fichiers de hubs de datasets en matière
 * d'entraînement réelle pour Gen3 :
 *  - objectif « langage »   : paires { motif, réponse } pour le cortex
 *    langagier (même contrat que CORPUS_GEN3 / paires du Studio) ;
 *  - objectif « intention » : échantillons { text, label } pour l'entraîneur
 *    supervisé du SNN (étiquetage lexical déterministe labelText(), ou
 *    colonne label explicite si elle correspond aux labels connus).
 *
 * Formats réellement analysés : .jsonl, .json, .csv, .txt (connecteurs hub :
 * seuls ces formats sont marqués `downloadable`). Tous les plafonds sont
 * appliqués RÉELLEMENT (octets téléchargés, lignes analysées, paires et
 * échantillons extraits). Un fichier qui échoue ne bloque jamais le cycle :
 * l'erreur est consignée honnêtement dans le rapport.
 */

/** Champs candidats pour le motif (question / instruction / texte). */
const CHAMPS_MOTIF = [
  "question", "motif", "instruction", "prompt", "texte", "text", "input",
  "utterance", "phrase", "commande", "command", "query", "fr", "title",
] as const;

/** Champs candidats pour la réponse. */
const CHAMPS_REPONSE = [
  "reponse", "response", "answer", "reply", "output", "completion",
  "target", "label_text", "body", "solution",
] as const;

/** Champs candidats pour un label d'intention explicite. */
const CHAMPS_LABEL = ["label", "intent", "intention", "classe", "category", "category_intention"] as const;

const MOTIF_MAX = 280;
const REPONSE_MAX = 1200;
const TEXTE_MAX = 300;
const MOTIF_MIN = 8;
const REPONSE_MIN = 2;
const TEXTE_MIN = 12;

export interface ApportDataset {
  choix: DatasetChoisi;
  paires: PaireLangage[];
  echantillons: TrainingSample[];
  fichiersLus: number;
  lignesLues: number;
  lignesUtiles: number;
  octetsTelecharges: number;
  erreurs: string[];
}

/* ------------------------------------------------------------------ */
/* Nettoyage & détection de champs                                      */
/* ------------------------------------------------------------------ */

/** Nettoie une valeur texte : caractères de contrôle supprimés, espaces
 *  compressés, tronquée à `max`. @returns null si vide. */
export function nettoyerTexte(valeur: unknown, max: number): string | null {
  let texte: string;
  if (typeof valeur === "string") texte = valeur;
  else if (typeof valeur === "number" && Number.isFinite(valeur)) texte = String(valeur);
  else return null;
  const propre = texte
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return propre.length > 0 ? propre : null;
}

/**Premier champ non vide parmi la liste (valeurs nettoyées, bornées). */
export function detecterChamp(record: Record<string, unknown>, champs: readonly string[], max: number): string | null {
  for (const champ of champs) {
    const brut = record[champ];
    const nettoye = nettoyerTexte(brut, max);
    if (nettoye) return nettoye;
  }
  return null;
}

/** Clé de dédoublonnage d'une paire (mêmes mots triés = même motif). */
function cleMotif(motif: string): string {
  return motif.toLowerCase().split(/\s+/).sort().join(" ");
}

/** Convertit une ligne en paire conversationnelle (ou null si inutilisable). */
export function convertirPaire(record: Record<string, unknown>, theme: string): PaireLangage | null {
  const motif = detecterChamp(record, CHAMPS_MOTIF, MOTIF_MAX);
  const reponse = detecterChamp(record, CHAMPS_REPONSE, REPONSE_MAX);
  if (!motif || !reponse) return null;
  if (motif.length < MOTIF_MIN || reponse.length < REPONSE_MIN) return null;
  if (motif === reponse) return null;
  return { motif, reponse, theme };
}

/** Label explicite de la ligne si reconnu (sinon null → étiquetage lexical). */
function labelExplicite(record: Record<string, unknown>): string | null {
  for (const champ of CHAMPS_LABEL) {
    const brut = nettoyerTexte(record[champ], 60);
    if (!brut) continue;
    const haut = brut.toUpperCase().replace(/[\s-]+/g, "_");
    const reconnu = LABELS_INTENTION.find((label) => label === haut);
    if (reconnu) return reconnu;
  }
  return null;
}

/** Convertit une ligne en échantillon d'intention (ou null). */
export function convertirEchantillon(record: Record<string, unknown>): TrainingSample | null {
  let texte = detecterChamp(record, CHAMPS_MOTIF, TEXTE_MAX);
  if (!texte || texte.length < TEXTE_MIN) {
    // Repli honnête : n'importe quelle valeur texte assez longue de la ligne.
    texte = null;
    for (const valeur of Object.values(record)) {
      const candidat = nettoyerTexte(valeur, TEXTE_MAX);
      if (candidat && candidat.length >= TEXTE_MIN) {
        texte = candidat;
        break;
      }
    }
  }
  if (!texte || texte.length < TEXTE_MIN) return null;
  const label = labelExplicite(record) ?? labelText(texte);
  return { text: texte, label };
}

/* ------------------------------------------------------------------ */
/* Parsing par format                                                   */
/* ------------------------------------------------------------------ */

type LigneBrute = Record<string, unknown>;

/** Normalise un JSON parsed en liste de lignes-records (ou null). */
function normaliserJson(parse: unknown): LigneBrute[] | null {
  if (Array.isArray(parse)) {
    return parse.map((element) =>
      element !== null && typeof element === "object" && !Array.isArray(element)
        ? (element as LigneBrute)
        : { texte: element },
    );
  }
  if (parse !== null && typeof parse === "object") {
    const objet = parse as Record<string, unknown>;
    for (const cle of ["data", "rows", "records", "examples", "train", "instances", "items"]) {
      const valeur = objet[cle];
      if (Array.isArray(valeur)) return normaliserJson(valeur);
    }
    return [objet];
  }
  return null;
}

/** Parse le contenu d'un fichier hub selon son extension (tolérant :
 *  .json illisible → tentative JSONL ; JSONL vide → tentative CSV). */
export function lignesDepuisContenu(
  brut: string,
  nomFichier: string,
  maxLignes: number,
): { lignes: LigneBrute[]; avertissements: string[] } {
  const contenu = brut.replace(/^\uFEFF/, "");
  const nom = nomFichier.toLowerCase();
  const avertissements: string[] = [];

  if (nom.endsWith(".json")) {
    try {
      const lignes = normaliserJson(JSON.parse(contenu)) ?? [];
      return { lignes: lignes.slice(0, maxLignes), avertissements };
    } catch {
      avertissements.push(`${nomFichier} : JSON illisible, tentative JSONL.`);
    }
  }

  if (nom.endsWith(".jsonl") || avertissements.length > 0) {
    const lignes: LigneBrute[] = [];
    for (const ligne of contenu.split(/\r?\n/)) {
      if (lignes.length >= maxLignes) break;
      const propre = ligne.trim();
      if (!propre) continue;
      try {
        const parse: unknown = JSON.parse(propre);
        if (parse !== null && typeof parse === "object" && !Array.isArray(parse)) {
          lignes.push(parse as LigneBrute);
        } else if (Array.isArray(parse) && parse.length > 0) {
          lignes.push({ texte: parse[0] });
        }
      } catch {
        // Ligne corrompue : sautée, comptée comme lue (honnêteté du volume).
      }
    }
    if (lignes.length > 0 || nom.endsWith(".jsonl")) {
      return { lignes, avertissements };
    }
  }

  if (nom.endsWith(".csv")) {
    const apercu = parseCsvPreview(contenu, maxLignes);
    return { lignes: csvPreviewToRows(apercu).slice(0, maxLignes), avertissements };
  }

  if (nom.endsWith(".txt")) {
    const lignes = contenu
      .split(/\r?\n/)
      .filter((ligne) => ligne.trim().length > 0)
      .slice(0, maxLignes)
      .map((ligne) => ({ texte: ligne.trim() }));
    return { lignes, avertissements };
  }

  return { lignes: [], avertissements: [`${nomFichier} : format non analysé.`] };
}

/* ------------------------------------------------------------------ */
/* Ingestion d'un dataset                                               */
/* ------------------------------------------------------------------ */

/** Convertit les lignes selon l'objectif (avec repli honnête : un dataset
 *  « langage » sans réponses possibles (ex. .txt) nourrit les intentions). */
function convertirLignes(
  lignes: readonly LigneBrute[],
  choix: DatasetChoisi,
  plafonds: PlafondsAuto,
): { paires: PaireLangage[]; echantillons: TrainingSample[]; lignesUtiles: number } {
  const theme = `hub:${choix.provider}:${choix.titre}`.slice(0, 60);
  const paires: PaireLangage[] = [];
  const echantillons: TrainingSample[] = [];
  const clesVues = new Set<string>();

  if (choix.objectif === "langage") {
    for (const ligne of lignes) {
      const paire = convertirPaire(ligne, theme);
      if (!paire) continue;
      const cle = cleMotif(paire.motif);
      if (clesVues.has(cle)) continue;
      clesVues.add(cle);
      paires.push(paire);
      if (paires.length >= plafonds.maxPairesParDataset) break;
    }
    // Repli : aucun champ réponse détecté → matière d'intention quand même.
    if (paires.length === 0) {
      for (const ligne of lignes) {
        const echantillon = convertirEchantillon(ligne);
        if (echantillon) echantillons.push(echantillon);
        if (echantillons.length >= plafonds.maxEchantillonsParDataset) break;
      }
    }
  } else {
    for (const ligne of lignes) {
      const echantillon = convertirEchantillon(ligne);
      if (echantillon) echantillons.push(echantillon);
      if (echantillons.length >= plafonds.maxEchantillonsParDataset) break;
    }
  }

  return { paires, echantillons, lignesUtiles: paires.length + echantillons.length };
}

/**
 * Ingestion complète d'un dataset choisi : inspection → sélection des
 * fichiers (plafonds réutilisés de lib/training/hub) → téléchargement
 * décompté du budget → parsing → conversion. Ne lève JAMAIS pour un fichier
 * individuel : les erreurs de fichier sont consignées dans le rapport.
 * Les erreurs d'inspection (dataset indisponible, refermé…) remontent —
 * le cycle les consigne et passe au suivant.
 */
export async function ingesterDataset(
  choix: DatasetChoisi,
  client: ClientHubAuto,
  plafonds: PlafondsAuto,
  budgetOctets: number,
): Promise<ApportDataset> {
  const apport: ApportDataset = {
    choix,
    paires: [],
    echantillons: [],
    fichiersLus: 0,
    lignesLues: 0,
    lignesUtiles: 0,
    octetsTelecharges: 0,
    erreurs: [],
  };
  if (budgetOctets <= 0) {
    apport.erreurs.push("Budget de téléchargement du cycle épuisé.");
    return apport;
  }

  const detail = await client.inspecter(choix.provider, choix.ref);
  const selection = selectFilesForImport(
    { files: detail.files.map((f) => ({ ...f })) },
    {
      perFileBytes: Math.min(plafonds.parFichierOctets, budgetOctets),
      totalBytes: budgetOctets,
      maxFiles: 2,
    },
  );

  let budget = budgetOctets;
  for (const fichier of selection.selected) {
    if (budget <= 0) break;
    try {
      const plafondFichier = Math.min(plafonds.parFichierOctets, budget);
      const buffer = await client.telecharger(choix.provider, choix.ref, fichier.name, plafondFichier);
      budget -= buffer.length;
      apport.octetsTelecharges += buffer.length;
      apport.fichiersLus += 1;

      const brut = buffer.toString("utf8");
      const { lignes, avertissements } = lignesDepuisContenu(brut, fichier.name, plafonds.maxLignesParDataset);
      apport.erreurs.push(...avertissements);
      apport.lignesLues += lignes.length;

      const converti = convertirLignes(lignes, choix, plafonds);
      apport.paires.push(...converti.paires);
      apport.echantillons.push(...converti.echantillons);
      apport.lignesUtiles += converti.lignesUtiles;
    } catch (erreur: unknown) {
      const message = erreur instanceof Error ? erreur.message : String(erreur ?? "erreur inconnue");
      apport.erreurs.push(`${fichier.name} : ${message.slice(0, 200)}`);
    }
  }

  if (selection.selected.length === 0 && selection.skipped.length > 0) {
    apport.erreurs.push(
      `Aucun fichier ingérable : ${selection.skipped[0].name} — ${selection.skipped[0].reason}`,
    );
  }

  return apport;
}

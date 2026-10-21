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

/** Clés du tableau de tours de conversation (format chat des hubs). */
const CHAMPS_MESSAGES = ["messages", "conversations", "dialog", "dialogue", "chat", "turns"] as const;
const ROLES_UTILISATEUR = new Set(["user", "human", "question"]);
const ROLES_ASSISTANT = new Set(["assistant", "gpt", "bot", "ai", "answer"]);

/**
 * EXTRAIT LES PAIRES DES STRUCTURES DE CHAT MODERNES — la forme dominante
 * des datasets d'instructions/dialogue sur les hubs :
 *   { messages: [{role:"user",content:…},{role:"assistant",content:…},…] }
 *   { conversations: [{from:"human",value:…},{from:"gpt",value:…},…] }
 * Chaque enchaînement utilisateur → assistant devient une paire. @returns
 * un tableau vide si la ligne n'est pas une structure de chat.
 */
export function extrairePairesChat(record: Record<string, unknown>, theme: string): PaireLangage[] {
  for (const champ of CHAMPS_MESSAGES) {
    const tableau = record[champ];
    if (!Array.isArray(tableau) || tableau.length < 2) continue;
    const paires: PaireLangage[] = [];
    let dernierUtilisateur: string | null = null;
    for (const tour of tableau) {
      if (tour === null || typeof tour !== "object" || Array.isArray(tour)) continue;
      const entree = tour as Record<string, unknown>;
      const role = (nettoyerTexte(entree.role ?? entree.from ?? entree.speaker, 20) ?? "").toLowerCase();
      const contenu = nettoyerTexte(entree.content ?? entree.value ?? entree.text ?? entree.gpt, REPONSE_MAX);
      if (!contenu) continue;
      if (ROLES_UTILISATEUR.has(role)) {
        dernierUtilisateur = contenu;
      } else if (ROLES_ASSISTANT.has(role) && dernierUtilisateur) {
        if (dernierUtilisateur.length >= MOTIF_MIN && contenu.length >= REPONSE_MIN && dernierUtilisateur !== contenu) {
          paires.push({ motif: dernierUtilisateur, reponse: contenu, theme });
        }
        dernierUtilisateur = null;
      }
    }
    if (paires.length > 0) return paires;
  }
  return [];
}

/**
 * APLATIT LES CLÉS D'UN RECORD (minuscules) — les hubs mélangent les casses
 * (« Question », « Answer », « Prompt », « Response », « Output »…) et la
 * détection de champs doit les reconnaître toutes.
 */
export function aplatirCles(record: Record<string, unknown>): Record<string, unknown> {
  const aplati: Record<string, unknown> = {};
  for (const [cle, valeur] of Object.entries(record)) {
    aplati[cle.toLowerCase()] = valeur;
  }
  return aplati;
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

/**
 * RÉCUPÈRE les objets JSON COMPLETS d'un fragment tronqué (téléchargement
 * plafonné d'un tableau pretty-printed). Scanne en suivant la profondeur
 * d'accolades et l'état des chaînes — un objet coupé en fin de fragment est
 * ignoré, jamais converti à moitié. Commence au premier « [ » (tableau nu
 * ou encapsulé « {"data":[…] ») sinon au premier « { ».
 */
function extraireObjetsJsonPartiel(contenu: string, maxObjets: number): LigneBrute[] {
  const objets: LigneBrute[] = [];
  const iCrochet = contenu.indexOf("[");
  const iAccolade = contenu.indexOf("{");
  let debutScan = -1;
  if (iCrochet >= 0 && (iAccolade < 0 || iCrochet < iAccolade)) debutScan = iCrochet;
  else if (iAccolade >= 0) debutScan = iAccolade;
  if (debutScan < 0) return objets;

  let profondeur = 0;
  let dansChaine = false;
  let echappe = false;
  let debutObjet = -1;
  for (let i = debutScan; i < contenu.length && objets.length < maxObjets; i += 1) {
    const caractere = contenu[i];
    if (dansChaine) {
      if (echappe) echappe = false;
      else if (caractere === "\\") echappe = true;
      else if (caractere === '"') dansChaine = false;
      continue;
    }
    if (caractere === '"') {
      dansChaine = true;
      continue;
    }
    if (caractere === "{") {
      if (profondeur === 0) debutObjet = i;
      profondeur += 1;
    } else if (caractere === "}") {
      profondeur -= 1;
      if (profondeur === 0 && debutObjet >= 0) {
        try {
          const parse = JSON.parse(contenu.slice(debutObjet, i + 1)) as unknown;
          if (parse !== null && typeof parse === "object" && !Array.isArray(parse)) {
            objets.push(parse as LigneBrute);
          }
        } catch {
          // Objet corrompu : ignoré (honnêteté du volume).
        }
        debutObjet = -1;
      }
    }
  }
  return objets;
}

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
  // Les fichiers .gz sont DÉJÀ décompressés par le connecteur de
  // téléchargement — seul le suffixe doit être retiré pour détecter le
  // format réel (.jsonl.gz → jsonl, .csv.gz → csv…).
  const nom = nomFichier.toLowerCase().replace(/\.gz$/, "");
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
        // CAS FRÉQUENT : tranche PARTIELLE d'un .json tableau (téléchargement
        // plafonné) — chaque ligne se termine par une virgule traînante ; on
        // la retire et on retente UNE fois avant de déclarer la ligne morte.
        const reprise = propre.replace(/,\s*$/, "");
        if (reprise !== propre && reprise.length > 1) {
          try {
            const parse: unknown = JSON.parse(reprise);
            if (parse !== null && typeof parse === "object" && !Array.isArray(parse)) {
              lignes.push(parse as LigneBrute);
            } else if (Array.isArray(parse) && parse.length > 0) {
              lignes.push({ texte: parse[0] });
            }
          } catch {
            // Ligne réellement corrompue : ignorée (honnêteté du volume).
          }
        }
      }
    }
    if (lignes.length > 0 || nom.endsWith(".jsonl")) {
      return { lignes, avertissements };
    }

    // DERNIER REPLI .json — tableau pretty-printed TRONQUÉ (téléchargement
    // plafonné) : les éléments multi-lignes ne se laissent pas parser ligne
    // à ligne. Un scanneur à profondeur équilibrée extrait chaque objet
    // COMPLET du fragment — jamais un objet coupé.
    if (nom.endsWith(".json")) {
      const objets = extraireObjetsJsonPartiel(contenu, maxLignes);
      if (objets.length > 0) {
        avertissements.push(
          `${nomFichier} : fragment JSON partiel — ${objets.length} objet(s) complet(s) récupéré(s).`,
        );
        return { lignes: objets, avertissements };
      }
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
      // 1. Structures de chat modernes (messages/conversations…) — la forme
      //    dominante des datasets d'instructions des hubs.
      for (const paire of extrairePairesChat(ligne, theme)) {
        const cle = cleMotif(paire.motif);
        if (clesVues.has(cle)) continue;
        clesVues.add(cle);
        paires.push(paire);
        if (paires.length >= plafonds.maxPairesParDataset) break;
      }
      if (paires.length >= plafonds.maxPairesParDataset) break;
      // 2. Paires plates (question/answer, prompt/completion…) — clés
      //    aplaties en minuscules pour reconnaître toutes les casses.
      const paire = convertirPaire(aplatirCles(ligne), theme);
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
        const echantillon = convertirEchantillon(aplatirCles(ligne));
        if (echantillon) echantillons.push(echantillon);
        if (echantillons.length >= plafonds.maxEchantillonsParDataset) break;
      }
    }
  } else {
    for (const ligne of lignes) {
      const echantillon = convertirEchantillon(aplatirCles(ligne));
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
      // Le plafond PAR FICHIER est appliqué RÉELLEMENT au téléchargement
      // (mode partiel : premiers mégaoctets complets d'un grand fichier).
      // Ici, on ne ferme donc PAS la porte aux fichiers volumineux — c'est
      // ce qui permet d'exploiter les grands datasets des hubs.
      perFileBytes: budgetOctets,
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

  // REpli LIGNES HUB (datasets-server /rows chez HF) — quand aucun fichier
  // n'a donné de matière (datasets parquet-only, très majoritaires), l'API
  // de paging du hub fournit les lignes DÉJÀ CONVERTIES. Paging borné,
  // aucun téléchargement de fichier, budget d'octets intact.
  if (apport.paires.length === 0 && apport.echantillons.length === 0 && client.lireLignes) {
    try {
      const lignes = await client.lireLignes(choix.provider, choix.ref, plafonds.maxLignesParDataset);
      if (lignes.length > 0) {
        apport.lignesLues += lignes.length;
        const converti = convertirLignes(lignes, choix, plafonds);
        apport.paires.push(...converti.paires);
        apport.echantillons.push(...converti.echantillons);
        apport.lignesUtiles += converti.lignesUtiles;
        if (converti.paires.length > 0 || converti.echantillons.length > 0) {
          apport.erreurs.push(
            `${lignes.length} ligne(s) lues via l'API de paging du hub (aucun fichier ingérable — format parquet converti par le hub).`,
          );
        }
      }
    } catch (erreur: unknown) {
      const message = erreur instanceof Error ? erreur.message : String(erreur ?? "erreur inconnue");
      apport.erreurs.push(`paging du hub : ${message.slice(0, 200)}`);
    }
  }

  return apport;
}

import "server-only";

import type { DatasetChoisi, HubSource, ObjectifAuto } from "./types";

/**
 * LE CONSERVATEUR — décide QUELS datasets hubs alimenteront l'auto-
 * apprentissage. Deux objectifs équilibrés :
 *  - « langage »   : dialogues/questions-réponses → cortex langagier ;
 *  - « intention » : commandes/utterances → entraîneur supervisé SNN.
 *
 * La sélection est DÉTERMINISTE (même entrée → même sortie) : tri par
 * téléchargements décroissants puis référence alphabétique, anti-rejoue des
 * datasets déjà ingérés, équilibre des objectifs (rotation), plafonds
 * stricts. Aucune requête réseau ici — le conservateur ne fait que choisir.
 */

/** Requêtes de recherche par objectif et hub (FR + EN, 80 caractères max). */
export const REQUETES_OBJECTIF: Record<ObjectifAuto, Record<HubSource, string[]>> = {
  langage: {
    huggingface: [
      "french conversation dialogue",
      "french question answering",
      "instruction following dialogue",
      "assistant conversation pairs",
    ],
    kaggle: [
      "french conversation",
      "chatbot dialogue dataset",
      "customer support conversations",
    ],
  },
  intention: {
    huggingface: [
      "intent classification",
      "command classification dataset",
      "user utterance intent",
      "text classification commands",
    ],
    kaggle: [
      "intent classification",
      "chatbot intent dataset",
    ],
  },
};

/** Une recherche exécutée (résultats bruts du hub, déjà triés par le hub). */
export interface RechercheObjectif {
  objectif: ObjectifAuto;
  provider: HubSource;
  requete: string;
  resultats: Array<{
    ref: string;
    titre: string;
    downloads: number | null;
    taille: number | null;
  }>;
}

interface Candidat {
  provider: HubSource;
  ref: string;
  titre: string;
  objectif: ObjectifAuto;
  downloads: number;
}

/**
 * Choisit les datasets du cycle à partir des recherches exécutées.
 *
 * Règles :
 *  - anti-rejoue : les références de `dejaIngestes` (normalisées) sont écartées ;
 *  - dédoublonnage inter-requêtes (un dataset vu deux fois n'est pris qu'une fois) ;
 *  - équilibre : rotation langage ↔ intention, `maxParObjectif` par objectif ;
 *  - plafond global `maxDatasetsParCycle` ;
 *  - tri déterministe : téléchargements desc (null = 0) puis ref asc.
 */
export function choisirDatasets(
  recherches: readonly RechercheObjectif[],
  dejaIngestes: readonly string[],
  plafonds: { maxDatasetsParCycle: number; maxParObjectif: number },
): DatasetChoisi[] {
  const prisesAvant = new Set(dejaIngestes.map((ref) => ref.trim().toLowerCase()));

  // Files de candidats par objectif (tri déterministe, dédoublonnées).
  const files = new Map<ObjectifAuto, Candidat[]>();
  for (const recherche of recherches) {
    const file = files.get(recherche.objectif) ?? [];
    for (const resultat of recherche.resultats) {
      const ref = resultat.ref.trim();
      if (!ref) continue;
      if (prisesAvant.has(ref.toLowerCase())) continue;
      if (file.some((c) => c.ref.toLowerCase() === ref.toLowerCase())) continue;
      file.push({
        provider: recherche.provider,
        ref,
        titre: resultat.titre || ref,
        objectif: recherche.objectif,
        downloads: resultat.downloads ?? 0,
      });
    }
    file.sort((a, b) => (b.downloads - a.downloads) || a.ref.localeCompare(b.ref));
    files.set(recherche.objectif, file);
  }

  // Rotation équilibrée des objectifs.
  const ordre: ObjectifAuto[] = ["langage", "intention"];
  const compte: Record<ObjectifAuto, number> = { langage: 0, intention: 0 };
  const choisis: DatasetChoisi[] = [];

  while (choisis.length < plafonds.maxDatasetsParCycle) {
    let progres = false;
    for (const objectif of ordre) {
      if (choisis.length >= plafonds.maxDatasetsParCycle) break;
      if (compte[objectif] >= plafonds.maxParObjectif) continue;
      const file = files.get(objectif) ?? [];
      if (file.length === 0) continue;
      const candidat = file.shift();
      if (!candidat) continue;
      progres = true; // un candidat consommé : la file rétrécit (terminaison garantie)
      if (choisis.some((c) => c.ref.toLowerCase() === candidat.ref.toLowerCase())) continue;
      choisis.push({
        provider: candidat.provider,
        ref: candidat.ref,
        titre: candidat.titre,
        objectif: candidat.objectif,
      });
      compte[objectif] += 1;
    }
    if (!progres) break;
  }

  return choisis;
}

/**
 * Rotation de la requête de recherche selon le numéro de cycle : à chaque
 * cycle, la requête suivante du catalogue est essayée (couverture progressive
 * du catalogue sans paramètre d'état supplémentaire).
 */
export function requeteDuCycle(
  objectif: ObjectifAuto,
  provider: HubSource,
  numeroCycle: number,
): string {
  const requetes = REQUETES_OBJECTIF[objectif][provider];
  const index = ((numeroCycle % requetes.length) + requetes.length) % requetes.length;
  return requetes[index];
}

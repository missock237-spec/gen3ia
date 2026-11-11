/* ------------------------------------------------------------------ */
/* AGRÉGATEUR MULTI-MOTEURS — cœur du moteur de recherche gen3ia       */
/* ------------------------------------------------------------------ */
/* Interroge EN PARALLÈLE tous les moteurs actifs (SearXNG si configuré, */
/* DuckDuckGo, Bing, Wikipédia en repli encyclopédique), puis FUSIONNE : */
/*   - dédoublonnage URL + contenu (module verification/dedoublonnage) ; */
/*   - score de fusion : pertinence moteur (rang du résultat) +         */
/*     confirmations multi-moteurs (un lien trouvé par 2 moteurs monte) */
/*     + crédibilité du domaine.                                        */
/* Un moteur qui échoue est retiré du tour et son échec est DIT dans le */
/* diagnostic — jamais de résultat inventé.                             */

import { chercherBing } from "./bing";
import { chercherSearxng, urlSearxng } from "./searxng";
import { chercherWikipedia } from "./wikipedia";
import { chercherDuckDuckGo } from "./duckduckgo";
import { credibiliteDomaine } from "../verification/verification-sources";
import { dedoublonner } from "../verification/dedoublonnage";
import type { DiagnosticRecherche, ResultatRecherche, ResultatVerifie } from "../types";

/** Budget temps global d'un tour d'agrégation : l'utilisateur ne doit pas
 *  attendre plus que ça pour une recherche temps réel. */
const BUDGET_AGGREGATION_MS = 18_000;

interface SortieMoteur {
  moteur: string;
  resultats: ResultatRecherche[];
  erreur?: string;
}

/** Récupère avec course-contre-temps global : Promise.race sur un timeout. */
function avecBudget<T>(promesse: Promise<T>, ms: number, message: string): Promise<T> {
  let minuteur: ReturnType<typeof setTimeout>;
  const garde = new Promise<never>((_, rejeter) => {
    minuteur = setTimeout(() => rejeter(new Error(`${message} (budget ${ms} ms dépassé)`)), ms);
  });
  return Promise.race([promesse, garde]).finally(() => clearTimeout(minuteur));
}

/** Liste des moteurs ACTIFS pour ce tour, dans l'ordre de priorité. */
export function moteursActifs(): string[] {
  const actifs: string[] = [];
  if (urlSearxng()) actifs.push("searxng");
  actifs.push("duckduckgo", "bing");
  return actifs;
}

/** Lance un moteur individuel avec gestion d'échec propre. */
async function lancerMoteur(
  moteur: string,
  query: string,
  maxResults: number,
): Promise<SortieMoteur> {
  try {
    switch (moteur) {
      case "searxng":
        return { moteur, resultats: await chercherSearxng(query, maxResults) };
      case "duckduckgo":
        return { moteur, resultats: await chercherDuckDuckGo(query, maxResults) };
      case "bing":
        return { moteur, resultats: await chercherBing(query, maxResults) };
      case "wikipedia":
        return { moteur, resultats: await chercherWikipedia(query, maxResults) };
      default:
        return { moteur, resultats: [], erreur: `moteur inconnu : ${moteur}` };
    }
  } catch (erreur) {
    return {
      moteur,
      resultats: [],
      erreur: erreur instanceof Error ? erreur.message.slice(0, 160) : "échec inconnu",
    };
  }
}

/** Options de fusion d'un tour. */
export interface OptionsAgregation {
  /** Nombre de résultats DEMANDÉS par moteur (la fusion peut en renvoyer
   *  moins après dédoublonnage). */
  maxResults?: number;
  /** Inclure Wikipédia (repli encyclopédique) même si les moteurs web
   *  répondent ? Défaut : seulement si aucun moteur web ne répond. */
  wikipediaToujours?: boolean;
}

/** Agrège les moteurs en parallèle, fusionne, dédoublonne, score. */
export async function agregerMoteurs(
  query: string,
  options: OptionsAgregation = {},
): Promise<{ resultats: ResultatVerifie[]; diagnostic: DiagnosticRecherche }> {
  const maxResults = options.maxResults ?? 8;
  const moteurs = moteursActifs();
  const lances = moteurs.map((moteur) => lancerMoteur(moteur, query, maxResults));
  // Wikipédia en REPLI : lancé seulement si demandé explicitement (la
  // cascade du tool web.search décide après l'échec des moteurs web).
  if (options.wikipediaToujours) lances.push(lancerMoteur("wikipedia", query, maxResults));

  const sorties = await avecBudget(Promise.all(lances), BUDGET_AGGREGATION_MS, "agrégation multi-moteurs");

  const moteursOperatifs: string[] = [];
  const moteursEnEchec: Array<{ moteur: string; raison: string }> = [];
  let resultatsBruts = 0;
  const parMoteur: SortieMoteur[] = [];
  for (const sortie of sorties) {
    resultatsBruts += sortie.resultats.length;
    if (sortie.resultats.length > 0) {
      moteursOperatifs.push(sortie.moteur);
      parMoteur.push(sortie);
    } else {
      moteursEnEchec.push({ moteur: sortie.moteur, raison: sortie.erreur ?? "aucun résultat" });
    }
  }

  // Fusion : parcours moteur par moteur (ordre de priorité), chaque liste
  // est enrichie de son rang → le dédoublonnage garde la meilleure occurrence.
  const entrees = parMoteur.flatMap((sortie) =>
    sortie.resultats.map((resultat, rang) => ({
      valeur: resultat,
      url: resultat.url,
      extrait: resultat.extrait ?? resultat.titre,
      rang,
      moteur: sortie.moteur,
    })),
  );

  const { conserves, doublonsRetires } = dedoublonner(entrees);

  // Comptage des confirmations multi-moteurs : même URL canonique trouvée
  // par plusieurs moteurs → crédit de fiabilité.
  const confirmationsParUrl = new Map<string, Set<string>>();
  for (const entree of entrees) {
    const cle = entree.valeur.url;
    const ensemble = confirmationsParUrl.get(cle) ?? new Set<string>();
    ensemble.add(entree.moteur);
    confirmationsParUrl.set(cle, ensemble);
  }

  const resultats: ResultatVerifie[] = conserves.map((entree) => {
    const confirmations = Math.max(1, (confirmationsParUrl.get(entree.valeur.url)?.size ?? 1));
    const credibilite = credibiliteDomaine(entree.valeur.url);
    // Score : rang dans le moteur (0 = premier) + bonus multi-moteurs
    // + bonus crédibilité. Borné, commenté, calibré pour trier un top 10.
    const rang = entrees.find((e) => e === entree)?.rang ?? 9;
    const score = (10 - Math.min(rang, 9)) + confirmations * 2 + (credibilite === "elevée" ? 3 : credibilite === "moyenne" ? 1 : 0);
    return {
      ...entree.valeur,
      confirmations,
      urlCanonique: entree.url,
      credibilite,
      score,
    };
  });

  resultats.sort((a, b) => b.score - a.score);

  const diagnostic: DiagnosticRecherche = {
    moteursInterroges: moteurs,
    moteursOperatifs,
    moteursEnEchec,
    resultatsBruts,
    resultatsUniques: resultats.length,
    doublonsRetires,
  };

  return { resultats: resultats.slice(0, maxResults), diagnostic };
}

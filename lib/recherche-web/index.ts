/* ------------------------------------------------------------------ */
/* RECHERCHE WEB TEMPS RÉEL — API publique du module                   */
/* ------------------------------------------------------------------ */
/* Chaîne complète demandée par l'architecture propriétaire :           */
/*   1. moteurs en parallèle (SearXNG si configuré, DuckDuckGo, Bing)   */
/*      + Wikipédia en repli encyclopédique ;                           */
/*   2. fusion : dédoublonnage URL + contenu, confirmations             */
/*      multi-moteurs, crédibilité de domaine, validation des dates ;   */
/*   3. lecture réelle des N meilleures pages (Playwright/Chromium si   */
/*      disponible, sinon HTTP) avec extraction structurée ;            */
/*   4. sortie : résultats vérifiés + pages lues + diagnostic honnête   */
/*      (ce qui a marché, ce qui a échoué, combien de doublons retirés).*/
/* La SYNTHÈSE et les citations sont produites par le chat gen3ia qui   */
/* consomme ce bloc (voir lib/domain/conversations/recherche-temps-reel) */

import { agregerMoteurs, moteursActifs } from "./moteurs/agregateur";
import { chercherWikipedia } from "./moteurs/wikipedia";
import { lirePagePourRecherche } from "./extraction/navigation-playwright";
import { validerDatePublication } from "./verification/verification-sources";
import type { PageExtraite, ReponseRechercheWeb, ResultatVerifie } from "./types";

// RAPPORT UTILISATEUR (demande propriétaire « recherche sans sources ») :
// la sortie visible de la recherche web est un rapport détaillé et
// autonome — construit par le module pur lib/recherche-web/rapport.
export { construirRapportRecherche, evaluerFiabilite } from "./rapport";
export type { RapportRecherche, ResultatPourRapport, FiabiliteRapport } from "./rapport";

/** Budget de lecture des pages : la recherche reste réactive. */
const PAGES_LUES_MAX = 3;

/** Options de rechercheWebTempsReel. */
export interface OptionsRechercheWeb {
  maxResults?: number;
  /** Lire réellement le contenu des meilleures pages (défaut : true). */
  lirePages?: boolean;
  /** Forcer le repli Wikipédia même si les moteurs web répondent. */
  wikipediaToujours?: boolean;
}

/** Recherche web temps réel COMPLÈTE (moteurs + vérification + lecture). */
export async function rechercheWebTempsReel(
  query: string,
  options: OptionsRechercheWeb = {},
): Promise<ReponseRechercheWeb> {
  const maxResults = options.maxResults ?? 8;
  const lirePages = options.lirePages ?? true;

  // ÉTAPE 1 + 2 : agrégation multi-moteurs, fusion, dédoublonnage.
  const agregation = await agregerMoteurs(query, {
    maxResults,
    wikipediaToujours: options.wikipediaToujours,
  });

  let resultats = agregation.resultats;

  // Cascade d'honnêteté : si TOUS les moteurs web échouent, Wikipédia est
  // le dernier recours réel (source toujours disponible, sans clé).
  if (resultats.length === 0) {
    try {
      const repli = await chercherWikipedia(query, maxResults);
      resultats = repli.map((r) => ({
        ...r,
        confirmations: 1,
        urlCanonique: r.url,
        credibilite: "elevée" as const,
        score: 10,
      }));
    } catch {
      /* le diagnostic portera déjà les échecs des moteurs web */
    }
  }

  // Vérification des dates annoncées par les moteurs (format, cohérence).
  for (const resultat of resultats) {
    resultat.publieLe = validerDatePublication(resultat.publieLe) ?? resultat.publieLe;
  }

  const diagnostic = { ...agregation.diagnostic };

  // ÉTAPE 3 : lecture réelle des meilleures pages (fail-soft par page).
  let pages: Array<PageExtraite & { source: string }> | undefined;
  if (lirePages && resultats.length > 0) {
    pages = [];
    const urlsDejaLues = new Set<string>();
    for (const resultat of resultats.slice(0, PAGES_LUES_MAX)) {
      if (urlsDejaLues.has(resultat.urlCanonique)) continue;
      urlsDejaLues.add(resultat.urlCanonique);
      try {
        const page = await lirePagePourRecherche(resultat.url);
        // Vérification croisée : la date lue dans la page prime sur celle
        // du moteur (elle vient de la source elle-même).
        resultat.datePublication = validerDatePublication(page.datePublication) ?? resultat.publieLe;
        pages.push({ ...page, source: resultat.url });
      } catch {
        /* page illisible : fail-soft, les autres pages continuent */
      }
    }
    if (pages.length === 0) pages = undefined;
  }

  return { query, resultats, diagnostic, pages };
}

/** Bloc de contexte SOURCÉ numéroté pour le chat : chaque fait issu du
 *  web est citable [n], chaque source est réelle et vérifiée. */
export function blocContexteSource(reponse: ReponseRechercheWeb, maxCaracteres = 24_000): string {
  const lignes: string[] = [];
  lignes.push(
    `[RECHERCHE WEB TEMPS RÉEL gen3ia — résultats RÉELS obtenus à l'instant. Moteurs interrogés : ${reponse.diagnostic.moteursInterroges.join(", ")} ; moteurs ayant répondu : ${reponse.diagnostic.moteursOperatifs.join(", ") || "aucun"} ; ${reponse.diagnostic.resultatsUniques} source(s) unique(s) après dédoublonnage (${reponse.diagnostic.doublonsRetires} doublon(s) retiré(s)).]`,
  );
  for (const moteursEnEchec of reponse.diagnostic.moteursEnEchec) {
    lignes.push(`- ${moteursEnEchec.moteur} indisponible : ${moteursEnEchec.raison}`);
  }
  lignes.push("");
  reponse.resultats.forEach((resultat, index) => {
    const morceaux = [
      `[${index + 1}] ${resultat.titre}`,
      `URL : ${resultat.url}`,
      resultat.extrait ? `Extrait : ${resultat.extrait}` : "",
      resultat.datePublication ? `Publié : ${resultat.datePublication.slice(0, 10)}` : "",
      `Moteur(s) : ${resultat.moteur}${resultat.confirmations > 1 ? ` (confirmé par ${resultat.confirmations} moteurs)` : ""} — crédibilité ${resultat.credibilite}`,
    ].filter(Boolean);
    lignes.push(morceaux.join("\n"));
  });
  if (reponse.pages?.length) {
    lignes.push("");
    lignes.push("CONTENU RÉEL DES PAGES LUES :");
    reponse.pages.forEach((page) => {
      lignes.push(
        `Page « ${page.titre ?? page.url} » (méthode : ${page.methode}${page.datePublication ? `, publiée : ${page.datePublication.slice(0, 10)}` : ""}${page.auteur ? `, auteur : ${page.auteur}` : ""}) :\n${page.texte}`,
      );
    });
  }
  return lignes.join("\n").slice(0, maxCaracteres);
}

/** Liste plate des moteurs actifs (exposition pour l'API/UI). */
export function moteursRechercheActifs(): string[] {
  return moteursActifs();
}

export type { ReponseRechercheWeb, ResultatVerifie, PageExtraite };

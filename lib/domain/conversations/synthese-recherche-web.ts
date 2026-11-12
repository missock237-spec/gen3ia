/* ------------------------------------------------------------------ */
/* SYNTHÈSE RECHERCHE WEB — sortie de l'outil web.search → bloc pont   */
/* ------------------------------------------------------------------ */
/* Tour PLAN : quand une étape web.search réussit, la synthèse finale   */
/* doit appuyer la réponse sur les RÉSULTATS RÉELS du moteur de         */
/* recherche (vérification propriétaire 2026-11-11 : la synthèse        */
/* partait d'un prompt « plan/étapes/objectifs » sans contexte — le     */
/* moteur neuronal y reconnaissait la famille planification et livrait  */
/* une méthode générique, AUCUNE source).                               */
/*                                                                      */
/* Ce module est PUR : il met la sortie JSON de l'outil au format que   */
/* le pont connaissances (lib/neural/connaissances-pont) sait lire —    */
/* sources numérotées [n] titre + URL + Extrait — pour le CANAL INTERNE */
/* du moteur (la synthèse s'appuie sur les résultats réels). La sortie  */
/* UTILISATEUR du tool, elle, est un RAPPORT sans sources (voir         */
/* lib/recherche-web/rapport) : ce bloc n'est jamais affiché tel quel   */
/* et la réponse ne livre pas de liste automatique de sources.          */
/* Zéro invention : sans résultat réel, la fonction retourne une chaîne */
/* vide (pas de bloc).                                                  */

/** Une sortie réussie de l'outil web.search — nouveau contrat : rapport
 *  utilisateur + résultats bruts internes `__interne.resultats` (ancien
 *  champ `results` encore accepté pour tolérance de forme). */
export interface SortieRechercheWeb {
  /** RAPPORT utilisateur autonome (aucune URL, aucune liste de sources). */
  rapport?: string;
  results?: Array<{
    title?: string;
    url?: string;
    snippet?: string;
    publishedAt?: string;
    source?: string;
  }>;
  /** Résultats bruts réservés AU MOTEUR (nouveau contrat du tool). */
  __interne?: {
    resultats?: Array<{
      title?: string;
      url?: string;
      snippet?: string;
      publishedAt?: string;
      source?: string;
    }>;
  };
  diagnostic?: {
    moteursOperatifs?: string[];
    moteursEnEchec?: Array<{ moteur?: string; raison?: string }>;
    doublonsRetires?: number;
  };
}

/** Garde de forme tolérante : la sortie de l'outil peut être un objet
 *  déjà parsé, une chaîne JSON, ou n'importe quoi d'autre. Les résultats
 *  bruts sont lus d'abord dans `__interne.resultats` (contrat rapport),
 *  à défaut dans l'ancien champ `results`. */
export function parserSortieRechercheWeb(sortie: unknown): SortieRechercheWeb | null {
  if (!sortie) return null;
  let corps: unknown = sortie;
  if (typeof sortie === "string") {
    try {
      corps = JSON.parse(sortie);
    } catch {
      return null;
    }
  }
  if (typeof corps !== "object" || corps === null) return null;
  const candidat = corps as SortieRechercheWeb;
  if (Array.isArray(candidat.results)) return candidat;
  const resultatsInternes = candidat.__interne?.resultats;
  if (Array.isArray(resultatsInternes)) {
    return { ...candidat, results: resultatsInternes };
  }
  return null;
}

/** Le RAPPORT utilisateur livré par le tool (champ `rapport`), ou chaîne
 *  vide. C'est ce texte — et lui seul — qui rejoint la réponse visible :
 *  jamais la liste des résultats bruts. */
export function rapportDepuisSortieRecherche(sortie: unknown): string {
  if (!sortie) return "";
  let corps: unknown = sortie;
  if (typeof sortie === "string") {
    try {
      corps = JSON.parse(sortie);
    } catch {
      return "";
    }
  }
  if (typeof corps !== "object" || corps === null) return "";
  const rapport = (corps as SortieRechercheWeb).rapport;
  return typeof rapport === "string" && rapport.trim() ? rapport.trim() : "";
}

/** Bloc au format du pont connaissances : `[n] titre` + `URL : …` +
 *  `Extrait : …`. Chaîne VIDE si aucun résultat réel (le tour reste
 *  honnête — la synthèse ne prétendra jamais à des sources inexistantes). */
export function blocContexteDepuisSortieRecherche(sortie: unknown): string {
  const parsée = parserSortieRechercheWeb(sortie);
  const resultats = parsée?.results ?? [];
  if (!parsée || resultats.length === 0) return "";
  const lignes: string[] = [];
  const moteursOk = parsée.diagnostic?.moteursOperatifs ?? [];
  lignes.push(
    `[RECHERCHE WEB TEMPS RÉEL gen3ia — résultats RÉELS obtenus à l'instant par l'outil web.search` +
      (moteursOk.length ? ` (moteurs ayant répondu : ${moteursOk.join(", ")})` : "") +
      `.]`,
  );
  let numero = 0;
  for (const resultat of resultats) {
    const titre = typeof resultat?.title === "string" ? resultat.title.trim() : "";
    const url = typeof resultat?.url === "string" ? resultat.url.trim() : "";
    if (!titre || !url) continue;
    numero += 1;
    lignes.push(`[${numero}] ${titre}`);
    lignes.push(`URL : ${url}`);
    if (typeof resultat?.snippet === "string" && resultat.snippet.trim()) {
      lignes.push(`Extrait : ${resultat.snippet.trim()}`);
    }
    if (typeof resultat?.publishedAt === "string" && resultat.publishedAt.trim()) {
      lignes.push(`Publié : ${resultat.publishedAt.trim()}`);
    }
  }
  if (numero === 0) return "";
  return lignes.join("\n");
}

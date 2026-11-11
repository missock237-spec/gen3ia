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
/* sources numérotées [n] titre + URL + Extrait — pour que la réponse   */
/* CITE les sources réelles avec leur URL. Zéro invention : sans        */
/* résultat réel, la fonction retourne une chaîne vide (pas de bloc).   */

/** Une sortie réussie de l'outil web.search (SearchResponse, lib/tools/web/search). */
export interface SortieRechercheWeb {
  results?: Array<{
    title?: string;
    url?: string;
    snippet?: string;
    publishedAt?: string;
    source?: string;
  }>;
  diagnostic?: {
    moteursOperatifs?: string[];
    moteursEnEchec?: Array<{ moteur?: string; raison?: string }>;
    doublonsRetires?: number;
  };
}

/** Garde de forme tolérante : la sortie de l'outil peut être un objet
 *  déjà parsé, une chaîne JSON, ou n'importe quoi d'autre. */
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
  if (!Array.isArray(candidat.results)) return null;
  return candidat;
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

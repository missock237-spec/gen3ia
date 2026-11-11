/* ------------------------------------------------------------------ */
/* GARDE DE PERTINENCE — filtre les SERP « mur anti-bot » hors sujet   */
/* ------------------------------------------------------------------ */
/* Constat réel (sonde 2026-11-11) : Bing sert depuis les IP datacenter */
/* une SERP HTTP 200 structurellement VALIDE (li.b_algo bien formés)    */
/* dont le contenu est CANNED et HORS SUJET (« Best Buy Military        */
/* Discount » pour la requête « prix Bitcoin aujourd'hui »). Sans garde,*/
/* ces résultats poubelle entraient dans le contexte sourcé du chat :   */
/* le modèle les aurait cités avec confiance. Honnêteté : JAMAIS.       */
/*                                                                      */
/* Garde DÉTERMINISTE (zéro LLM, zéro variance) : un résultat est       */
/* pertinent si son titre/extrait contient au moins un terme porteur    */
/* de la requête (accents retirés, mots vides filtrés, longueur ≥ 3 ou  */
/* nombre). Une vraie SERP partage presque toujours un terme avec la    */
/* requête ; le mur anti-bot canned, quasiment jamais.                  */
/* FAIL-OPEN assumé : si la requête ne contient AUCUN terme porteur     */
/* (requête trop courte/trop générique), la garde ne rejette rien —     */
/* elle ne doit jamais tuer une vraie SERP par excès de zèle.           */

import type { ResultatRecherche } from "../types";

/** Mots vides français + anglais + verbes de commande : aucun pouvoir
 *  discriminant sur la pertinence. */
const MOTS_VIDES = new Set([
  "the", "and", "for", "are", "was", "were", "has", "have", "had", "with", "from", "that", "this", "what", "when", "where", "who", "how", "why", "will", "would", "can", "could", "should", "into", "about", "out", "just", "now", "get", "got",
  "les", "des", "une", "son", "ses", "leur", "leurs", "est", "sont", "était", "etaient", "pour", "avec", "sans", "dans", "sur", "sous", "par", "qui", "que", "quoi", "quel", "quelle", "quels", "quelles", "comment", "pourquoi", "combien", "quand",
  "aux", "cet", "cette", "ces", "mais", "donc", "or", "ni", "car", "plus", "moins", "tres", "bien", "fait", "faire", "etre", "avoir", "peut", "peuvent", "veux", "vouloir",
  "cherche", "chercher", "recherche", "rechercher", "trouve", "trouver", "donne", "donner", "moi", "toi", "lui", "eux", "web", "internet", "google", "moteur", "page", "pages", "site", "sites", "lien", "liens",
  "aujourdhui", "hier", "demain", "maintenant", "actuel", "actuelle", "actuellement", "recent", "recente", "recentement", "dernier", "derniere", "dernieres", "derniers", "nouveau", "nouvelle", "nouveaux", "nouvelles",
  "jour", "jours", "semaine", "semaines", "mois", "annee", "annees", "an", "ans", "heure", "heures", "minute", "minutes", "liste", "meilleur", "meilleure", "meilleurs", "gratuit", "gratuite", "francais", "france",
  "aujourd", "hui", "demain",
]);

/** Retire les accents et met en minuscule. */
function normaliser(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/œ/g, "oe");
}

/** Termes PORTeurs de la requête : significatifs (≥ 3 lettres, ou nombre),
 *  hors mots vides. Une requête sans terme porteur renvoie [] — la garde
 *  doit alors fail-open. */
export function termesRequete(requete: string): string[] {
  const norm = normaliser(requete);
  const candidats = norm.split(/[^a-z0-9]+/).filter(Boolean);
  const termes: string[] = [];
  for (const c of candidats) {
    if (MOTS_VIDES.has(c)) continue;
    if (c.length < 3 && !/\d/.test(c)) continue;
    if (!termes.includes(c)) termes.push(c);
  }
  return termes;
}

/** Un résultat est pertinent si titre+extrait contient au moins UN terme
 *  porteur de la requête. */
export function resultatPertinent(resultat: ResultatRecherche, termes: string[]): boolean {
  if (termes.length === 0) return true; // fail-open appelant sans termes
  const haystack = normaliser(`${resultat.titre} ${resultat.extrait ?? ""}`);
  return termes.some((t) => haystack.includes(t));
}

/** Filtre une liste de résultats bruts : ne garde que les pertinents.
 *  Requête sans terme porteur → liste inchangée (fail-open). */
export function resultatsPertinents(resultats: ResultatRecherche[], requete: string): ResultatRecherche[] {
  const termes = termesRequete(requete);
  if (termes.length === 0) return resultats;
  return resultats.filter((r) => resultatPertinent(r, termes));
}

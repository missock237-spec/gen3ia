/* ------------------------------------------------------------------ */
/* DÉDOUCLONNAGE — vérification de l'unicité des sources               */
/* ------------------------------------------------------------------ */
/* Deux niveaux, conformes à l'architecture demandée (« détection des  */
/* doublons ») :                                                       */
/*   1. URL : normalisation canonique (paramètres de tracking retirés, */
/*      fragment, trailing slash, www) → deux liens identiques au      */
/*      contenu près fusionnent même si leurs URL diffèrent.           */
/*   2. CONTENU : shingling de mots + similarité de Jaccard → deux     */
/*      extraits quasi identiques (agrégateurs qui recopient la même   */
/*      dépêche) sont réduits à la meilleure occurrence.               */
/* Aucune estimation magique : les seuils sont fixés, commentés et     */
/* testés (voir dedoublonnage.test.ts).                                */

const PARAMETRES_TRACKING = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "msclkid",
  "dclid",
  "twclid",
  "igshid",
  "mkt_tok",
  "yclid",
  "ref",
  "ref_src",
  "referrer",
  "share",
  "sh",
  "s",
  "cmpid",
  "ocid",
  "cvid",
  "form",
  "skw",
]);

/**
 * Normalise une URL en forme canonique : https forcé pour les hôtes
 * publics, www retiré, fragment retiré, paramètres de tracking retirés,
 * query vide retirée, trailing slash retiré (hors racine). Réservée aux
 * http(s) — tout autre schéma renvoie la chaîne telle quelle.
 */
export function normaliserUrl(url: string): string {
  let parse;
  try {
    parse = new URL(url);
  } catch {
    return url;
  }
  if (parse.protocol !== "http:" && parse.protocol !== "https:") return url;
  parse.protocol = "https:";
  parse.hash = "";
  const hote = parse.hostname.replace(/^www\./, "");
  if (hote) parse.hostname = hote;
  const aGarder: string[] = [];
  parse.searchParams.forEach((valeur, cle) => {
    if (!PARAMETRES_TRACKING.has(cle.toLowerCase())) aGarder.push(`${cle}=${valeur}`);
  });
  aGarder.sort(); // ordre stable : deux URL mêmes-paramètres-ordre-différent fusionnent
  const chemin = parse.pathname.replace(/\/+$/, "") || "/";
  const query = aGarder.length ? `?${aGarder.join("&")}` : "";
  return `https://${hote}${chemin}${query}`;
}

/** Normalisation textuelle : minuscules, accents retirés, ponctuation
 *  et chiffres isolés ignorés, mots vides français/anglais retirés. */
const MOTS_VIDES = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "à", "au", "aux",
  "en", "dans", "sur", "pour", "par", "avec", "sans", "son", "sa", "ses", "ce",
  "cet", "cette", "ces", "qui", "que", "quoi", "dont", "est", "sont", "être",
  "ne", "me", "te", "se", "nous", "vous", "pas", "plus", "moi", "toi", "lui",
  "a", "the", "of", "to", "in", "on", "for", "and", "or", "is", "are", "was",
  "it", "as", "at", "by", "an", "be",
]);

export function normaliserTexte(texte: string): string[] {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((mot) => mot.length > 1 && !MOTS_VIDES.has(mot) && !/^\d+$/.test(mot));
}

/** Shingles de mots consécutifs (défaut : trigrammes). */
export function shingles(texte: string, taille = 3): Set<string> {
  const mots = normaliserTexte(texte);
  const ensemble = new Set<string>();
  if (mots.length < taille) {
    // Texte trop court pour un shingle complet : le mot unique est le
    // signal — deux extraits qui ne partagent aucun mot ne fusionnent pas.
    for (const mot of mots) ensemble.add(mot);
    return ensemble;
  }
  for (let i = 0; i <= mots.length - taille; i += 1) {
    ensemble.add(mots.slice(i, i + taille).join(" "));
  }
  return ensemble;
}

/** Similarité de Jaccard entre deux ensembles (0..1). */
export function similariteJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [petit, grand] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of petit) if (grand.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Seuil de similarité au-delà duquel deux extraits sont considérés comme
 *  le même contenu. 0.55 : calibré pour attraper les dépêches recopiées
 *  (généralement > 0.7) sans fusionner deux articles distincts qui parlent
 *  du même sujet (généralement < 0.3). */
export const SEUIL_DOUBLON_CONTENU = 0.55;

/** Entrée minimale pour le dédoublonnage (l'objet complet T est conservé
 *  tel quel dans la sortie — rang, moteur, valeur…). */
export interface EntreeDedoublonnage {
  url: string;
  /** Extrait représentatif du contenu (snippet ou début du texte). */
  extrait: string;
}

/** Garde-t-on la première occurrence (les moteurs sont interrogés dans
 *  un ordre de priorité déclaré par l'appelant) : oui — l'occurrence
 *  conservée est celle du moteur le plus fiable/prioritaire. */
export function dedoublonner<T extends EntreeDedoublonnage>(
  entrees: T[],
  options: { seuilContenu?: number; maxTailleExtrait?: number } = {},
): { conserves: T[]; doublonsRetires: number } {
  const seuil = options.seuilContenu ?? SEUIL_DOUBLON_CONTENU;
  const tailleExtrait = options.maxTailleExtrait ?? 600;
  const conserves: T[] = [];
  const urlsVues = new Set<string>();
  const shinglesVus: Set<string>[] = [];
  let doublonsRetires = 0;

  for (const entree of entrees) {
    const canonique = normaliserUrl(entree.url);
    // 1) doublon d'URL exact (après normalisation) → fusion
    if (urlsVues.has(canonique)) {
      doublonsRetires += 1;
      continue;
    }
    // 2) doublon de CONTENU (extrait quasi identique) → fusion
    const sh = shingles(entree.extrait.slice(0, tailleExtrait));
    const doublonContenu = shinglesVus.some((autre) => similariteJaccard(sh, autre) >= seuil);
    if (doublonContenu) {
      doublonsRetires += 1;
      continue;
    }
    urlsVues.add(canonique);
    shinglesVus.push(sh);
    conserves.push(entree);
  }
  return { conserves, doublonsRetires };
}

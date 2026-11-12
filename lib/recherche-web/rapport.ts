/* ------------------------------------------------------------------ */
/* RAPPORT DE RECHERCHE — sortie UTILISATEUR de la recherche web gen3ia */
/* ------------------------------------------------------------------ */
/* Demande propriétaire : dans la recherche web, gen3 ne montre PLUS à   */
/* l'utilisateur les sources dont il tire ses résultats. La recherche    */
/* produit un RAPPORT DÉTAILLÉ et autonome — l'utilisateur ne voit que   */
/* ce dont il a besoin :                                                 */
/*   - un titre thématique (sujet nettoyé de tout préfixe de commande) ; */
/*   - des sections organisées par sous-thèmes détectés (regroupement    */
/*     déterministe par recouvrement de mots-clés des titres/extraits) ; */
/*   - des points clés avec les chiffres, dates et acteurs extraits des  */
/*     extraits ;                                                        */
/*   - les nuances et désaccords entre contenus (valeurs contradictoires */
/*     ou formulations opposées) ;                                       */
/*   - une synthèse finale actionnable.                                  */
/*                                                                       */
/* GARDE-FOUS DE PRÉSENTATION (vérifiés par les tests) :                 */
/*   - l'interface d'entrée NE PORTE PAS d'URL : le constructeur est     */
/*     structurellement incapable de citer une adresse de page ;         */
/*   - une sanitisation défensive retire toute URL, tout domaine et tout */
/*     courriel qui se serait glissé dans un titre ou un extrait ;       */
/*   - le mot « source » n'apparaît jamais dans le rapport (ni liste de  */
/*     sources, ni bibliographie) — les résultats bruts restent dans le  */
/*     champ interne `__interne.resultats` du tool web.search.           */
/*                                                                       */
/* HONNÊTETÉ : le rapport est établi sur les extraits agrégés au moment  */
/* de la demande (pas sur la lecture intégrale des pages) — c'est ÉCRIT  */
/* dans la synthèse. Un résultat n'est jamais inventé : sans contenu     */
/* exploitable, le rapport le dit clairement.                            */
/*                                                                       */
/* Module PUR (aucune I/O, aucun réseau) : testable unitairement.        */

/* ------------------------------------------------------------------ */
/* Types publics                                                        */
/* ------------------------------------------------------------------ */

/** Ce qu'un résultat apporte au rapport : du CONTENU, jamais d'URL. */
export interface ResultatPourRapport {
  /** Titre humain du contenu trouvé. */
  titre: string;
  /** Extrait (snippet) proposé par le moteur, s'il existe. */
  extrait?: string;
  /** Date de publication annoncée, si elle l'est. */
  publieLe?: string;
}

/** Niveau de confiance du rapport, selon le volume recueilli. */
export type FiabiliteRapport = "haute" | "moyenne" | "basse";

/** Rapport détaillé produit pour l'utilisateur (aucune référence de source). */
export interface RapportRecherche {
  /** Titre thématique du rapport. */
  titre: string;
  /** Texte complet du rapport (français structuré). */
  texte: string;
  /** Nombre de sous-thèmes (sections) détectés. */
  sections: number;
  /** Fiabilité d'ensemble selon le volume recueilli. */
  fiabilite: FiabiliteRapport;
}

/* ------------------------------------------------------------------ */
/* Sanitisation défensive (aucune URL / domaine / courriel ne sort)     */
/* ------------------------------------------------------------------ */

const REGEX_URL = /\bhttps?:\/\/\S+/gi;
const REGEX_WWW = /\bwww\.\S+/gi;
const REGEX_COURRIEL = /[\w.+-]+@[\w-]+\.[\w.-]+/gi;
/** Jeton en forme de domaine (ex. « exemple.fr », « www.lemonde.com »). */
const REGEX_DOMAINE =
  /\b[a-z0-9][a-z0-9._-]*\.(?:com|fr|org|net|io|co|dev|ai|eu|de|uk|us|ca|ch|be|es|it|pt|nl|info|app|xyz|me|tv|news|media|tech|online|site|store|blog|edu|gov)\b/gi;

/** Retire toute référence d'adresse d'un texte (titre ou extrait). */
function sanitariser(texte: string): string {
  return texte
    .replace(REGEX_URL, " ")
    .replace(REGEX_WWW, " ")
    .replace(REGEX_COURRIEL, " ")
    .replace(REGEX_DOMAINE, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Mots-clés et regroupement thématique (déterministe, zéro LLM)        */
/* ------------------------------------------------------------------ */

/** Mots outils écartés du regroupement (français + anglais minimal). */
const MOTS_OUTILS = new Set([
  "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "en", "au",
  "aux", "a", "ce", "cet", "cette", "ces", "son", "sa", "ses", "leur",
  "leurs", "pour", "par", "sur", "dans", "avec", "sans", "sous", "vers",
  "est", "sont", "etre", "avoir", "plus", "moins", "tres", "bien", "que",
  "qui", "quoi", "dont", "comme", "aussi", "apres", "avant", "entre",
  "chez", "tout", "tous", "toute", "toutes", "il", "elle", "ils", "elles",
  "nous", "vous", "ne", "pas", "mais", "donc", "car", "si", "then", "its",
  "the", "of", "and", "to", "in", "for", "with", "on", "from", "this",
  "that", "at", "by", "is", "are", "was", "were", "be", "been",
  "his", "her", "or", "an", "as", "it", "new", "plusieurs", "peut",
]);

/** Minuscules + accents retirés (comparaison stable). */
function normaliser(mot: string): string {
  return mot.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

interface Vocabulaire {
  /** Clés normalisées des mots informatifs. */
  cles: Set<string>;
  /** Première occurrence originale de chaque clé (pour l'affichage). */
  originaux: Map<string, string>;
}

/** Mots-clés informatifs d'un texte (≥ 2 lettres, hors mots outils et hors
 *  nombres — les chiffres relèvent des points clés, pas du thème). */
function motsCles(texte: string): Vocabulaire {
  const cles = new Set<string>();
  const originaux = new Map<string, string>();
  for (const brut of texte.split(/[^\p{L}\p{N}]+/u)) {
    const cle = normaliser(brut);
    if (cle.length < 2 || cle.length > 24) continue;
    if (MOTS_OUTILS.has(cle)) continue;
    if (/^\d+$/.test(cle)) continue;
    cles.add(cle);
    if (!originaux.has(cle)) originaux.set(cle, brut);
  }
  return { cles, originaux };
}

/** Un résultat analysé : contenu nettoyé + vocabulaire thématique. */
interface Membre {
  titre: string;
  extrait: string;
  publieLe: string;
  vocab: Vocabulaire;
}

/** Un sous-thème : plusieurs résultats voisins + fréquence de leurs mots. */
interface Groupe {
  membres: Membre[];
  /** Clé → nombre de membres du groupe qui l'utilisent. */
  frequence: Map<string, number>;
}

/** Analyse les résultats d'entrée (sanitisation + mots-clés). */
function analyserResultats(resultats: ResultatPourRapport[]): Membre[] {
  const membres: Membre[] = [];
  for (const resultat of resultats.slice(0, 20)) {
    if (!resultat || typeof resultat.titre !== "string") continue;
    const titre = sanitariser(resultat.titre);
    const extrait = sanitariser(typeof resultat.extrait === "string" ? resultat.extrait : "");
    const publieLe = sanitariser(typeof resultat.publieLe === "string" ? resultat.publieLe : "");
    if (!titre && !extrait) continue;
    membres.push({
      titre,
      extrait,
      publieLe,
      vocab: motsCles(`${titre} ${extrait}`),
    });
  }
  return membres;
}

/** Mots communs entre un membre et un groupe (recouvrement borné). */
function motsCommuns(cles: Set<string>, groupe: Groupe): { communs: number; recouvrement: number } {
  let communs = 0;
  for (const cle of cles) {
    if ((groupe.frequence.get(cle) ?? 0) > 0) communs += 1;
  }
  const reference = Math.min(cles.size, groupe.frequence.size) || 1;
  return { communs, recouvrement: communs / reference };
}

/** Forme originale (accents gardés) d'une clé dans N'IMPORTE QUEL membre du
 *  groupe — le premier membre ne porte pas toujours le mot. */
function originalDuGroupe(groupe: Groupe, cle: string): string {
  for (const membre of groupe.membres) {
    const original = membre.vocab.originaux.get(cle);
    if (original) return original;
  }
  return cle;
}

/** Regroupement glouton déterministe : un résultat rejoint le groupe avec
 *  lequel il partage le plus de mots-clés (≥ 2 mots communs ou ≥ 35 % de
 *  recouvrement), sinon il ouvre un nouveau sous-thème. */
function regrouper(membres: Membre[]): Groupe[] {
  const groupes: Groupe[] = [];
  for (const membre of membres) {
    let cible: Groupe | null = null;
    let meilleur = 0;
    for (const groupe of groupes) {
      const { communs, recouvrement } = motsCommuns(membre.vocab.cles, groupe);
      if ((communs >= 2 || recouvrement >= 0.35) && communs > meilleur) {
        meilleur = communs;
        cible = groupe;
      }
    }
    if (!cible) {
      cible = { membres: [], frequence: new Map() };
      groupes.push(cible);
    }
    cible.membres.push(membre);
    for (const cle of membre.vocab.cles) {
      cible.frequence.set(cle, (cible.frequence.get(cle) ?? 0) + 1);
    }
  }
  return groupes;
}

/* ------------------------------------------------------------------ */
/* Extraction de phrases, chiffres, dates, acteurs                      */
/* ------------------------------------------------------------------ */

const REGEX_CHIFFRE = /\d/;
const REGEX_DATE =
  /\b20\d{2}\b|\b\d{1,2}(?:er)?\s+(?:janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre)\b|\b\d{4}-\d{2}-\d{2}\b/i;
/** Unités suivies d'une valeur (pour détecter les désaccords chiffrés). */
const REGEX_MESURE = /(\d+(?:[.,]\d+)?)\s*(%|€|\$|milliards?|millions?|points?|degrés?|°C)/gi;
/** Marqueurs d'opposition / de prudence entre contenus. */
const REGEX_CONTRASTE =
  /cependant|toutefois|en revanche|a l'inverse|à l'inverse|contraire|contrairement|desaccord|désaccord|contredit|conteste|contesté|diverge|differ|différ|doute|incertitude|incertain|debat|débat|polemique|polémique|mitige|mitigé|nuance|selon certains|d'autres|mais\b|prudents?|sceptique|however|whereas|dispute|critique/i;

/** Découpe un texte en phrases exploitables (≥ 12 caractères). */
function phrases(texte: string): string[] {
  return texte
    .split(/(?<=[.!?…])\s+/)
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length >= 12);
}

/** Poids informatif d'une phrase : chiffres, dates, acteurs nommés. */
function poidsPhrase(phrase: string): number {
  let poids = 0;
  if (REGEX_CHIFFRE.test(phrase)) poids += 2;
  if (REGEX_DATE.test(phrase)) poids += 2;
  // Un mot capitalisé APRÈS le premier mot → un acteur / une entité nommée.
  if (/[A-ZÀ-ÖØ-Þ]/.test(phrase.slice(1))) poids += 1;
  return poids;
}

/** Tronque proprement une phrase (coupure au mot, ellipse). */
function tronquer(texte: string, max = 220): string {
  const brut = texte.trim();
  if (brut.length <= max) return brut;
  const coupe = brut.slice(0, max);
  const dernierEspace = coupe.lastIndexOf(" ");
  return `${(dernierEspace > max * 0.5 ? coupe.slice(0, dernierEspace) : coupe).trimEnd()}…`;
}

/** Normalise la fin d'une puce (point final unique). */
function avecPointFinal(texte: string): string {
  return `${texte.replace(/[.!,;:…\s]+$/, "")}.`;
}

/** La phrase la plus informative d'un contenu (ou son titre à défaut),
 *  enrichie de la date de publication quand l'extrait n'en porte aucune. */
function lignePrincipale(membre: Membre): string {
  const candidates = phrases(membre.extrait);
  let ligne: string;
  if (candidates.length === 0) {
    ligne = tronquer(membre.titre || membre.extrait, 200);
  } else {
    let meilleure = candidates[0];
    let meilleurPoids = poidsPhrase(meilleure);
    for (const phrase of candidates.slice(1)) {
      const poids = poidsPhrase(phrase);
      if (poids > meilleurPoids) {
        meilleure = phrase;
        meilleurPoids = poids;
      }
    }
    ligne = tronquer(meilleure, 200);
  }
  // La date annoncée par le moteur complète une phrase sans aucune date.
  if (membre.publieLe && !REGEX_CHIFFRE.test(ligne)) {
    ligne = `${ligne} (publié le ${membre.publieLe.slice(0, 10)})`;
  }
  return ligne;
}

/* ------------------------------------------------------------------ */
/* Nom des sous-thèmes                                                  */
/* ------------------------------------------------------------------ */

/** Capitalise la première lettre (les suivantes restent fidèles). */
function capitaliser(texte: string): string {
  return texte.length === 0 ? texte : `${texte[0].toUpperCase()}${texte.slice(1)}`;
}

/** Énumération française : « A, B et C ». */
function enumerrer(morceaux: string[]): string {
  if (morceaux.length === 0) return "";
  if (morceaux.length === 1) return morceaux[0];
  return `${morceaux.slice(0, -1).join(", ")} et ${morceaux[morceaux.length - 1]}`;
}

/** Nom de section : les mots-clés partagés par la moitié du groupe au moins,
 *  sinon les premiers mots significatifs du titre du 1er membre. */
function nommerGroupe(groupe: Groupe): string {
  const seuil = Math.ceil(groupe.membres.length / 2);
  const partages = [...groupe.frequence.entries()]
    .filter(([, frequence]) => frequence >= seuil)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([cle]) => originalDuGroupe(groupe, cle));
  if (partages.length > 0) {
    return capitaliser(enumerrer(partages.map((mot) => mot.toLowerCase())));
  }
  const motsTitre = groupe.membres[0].titre
    .split(/[^\p{L}\p{N}]+/u)
    .filter((mot) => mot.length >= 2 && !MOTS_OUTILS.has(normaliser(mot)))
    .slice(0, 5)
    .join(" ");
  return capitaliser((motsTitre || groupe.membres[0].titre).slice(0, 60));
}

/* ------------------------------------------------------------------ */
/* Points clés et nuances                                               */
/* ------------------------------------------------------------------ */

/** Points clés globaux : les phrases les plus factuelles (chiffres, dates,
 *  acteurs) tirées DES EXTRAITS (les titres figurent déjà dans les
 *  sections), dédupliquées, bornées à 8 — les titres ne servent de repli
 *  que si les extraits sont pauvres en faits. */
function pointsCles(membres: Membre[]): string[] {
  const candidates: Array<{ texte: string; poids: number; rang: number }> = [];
  const vus = new Set<string>();
  const ajouter = (phrase: string, poids: number, rang: number) => {
    if (poids < 2) return;
    const empreinte = normaliser(phrase).slice(0, 60);
    if (vus.has(empreinte)) return;
    vus.add(empreinte);
    candidates.push({ texte: tronquer(phrase, 200), poids, rang });
  };
  membres.forEach((membre, rang) => {
    for (const phrase of phrases(membre.extrait)) ajouter(phrase, poidsPhrase(phrase), rang);
  });
  // Extraits pauvres en faits : les titres complètent les points clés.
  if (candidates.length < 3) {
    membres.forEach((membre, rang) => ajouter(membre.titre, poidsPhrase(membre.titre), rang));
  }
  candidates.sort((a, b) => b.poids - a.poids || a.rang - b.rang);
  const retenues = candidates.slice(0, 8).map((candidate) => avecPointFinal(candidate.texte));
  if (retenues.length > 0) return retenues;
  // Aucun chiffre/date détecté : les titres font office de points clés.
  return membres.slice(0, 3).map((membre) => avecPointFinal(tronquer(membre.titre, 160)));
}

/** Nuances et désaccords : valeurs chiffrées divergentes (sur des contenus
 *  qui parlent du même sujet) + oppositions verbales explicites. */
function nuances(membres: Membre[]): string[] {
  const lignes: string[] = [];
  // 1. Valeurs divergentes pour une même unité — mais UNIQUEMENT entre des
  //    contenus qui partagent au moins un mot-clé : sinon on comparerait
  //    37 % de croissance du marché IA avec 2,4 % de cours du Bitcoin.
  const mesures: Array<{ valeur: string; unite: string; cles: Set<string> }> = [];
  for (const membre of membres) {
    for (const match of membre.extrait.matchAll(REGEX_MESURE)) {
      mesures.push({
        valeur: match[1].replace(",", "."),
        unite: normaliser(match[2]),
        cles: membre.vocab.cles,
      });
    }
  }
  for (let i = 0; i < mesures.length && lignes.length < 2; i += 1) {
    for (let j = i + 1; j < mesures.length && lignes.length < 2; j += 1) {
      const a = mesures[i];
      const b = mesures[j];
      if (a.unite !== b.unite || a.valeur === b.valeur) continue;
      const sujetCommun = [...a.cles].some((cle) => b.cles.has(cle));
      if (!sujetCommun) continue;
      lignes.push(
        avecPointFinal(
          `Des valeurs différentes circulent sur un même point (${a.valeur} ${a.unite} vs ${b.valeur} ${b.unite}) : vérifiez la période et le périmètre de calcul avant de trancher`,
        ),
      );
      break;
    }
  }
  // 2. Formulations opposées / prudents dans les extraits eux-mêmes.
  for (const membre of membres) {
    for (const phrase of phrases(membre.extrait)) {
      if (!REGEX_CONTRASTE.test(phrase)) continue;
      const ligne = avecPointFinal(tronquer(phrase, 200));
      if (!lignes.includes(ligne)) lignes.push(ligne);
      if (lignes.length >= 4) return lignes;
      break; // une opposition par contenu suffit
    }
  }
  return lignes;
}

/* ------------------------------------------------------------------ */
/* Titre thématique et synthèse                                         */
/* ------------------------------------------------------------------ */

/** Préfixes de commande retirés du sujet (la demande, pas le moteur). */
const PREFIXES_COMMANDE = [
  /^\s*(cherche|moteur|recherche|renseigne[- ]toi|informe[- ]?s?[- ]toi|va chercher|trouve[- ]moi|consulte le web|fais une recherche)\b\s*(sur|pour|a propos de|à propos de|dans|sur le web|sur internet)?\s*/i,
  /^\s*(est[- ]ce que|dis[- ]moi|peux[- ]tu|sais[- ]tu|tu sais|je veux savoir|je voudrais savoir)\b[,:\s]+/i,
  /^\s*(what|who|how|why)\b[,:\s]+/i,
];

/** Sujet nettoyé : la demande sans verbe de commande ni ponctuation finale. */
function sujetDeLaRecherche(query: string): string {
  let sujet = query.trim().slice(0, 220);
  for (const prefixe of PREFIXES_COMMANDE) {
    const suivant = sujet.replace(prefixe, "");
    if (suivant !== sujet) {
      sujet = suivant.trim();
      break;
    }
  }
  return sujet.replace(/[\s.!?]+$/, "").trim() || query.trim().slice(0, 120);
}

/* ------------------------------------------------------------------ */
/* Fiabilité                                                            */
/* ------------------------------------------------------------------ */

/** Fiabilité d'ensemble : elle dépend du VOLUME recueilli (le rapport est
 *  construit sur des extraits, sa confiance ne peut pas dépasser la base). */
export function evaluerFiabilite(nbResultats: number): FiabiliteRapport {
  if (!Number.isFinite(nbResultats) || nbResultats < 3) return "basse";
  if (nbResultats >= 6) return "haute";
  return "moyenne";
}

/* ------------------------------------------------------------------ */
/* Constructeur principal                                               */
/* ------------------------------------------------------------------ */

/** Rapport honnête quand la recherche n'a rien ramené d'exploitable. */
function rapportVide(query: string): RapportRecherche {
  const sujet = sujetDeLaRecherche(sanitariser(query));
  return {
    titre: `Rapport de recherche : ${sujet}`,
    sections: 0,
    fiabilite: "basse",
    texte: [
      `RAPPORT DE RECHERCHE : ${sujet}`,
      `Recherche : « ${sanitariser(query).slice(0, 200)} » — fiabilité basse (0 contenu exploitable)`,
      "",
      "Aucun contenu exploitable n'a été recueilli au moment de la demande. La recherche n'aboutit pas : rien n'est inventé pour combler le vide.",
      "Que faire : reformulez avec des mots-clés plus simples, vérifiez l'orthographe des noms propres, ou réessayez dans quelques instants — les moteurs interrogés peuvent être momentanément indisponibles.",
    ].join("\n"),
  };
}

/** Construit le rapport utilisateur : titre thématique, sections par
 *  sous-thèmes, points clés chiffrés/datés, nuances, synthèse actionnable.
 *  AUCUNE URL, AUCUN domaine, AUCUNE mention de « sources ». */
export function construirRapportRecherche(
  query: string,
  resultats: ResultatPourRapport[],
): RapportRecherche {
  if (!Array.isArray(resultats) || resultats.length === 0) return rapportVide(query);
  const membres = analyserResultats(resultats);
  if (membres.length === 0) return rapportVide(query);

  // La requête elle-même est nettoyée : une URL collée par l'utilisateur ne
  // doit jamais resservir dans le rapport.
  const requete = sanitariser(query);
  const groupes = regrouper(membres);
  const fiabilite = evaluerFiabilite(membres.length);
  const sujet = sujetDeLaRecherche(requete);

  // Sections thématiques, les plus peuplées d'abord (ordre stable).
  const groupesTries = [...groupes].sort(
    (a, b) => b.membres.length - a.membres.length || a.membres[0].titre.localeCompare(b.membres[0].titre),
  );
  const sectionsTexte: string[] = [];
  const labels: string[] = [];
  groupesTries.forEach((groupe, index) => {
    const label = nommerGroupe(groupe);
    labels.push(label);
    const puces = groupe.membres.slice(0, 3).map((membre) => `- ${avecPointFinal(lignePrincipale(membre))}`);
    sectionsTexte.push([`Thème ${index + 1} — ${label}`, ...puces].join("\n"));
  });

  const cles = pointsCles(membres);
  const lignesNuances = nuances(membres);

  const enTete = [
    `RAPPORT DE RECHERCHE : ${sujet}`,
    `Recherche : « ${requete.slice(0, 200)} » — fiabilité ${fiabilite} (${membres.length} contenu(s) analysé(s), ${groupesTries.length} angle(s) identifié(s))`,
  ];

  const synthese: string[] = [];
  synthese.push(
    `Sur « ${sujet} », les contenus recueillis à l'instant dessinent ${labels.length === 1 ? "un angle principal" : `${labels.length} angles`} : ${enumerrer(labels)}.`,
  );
  if (cles.length > 0) synthese.push(`L'essentiel : ${avecPointFinal(tronquer(cles[0], 220))}`);
  if (lignesNuances.length > 0) {
    synthese.push(
      `À manier avec précaution : ${avecPointFinal(tronquer(lignesNuances[0], 200))}`,
    );
  }
  synthese.push(
    "Pour aller plus loin : précisez la période, la zone géographique ou l'acteur concerné, puis relancez une recherche ciblée.",
    "Limite honnête : ce rapport s'appuie sur les extraits recueillis au moment de la demande — les pages n'ont pas été lues intégralement.",
  );

  const blocs = [
    enTete.join("\n"),
    ...sectionsTexte,
    ["Points clés (chiffres, dates, acteurs)", ...cles.map((cle) => `- ${cle}`)].join("\n"),
    ...(lignesNuances.length > 0
      ? [["Nuances et points de vigilance", ...lignesNuances.map((ligne) => `- ${ligne}`)].join("\n")]
      : []),
    ["Synthèse", ...synthese].join("\n"),
  ];

  return {
    titre: `Rapport de recherche : ${sujet}`,
    texte: blocs.join("\n\n"),
    sections: groupesTries.length,
    fiabilite,
  };
}

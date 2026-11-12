/**
 * EXTRACTION DE CORPUS DU STUDIO D'ENTRAÎNEMENT (demande propriétaire :
 * « l'utilisateur fournit TOUTES les ressources nécessaires — fichiers,
 * textes, URLs — pour entraîner son IA sur un domaine choisi »).
 *
 * Ce module convertit une RESSOURCE BRUTE (texte collé, contenu de fichier
 * dataset, contenu de page web) en UNITÉS DE CONNAISSANCE exploitables par
 * la mémoire de domaine de l'utilisateur :
 *   - paires Q/A : blocs « Q: … / A: … » (txt) ou enregistrements
 *     json/jsonl/csv à clés question/réponse (mêmes conventions que le
 *     moteur gen3-native — lib/training/engines/gen3-dataset.ts réutilisé) ;
 *   - faits : phrases de définition (« X est … », « X désigne … ») →
 *     question dérivée « Que sait-on sur X ? » ;
 *   - exemples de code : blocs clôturés ``` … ``` → question dérivée de la
 *     ligne explicative qui précède.
 *
 * HONNÊTETÉ : chaque élément ignoré est COMPTE et signalé (éléments, ignorés,
 * avertissements) — rien n'est inventé, aucun quota silencieux. Le découpage
 * est DÉTERMINISTE (même ressource → mêmes unités, partout, toujours).
 *
 * Module PUR — aucune dépendance réseau.
 */

import { parserDatasetGen3, type PaireBrute } from "@/lib/training/engines/gen3-dataset";
import { empreinte128 } from "@/lib/neural/generation/memoire-domaines";

/** Type d'une unité de connaissance extraite. */
export type TypeUnite = "qa" | "fait" | "code";

/** Origine de la ressource (traçabilité du corpus ingéré). */
export type OrigineRessource = "texte" | "dataset" | "url";

/** Une unité de connaissance — la brique de la mémoire utilisateur. */
export interface UniteConnaissance {
  /** Empreinte FNV-1a 128 bits du contenu (déduplication, même mécanique que memoire-domaines). */
  readonly empreinte: string;
  readonly type: TypeUnite;
  /** Question canonique — dérivée pour les faits et le code. */
  readonly question: string;
  /** Réponse / fait / code servi à la réponse. */
  readonly contenu: string;
  /** Mots-clés de contenu (recouvrement lexical à la consultation). */
  readonly motscles: readonly string[];
  readonly source: { readonly ressource: string; readonly origine: OrigineRessource };
  /** Octets réels du contenu (UTF-8). */
  readonly octets: number;
}

/** Résultat d'extraction d'une ressource (compteurs honnêtes). */
export interface ResultatExtraction {
  readonly unites: UniteConnaissance[];
  /** Éléments rencontrés (paires, phrases candidates, blocs de code). */
  readonly elements: number;
  /** Éléments ignorés (vides, trop courts, trop longs, illisibles, doublons). */
  readonly ignores: number;
  readonly avertissements: string[];
  /** Octets réels du contenu nettoyé ayant été traité. */
  readonly octetsTraites: number;
}

/** Plafond d'une unité de contenu (au-delà : tronquée et signalée). */
export const MAX_CONTENU_UNITES = 3000;
/** Plafond d'une question d'unité. */
export const MAX_QUESTION_UNITES = 400;
/** Longueur minimale d'une réponse/fait pour être retenue. */
export const MIN_LONGUEUR_CONTENU = 12;

/** Plafond du contenu d'une ressource traitée (cohérent avec les plafonds
 * dataset du Studio — au-delà, la ressource est tronquée et signalée). */
export const MAX_OCTETS_RESSOURCE = 5 * 1024 * 1024;

// ─── NETTOYAGE ───────────────────────────────────────────────────────────────

/** Mots-outils (même philosophie que memoire-domaines : contenu seul) —
 * y compris les résidus d'élision (« qu » de « qu'est », « jusqu », « parce »)
 * qui créeraient de faux recouvrements entre questions sans rapport. */
const MOTS_OUTILS_EXTRACTION = new Set([
  "le", "la", "les", "de", "des", "du", "un", "une", "et", "ou", "est", "ce",
  "que", "qui", "quoi", "dans", "sur", "pour", "avec", "au", "aux", "a", "d",
  "l", "sont", "se", "son", "sa", "ses", "ne", "pas", "plus", "comme", "mais",
  "donc", "or", "ni", "car", "je", "tu", "il", "elle", "on", "nous", "vous",
  "ils", "elles", "this", "that", "the", "of", "and", "to", "in", "is", "are",
  "qu", "jusqu", "lorsqu", "puisqu", "quoiqu", "parce",
]);

/** Tokenisation de contenu : minuscules, séparateurs non lettre/chiffre,
 * sans mots-outils — le même registre lexical que la consultation. */
export function tokensContenu(texte: string): string[] {
  return texte
    .toLowerCase()
    .split(/[^a-zàâçéèêëîïôûùüÿñæœ0-9_]+/)
    .filter((m) => m.length > 1 && !MOTS_OUTILS_EXTRACTION.has(m));
}

/** Nettoie une ressource brute : normalise les fins de ligne, retire les
 * caractères de contrôle et les séparateurs invisibles, resserre les blancs. */
export function nettoyerTexte(brut: string): string {
  return brut
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Dégraisse un HTML en texte (aucune dépendance : retrait des blocs
 * script/style/noscript/svg, des balises, décodage des entités courantes). */
export function htmlVersTexte(html: string): string {
  const sansBlocs = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const sansBalises = sansBlocs
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const dekode = sansBalises
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
  return nettoyerTexte(dekode);
}

// ─── FABRIQUE D'UNITÉS ───────────────────────────────────────────────────────

function unité(
  type: TypeUnite,
  question: string,
  contenu: string,
  ressource: string,
  origine: OrigineRessource,
): UniteConnaissance | null {
  const q = question.trim().slice(0, MAX_QUESTION_UNITES);
  const c = contenu.trim().slice(0, MAX_CONTENU_UNITES);
  if (q.length < 6 || c.length < MIN_LONGUEUR_CONTENU) return null;
  const empreinte = empreinte128(`${q}\n${c}`);
  return {
    empreinte,
    type,
    question: q,
    contenu: c,
    // Mots-clés du CONTENU ET de la QUESTION (recouvrement lexical à la
    // consultation : une reformulation qui partage les mots du sujet passe,
    // une question sans rapport non).
    motscles: [...new Set([...tokensContenu(c), ...tokensContenu(q)])].slice(0, 48),
    source: { ressource: ressource.slice(0, 180), origine },
    octets: Buffer.byteLength(c, "utf-8"),
  };
}

// ─── PAIRES Q/A (blocs txt « Q: … / A: … ») ─────────────────────────────────

const REGEX_Q = /^\s*(?:Q|Question)\s*[:.]\s*(.*)$/i;
const REGEX_A = /^\s*(?:A|R|Réponse|Reponse|Answer)\s*[:.]\s*(.*)$/i;

/** Extrait les blocs Q/A d'un texte (question multi-ligne permise, réponse
 * jusqu'à la ligne vide ou la question suivante). */
export function extrairePairesTexte(texte: string): Array<{ question: string; reponse: string }> {
  const paires: Array<{ question: string; reponse: string }> = [];
  const lignes = texte.split("\n");
  let question: string[] = [];
  let reponse: string[] = [];
  let phase: "q" | "a" | null = null;

  const terminer = (): void => {
    if (phase === "a" && question.length > 0 && reponse.length > 0) {
      paires.push({
        question: question.join(" ").trim(),
        reponse: reponse.join(" ").trim(),
      });
    }
    question = [];
    reponse = [];
    phase = null;
  };

  for (const ligne of lignes) {
    const q = REGEX_Q.exec(ligne);
    const a = REGEX_A.exec(ligne);
    if (q) {
      terminer();
      phase = "q";
      question = q[1] && q[1].trim().length > 0 ? [q[1].trim()] : [];
      continue;
    }
    if (a) {
      if (phase === "q" || phase === "a") phase = "a";
      reponse = a[1] && a[1].trim().length > 0 ? [a[1].trim()] : [];
      continue;
    }
    if (ligne.trim().length === 0) {
      // Ligne vide : clôt la paire en cours (convention des blocs txt).
      terminer();
      continue;
    }
    if (phase === "q") question.push(ligne.trim());
    else if (phase === "a") reponse.push(ligne.trim());
  }
  terminer();
  return paires;
}

// ─── FAITS (phrases de définition) ───────────────────────────────────────────

/** Phrases de définition reconnues : sujet (commençant par une majuscule,
 * borné à 89 caractères) + verbe d'existence/définition + attribut.
 * Au-delà des bornes, la phrase est ignorée (comptée) — honnêteté. */
const REGEX_FAIT =
  /^([A-ZÀ-ÖØ-Þ].{1,88}?)\s+(est|sont|désigne|signifie|consiste|correspond)\s+([^.!?]{10,600})[.!?]?$/;

export function extraireFaits(texte: string): Array<{ sujet: string; fait: string }> {
  const faits: Array<{ sujet: string; fait: string }> = [];
  for (const paragraphe of texte.split(/\n+/)) {
    for (const phrase of paragraphe.split(/(?<=[.!?])\s+/)) {
      const m = REGEX_FAIT.exec(phrase.trim());
      if (m) faits.push({ sujet: m[1].trim(), fait: phrase.trim() });
    }
  }
  return faits;
}

function questionDeFait(sujet: string): string {
  return `Que sait-on sur ${sujet} ?`;
}

// ─── CODE (blocs clôturés) ───────────────────────────────────────────────────

/** Extrait les blocs de code clôturés ```lang … ``` avec la ligne
 * explicative qui les précède (question dérivée). */
export function extraireBlocsCode(
  texte: string,
): Array<{ lang: string; code: string; explication: string }> {
  const blocs: Array<{ lang: string; code: string; explication: string }> = [];
  const lignes = texte.split("\n");
  let i = 0;
  while (i < lignes.length) {
    const ouverture = /^\s*```([\w+#-]*)\s*$/.exec(lignes[i] ?? "");
    if (!ouverture) {
      i += 1;
      continue;
    }
    const lang = ouverture[1] ?? "";
    const indexOuverture = i;
    const corps: string[] = [];
    i += 1;
    while (i < lignes.length && !/^\s*```\s*$/.test(lignes[i] ?? "")) {
      corps.push(lignes[i] ?? "");
      i += 1;
    }
    if (i >= lignes.length) {
      // Bloc jamais clôturé : ignoré par l'appelant (compté).
      break;
    }
    i += 1;
    // Ligne explicative : la dernière ligne NON VIDE qui précède l'OUVERTURE
    // du bloc (jusqu'à 4 lignes en arrière) — question dérivée du code.
    let explication = "";
    for (let j = indexOuverture - 1; j >= 0 && j >= indexOuverture - 4; j -= 1) {
      const ligne = (lignes[j] ?? "").trim();
      if (ligne.length === 0 || ligne.startsWith("```")) break;
      explication = ligne;
    }
    blocs.push({ lang, code: corps.join("\n").trim(), explication });
  }
  return blocs;
}

function questionDeCode(lang: string, explication: string): string {
  const base = explication.length >= 6 ? explication : "Exemple de code";
  const suffixe = lang ? ` (${lang})` : "";
  return `${base}${suffixe}`.slice(0, MAX_QUESTION_UNITES);
}

// ─── EXTRACTION COMPLÈTE D'UNE RESSOURCE ─────────────────────────────────────

function pairesDepuisDataset(
  format: string,
  contenu: string,
): { paires: PaireBrute[]; avertissements: string[] } {
  const resultat = parserDatasetGen3(format, contenu);
  return { paires: resultat.paires, avertissements: resultat.avertissements };
}

/** Détecte un format dataset structuré par le nom de ressource (json/jsonl/csv). */
function formatDepuisNom(ressource: string): string | null {
  const nom = ressource.toLowerCase();
  if (nom.endsWith(".jsonl")) return "jsonl";
  if (nom.endsWith(".json")) return "json";
  if (nom.endsWith(".csv")) return "csv";
  return null;
}

/**
 * Extraction complète : une ressource → unités de connaissance.
 * Ordre d'essai (déterministe) :
 *   1. format dataset structuré (nom .json/.jsonl/.csv OU contenu JSON parseable) ;
 *   2. blocs Q/A du texte ;
 *   3. faits de définition (seulement si peu de paires Q/A — bruit évité) ;
 *   4. blocs de code clôturés.
 * Les empreintes dédupliquent les unités de CETTE ressource.
 */
export function extraireUnitesConnaissance(ressource: {
  titre: string;
  contenu: string;
  origine: OrigineRessource;
}): ResultatExtraction {
  const avertissements: string[] = [];
  const brut = ressource.contenu;
  if (nettoyerTexte(brut).length === 0) {
    return {
      unites: [],
      elements: 0,
      ignores: 0,
      avertissements: ["Ressource vide : rien à extraire."],
      octetsTraites: 0,
    };
  }
  const tronquee = brut.length > MAX_OCTETS_RESSOURCE;
  const texte = nettoyerTexte(tronquee ? brut.slice(0, MAX_OCTETS_RESSOURCE) : brut);
  if (tronquee) {
    avertissements.push(
      `Ressource « ${ressource.titre} » tronquée au plafond ${Math.round(MAX_OCTETS_RESSOURCE / (1024 * 1024))} Mo.`,
    );
  }
  const octetsTraites = Buffer.byteLength(texte, "utf-8");

  const vues = new Set<string>();
  const unites: UniteConnaissance[] = [];
  let elements = 0;
  let ignores = 0;

  const pousser = (u: UniteConnaissance | null, cleDedup: string): void => {
    elements += 1;
    if (!u) {
      ignores += 1;
      return;
    }
    if (vues.has(u.empreinte) || vues.has(cleDedup)) {
      // Doublon INTERNE : compté honnêtement, jamais ajouté deux fois.
      ignores += 1;
      return;
    }
    vues.add(u.empreinte);
    vues.add(cleDedup);
    unites.push(u);
  };

  // 1. Dataset structuré (fichier nommé json/jsonl/csv, ou contenu JSON
  //    parseable même sans extension — les datasets collés sont admis).
  const formatDetecte = formatDepuisNom(ressource.titre) ?? (/^\s*[[{]/.test(texte) ? "json" : null);
  if (formatDetecte) {
    const { paires, avertissements: avDataset } = pairesDepuisDataset(formatDetecte, texte);
    avertissements.push(...avDataset);
    for (const paire of paires) {
      pousser(
        unité("qa", paire.question, paire.reponse, ressource.titre, ressource.origine),
        empreinte128(paire.question),
      );
    }
    if (paires.length > 0) {
      avertissements.push(
        `Dataset « ${ressource.titre} » : ${paires.length} paire(s) question/réponse retenue(s) (format ${formatDetecte}).`,
      );
      return { unites, elements, ignores, avertissements, octetsTraites };
    }
    // Un fichier .json/.csv sans paire exploitable : on poursuit l'extraction
    // texte (honnêteté : le contenu reste traité, l'avertissement reste).
    avertissements.push(
      `Fichier « ${ressource.titre} » (${formatDetecte}) sans paire exploitable : extraction texte appliquée.`,
    );
  }

  // 2. Blocs Q/A du texte.
  for (const paire of extrairePairesTexte(texte)) {
    pousser(
      unité("qa", paire.question, paire.reponse, ressource.titre, ressource.origine),
      empreinte128(paire.question),
    );
  }

  // 3. Faits de définition (uniquement si peu de paires Q/A : les documents
  //    structurés en Q/A n'ont pas besoin de faits dérivés — bruit évité).
  if (unites.length < 4) {
    for (const { sujet, fait } of extraireFaits(texte)) {
      pousser(
        unité("fait", questionDeFait(sujet), fait, ressource.titre, ressource.origine),
        empreinte128(fait),
      );
    }
  }

  // 4. Blocs de code clôturés.
  if (/^\s*```/m.test(texte)) {
    for (const bloc of extraireBlocsCode(texte)) {
      if (bloc.code.length === 0) {
        elements += 1;
        ignores += 1;
        continue;
      }
      pousser(
        unité("code", questionDeCode(bloc.lang, bloc.explication), bloc.code, ressource.titre, ressource.origine),
        empreinte128(bloc.code),
      );
    }
  }

  if (unites.length === 0) {
    avertissements.push(
      `Aucune unité exploitable dans « ${ressource.titre} » : fournissez des blocs « Q: / A: », des définitions claires (« X est … ») ou des paires json/jsonl/csv.`,
    );
  }
  return { unites, elements, ignores, avertissements, octetsTraites };
}

/** Fusionne plusieurs extractions (une par ressource) en corpus dédupliqué. */
export function fusionnerExtractions(resultats: readonly ResultatExtraction[]): {
  unites: UniteConnaissance[];
  elements: number;
  ignores: number;
  avertissements: string[];
  doublons: number;
} {
  const vues = new Set<string>();
  const unites: UniteConnaissance[] = [];
  let doublons = 0;
  let elements = 0;
  let ignores = 0;
  const avertissements: string[] = [];
  for (const r of resultats) {
    elements += r.elements;
    ignores += r.ignores;
    avertissements.push(...r.avertissements);
    for (const u of r.unites) {
      if (vues.has(u.empreinte)) {
        doublons += 1;
        continue;
      }
      vues.add(u.empreinte);
      unites.push(u);
    }
  }
  return { unites, elements, ignores, avertissements, doublons };
}

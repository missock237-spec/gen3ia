import "server-only";

import { z } from "zod";

import type { ToolDefinition } from "../types";

/**
 * OUTIL `code.inspect` — analyse statique LÉGÈRE d'un snippet.
 *
 * 100 % déterministe, sans réseau, sans exécution de code : détection de
 * langage (html/css/js/ts/json), erreurs de syntaxe de base (chaînes et
 * commentaires non terminés, délimiteurs déséquilibrés avec n° de ligne,
 * balises HTML non fermées/orphelines, JSON invalide avec position) et
 * comptages honnêtes (fonctions, classes, balises, délimiteurs).
 *
 * HONNÊTETÉ : c'est une analyse LÉGÈRE — elle ne remplace pas un parseur
 * complet (pas de grammaire JS/TS, pas de résolution de types). Les erreurs
 * signalées sont des erreurs STRUCTURELLES certaines, pas des diagnostics
 * complets.
 */

const CONTENU_MAX_CARACTERES = 100_000;

const LANGAGES = ["html", "css", "js", "ts", "json"] as const;

const EntreeCodeInspect = z.object({
  contenu: z.string().max(CONTENU_MAX_CARACTERES),
  langage: z.enum(LANGAGES).optional(),
});

export type LangageDetecte = (typeof LANGAGES)[number];

export interface ErreurAnalyse {
  message: string;
  ligne?: number;
  colonne?: number;
}

export interface StatsCodeInspect {
  fonctions: number;
  classes: number;
  lignes: number;
  caracteres: number;
  accoladesOuvertes: number;
  accoladesFermees: number;
  parenthesesOuvertes: number;
  parenthesesFermees: number;
  crochetsOuverts: number;
  crochetsFermes: number;
  equilibre: boolean;
}

export interface StatsHtml {
  balisesOuvrantes: number;
  balisesFermantes: number;
  balisesAutoFermantes: number;
  balisesNonFermees: string[];
  balisesOrphelines: string[];
}

export interface SortieCodeInspect {
  langage: LangageDetecte;
  /** Vrai si le langage a été imposé en entrée (détection court-circuitée). */
  langageImpose: boolean;
  valide: boolean;
  erreurs: ErreurAnalyse[];
  stats: StatsCodeInspect;
  /** Présent uniquement pour le langage html. */
  html?: StatsHtml;
  /** Remarques honnêtes (limites de l'analyse, hypothèses de détection). */
  avis: string[];
}

/* ------------------------------------------------------------------ */
/* Détection de langage                                               */
/* ------------------------------------------------------------------ */

const MOTS_CLES_TS =
  /(?:\binterface\s+\w+|\btype\s+\w+\s*[=<{]|:\s*(?:string|number|boolean|any|unknown|never|void)\b|\breadonly\b|\bimplements\b|\benum\b|\bas\s+(?:const|\w+Decl)|<[A-Z]\w*>\()/;
const MOTS_CLES_JS = /\b(?:function|const|let|var|return|=>|class)\b/;
/**
 * Heuristique CSS : règle @… OU bloc { … } contenant une déclaration
 * terminée par « ; » (un objet JS « { a: 1 } » n'a pas de point-virgule —
 * discrimination volontairement simple, le langage peut être imposé).
 */
const REGEX_CSS =
  /@(?:media|import|keyframes|font-face|supports|charset)\b|\{[^{}]*:[^{}]*;[^{}]*\}/;

export function detecterLangage(contenu: string): { langage: LangageDetecte; avis: string } {
  const nettoye = contenu.trim();
  if (!nettoye) return { langage: "js", avis: "contenu vide : langage « js » par défaut, aucun diagnostic pertinent" };
  if (/^<!doctype\s+html/i.test(nettoye) || /<\/[a-zA-Z][a-zA-Z0-9-]*>/.test(nettoye) || /<[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?>/.test(nettoye)) {
    return { langage: "html", avis: "" };
  }
  if (nettoye.startsWith("{") || nettoye.startsWith("[")) {
    try {
      JSON.parse(nettoye);
      return { langage: "json", avis: "" };
    } catch {
      // Un objet JS valide n'est pas du JSON valide : on continue.
    }
  }
  if (MOTS_CLES_TS.test(nettoye)) return { langage: "ts", avis: "" };
  if (!MOTS_CLES_JS.test(nettoye) && REGEX_CSS.test(nettoye)) return { langage: "css", avis: "" };
  return { langage: "js", avis: "" };
}

/* ------------------------------------------------------------------ */
/* Nettoyage : chaînes et commentaires (scanner à états)              */
/* ------------------------------------------------------------------ */

interface ResultatNettoyage {
  /** Code avec chaînes/commentaires remplacés par des espaces (lignes gardées). */
  nettoye: string;
  erreurs: ErreurAnalyse[];
}

/** Scanner caractère par caractère pour JS/TS/CSS (chaînes, gabarits, commentaires). */
function nettoyerCode(contenu: string): ResultatNettoyage {
  const sorti: string[] = [];
  const erreurs: ErreurAnalyse[] = [];
  let ligne = 1;
  let colonne = 1; // suivi de colonne pour les futurs messages positionnés

  let i = 0;
  const n = contenu.length;

  type Etat = "code" | "simple" | "double" | "gabarit" | "ligne" | "bloc";
  const pileEtats: Etat[] = ["code"];
  const profondeursGabarits: number[] = [];

  while (i < n) {
    const etat = pileEtats[pileEtats.length - 1];
    const c = contenu[i];
    const suivant = i + 1 < n ? contenu[i + 1] : "";

    if (c === "\n") {
      sorti.push("\n");
      ligne += 1;
      colonne = 1;

      i += 1;
      if (etat === "ligne") pileEtats.pop();
      continue;
    }

    if (etat === "ligne") {
      sorti.push(" ");

      i += 1;
      continue;
    }

    if (etat === "bloc") {
      if (c === "*" && suivant === "/") {
        sorti.push("  ");


        pileEtats.pop();
      } else {
        sorti.push(" ");
        i += 1;

      }
      continue;
    }

    if (etat === "simple" || etat === "double") {
      if (c === "\\") {
        sorti.push("  ");


        continue;
      }
      const fin = etat === "simple" ? "'" : '"';
      if (c === fin) {
        sorti.push(fin);

        i += 1;
        pileEtats.pop();
        continue;
      }
      sorti.push(" ");
      i += 1;

      continue;
    }

    if (etat === "gabarit") {
      if (c === "\\") {
        sorti.push("  ");


        continue;
      }
      if (c === "`") {
        sorti.push("`");

        i += 1;
        pileEtats.pop();
        continue;
      }
      if (c === "$" && suivant === "{") {
        sorti.push("  ");


        pileEtats.push("code");
        profondeursGabarits.push(1);
        continue;
      }
      sorti.push(" ");
      i += 1;

      continue;
    }

    // État « code ».
    if (c === "/" && suivant === "/") {
      sorti.push("  ");
      i += 2;

      pileEtats.push("ligne");
      continue;
    }
    if (c === "/" && suivant === "*") {
      sorti.push("  ");
      i += 2;

      pileEtats.push("bloc");
      continue;
    }
    if (c === "'") {
      sorti.push("'");
      i += 1;

      pileEtats.push("simple");
      continue;
    }
    if (c === '"') {
      sorti.push('"');
      i += 1;

      pileEtats.push("double");
      continue;
    }
    if (c === "`") {
      sorti.push("`");
      i += 1;

      pileEtats.push("gabarit");
      continue;
    }
    if (c === "{" && profondeursGabarits.length > 0) {
      profondeursGabarits[profondeursGabarits.length - 1] += 1;
    }
    if (c === "}" && profondeursGabarits.length > 0) {
      const profondeur = profondeursGabarits[profondeursGabarits.length - 1] - 1;
      if (profondeur === 0) {
        profondeursGabarits.pop();
        pileEtats.pop(); // retour dans le gabarit
        sorti.push("}");
        i += 1;

        continue;
      }
      profondeursGabarits[profondeursGabarits.length - 1] = profondeur;
    }
    sorti.push(c);
    i += 1;
    colonne += 1;
  }

  // Fin de fichier : états encore ouverts = erreurs de syntaxe certaines.
  for (const etatRestant of pileEtats) {
    if (etatRestant === "simple") erreurs.push({ message: "chaîne « ' » non terminée", ligne, colonne });
    if (etatRestant === "double") erreurs.push({ message: "chaîne « \" » non terminée", ligne, colonne });
    if (etatRestant === "gabarit") erreurs.push({ message: "gabarit « ` » non terminé", ligne, colonne });
    if (etatRestant === "bloc") erreurs.push({ message: "commentaire /* non terminé", ligne });
  }

  return { nettoye: sorti.join(""), erreurs };
}

/* ------------------------------------------------------------------ */
/* Comptages de délimiteurs                                            */
/* ------------------------------------------------------------------ */

interface ComptageDelimiteurs {
  stats: Pick<StatsCodeInspect, "accoladesOuvertes" | "accoladesFermees" | "parenthesesOuvertes" | "parenthesesFermees" | "crochetsOuverts" | "crochetsFermes" | "equilibre">;
  erreurs: ErreurAnalyse[];
}

function compterDelimiteurs(nettoye: string): ComptageDelimiteurs {
  const paires: Array<{ ouvrant: string; fermant: string; nom: string; ouverture: string; fermeture: string }> = [
    { ouvrant: "{", fermant: "}", nom: "accolade", ouverture: "accoladesOuvertes", fermeture: "accoladesFermees" },
    { ouvrant: "(", fermant: ")", nom: "parenthèse", ouverture: "parenthesesOuvertes", fermeture: "parenthesesFermees" },
    { ouvrant: "[", fermant: "]", nom: "crochet", ouverture: "crochetsOuverts", fermeture: "crochetsFermes" },
  ];
  const stats = {
    accoladesOuvertes: 0,
    accoladesFermees: 0,
    parenthesesOuvertes: 0,
    parenthesesFermees: 0,
    crochetsOuverts: 0,
    crochetsFermes: 0,
  };
  const erreurs: ErreurAnalyse[] = [];

  // Lignes par position pour numéroter les erreurs.
  const lignesParPosition: number[] = [];
  let numeroLigne = 1;
  for (const c of nettoye) {
    if (c === "\n") numeroLigne += 1;
    lignesParPosition.push(numeroLigne);
  }

  for (const paire of paires) {
    let profondeur = 0;
    for (let i = 0; i < nettoye.length; i += 1) {
      const c = nettoye[i];
      if (c === paire.ouvrant) {
        profondeur += 1;
        stats[paire.ouverture as keyof typeof stats] += 1;
      } else if (c === paire.fermant) {
        stats[paire.fermeture as keyof typeof stats] += 1;
        profondeur -= 1;
        if (profondeur < 0) {
          erreurs.push({ message: `${paire.nom} fermante « ${paire.fermant} » sans ouvrante`, ligne: lignesParPosition[i] });
          profondeur = 0;
        }
      }
    }
    if (profondeur > 0) {
      erreurs.push({ message: `${profondeur} ${paire.nom}${profondeur > 1 ? "s" : ""} ouvrante${profondeur > 1 ? "s" : ""} « ${paire.ouvrant} » sans fermante`, ligne: lignesParPosition[nettoye.length - 1] ?? 1 });
    }
  }

  const equilibre =
    stats.accoladesOuvertes === stats.accoladesFermees &&
    stats.parenthesesOuvertes === stats.parenthesesFermees &&
    stats.crochetsOuverts === stats.crochetsFermes;
  return { stats: { ...stats, equilibre }, erreurs };
}

/* ------------------------------------------------------------------ */
/* Analyse HTML                                                        */
/* ------------------------------------------------------------------ */

const BALISES_VIDES = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

interface AnalyseHtml {
  erreurs: ErreurAnalyse[];
  stats: StatsHtml;
}

function analyserHtml(contenu: string): AnalyseHtml {
  const erreurs: ErreurAnalyse[] = [];
  const stats: StatsHtml = {
    balisesOuvrantes: 0,
    balisesFermantes: 0,
    balisesAutoFermantes: 0,
    balisesNonFermees: [],
    balisesOrphelines: [],
  };

  // Commentaires d'abord (<!-- -->) — non terminé = erreur certaine.
  let source = contenu;
  const ouvertureCommentaire = source.indexOf("<!--");
  if (ouvertureCommentaire >= 0 && source.indexOf("-->", ouvertureCommentaire + 4) < 0) {
    erreurs.push({ message: "commentaire <!-- non terminé" });
    source = source.slice(0, ouvertureCommentaire);
  } else {
    source = source.replace(/<!--[\s\S]*?-->/g, "");
  }

  const pile: string[] = [];
  const regexBalise = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>])*?)>/g;
  let correspondance: RegExpExecArray | null;
  while ((correspondance = regexBalise.exec(source)) !== null) {
    const brut = correspondance[0];
    const nom = correspondance[1].toLowerCase();
    const attributs = correspondance[2] ?? "";
    const fermeture = brut.startsWith("</");
    const autoFermeture = attributs.trimEnd().endsWith("/") || BALISES_VIDES.has(nom);

    if (fermeture) {
      stats.balisesFermantes += 1;
      const sommet = pile[pile.length - 1];
      if (sommet === nom) {
        pile.pop();
      } else if (pile.includes(nom)) {
        // Mal imbriquée : on ferme jusqu'à la balise correspondante. Les
        // balises traversées sont des balises NON fermées (stat + erreur).
        const indexPile = pile.lastIndexOf(nom);
        for (let k = pile.length - 1; k >= indexPile; k -= 1) {
          stats.balisesNonFermees.push(pile[k]);
          erreurs.push({ message: `balise « <${pile[k]}> » non fermée avant « </${nom}> »` });
        }
        pile.length = indexPile;
      } else {
        stats.balisesOrphelines.push(nom);
        erreurs.push({ message: `balise fermante orpheline « </${nom}> » (aucune ouverture correspondante)` });
      }
    } else {
      stats.balisesOuvrantes += 1;
      if (autoFermeture) stats.balisesAutoFermantes += 1;
      else pile.push(nom);
    }
  }

  for (const nomRestant of pile) {
    stats.balisesNonFermees.push(nomRestant);
    erreurs.push({ message: `balise « <${nomRestant}> » jamais fermée` });
  }
  return { erreurs, stats };
}

/* ------------------------------------------------------------------ */
/* Analyse JSON                                                        */
/* ------------------------------------------------------------------ */

function ligneColonneDepuisPosition(contenu: string, position: number): { ligne: number; colonne: number } {
  const avant = contenu.slice(0, Math.max(0, position));
  const morceaux = avant.split("\n");
  return { ligne: morceaux.length, colonne: (morceaux[morceaux.length - 1]?.length ?? 0) + 1 };
}

/* ------------------------------------------------------------------ */
/* Outil                                                              */
/* ------------------------------------------------------------------ */

export const outilCodeInspect: ToolDefinition<z.infer<typeof EntreeCodeInspect>, SortieCodeInspect> = {
  id: "code.inspect",
  name: "code.inspect",
  description:
    "Analyse statique LÉGÈRE d'un snippet : détecte le langage (html/css/js/ts/json), signale les erreurs de syntaxe de base (chaîne/commentaire non terminé, accolades/parenthèses/crochets déséquilibrés avec n° de ligne, balises HTML non fermées ou orphelines, JSON invalide avec position) et compte les fonctions/classes/balises. " +
    "Input : { contenu: \"…code…\", langage?: \"html\"|\"css\"|\"js\"|\"ts\"|\"json\" } (langage auto-détecté si absent). " +
    "Ne remplace PAS un parseur complet ni un linter : erreurs STRUCTURELLES certaines seulement, aucun diagnostic de type. Aucune exécution de code, aucun réseau.",
  category: "code",
  risk: "low",
  inputSchema: EntreeCodeInspect,
  async execute(input) {
    const contenu = input.contenu;
    const avis: string[] = [];
    let langage: LangageDetecte;
    let langageImpose = false;

    if (input.langage) {
      langage = input.langage;
      langageImpose = true;
    } else {
      const detection = detecterLangage(contenu);
      langage = detection.langage;
      if (detection.avis) avis.push(detection.avis);
    }

    const erreurs: ErreurAnalyse[] = [];
    let stats: StatsCodeInspect = {
      fonctions: 0,
      classes: 0,
      lignes: contenu.split("\n").length,
      caracteres: contenu.length,
      accoladesOuvertes: 0,
      accoladesFermees: 0,
      parenthesesOuvertes: 0,
      parenthesesFermees: 0,
      crochetsOuverts: 0,
      crochetsFermes: 0,
      equilibre: true,
    };
    let statsHtml: StatsHtml | undefined;

    if (langage === "json") {
      try {
        JSON.parse(contenu);
      } catch (erreur) {
        const message = erreur instanceof Error ? erreur.message : "JSON invalide";
        const erreurAnalyse: ErreurAnalyse = { message };
        const positionMatch = /position\s+(\d+)/.exec(message);
        const ligneColonneMatch = /line\s+(\d+)\s+column\s+(\d+)/.exec(message);
        if (ligneColonneMatch) {
          erreurAnalyse.ligne = Number(ligneColonneMatch[1]);
          erreurAnalyse.colonne = Number(ligneColonneMatch[2]);
        } else if (positionMatch) {
          const { ligne, colonne } = ligneColonneDepuisPosition(contenu, Number(positionMatch[1]));
          erreurAnalyse.ligne = ligne;
          erreurAnalyse.colonne = colonne;
        }
        erreurs.push(erreurAnalyse);
      }
      avis.push("analyse json : validité structurelle seule (JSON.parse) — aucun typage de schéma");
    } else if (langage === "html") {
      const analyse = analyserHtml(contenu);
      erreurs.push(...analyse.erreurs);
      statsHtml = analyse.stats;
      avis.push("balises vides (br, img, input…) comptées auto-fermées ; l'imbrication profonde n'est pas validée au-delà de l'appariement des balises");
    } else {
      // js / ts / css : chaînes + commentaires neutralisés puis comptages.
      const nettoyage = nettoyerCode(contenu);
      erreurs.push(...nettoyage.erreurs);
      const delimiteurs = compterDelimiteurs(nettoyage.nettoye);
      stats = { ...stats, ...delimiteurs.stats };
      erreurs.push(...delimiteurs.erreurs);
      if (langage === "css") {
        stats.fonctions = 0;
        stats.classes = 0;
        avis.push("analyse css : équilibre des accolades et chaînes seulement — pas de validation de sélecteurs");
      } else {
        const fonctionsDecl = (nettoyage.nettoye.match(/\bfunction\b/g) ?? []).length;
        const fleches = (nettoyage.nettoye.match(/=>/g) ?? []).length;
        stats.fonctions = fonctionsDecl + fleches;
        stats.classes = (nettoyage.nettoye.match(/\bclass\b/g) ?? []).length;
        avis.push("fonctions = déclarations « function » + flèches « => » (méthodes d'objet non comptées) — pas de grammaire complète, pas de vérification de types");
      }
    }

    return {
      langage,
      langageImpose,
      valide: erreurs.length === 0,
      erreurs,
      stats,
      ...(statsHtml ? { html: statsHtml } : {}),
      avis,
    };
  },
};

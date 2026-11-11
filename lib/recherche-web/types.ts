/* ------------------------------------------------------------------ */
/* MOTEUR DE RECHERCHE WEB TEMPS RÉEL gen3ia                           */
/* ------------------------------------------------------------------ */
/* Architecture demandée par le propriétaire (2026-11-11) :             */
/*   1. Moteurs de recherche   : DuckDuckGo, Bing, autres sources       */
/*      accessibles (SearXNG auto-hébergeable, Wikipédia en repli).     */
/*   2. Navigation web         : Playwright/Chromium quand disponible,  */
/*      sinon HTTP direct — le rendu JavaScript des pages est géré.     */
/*   3. Extraction et vérification : contenu, dates, sources, détection */
/*      des doublons (normalisation d'URL + similarité de contenu).     */
/*   4. Réponse intelligente   : analyse, comparaison, synthèse et      */
/*      citations des sources (contexte numéroté livré au chat).        */
/*                                                                      */
/* HONNÊTETÉ : aucun résultat n'est jamais inventé — un moteur qui      */
/* échoue est retiré de la fusion pour ce tour et l'échec est DIT.      */
/* ------------------------------------------------------------------ */

/** Un résultat brut renvoyé par UN moteur de recherche. */
export interface ResultatRecherche {
  /** Titre humain du résultat (nettoyé de tout balisage). */
  titre: string;
  /** URL directe du résultat (redirecteurs moteurs décodés). */
  url: string;
  /** Extrait proposé par le moteur (snippet). */
  extrait?: string;
  /** Date de publication annoncée par le moteur, si elle l'est. */
  publieLe?: string;
  /** Nom du moteur qui a fourni le résultat (« duckduckgo », « bing »…). */
  moteur: string;
}

/** Un résultat vérifié, fusionné et dédoublonné (sortie du moteur). */
export interface ResultatVerifie extends ResultatRecherche {
  /** Nombre de moteurs distincts qui ont trouvé ce même lien. */
  confirmations: number;
  /** URL canonique après normalisation (tracking retiré). */
  urlCanonique: string;
  /** Date de publication trouvée dans la page/métadonnées, si extraite. */
  datePublication?: string;
  /** Crédibilité du domaine : « elevée » | « moyenne » | « inconnue ». */
  credibilite: "elevée" | "moyenne" | "inconnue";
  /** Score de fusion interne (relevance + confirmations + crédibilité). */
  score: number;
}

/** Le contenu d'une page réellement lue (extraction structurée). */
export interface PageExtraite {
  url: string;
  /** URL après redirection, si le serveur en a imposé une. */
  urlFinale?: string;
  titre?: string;
  /** Date de publication extraite des métadonnées (JSON-LD, OpenGraph…). */
  datePublication?: string;
  auteur?: string;
  /** Texte principal lisible de la page (tronqué). */
  texte: string;
  /** Description courte (meta description / OpenGraph). */
  description?: string;
  /** « http » (fetch direct) ou « playwright » (rendu Chromium réel). */
  methode: "http" | "playwright";
  /** Nombre de caractères extraits avant troncature. */
  caracteresBruts: number;
}

/** Diagnostic d'un tour de recherche — dit honnêtement à l'utilisateur. */
export interface DiagnosticRecherche {
  /** Moteurs interrogés pour ce tour. */
  moteursInterroges: string[];
  /** Moteurs qui ont répondu des résultats exploitables. */
  moteursOperatifs: string[];
  /** Moteurs en échec + raison courte (affiché si tout échoue). */
  moteursEnEchec: Array<{ moteur: string; raison: string }>;
  /** Résultats bruts reçus avant dédoublonnage. */
  resultatsBruts: number;
  /** Résultats uniques conservés après dédoublonnage. */
  resultatsUniques: number;
  /** Doublons de contenu retirés (même page, extraits quasi identiques). */
  doublonsRetires: number;
}

/** Sortie complète du moteur de recherche web temps réel. */
export interface ReponseRechercheWeb {
  query: string;
  resultats: ResultatVerifie[];
  diagnostic: DiagnosticRecherche;
  /** Pages effectivement lues (extraction réelle), si demandé. */
  pages?: Array<PageExtraite & { /** URL du résultat d'origine auquel la page est rattachée. */ source: string }>;
}

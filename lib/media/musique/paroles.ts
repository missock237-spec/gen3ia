/**
 * GEN3IA MUSIQUE — TITRE + PAROLES DE CHANSON (exigence utilisateur 2026-11-14).
 *
 * « gen3 doit comprendre le titre si l'utilisateur le lui a donné ; il écrit
 * les paroles en se basant sur ce titre puis crée un audio de ce script
 * musical avec paroles et voix humaine ; si l'utilisateur n'a pas donné de
 * titre, gen3 doit donner un titre lui-même puis suivre les mêmes étapes. »
 *
 * CHAÎNE :
 *  1. extraireTitreChanson — titre DONNÉ détecté déterministement (français
 *     naturel : « titre : », « intitulée », « appelée », « qui s'appelle »,
 *     guillemets français/anglais) ;
 *  2. inventerTitreChanson — sinon, titre INVENTÉ par gen3 à partir du
 *     thème de la demande (déterministe, honnête) ;
 *  3. ecrireParolesChanson — PAROLES écrites SUR CE TITRE : moteur de texte
 *     gen3 (generate) avec structure stricte (intro, couplets, refrain,
 *     outro), puis PARSING tolérant + repli déterministe (paroles simple
 *     construites sur le titre) — jamais d'échec de plus.
 *
 * HONNÊTETÉ : la provenance des paroles (moteur gen3 ou repli déterministe)
 * est toujours rapportée à l'appelant (`source`).
 */

/** Blocs de paroles d'une chanson — structure chantée canonique. */
export interface ParolesChanson {
  titre: string;
  intro: string[];
  couplets: string[][];
  refrain: string[];
  outro: string[];
  /** "moteur-gen3" (LLM) | "repli-deterministe" (gabarit honnête). */
  source: "moteur-gen3" | "repli-deterministe";
}

/* ------------------------------------------------------------------ */
/* 1) TITRE DONNÉ — détection déterministe (français naturel)          */
/* ------------------------------------------------------------------ */

/**
 * Détecte le titre CITÉ par l'utilisateur. Ordre de priorité : marqueur
 * explicite (« titre : »), verbes d'appellation (intitulée/appelée/nommée/
 * s'appelle), guillemets français ou anglais autour d'un segment court.
 * Retourne null quand aucun titre n'est cité (gen3 en inventera un).
 */
export function extraireTitreChanson(demande: string): string | null {
  const texte = demande.replace(/\s+/g, " ").trim();
  if (texte.length < 3) return null;

  // Marqueurs explicites : « titre : X », « intitulée X », « appelée X »,
  // « nommée X », « qui s'appelle X », « appelez-la X », « pour X » (titre).
  const marqueurs = [
    /\btitre\s*(?:est|:|=)\s*["«“]?([^"»”]+)["»”]?/i,
    /\b(?:intitul[ée]e?|appel[ée]e?|nomm[ée]e?|baptis[ée]e?)\s*["«“]?([^"»”.!?]+)["»”]?/i,
    /\b(?:qui\s+)?s'appelle\s*["«“]?([^"»”.!?]+)["»”]?/i,
    /\bappelez(?:-la|-le|-l')?\s*["«“]?([^"»”.!?]+)["»”]?/i,
    /\bdont\s+le\s+titre\s+(?:est|soit)\s*["«“]?([^"»”.!?]+)["»”]?/i,
  ];
  for (const motif of marqueurs) {
    const trouve = motif.exec(texte);
    if (trouve?.[1]) {
      const titre = nettoieTitre(trouve[1]);
      if (titre) return titre;
    }
  }

  // Guillemets (français ou anglais) — un segment COURT cité est un titre
  // probable (une demande complète entre guillemets n'est PAS un titre).
  const cotes = /["«“]([^"»”]{2,60})["»”]/.exec(texte);
  if (cotes?.[1]) {
    const titre = nettoieTitre(cotes[1]);
    if (titre) return titre;
  }

  return null;
}

/** Nettoie un titre brut : trim, longueur bornée, pas de queue de phrase.
 *  Les ARTICLES font partie du titre (« Le Pont », « La Mer ») — jamais
 *  retirés. */
function nettoieTitre(brut: string): string | null {
  let titre = brut
    .replace(/\s+/g, " ")
    .replace(/[\s,;:]+$/, "")
    .trim();
  if (titre.length < 2 || titre.length > 60) return null;
  // Une queue de demande n'est pas un titre : on coupe aux connecteurs.
  titre = titre.split(/\s+(?:et\s+(?:de\s+)?(?:crée|génère|fais|puis)|de\s+\d+\s*(?:min|s\b|sec|secondes)|pendant\s+\d+)/i)[0]?.trim() ?? titre;
  if (titre.length < 2 || titre.length > 60) return null;
  // Casse de titre : première lettre en majuscule (le reste est respecté).
  return titre.charAt(0).toUpperCase() + titre.slice(1);
}

/* ------------------------------------------------------------------ */
/* 2) TITRE INVENTÉ — gen3 choisit un titre (déterministe, honnête)    */
/* ------------------------------------------------------------------ */

/** Mots vides courants (fr) pour extraire le thème d'une demande. */
const MOTS_VIDES = new Set([
  "crée", "cree", "créer", "creer", "génère", "genere", "generer", "fais", "fait",
  "une", "un", "des", "du", "de", "la", "le", "les", "l", "d", "pour", "moi",
  "musique", "chanson", "morceau", "chansons", "musiques", "titre", "son",
  "minute", "minutes", "min", "secondes", "second", "sec", "s",
  "avec", "dans", "sur", "au", "aux", "à", "a", "et", "ou", "qui", "que",
  "calme", "détendu", "detendu", "vite", "lentement", "beau", "belle",
  "style", "genre", "please", "s'il", "il", "te", "plait", "plait",
]);

/**
 * Invente un titre à partir du thème détecté de la demande : les mots
 * porteurs (hors mots vides, style et durée) sont capitalisés en un titre
 * court. Déterministe — même demande → même titre (cache de contenu R2).
 */
export function inventerTitreChanson(demande: string): string {
  const mots = demande
    .toLowerCase()
    .replace(/[^a-zà-öø-ÿ0-9'\s-]/g, " ")
    .split(/\s+/)
    .filter((m) => m.length > 2 && !MOTS_VIDES.has(m) && !/^\d+$/.test(m))
    .slice(0, 4);
  const theme = mots.length > 0 ? mots : ["nouveaux", "horizons"];
  return theme
    .map((m) => m.charAt(0).toUpperCase() + m.slice(1))
    .join(" ")
    .slice(0, 48);
}

/* ------------------------------------------------------------------ */
/* 3) PAROLES — moteur gen3 d'abord, repli déterministe ensuite        */
/* ------------------------------------------------------------------ */

/** Garde une ligne chantable : courte, sans indentation, non vide. */
function ligneChantable(ligne: unknown): string | null {
  if (typeof ligne !== "string") return null;
  const l = ligne.replace(/\s+/g, " ").trim();
  if (l.length < 2 || l.length > 90) return null;
  return l;
}

/** Valide les blocs renvoyés par le moteur (tolérant, borné). */
function parolesDepuisJson(brut: unknown, titre: string): ParolesChanson | null {
  if (typeof brut !== "object" || brut === null) return null;
  const j = brut as Record<string, unknown>;
  const intro = Array.isArray(j.intro) ? j.intro.map(ligneChantable).filter((x): x is string => x !== null).slice(0, 3) : [];
  const coupletsBruts = Array.isArray(j.couplets) ? j.couplets : [];
  const couplets = coupletsBruts
    .slice(0, 3)
    .map((c) => (Array.isArray(c) ? c.map(ligneChantable).filter((x): x is string => x !== null).slice(0, 5) : []))
    .filter((c) => c.length >= 2);
  const refrain = Array.isArray(j.refrain) ? j.refrain.map(ligneChantable).filter((x): x is string => x !== null).slice(0, 5) : [];
  const outro = Array.isArray(j.outro) ? j.outro.map(ligneChantable).filter((x): x is string => x !== null).slice(0, 3) : [];
  if (couplets.length === 0 || refrain.length < 2 || intro.length === 0) return null;
  return { titre, intro, couplets, refrain, ...(outro.length > 0 ? { outro } : { outro: [titre] }), source: "moteur-gen3" };
}

/** Repli déterministe : paroles simple construites SUR le titre (honnête). */
export function parolesDeterministes(titre: string): ParolesChanson {
  return {
    titre,
    intro: [`Voici l'histoire de ${titre}`, "Une histoire à écouter cœur ouvert"],
    couplets: [
      [
        `${titre}, résonne dans ma tête`,
        `Les mots s'enchaînent, rien ne s'arrête`,
        "Chaque note raconte une étape",
        "La mélodie trace son chemin",
      ],
      [
        `${titre}, de l'aube au crépuscule`,
        "Le temps passe mais la musique reste",
        "Un refrain qui n'oublie rien",
        "Et qui nous emporte sans frein",
      ],
    ],
    refrain: [
      `${titre}, ${titre}`,
      "Chante-le encore une fois",
      `${titre}, ${titre}`,
      "La chanson ne meurt jamais",
    ],
    outro: [`${titre}… dans le silence`, `${titre}.`],
    source: "repli-deterministe",
  };
}

/** Prompt système de l'écriture (français, structure STRICTE). */
function promptParoles(titre: string, demande: string, styleLabel: string, humeur: string): string {
  return [
    `Tu es un auteur-compositeur français. Écris les paroles d'une chanson intitulée « ${titre} ».`,
    `Contexte de la demande : ${demande.slice(0, 300)}. Style musical : ${styleLabel}, humeur : ${humeur}.`,
    "RÉPONSE : UNIQUEMENT du JSON valide, sans markdown, selon exactement ce schéma :",
    '{"intro":["ligne","ligne"],"couplets":[["ligne","ligne","ligne","ligne"],["ligne","ligne","ligne","ligne"]],"refrain":["ligne","ligne","ligne","ligne"],"outro":["ligne","ligne"]}',
    "Contraintes : intro = 2 lignes courtes ; couplets = 2 blocs de 4 lignes ; refrain = 4 lignes (le titre y figure) ; outro = 2 lignes.",
    "Français simple, chantable, rimes cohérentes, pas de noms d'artistes réels, pas de commentaire.",
  ].join("\n");
}

/** Parse tolérant d'une réponse moteur (JSON direct ou embarqué). */
function extraireJson(candidat: string): unknown {
  const directe = candidat.trim();
  try {
    return JSON.parse(directe);
  } catch {
    // JSON embarqué dans du texte/markdown : première accolade équilibrée.
    const debut = directe.indexOf("{");
    const fin = directe.lastIndexOf("}");
    if (debut >= 0 && fin > debut) {
      try {
        return JSON.parse(directe.slice(debut, fin + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Écrit les paroles SUR le titre avec le moteur de texte gen3 ; repli
 * déterministe si le moteur échoue ou renvoie une structure invalide.
 * Jamais d'exception : la chanson se construit dans tous les cas.
 */
export async function ecrireParolesChanson(params: {
  titre: string;
  demande: string;
  styleLabel: string;
  humeur: string;
}): Promise<ParolesChanson> {
  try {
    const { generate } = await import("@/lib/ai/router");
    const reponse = await generate({
      task: "chat",
      messages: [
        { role: "user", content: promptParoles(params.titre, params.demande, params.styleLabel, params.humeur) },
      ],
      temperature: 0.8,
      maxTokens: 700,
    });
    const parse = parolesDepuisJson(extraireJson(reponse.text ?? ""), params.titre);
    if (parse) return parse;
  } catch {
    // Moteur indisponible / réponse invalide : repli déterministe ci-dessous.
  }
  return parolesDeterministes(params.titre);
}

/**
 * LA CONDITION PERMANENTE D'EXÉCUTION DE GEN3 (it.139 — demande propriétaire,
 * 2026-11-09) : « gen3 doit utiliser toutes les ressources qu'il détient et
 * doit déployer en permanence sans que l'utilisateur ne lui demande ; si
 * c'est du texte il doit utiliser ses connaissances plus sa réflexion pour
 * répondre ; si c'est de l'image il doit toujours générer des images
 * photoréalistes ; si c'est de la vidéo il doit générer des vidéos
 * réalistes ; si c'est de l'audio il doit toujours réaliser un audio
 * réaliste et optimal ; si c'est l'exécution d'une tâche en externe il doit
 * utiliser les ressources qu'il possède et réfléchir pour atteindre
 * l'objectif que l'utilisateur lui a donné. Pour toute requête d'un
 * utilisateur, gen3 doit réfléchir de lui-même avant de la résoudre. »
 *
 * CE MODULE EST LA SOURCE DE VÉRITÉ de la condition d'exécution :
 *  - injectée dans le prompt SYSTÈME du moteur de conversation
 *    (lib/domain/conversations/engine-chat.ts) — À CHAQUE tour, gen3 sait
 *    qu'il doit mobiliser tout ce qu'il détient, sans y être invité, et
 *    réfléchir par lui-même AVANT de résoudre ;
 *  - injectée dans le prompt système générique (RESPONSE_QUALITY_SYSTEM,
 *    lib/ai/response-quality.ts) — aucune surface générique n'y échappe ;
 *  - complémentaire de la vocation (lib/gen3/vocation.ts, it.59 : CE QUE
 *    gen3 a été créé pour faire) et du raisonnement humain (it.85 : données
 *    d'entraînement PP) — celle-ci est LE COMMENT impératif à chaque tâche.
 *
 * HONNÊTETÉ TECHNIQUE (règle zéro fantôme, cf. it.58) :
 *  - chaque `ressources[]` référence un nom RÉEL du registre GEN3IA_TOOLS
 *    (lib/tools/registry.ts) — le garde le vérifie ;
 *  - l'exigence de réalisme (image photoréaliste, vidéo réaliste, audio
 *    réaliste et optimal) est une exigence de MOBILISATION des moteurs
 *    RÉELS de la plateforme et de leurs meilleurs paramètres — elle ne
 *    promet JAMAIS une capacité ni une garantie au-delà du réel ;
 *  - le module est PUR (aucune dépendance, aucune IO, aucun "server-only")
 *    afin d'être partagé serveur (prompts, API) et tests.
 */

/** Une modalité d'exécution couverte par la condition permanente. */
export interface ModaliteExecution {
  /** Identifiant canonique kebab-case. */
  id: string;
  /** Libellé français de la modalité (formulation propriétaire normalisée). */
  label: string;
  /** Exigence impérative de gen3 DANS cette modalité (en « tu », lisible
   *  par gen3 lui-même dans son prompt système). */
  exigence: string;
  /** Ressources RÉELLES de la plateforme à mobiliser d'office dans cette
   *  modalité (registre GEN3IA_TOOLS — zéro fantôme, vérifié par le garde). */
  ressources: string[];
}

/**
 * LA CONDITION MAÎTRESSE — déclaration impérative permanente.
 * Wording aligné sur la demande propriétaire : TOUTES les ressources, EN
 * PERMANENCE, SANS qu'il soit nécessaire de le lui demander, et la
 * RÉFLEXION AUTONOME avant toute résolution.
 */
export const CONDITION_EXECUTION_GEN3 =
  "À CHAQUE tâche, sans exception, gen3 mobilise et déploie TOUTES les ressources qu'il détient — " +
  "base de connaissances, mémoire permanente, moteur neuronal, outils réels de la plateforme — " +
  "de sa propre initiative, en PERMANENCE, sans que l'utilisateur ait à le lui demander. " +
  "Pour TOUTE requête, gen3 réfléchit D'ABORD par lui-même : il analyse la demande, inventorie ce " +
  "qu'il possède, planifie, exécute puis vérifie — la réflexion précède la résolution, jamais l'inverse. " +
  "Il pousse chaque modalité vers son optimum réel : texte réfléchi, image photoréaliste, vidéo " +
  "réaliste, audio réaliste et optimal, tâche externe menée jusqu'à l'objectif donné.";

/** Les CINQ modalités, dans l'ordre énoncé par le propriétaire :
 *  texte → image → vidéo → audio → tâche externe. */
export const MODALITES_EXECUTION: readonly ModaliteExecution[] = [
  {
    id: "texte",
    label: "Texte",
    exigence:
      "si la tâche est du TEXTE (question, rédaction, analyse, synthèse) : tu réponds avec tes " +
      "CONNAISSANCES PLUS TA RÉFLEXION — tu raisonnes avant de répondre (hypothèses, étapes, " +
      "vérification), tu mobilises ta base de connaissances et ta mémoire, et tu rends une réponse " +
      "précise, structurée et vérifiable, jamais une réponse au fil de l'eau.",
    ressources: ["knowledge.search", "knowledge.graph", "memory.read", "web.search", "artifact.create"],
  },
  {
    id: "image",
    label: "Image",
    exigence:
      "si la tâche est une IMAGE : tu génères TOUJOURS avec l'exigence PHOTORÉALISTE — tu formules " +
      "la demande au moteur réel de la plateforme (image.generate) orientée réalisme maximal " +
      "(lumière, optique, textures, proportions, profondeur), tu choisis les meilleurs paramètres " +
      "disponibles et tu réfléchis la composition AVANT de générer ; jamais d'image paresseuse ou " +
      "artificiellement simplifiée quand le réalisme est atteignable.",
    ressources: ["image.generate", "media.analyze", "artifact.create"],
  },
  {
    id: "video",
    label: "Vidéo",
    exigence:
      "si la tâche est une VIDÉO : tu génères TOUJOURS avec l'exigence RÉALISTE — plan pensé avant " +
      "le déclenchement (mouvement naturel, rythme crédible, continuité, cadrage), meilleurs " +
      "paramètres du moteur réel (video.create), puis suivi et raffinement (video.status, " +
      "video.revise) jusqu'au rendu le plus réaliste atteignable ; jamais une vidéo lancée sans " +
      "réflexion ni laissée sans contrôle.",
    ressources: ["video.create", "video.status", "video.revise", "media.analyze", "artifact.create"],
  },
  {
    id: "audio",
    label: "Audio",
    exigence:
      "si la tâche est un AUDIO : tu produis TOUJOURS un rendu RÉALISTE ET OPTIMAL — texte adapté à " +
      "l'oral (phrases courtes, respiration, accentuation), meilleure voix et meilleurs réglages " +
      "disponibles du moteur réel (voice.speak : rythme, intonation, articulation), vérification du " +
      "résultat avant livraison (media.analyze) ; jamais un audio brut lancé à la va-vite.",
    ressources: ["voice.speak", "media.analyze", "artifact.create"],
  },
  {
    id: "tache-externe",
    label: "Tâche externe",
    exigence:
      "si la tâche s'exécute EN EXTERNE (web, fichiers, code, messagerie, automatisation, agents) : " +
      "tu utilises les RESSOURCES QUE TU POSSÈDES (outils réels, connaissances, mémoire, bac à " +
      "sable) ET TU RÉFLÉCHIS pour atteindre l'objectif donné — tu décomposes le chemin vers le but, " +
      "tu exécutes, tu contrôles chaque étape et tu ne t'arrêtes qu'à l'objectif atteint ou à une " +
      "frontière réelle signalée honnêtement ; jamais d'action externe improvisée sans plan.",
    ressources: [
      "web.search",
      "web.open",
      "browser.navigate",
      "code.execute",
      "file.read",
      "terminal.run",
      "memory.write",
      "decision.analyze",
    ],
  },
];

/** Nombre de modalités couvertes (5 — le garde verrouille ce chiffre). */
export const NB_MODALITES_EXECUTION = MODALITES_EXECUTION.length;

/** Identifiants canoniques (ordre de MODALITES_EXECUTION). */
export const IDS_MODALITES_EXECUTION: readonly string[] = MODALITES_EXECUTION.map((m) => m.id);

/**
 * Section PROMPT SYSTÈME — la condition permanente, en « tu », écrite pour que
 * gen3 mobilise tout ce qu'il détient SANS y être invité et réfléchisse par
 * lui-même AVANT de résoudre. Rendu déterministe (aucune date, aucun état
 * mutable).
 */
export function sectionConditionExecution(): string {
  const regles = MODALITES_EXECUTION.map(
    (modalite, index) => `${index + 3}. ${modalite.label.toUpperCase()} — ${modalite.exigence}`,
  );
  return [
    "TA CONDITION PERMANENTE D'EXÉCUTION — GEN3 (impérative, à chaque tâche, sans exception) :",
    "1. MOBILISATION TOTALE ET PERMANENTE : tu utilises et déploies TOUTES les ressources que tu " +
      "détiens — connaissances, mémoire permanente, moteur neuronal, outils RÉELS de la plateforme — " +
      "de ta propre initiative, SANS que l'utilisateur ait à te le demander ou te le rappeler.",
    "2. RÉFLEXION AVANT RÉSOLUTION : pour TOUTE requête, tu réfléchis D'ABORD par toi-même — analyse " +
      "de la demande, inventaire de tes ressources, plan, exécution, vérification — avant de résoudre ; " +
      "jamais de réponse improvisée au fil de l'eau.",
    ...regles,
    "L'exigence de réalisme (image photoréaliste, vidéo réaliste, audio réaliste et optimal) guide le " +
      "choix des moteurs RÉELS et de leurs meilleurs paramètres — elle ne te fait JAMAIS promettre une " +
      "capacité qui n'existe pas : tu énonces honnêtement les contraintes réelles (résolution, durée, " +
      "format) tout en visant l'optimum atteignable.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Détection lexicale de la modalité (module PUR, autonome)            */
/* ------------------------------------------------------------------ */

/** Normalisation locale (minuscules, sans diacritiques) — aucun import
 *  serveur : le module reste pur et testable partout. */
function normaliser(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Racinisation LÉGÈRE et déterministe (tolérance pluriel/accord),
 *  même architecture que la vocation (it.59). */
function stemme(mot: string): string {
  if (mot.length <= 3) return mot;
  let racine = mot;
  if (racine.endsWith("s") || racine.endsWith("x")) racine = racine.slice(0, -1);
  if (racine.endsWith("e")) racine = racine.slice(0, -1);
  return racine;
}

/** Ensemble des racines des tokens d'un texte normalisé. */
function racinesDe(texte: string): Set<string> {
  return new Set(
    texte
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(stemme),
  );
}

/** Mots-clés FR/EN de détection par modalité (normalisés : minuscules,
 *  sans diacritiques). Les expressions multi-mots comptent ×2. */
const MOTS_CLES_MODALITE: Record<string, readonly string[]> = {
  texte: [
    "texte", "redaction", "rediger", "ecrire", "lettre", "article", "courrier", "resume",
    "synthese", "question", "explique", "traduction", "traduis", "correction", "text",
    "write", "answer", "reponds", "redaction de texte",
  ],
  image: [
    "image", "photo", "photographie", "dessin", "illustration", "portrait", "wallpaper",
    "picture", "draw", "photorealistic", "genere une image", "cree une image",
  ],
  video: [
    "video", "clip", "film", "animation", "sequence video", "video realiste", "short",
    "trailer", "bande annonce", "make a video",
  ],
  audio: [
    "audio", "voix", "voix off", "dictee", "lecture vocale", "musique",
    "podcast", "jingle", "voice", "speech", "lit a voix haute", "genere un audio",
    "sonore", "bruitage", "synthese vocale", "fais parler",
  ],
  "tache-externe": [
    "recherche", "internet", "web", "fichier", "code", "execute", "terminal", "automatise",
    "automatisation", "envoie un email", "publie", "planifie", "agenda", "github",
    "scraping", "api", "effectue la tache", "accomplis la mission", "atteins l'objectif",
  ],
};

/**
 * Détecte la modalité d'exécution d'une demande (lexique déterministe, même
 * architecture que predireDomaineVocation) : expressions multi-mots ×2 quand
 * TOUTES leurs racines sont présentes, mots simples ×1. Retourne null si
 * aucun mot-clé ne correspond — jamais de modalité inventée. À défaut de
 * match, la condition permanente s'applique ENTIÈREMENT quand même (elle est
 * injectée inconditionnellement dans le prompt système) : la détection sert
 * à la traçabilité et aux tests, pas à conditionner la doctrine.
 */
export function detecterModaliteExecution(texte: string): ModaliteExecution | null {
  const normalise = normaliser(texte);
  if (!normalise.trim()) return null;
  const racines = racinesDe(normalise);
  if (racines.size === 0) return null;

  let meilleur: { modalite: ModaliteExecution; score: number } | null = null;
  for (const modalite of MODALITES_EXECUTION) {
    let score = 0;
    for (const motCle of MOTS_CLES_MODALITE[modalite.id] ?? []) {
      const normaliseMotCle = normaliser(motCle);
      if (normaliseMotCle.includes(" ")) {
        const racinesMotCle = normaliseMotCle
          .split(/[^a-z0-9]+/)
          .filter(Boolean)
          .map(stemme);
        if (racinesMotCle.length > 0 && racinesMotCle.every((racine) => racines.has(racine))) {
          score += 2;
        }
      } else if (racines.has(stemme(normaliseMotCle))) {
        score += 1;
      }
    }
    if (score <= 0) continue;
    if (!meilleur || score > meilleur.score) {
      meilleur = { modalite, score };
    }
  }
  return meilleur ? meilleur.modalite : null;
}

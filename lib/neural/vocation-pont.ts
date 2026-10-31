/**
 * PONT VOCATION → RÉPONSE (it.66 — demande propriétaire : « fais en sorte
 * qu'il soit capable de répondre à des questions qui rentrent dans son
 * cadre d'apprentissage »).
 *
 * PROBLÈME CORRIGÉ : le cadre d'apprentissage de gen3 (les 19 domaines de
 * la charte de vocation, entraînés à l'échelle million it.63 et 5M it.65)
 * n'était visible que dans le prompt système du chemin LLM externe — le
 * moteur neural LOCAL ne répondait jamais depuis ce cadre : une question
 * tombait sur cortex/décodeur sans ancrage vocation.
 *
 * SOLUTION : ce module est appelé par le moteur neural dans la chaîne de
 * composition (après pilotage plateforme et connaissances utilisateur,
 * AVANT le repli cortex/décodeur). Pour une question dans le cadre :
 *  1. détection lexicale du domaine (predireDomaineVocation — 19 domaines) ;
 *  2. tâches réellement correspondantes (recouvrement lexical question↔tâches) ;
 *  3. réponse composée DEPUIS LA CHARTE uniquement : mission, tâches,
 *     outils réels de la plateforme, offre d'exécution — chaque élément
 *     cité tel quel, zéro invention, zéro statistique fabriquée ;
 *  4. questions meta (« que sais-tu faire ? », « quels sont tes domaines ? »)
 *     → vue d'ensemble honnête des 19 domaines ;
 *  5. sinon recherche dans le corpus de questions (lib/gen3/corpus-questions).
 *
 * Si rien ne correspond, retourne null — la chaîne classique prend le
 * relais (refus honnête plutôt qu'invention). Module PUR (aucune I/O).
 */

import type { CompositionReponse } from "./engine";
import { DOMAINES_VOCATION, NB_DOMAINES_VOCATION, predireDomaineVocation } from "../gen3/vocation";
import {
  CORPUS_QUESTIONS_VOCATION,
  motsInformatifsQuestion,
  rechercherPaireVocation,
  SEUIL_APPARIEMENT_QUESTION,
} from "../gen3/corpus-questions";

/** Score lexical minimal pour répondre depuis un domaine détecté. */
export const PONT_VOCATION_SCORE_MIN = 1;

/** Nombre maximal de tâches citées dans une réponse de domaine. */
export const PONT_VOCATION_MAX_TACHES = 4;

/** Déclencheurs meta (FR + EN, normalisés sans accents). */
const DECLANCHEURS_META: ReadonlyArray<{ motif: RegExp; theme: string }> = [
  { motif: /^(bonjour|salut|bonsoir|hello|hey)\b/, theme: "hors-meta" },
  {
    motif: /(que sais[- ]tu faire|tu sais faire quoi|quels? (sont )?tes domaines|liste de tes domaines|tes 19 domaines|dans quels? domaines|what can you do|your domains|which domains)/,
    theme: "meta-vocation",
  },
];

/**
 * Meta-question ? Retourne la réponse de vue d'ensemble (19 domaines cités
 * depuis la charte, dans l'ordre du propriétaire) ou null.
 */
function composerMetaVocation(question: string): CompositionReponse | null {
  const normalise = question
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  for (const declencheur of DECLANCHEURS_META) {
    if (declencheur.theme !== "meta-vocation") continue;
    if (declencheur.motif.test(normalise)) {
      const lignes = DOMAINES_VOCATION.map(
        (domaine, index) => `${index + 1}. ${domaine.label} — ${domaine.taches[0]}`,
      );
      const texte =
        `J'ai été créé pour exécuter des tâches dans ${NB_DOMAINES_VOCATION} domaines — c'est ma vocation opérationnelle :\n` +
        `${lignes.join("\n")}\n` +
        `Posez votre question dans l'un de ces cadres (ou demandez-moi « que sais-tu faire en [domaine] ? ») et je réponds depuis ce que j'ai été entraîné à faire.`;
      return {
        texte,
        source: "vocation",
        theme: "meta-vocation",
        scoreAppariement: 1,
      };
    }
  }
  return null;
}

/** Tâches du domaine réellement correspondantes à la question (0 → N). */
function tachesCorrespondantes(
  question: string,
  taches: readonly string[],
): string[] {
  const motsQuestion = new Set(motsInformatifsQuestion(question));
  if (motsQuestion.size === 0) return [];
  const classee: { tache: string; communs: number }[] = [];
  for (const tache of taches) {
    const motsTache = motsInformatifsQuestion(tache);
    let communs = 0;
    for (const mot of motsTache) {
      if (motsQuestion.has(mot)) communs += 1;
    }
    if (communs > 0) classee.push({ tache, communs });
  }
  classee.sort((a, b) => b.communs - a.communs);
  return classee.slice(0, PONT_VOCATION_MAX_TACHES).map((entree) => entree.tache);
}

/**
 * Compose une réponse DEPUIS LE CADRE D'APPRENTISSAGE (charte de vocation
 * des 19 domaines) quand la question y tombe. Retourne null sinon — le
 * moteur retombe sur cortex/décodeur (refus honnête plutôt qu'invention).
 */
export function composerDepuisVocation(question: string): CompositionReponse | null {
  const propre = question?.trim();
  if (!propre) return null;

  // 1. Détection du domaine de vocation (déterministe, jamais inventé) —
  //    PRIMAIRE : une question qui porte les mots d'un domaine mérite la
  //    réponse de CE domaine (y compris « que sais-tu faire en X ? ») ; la
  //    vue d'ensemble (meta) ne s'applique qu'aux questions SANS domaine.
  const detection = predireDomaineVocation(propre);

  // 2. Meta-questions (vue d'ensemble de la vocation) — seulement si la
  //    question ne désigne aucun domaine.
  if (!detection) {
    const meta = composerMetaVocation(propre);
    if (meta) return meta;
  }

  // 3. Domaine détecté → réponse ancrée : tâches correspondantes + mission
  //    + outils réels. Le contenu est cité depuis la charte, tel quel.
  if (detection && detection.score >= PONT_VOCATION_SCORE_MIN) {
    const domaine = DOMAINES_VOCATION.find((d) => d.id === detection.id);
    if (!domaine) return null;

    const taches = tachesCorrespondantes(propre, domaine.taches);
    const mission1re = domaine.mission.replace(/^tu as été créé pour /, "j'ai été créé pour ");
    const blocTaches = taches.length
      ? `Dans votre demande, cela correspond à : ${taches.join(" ; ")}.`
      : `Concrètement, je peux exécuter : ${domaine.taches.slice(0, PONT_VOCATION_MAX_TACHES).join(" ; ")}.`;
    const texte =
      `« ${domaine.label} » fait partie de mon cadre d'apprentissage : ${mission1re} ` +
      `${blocTaches}\n` +
      `Je m'appuie sur les outils réels de la plateforme : ${domaine.outils.join(", ")}. ` +
      `Précisez votre demande (contexte, fichier, objectif) et je l'exécute dans ce cadre. ` +
      `(Source : charte de vocation gen3 — domaine « ${domaine.label} », score lexical ${detection.score}.)`;

    return {
      texte,
      source: "vocation",
      theme: `vocation:${domaine.id}`,
      scoreAppariement: Math.min(1, detection.score / 10),
    };
  }

  // 4. Domaine non détecté → recherche dans le corpus de questions
  //    (paires question→réponse construites depuis la charte).
  const paire = rechercherPaireVocation(propre);
  if (paire) {
    return {
      texte: paire.reponse,
      source: "vocation",
      theme: `vocation:${paire.domaineId}`,
      scoreAppariement: SEUIL_APPARIEMENT_QUESTION,
    };
  }

  // 5. Hors cadre apparent : null — refus honnête, la chaîne classique
  //    (cortex/décodeur) répond sans prétendre tenir le domaine.
  return null;
}

/** Statistiques du pont (couverture vérifiable, zéro métrique inventée). */
export function statsPontVocation(): {
  domainesCharte: number;
  pairesCorpus: number;
  seuilScore: number;
  seuilPaire: number;
} {
  return {
    domainesCharte: DOMAINES_VOCATION.length,
    pairesCorpus: CORPUS_QUESTIONS_VOCATION.length,
    seuilScore: PONT_VOCATION_SCORE_MIN,
    seuilPaire: SEUIL_APPARIEMENT_QUESTION,
  };
}

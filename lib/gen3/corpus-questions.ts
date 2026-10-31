/**
 * LE CORPUS DE QUESTIONS DU CADRE D'APPRENTISSAGE (it.66 — demande
 * propriétaire : « fais en sorte qu'il soit capable de répondre à des
 * questions qui rentrent dans son cadre d'apprentissage »).
 *
 * RÔLE : gen3 doit pouvoir RÉPONDRE aux questions qui tombent dans ses 19
 * domaines de vocation. Ce module fabrique le matériel question→réponse
 * correspondant, de façon DÉTERMINISTE et SANS AUCUNE INVENTION :
 * chaque réponse est composée exclusivement depuis la CHARTE DE VOCATION
 * réelle (lib/gen3/vocation.ts) — mission, tâches, outils réels. Aucune
 * statistique, aucun fait externe, aucune promesse hors charte.
 *
 * DEUX CONSOMMATEURS :
 *  1. le cortex langagier (lib/neural/runtime.ts) apprend ces paires au
 *     démarrage — le SNN lui-même connaît les questions de son cadre ;
 *  2. le pont vocation (lib/neural/vocation-pont.ts) y puise la réponse
 *     composée pour un tour utilisateur (recherche lexicale + ancrage).
 *
 * HONNÊTÉ TECHNIQUE (règle zéro fantôme) :
 *  - module PUR (aucune IO, aucune dépendance Node) ;
 *  - déterministe : la même question produit toujours la même réponse ;
 *  - la couverture 19/19 domaines, FR+EN, est vérifiée par la 34ᵉ garde.
 */

import { DOMAINES_VOCATION, NB_DOMAINES_VOCATION } from "./vocation";

/** Une paire question→réponse du cadre d'apprentissage de gen3. */
export interface PaireQuestionVocation {
  /** La question telle qu'un utilisateur peut la poser (FR ou EN). */
  question: string;
  /** La réponse — composée DEPUIS LA CHARTE uniquement. */
  reponse: string;
  /** Identifiant du domaine de vocation couvert (lib/gen3/vocation). */
  domaineId: string;
  /** Thème conversationnel (traçabilité : taches | outils | mission | meta). */
  theme: "taches" | "outils" | "mission" | "tache-precise";
  /** Langue de la paire. */
  langue: "fr" | "en";
}

/** Seuil de recouvrement lexical pour retenir une paire (0 → 1). */
export const SEUIL_APPARIEMENT_QUESTION = 0.4;

/** Mots outils écartés du calcul d'appariement (FR + EN). */
export const MOTS_OUTILS_QUESTIONS: ReadonlySet<string> = new Set([
  "avec", "sans", "pour", "dans", "cette", "tout", "tous", "toute", "toutes",
  "être", "avoir", "fait", "faire", "comme", "mais", "donc", "alors",
  "plus", "moins", "très", "bien", "peut", "peux", "veux", "dois", "doit",
  "quel", "quelle", "quels", "quelles", "est-ce", "qu'est", "ceci", "cela",
  "leur", "notre", "votre", "chaque", "après", "avant", "entre", "chez",
  "puis", "ainsi", "dont", "aussi", "sont", "etes", "êtes", "selon",
  "the", "and", "for", "with", "what", "which", "your", "you", "are",
  "can", "could", "how", "does", "did", "that", "this", "from", "have",
]);

/** Normalise : minuscules + accents retirés. */
function normaliser(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Mots informatifs d'une phrase (≥ 4 caractères, hors mots outils). */
export function motsInformatifsQuestion(texte: string): string[] {
  const vus = new Set<string>();
  for (const mot of normaliser(texte).split(/[^a-z0-9]+/)) {
    if (mot.length < 4 || MOTS_OUTILS_QUESTIONS.has(mot)) continue;
    vus.add(mot);
  }
  return [...vus];
}

/** Recouvrement lexical question↔paire (0 → 1, relative à la question). */
function recouvrement(motsQuestion: string[], motsPaire: Set<string>): number {
  if (motsQuestion.length === 0) return 0;
  let communs = 0;
  for (const mot of motsQuestion) {
    if (motsPaire.has(mot)) communs += 1;
  }
  return communs / motsQuestion.length;
}

/** Rend la mission à la première personne (la charte la dit en « tu »). */
function missionAPremierePersonne(mission: string): string {
  return mission.replace(/^tu as été créé pour /, "j'ai été créé pour ");
}

/** Liste des tâches citées tel quel (le contenu réel de la charte). */
function citerTaches(taches: readonly string[]): string {
  return taches.map((tache) => `· ${tache}`).join("\n");
}

/** Liste des outils cités tel quel (registre réel, garde 27ᵉ). */
function citerOutils(outils: readonly string[]): string {
  return outils.join(", ");
}

/** Réponse « tâches » du domaine — ancrée charte, FR. */
function reponseTachesFR(label: string, mission: string, taches: readonly string[], outils: readonly string[]): string {
  return (
    `${label} est l'un de mes 19 domaines de vocation : ${missionAPremierePersonne(mission)} ` +
    `Concrètement, je peux exécuter :\n${citerTaches(taches)}\n` +
    `Pour cela je m'appuie sur les outils réels de la plateforme : ${citerOutils(outils)}. ` +
    `Formulez votre demande précise et je l'exécute dans ce cadre.`
  );
}

/** Réponse « outils » du domaine — ancrée charte, FR. */
function reponseOutilsFR(label: string, outils: readonly string[], taches: readonly string[]): string {
  return (
    `Dans le domaine « ${label} », je travaille avec les outils réels de la plateforme : ` +
    `${citerOutils(outils)}. Ils me servent pour : ${taches.slice(0, 3).join(", ")}… ` +
    `— chaque outil cité existe dans le registre de la plateforme, je n'en promets aucun autre.`
  );
}

/** Réponse « mission » du domaine — ancrée charte, FR. */
function reponseMissionFR(label: string, mission: string): string {
  return (
    `Ma mission dans « ${label} » : ${missionAPremierePersonne(mission)} ` +
    `C'est l'un des 19 domaines pour lesquels j'ai été créé — ce n'est pas une décoration, c'est ma raison d'être opérationnelle.`
  );
}

/** Réponse « tâche précise » — la tâche demandée + mission + outils, FR. */
function reponseTachePreciseFR(label: string, tache: string, mission: string, outils: readonly string[]): string {
  return (
    `Oui : « ${tache} » fait partie des tâches que j'exécute dans le domaine « ${label} ». ` +
    `Dans ce domaine, ${missionAPremierePersonne(mission)} ` +
    `Je m'appuie sur : ${citerOutils(outils)}. Donnez-moi le contexte (fichier, sujet, objectif) et je réalise la tâche.`
  );
}

/** EN — réponse « tâches » ancrée charte (contenu traduit strict). */
function reponseTachesEN(label: string, taches: readonly string[], outils: readonly string[]): string {
  return (
    `"${label}" is one of my 19 vocation domains. Tasks I actually execute there:\n` +
    `${taches.map((t) => `· ${t}`).join("\n")}\n` +
    `I rely on the platform's real tools: ${citerOutils(outils)}. ` +
    `State your request precisely and I will execute it within this framework.`
  );
}

/** EN — réponse « mission » ancrée charte. */
function reponseMissionEN(label: string, taches: readonly string[]): string {
  return (
    `In the "${label}" domain, I was created to execute tasks such as: ${taches.slice(0, 3).join(", ")}. ` +
    `This is one of the 19 domains I was built for — my operational reason for existing.`
  );
}

/** Construit les paires du corpus (déterministe, ordre de la charte). */
function construireCorpus(): PaireQuestionVocation[] {
  const paires: PaireQuestionVocation[] = [];
  for (const domaine of DOMAINES_VOCATION) {
    const { id, label, mission, taches, outils } = domaine;
    const fr: PaireQuestionVocation[] = [
      {
        question: `que sais-tu faire en ${label.toLowerCase()} ?`,
        reponse: reponseTachesFR(label, mission, taches, outils),
        domaineId: id,
        theme: "taches",
        langue: "fr",
      },
      {
        question: `quels outils utilises-tu pour ${label.toLowerCase()} ?`,
        reponse: reponseOutilsFR(label, outils, taches),
        domaineId: id,
        theme: "outils",
        langue: "fr",
      },
      {
        question: `quelle est ta mission en ${label.toLowerCase()} ?`,
        reponse: reponseMissionFR(label, mission),
        domaineId: id,
        theme: "mission",
        langue: "fr",
      },
      {
        question: `peux-tu m'aider pour ${label.toLowerCase()} ?`,
        reponse: reponseTachesFR(label, mission, taches, outils),
        domaineId: id,
        theme: "taches",
        langue: "fr",
      },
    ];
    const en: PaireQuestionVocation[] = [
      {
        question: `what can you do in ${label.toLowerCase()} ?`,
        reponse: reponseTachesEN(label, taches, outils),
        domaineId: id,
        theme: "taches",
        langue: "en",
      },
      {
        question: `what is your mission in ${label.toLowerCase()} ?`,
        reponse: reponseMissionEN(label, taches),
        domaineId: id,
        theme: "mission",
        langue: "en",
      },
    ];
    paires.push(...fr, ...en);

    // Tâche précise : chaque tâche de la charte devient une question réelle.
    for (const tache of taches) {
      paires.push({
        question: `peux-tu faire la ${tache} ?`,
        reponse: reponseTachePreciseFR(label, tache, mission, outils),
        domaineId: id,
        theme: "tache-precise",
        langue: "fr",
      });
      paires.push({
        question: `${tache} : comment procèdes-tu ?`,
        reponse: reponseTachePreciseFR(label, tache, mission, outils),
        domaineId: id,
        theme: "tache-precise",
        langue: "fr",
      });
    }
  }
  return paires;
}

/** LE CORPUS DE QUESTIONS — déterministe, 19/19 domaines, FR+EN. */
export const CORPUS_QUESTIONS_VOCATION: readonly PaireQuestionVocation[] = construireCorpus();

/**
 * Recherche la meilleure paire pour une question réelle (recouvrement
 * lexical normalisé, seuil SEUIL_APPARIEMENT_QUESTION). Retourne null si
 * aucune paire n'atteint le seuil — JAMAIS de paire imposée.
 */
export function rechercherPaireVocation(question: string): PaireQuestionVocation | null {
  const propre = question?.trim();
  if (!propre) return null;
  const motsQuestion = motsInformatifsQuestion(propre);
  if (motsQuestion.length === 0) return null;

  let meilleure: { paire: PaireQuestionVocation; score: number } | null = null;
  for (const paire of CORPUS_QUESTIONS_VOCATION) {
    const score = recouvrement(motsQuestion, new Set(motsInformatifsQuestion(paire.question)));
    if (score >= SEUIL_APPARIEMENT_QUESTION && (!meilleure || score > meilleure.score)) {
      meilleure = { paire, score };
    }
  }
  return meilleure ? meilleure.paire : null;
}

/** Statistiques honnêtes du corpus (couverture vérifiable). */
export function statsCorpusQuestions(): {
  total: number;
  parDomaine: Record<string, number>;
  parLangue: Record<string, number>;
  domainesCouverts: number;
} {
  const parDomaine: Record<string, number> = {};
  const parLangue: Record<string, number> = {};
  for (const paire of CORPUS_QUESTIONS_VOCATION) {
    parDomaine[paire.domaineId] = (parDomaine[paire.domaineId] ?? 0) + 1;
    parLangue[paire.langue] = (parLangue[paire.langue] ?? 0) + 1;
  }
  return {
    total: CORPUS_QUESTIONS_VOCATION.length,
    parDomaine,
    parLangue,
    domainesCouverts: Object.keys(parDomaine).length,
  };
}

/** Nombre de domaines de vocation (réexport lisible pour les surfaces). */
export const NB_DOMAINES_COUVERTS_ATTENDU = NB_DOMAINES_VOCATION;

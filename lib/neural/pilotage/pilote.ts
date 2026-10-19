/**
 * PILOTAGE PLATEFORME — le module qui fait de Gen le PILOTE de toutes les
 * fonctionnalités de la plateforme. Quand l'utilisateur interroge son espace
 * (« mes automatisations ? », « où en sont mes projets ? », « état de la
 * plateforme »), Gen lit les DONNÉES RÉELLES de son compte et répond avec
 * des chiffres vrais — jamais inventés.
 *
 * PRINCIPE D'HONNÊTETÉ (cohérent avec le cortex langagier) :
 *  - les données viennent de loaders injectés (dépôts Firestore/R2 réels
 *    câblés par le runtime — module PUR ici, testable avec des faux) ;
 *  - un loader en échec est signalé honnêtement (« indisponible ») au lieu
 *    d'un chiffre fabriqué ;
 *  - sans utilisateur identifié (metadata.userId absent), Gen ne prétend
 *    RIEN : le pilotage retourne null et la conversation suit son cours
 *    normal (cortex / décodeur).
 *
 * Module PUR — aucune dépendance Node, aucune I/O propre.
 */

import type { CompositionReponse } from "../engine";

/** Intentions de pilotage détectables dans le message utilisateur. */
export type IntentionPilotage =
  | "vue_ensemble"
  | "automatisations"
  | "projets"
  | "fichiers"
  | "connaissances"
  | "conversations"
  | "entrainements";

/** Données réelles collectées (chaque bloc peut manquer si indisponible). */
export interface DonneesPilotage {
  automatisations?: { total: number; enCours: number; aValider: number; terminees: number };
  projets?: { total: number; derniers: string[] };
  fichiers?: { total: number; derniers: string[] };
  connaissances?: { total: number; dernieres: string[] };
  conversations?: { total: number };
  entrainements?: { total: number; modeles: number };
}

/**
 * Loaders injectables — chaque chargeur lit la source réelle pour le compte
 * courant. Un chargeur qui lève est capté (bloc indisponible), jamais
 * propagé : le pilotage reste fail-soft.
 */
export interface ChargeursPilotage {
  automatisations: (userId: string) => Promise<DonneesPilotage["automatisations"]>;
  projets: (userId: string) => Promise<DonneesPilotage["projets"]>;
  fichiers: (userId: string) => Promise<DonneesPilotage["fichiers"]>;
  connaissances: (userId: string) => Promise<DonneesPilotage["connaissances"]>;
  conversations: (userId: string) => Promise<DonneesPilotage["conversations"]>;
  entrainements: (userId: string) => Promise<DonneesPilotage["entrainements"]>;
}

/** Normalisation : minuscules + accents retirés (comparaison robuste FR). */
function normaliser(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Familles de mots-clés par intention (formes normalisées sans accents). */
const MOTS_CLES: Record<Exclude<IntentionPilotage, "vue_ensemble">, string[]> = {
  automatisations: ["automatisation", "automatisations", "mission", "missions", "mes agents"],
  projets: ["projet", "projets"],
  fichiers: ["fichier", "fichiers", "document importe", "documents importes"],
  connaissances: ["connaissance", "connaissances", "memoire", "souvenir", "souvenirs"],
  conversations: ["conversation", "conversations", "discussions"],
  entrainements: ["entrainement", "entrainements", "modele entraine", "modeles entraines", "mes modeles"],
};

const GLOBALS = [
  "etat de la plateforme",
  "etat de ma plateforme",
  "statut de la plateforme",
  "statut de ma plateforme",
  "vue d'ensemble",
  "vue densemble",
  "tableau de bord",
  "point global",
  "ce que tu vois",
  "ce que tu pilotes",
  "resume de ma plateforme",
  "tout ce que tu pilotes",
];

/**
 * Détecte l'intention de pilotage d'un message. Retourne null quand le
 * message n'est pas une commande de pilotage (la conversation continue
 * normalement). Les intentions SPÉCIFIQUES priment sur la vue d'ensemble :
 * « état de mes automatisations » pilote les automatisations, pas la vue
 * globale.
 */
export function detecterIntentionPilotage(message: string): IntentionPilotage | null {
  const m = normaliser(message);
  if (!m.trim()) return null;

  for (const [intention, mots] of Object.entries(MOTS_CLES) as Array<
    [Exclude<IntentionPilotage, "vue_ensemble">, string[]]
  >) {
    if (mots.some((mot) => m.includes(mot))) return intention;
  }

  if (GLOBALS.some((mot) => m.includes(mot))) return "vue_ensemble";
  return null;
}

/** Capture fail-soft d'un loader : valeur ou undefined (jamais de throw). */
async function charger<T>(
  loader: (userId: string) => Promise<T>,
  userId: string,
): Promise<T | undefined> {
  try {
    return await loader(userId);
  } catch {
    return undefined;
  }
}

/** Formatage compact d'une liste de noms (max 3, guillemets français). */
function citerNoms(noms: string[]): string {
  const cites = noms.slice(0, 3).map((nom) => `« ${nom} »`);
  if (cites.length === 0) return "";
  const reste = noms.length - cites.length;
  return cites.join(", ") + (reste > 0 ? ` et ${reste} autre${reste > 1 ? "s" : ""}` : "");
}

/** Phrase honnête pour un bloc indisponible (erreur loader). */
const INDISPONIBLE = "je n'ai pas pu lire cette source à l'instant";

/** Bloc texte d'une intention — chiffres réels uniquement. */
function blocAutomatisations(d: DonneesPilotage["automatisations"]): string {
  if (!d) return `Automatisations : ${INDISPONIBLE}.`;
  if (d.total === 0) return "Automatisations : tu n'en as aucune pour l'instant — décris-moi un objectif dans le chat ou le Studio et je le transforme en mission.";
  return `Automatisations : ${d.total} au total — ${d.enCours} en cours, ${d.aValider} en attente de ta validation, ${d.terminees} terminée${d.terminees > 1 ? "s" : ""}.`;
}

function blocProjets(d: DonneesPilotage["projets"]): string {
  if (!d) return `Projets : ${INDISPONIBLE}.`;
  if (d.total === 0) return "Projets : aucun pour l'instant — donne un titre et un objectif et j'ouvre le premier.";
  const derniers = citerNoms(d.derniers);
  return `Projets : ${d.total} enregistré${d.total > 1 ? "s" : ""}${derniers ? `, dont les plus récents : ${derniers}` : ""}.`;
}

function blocFichiers(d: DonneesPilotage["fichiers"]): string {
  if (!d) return `Fichiers : ${INDISPONIBLE}.`;
  if (d.total === 0) return "Fichiers : rien d'importé pour l'instant — dépose un document et je le lis pour toi.";
  const derniers = citerNoms(d.derniers);
  return `Fichiers : ${d.total} importé${d.total > 1 ? "s" : ""}${derniers ? `, récents : ${derniers}` : ""}.`;
}

function blocConnaissances(d: DonneesPilotage["connaissances"]): string {
  if (!d) return `Connaissances : ${INDISPONIBLE}.`;
  if (d.total === 0) return "Connaissances : ta mémoire permanente est vide — confie-moi des faits à retenir et je les garde.";
  const dernieres = citerNoms(d.dernieres);
  return `Connaissances : ${d.total} souvenir${d.total > 1 ? "s" : ""} en mémoire permanente${dernieres ? `, récents : ${dernieres}` : ""}.`;
}

function blocConversations(d: DonneesPilotage["conversations"]): string {
  if (!d) return `Conversations : ${INDISPONIBLE}.`;
  if (d.total === 0) return "Conversations : aucune pour l'instant — celle-ci sera la première.";
  return `Conversations : ${d.total} enregistrée${d.total > 1 ? "s" : ""} — je m'en sers pour le contexte (reprises courtes comprises).`;
}

function blocEntrainements(d: DonneesPilotage["entrainements"]): string {
  if (!d) return `Entraînements : ${INDISPONIBLE}.`;
  if (d.total === 0) return "Entraînements : aucun modèle en cours — confie-moi un dataset au Studio et je l'entraîne moi-même.";
  return `Entraînements : ${d.total} projet${d.total > 1 ? "s" : ""} d'entraînement, ${d.modeles} modèle${d.modeles > 1 ? "s" : ""} produit${d.modeles > 1 ? "s" : ""} — « Gen entraîne VOS modèles ».`;
}

/** Composition de la réponse de pilotage (texte 100 % fondé sur les données). */
export function composerPilotage(
  intention: IntentionPilotage,
  donnees: DonneesPilotage,
): CompositionReponse {
  if (intention === "vue_ensemble") {
    const sections = [
      "Voici l'état réel de ton espace, que je pilote directement :",
      "- " + blocAutomatisations(donnees.automatisations),
      "- " + blocProjets(donnees.projets),
      "- " + blocFichiers(donnees.fichiers),
      "- " + blocConnaissances(donnees.connaissances),
      "- " + blocConversations(donnees.conversations),
      "- " + blocEntrainements(donnees.entrainements),
      "Dis-moi la surface à approfondir et j'y vais.",
    ];
    return { texte: sections.join("\n"), source: "pilotage" };
  }

  let texte: string;
  switch (intention) {
    case "automatisations":
      texte = blocAutomatisations(donnees.automatisations);
      break;
    case "projets":
      texte = blocProjets(donnees.projets);
      break;
    case "fichiers":
      texte = blocFichiers(donnees.fichiers);
      break;
    case "connaissances":
      texte = blocConnaissances(donnees.connaissances);
      break;
    case "conversations":
      texte = blocConversations(donnees.conversations);
      break;
    case "entrainements":
      texte = blocEntrainements(donnees.entrainements);
      break;
  }
  return { texte: texte + " Je peux agir dessus : demande-moi ce qu'il faut faire ensuite.", source: "pilotage" };
}

/**
 * Exécute le pilotage : détection → collecte réelle → composition.
 * Retourne null si le message n'est pas du pilotage OU si aucun compte
 * n'est identifié (honnêteté : jamais de données fabriquées).
 */
export async function executerPilotage(
  chargeurs: ChargeursPilotage,
  message: string,
  ctx: { userId?: string },
): Promise<CompositionReponse | null> {
  const intention = detecterIntentionPilotage(message);
  if (!intention || !ctx.userId) return null;

  const uid = ctx.userId;
  const donnees: DonneesPilotage = {};

  if (intention === "vue_ensemble" || intention === "automatisations") {
    donnees.automatisations = await charger(chargeurs.automatisations, uid);
  }
  if (intention === "vue_ensemble" || intention === "projets") {
    donnees.projets = await charger(chargeurs.projets, uid);
  }
  if (intention === "vue_ensemble" || intention === "fichiers") {
    donnees.fichiers = await charger(chargeurs.fichiers, uid);
  }
  if (intention === "vue_ensemble" || intention === "connaissances") {
    donnees.connaissances = await charger(chargeurs.connaissances, uid);
  }
  if (intention === "vue_ensemble" || intention === "conversations") {
    donnees.conversations = await charger(chargeurs.conversations, uid);
  }
  if (intention === "vue_ensemble" || intention === "entrainements") {
    donnees.entrainements = await charger(chargeurs.entrainements, uid);
  }

  return composerPilotage(intention, donnees);
}

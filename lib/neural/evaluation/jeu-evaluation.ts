/**
 * JEU D'ÉVALUATION INDÉPENDANT GEN3 (vague post-audit v2.1).
 *
 * Module PUR — un corpus d'épreuves rédigé À LA MAIN, indépendant du corpus
 * d'amorçage de la plateforme (lib/neural/generation/corpus.ts), de
 * SEED_EXAMPLES et de tout étiqueteur d'entraînement : le moteur n'a JAMAIS
 * vu ces motifs ailleurs que dans ce jeu. C'est la réponse directe à l'audit
 * stratégique §6 : « le benchmark actuel (10 exemples, 3 reformulations,
 * 3 inconnues) valide le scénario de référence, il ne prouve pas une
 * intelligence générale — il faut compléter par des évaluations
 * indépendantes, inconnues du moteur ».
 *
 * Cinq familles de capacités :
 *  1. rappel-exact        : la question exacte apprise restitue la réponse ;
 *  2. reformulation       : variantes morphologiques/fautes — le gain de la
 *                           généralisation est MESURÉ (mode flou off vs on) ;
 *  3. memoire-interference: des paires voisines apprises ensemble ne se
 *                           brouillent pas mutuellement ;
 *  4. rejet-calibre       : des sujets JAMAIS appris ne déclenchent AUCUNE
 *                           réponse (calibration du rejet — aucune
 *                           hallucination de rappel) ;
 *  5. langue-garde        : une question d'une autre langue que le corpus
 *                           appris ne reçoit pas de réponse hors-sujet.
 *
 * Chaque item est vérifiable mécaniquement : sous-chaînes attendues dans la
 * réponse (normalisées : minuscules, sans diacritiques) ou rejet attendu.
 */

/** Familles de capacités mesurées par le laboratoire. */
export type FamilleCapacite =
  | "rappel-exact"
  | "reformulation"
  | "memoire-interference"
  | "rejet-calibre"
  | "langue-garde";

export const FAMILLES_CAPACITES: readonly FamilleCapacite[] = [
  "rappel-exact",
  "reformulation",
  "memoire-interference",
  "rejet-calibre",
  "langue-garde",
];

/** Paire de connaissances à APPRENDRE au cortex avant l'évaluation. */
export interface ItemApprentissage {
  motif: string;
  reponse: string;
  theme: string;
}

/** Épreuve d'évaluation : question posée + vérification mécanique. */
export interface ItemEvaluation {
  id: string;
  famille: FamilleCapacite;
  question: string;
  /** Sous-chaînes attendues dans la réponse (normalisées). */
  attendu?: string[];
  /** true : la bonne réponse est null (aucune paire ne doit répondre). */
  rejetAttendu?: boolean;
}

/** Corpus d'apprentissage du laboratoire (14 paires, thèmes labo:*) —
 *  rédigé pour l'évaluation, jamais utilisé par l'entraînement de la
 *  plateforme. */
export const CORPUS_LABO: readonly ItemApprentissage[] = [
  { motif: "quelle est la recette du tajine de la maison", reponse: "Le tajine de la maison mijote trois heures avec des pruneaux et des amandes.", theme: "labo:cuisine" },
  { motif: "quelle est la distance entre la terre et la lune", reponse: "La distance moyenne entre la Terre et la Lune est d'environ trois cent quatre-vingt-quatre mille kilomètres.", theme: "labo:astronomie" },
  { motif: "quand ouvre la bibliothèque du quartier", reponse: "La bibliothèque du quartier ouvre du mardi au samedi, de dix heures à dix-huit heures.", theme: "labo:bibliotheque" },
  { motif: "qui répare les vélos à l'atelier solidaire", reponse: "L'atelier solidaire répare les vélos le mercredi après-midi avec des bénévoles mécaniciens.", theme: "labo:atelier" },
  { motif: "quel instrument apprend-on à l'école de musique", reponse: "À l'école de musique, on apprend le piano, la guitare et la flûte traversière.", theme: "labo:musique" },
  { motif: "comment planter des tomates cerises", reponse: "Les tomates cerises se plantent au printemps, en plein soleil, avec un arrosage régulier.", theme: "labo:jardin" },
  { motif: "quelle ligne de bus dessert le parc des expositions", reponse: "La ligne 27 dessert le parc des expositions toutes les vingt minutes.", theme: "labo:transport" },
  { motif: "quels sont les horaires du centre de vaccination", reponse: "Le centre de vaccination accueille sans rendez-vous du lundi au vendredi, de neuf heures à dix-sept heures.", theme: "labo:sante" },
  { motif: "que contient le cartable de rentrée recommandé", reponse: "Le cartable de rentrée recommandé contient des cahiers grand format, une trousse complète et une calculatrice scientifique.", theme: "labo:cartable" },
  { motif: "quand paraît le bulletin météo du week-end", reponse: "Le bulletin météo du week-end paraît chaque vendredi à dix-huit heures.", theme: "labo:meteo" },
  { motif: "combien coûte l'entrée du musée des sciences", reponse: "L'entrée du musée des sciences coûte huit euros et reste gratuite le premier dimanche du mois.", theme: "labo:musee" },
  { motif: "quels animaux sont acceptés à la pension canine", reponse: "La pension canine accepte les chiens vaccinés et les chats tempérés.", theme: "labo:animaux" },
  { motif: "où développer les photos argentiques en ville", reponse: "Le laboratoire photographique du centre développe les photos argentiques en vingt-quatre heures.", theme: "labo:photo" },
  { motif: "quelle hauteur fait la salle d'escalade", reponse: "La salle d'escalade propose des blocs de quatre mètres et des voies de douze mètres.", theme: "labo:escalade" },
  // Paires des épreuves de reformulation « tout-flou » (formes de base des
  // familles -ail/-eau dont le pluriel irrégulier échappe à la racinisation).
  { motif: "travail château restauré", reponse: "Le travail de restauration du château se poursuit ce printemps.", theme: "labo:patrimoine" },
  { motif: "travail vitrail atelier", reponse: "L'atelier de vitrail termine le travail du chœur.", theme: "labo:artisanat" },
  { motif: "corail camée bijouterie", reponse: "La bijouterie assemble le corail et le camé sur or massif.", theme: "labo:bijouterie" },
];

/** Épreuves d'évaluation (30 items) — indépendantes du corpus d'amorçage. */
export const EPREUVES_LABO: readonly ItemEvaluation[] = [
  // ── 1. Rappel exact (8) ────────────────────────────────────────────────
  { id: "r1", famille: "rappel-exact", question: "quelle est la recette du tajine de la maison", attendu: ["tajine", "pruneaux"] },
  { id: "r2", famille: "rappel-exact", question: "quand ouvre la bibliothèque du quartier", attendu: ["bibliothèque", "mardi"] },
  { id: "r3", famille: "rappel-exact", question: "quelle ligne de bus dessert le parc des expositions", attendu: ["ligne 27"] },
  { id: "r4", famille: "rappel-exact", question: "combien coûte l'entrée du musée des sciences", attendu: ["huit euros"] },
  { id: "r5", famille: "rappel-exact", question: "où développer les photos argentiques en ville", attendu: ["vingt-quatre"] },
  { id: "r6", famille: "rappel-exact", question: "quelle hauteur fait la salle d'escalade", attendu: ["douze mètres"] },
  { id: "r7", famille: "rappel-exact", question: "qui répare les vélos à l'atelier solidaire", attendu: ["mercredi"] },
  { id: "r8", famille: "rappel-exact", question: "quand paraît le bulletin météo du week-end", attendu: ["vendredi"] },

  // ── 2. Reformulation (6) ───────────────────────────────────────────────
  // (a) Tout-flou : TOUS les tokens informatifs divergent (pluriels
  //     irréguliers -aux hors portée de racineLegere) → sans couche floue :
  //     aucun recoupement exact → aucune réponse.
  { id: "f1", famille: "reformulation", question: "travaux chateaux", attendu: ["château"] },
  { id: "f2", famille: "reformulation", question: "travaux vitraux", attendu: ["vitrail"] },
  { id: "f3", famille: "reformulation", question: "coraux camés", attendu: ["corail"] },
  // (b) Fautes de frappe sur une requête riche : la couche floue augmente le
  //     score (la garde de couverture it.85-r reste sur les tokens exacts).
  { id: "f4", famille: "reformulation", question: "la distanse entre la terre et la lune", attendu: ["kilomètres"] },
  { id: "f5", famille: "reformulation", question: "quand parait le bulleton méteo du week-end", attendu: ["vendredi"] },
  { id: "f6", famille: "reformulation", question: "les recettes du tajine de la maison", attendu: ["pruneaux"] },

  // ── 3. Mémoire / interférence (4) ──────────────────────────────────────
  { id: "m1", famille: "memoire-interference", question: "quel instrument apprend-on à l'école de musique", attendu: ["piano"] },
  { id: "m2", famille: "memoire-interference", question: "quels animaux sont acceptés à la pension canine", attendu: ["chiens"] },
  { id: "m3", famille: "memoire-interference", question: "quels sont les horaires du centre de vaccination", attendu: ["rendez-vous"] },
  { id: "m4", famille: "memoire-interference", question: "comment planter des tomates cerises", attendu: ["printemps"] },

  // ── 4. Rejet calibré (8) — sujets JAMAIS appris ────────────────────────
  { id: "x1", famille: "rejet-calibre", question: "quel est le tarif du parking souterrain", rejetAttendu: true },
  { id: "x2", famille: "rejet-calibre", question: "comment réparer une fuite de chaudière", rejetAttendu: true },
  { id: "x3", famille: "rejet-calibre", question: "quels sont les ingrédients d'un gâteau au chocolat", rejetAttendu: true },
  { id: "x4", famille: "rejet-calibre", question: "où acheter des timbres fiscaux", rejetAttendu: true },
  { id: "x5", famille: "rejet-calibre", question: "quelle est la capitale de l'Australie", rejetAttendu: true },
  { id: "x6", famille: "rejet-calibre", question: "comment résilier un abonnement de téléphonie", rejetAttendu: true },
  { id: "x7", famille: "rejet-calibre", question: "quel poids peut porter un camion de déménagement", rejetAttendu: true },
  { id: "x8", famille: "rejet-calibre", question: "comment ouvrir un compte épargne jeune", rejetAttendu: true },

  // ── 5. Garde de langue (4) — corpus appris uniquement en FR ────────────
  { id: "l1", famille: "langue-garde", question: "what are the opening hours of the library", rejetAttendu: true },
  { id: "l2", famille: "langue-garde", question: "how far is the moon from the earth", rejetAttendu: true },
  { id: "l3", famille: "langue-garde", question: "which bus goes to the exhibition center", rejetAttendu: true },
  { id: "l4", famille: "langue-garde", question: "how much is the science museum ticket", rejetAttendu: true },
];

/** Normalisation de comparaison : minuscules, sans diacritiques. */
export function normaliserTexte(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

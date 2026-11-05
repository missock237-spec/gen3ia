/**
 * GÉNÉRATEUR RAISONNEMENT it.94 — 7 familles à couverture zéro (demande
 * propriétaire Job 478451 : « Entraîne Gen3 à comprendre, analyser, raisonner
 * et résoudre des problèmes complexes »).
 *
 * La mesure it.86→it.94 (var-copie/progression.json) montre que 7 familles de
 * raisonnement n'ont JAMAIS été balayées : deduction, conditionnel, spatial,
 * temporel, analogie, causalite, planification (toutes à 0 exact/0 méthode).
 * Ce module produit des paires { motif, réponse, famille } où la réponse est
 * CALCULÉE par construction (syllogismes instanciés, modus ponens/tollens,
 * composition de relations spatiales, sommes temporelles mod 7, relations
 * analogiques déclarées, chaînes causales certaines, procédures ordonnées).
 *
 * Garanties d'honnêteté :
 *  - AUCUNE donnée inventée : chaque banque (sous-ensembles, règles si-alors,
 *    paires analogiques, causes/effets, procédures) énonce des vérités
 *    triviales vérifiables ;
 *  - déterminisme total : PRNG mulberry32(seed) — même graine = mêmes paires ;
 *  - unicité des motifs (Set + re-tirage) ;
 *  - réponses structurées « pas à pas » (1) 2) … Donc :) fidèles au style
 *    maison du corpus (cf. corpus-raisonnement-it85).
 *
 * Module PUR — aucune dépendance Node.
 */

import { tokenize } from "../neural/encoding/text-encoder";

export type FamilleRaisonnementIt94 =
  | "deduction"
  | "conditionnel"
  | "spatial"
  | "temporel"
  | "analogie"
  | "causalite"
  | "planification";

export const FAMILLES_IT94: readonly FamilleRaisonnementIt94[] = [
  "deduction", "conditionnel", "spatial", "temporel",
  "analogie", "causalite", "planification",
];

export interface PaireRaisonnementIt94 {
  readonly motif: string;
  /** Motif de fond (sans préfixe d'évaluation) — la mesure SNN stimule ce fond. */
  readonly fond: string;
  readonly reponse: string;
  readonly theme: string;
  readonly famille: FamilleRaisonnementIt94;
}

/** PRNG mulberry32 — déterministe, seed 32 bits. */
function mulberry32(graine: number): () => number {
  let a = graine >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Banques de données certaines ────────────────────────────────────────────

/** Sous-ensembles : tous les X sont des Y (pluralité). */
const SOUS_ENSEMBLES: ReadonlyArray<readonly [string, string]> = [
  ["oiseaux", "animaux"], ["roses", "fleurs"], ["requins", "poissons"],
  ["chênes", "arbres"], ["violons", "instruments"], ["voitures", "véhicules"],
  ["pianos", "instruments"], ["diamants", "minéraux"], ["romans", "livres"],
  ["éperviers", "rapaces"], ["marsupiaux", "mammifères"], ["colibris", "oiseaux"],
  ["tulipes", "fleurs"], ["truites", "poissons"], ["bicyclettes", "véhicules"],
  ["sapins", "arbres"], ["guitares", "instruments"], ["rubis", "pierres précieuses"],
];

/** Paires disjointes : aucun X n'est un Y (singularité d'usage). */
const DISJOINTS: ReadonlyArray<readonly [string, string]> = [
  ["poisson", "chat"], ["arbre", "meuble"], ["avion", "bateau"],
  ["pierre", "oiseau"], ["livre", "ustensile"], ["vélo", "bateau"],
  ["piano", "outil"], ["lampe", "véhicule"], ["nuage", "minéral"],
  ["râteau", "instrument de musique"],
];

const PRENOMS: readonly string[] = [
  "Alice", "Bruno", "Camille", "Dario", "Élise", "Farid", "Gabrielle", "Hugo",
  "Inès", "Jonas", "Katia", "Léon", "Maëlys", "Nadia", "Oscar", "Paloma",
  "Quentin", "Rosa", "Samuel", "Tara", "Ulysse", "Véra", "Wilfried", "Yasmine", "Zoé",
];

/** Règles si-alors certaines (monde quotidien et technique). */
const REGLES: ReadonlyArray<readonly [string, string]> = [
  ["la prise est débranchée", "l'appareil ne s'allume pas"],
  ["l'alarme est armée", "toute ouverture déclenche la sirène"],
  ["le code ne compile pas", "le déploiement est bloqué"],
  ["la facture reste impayée après l'échéance", "un rappel de paiement est envoyé"],
  ["le pare-feu bloque ce port", "la connexion sur ce port échoue"],
  ["la voiture manque de carburant", "le moteur cale"],
  ["le fichier est supprimé et la corbeille vidée", "il n'est plus récupérable depuis la corbeille"],
  ["le certificat est expiré", "le navigateur signale une connexion non sécurisée"],
  ["la batterie est vide", "le téléphone s'éteint"],
  ["la sous-couche n'a pas séché", "la couche de finition marque au passage du rouleau"],
];

/** Objets pour les relations spatiales. */
const OBJETS: readonly string[] = [
  "la lampe", "la chaise", "la marmite", "le carton", "la plante",
  "le bureau", "le tapis", "le tableau", "la console", "l'étagère",
  "le fauteuil", "la boîte", "le miroir", "le coussin", "le vase",
];

const DIRECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["à gauche de", "à droite de"],
  ["à droite de", "à gauche de"],
  ["au-dessus de", "en dessous de"],
  ["en dessous de", "au-dessus de"],
];

const EVENEMENTS: readonly string[] = [
  "L'anniversaire de Léa", "La récolte des pommes", "La livraison du colis",
  "La répétition du concert", "La coupe du gâteau", "La revue de code",
  "La visite du client", "La répétition du spectacle", "L'ouverture des inscriptions",
  "La fin des vendanges", "Le départ de la randonnée", "La remise des diplômes",
];

const JOURS: readonly string[] = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

/** Paires analogiques : [a, b, description de la relation, c, d]. */
const ANALOGIES: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ["doigt", "main", "une partie d'un tout", "dent", "bouche"],
  ["page", "livre", "une partie d'un tout", "chapitre", "roman"],
  ["branche", "arbre", "une partie d'un tout", "pétale", "fleur"],
  ["roue", "voiture", "une partie d'un tout", "aile", "avion"],
  ["case", "grille", "une partie d'un tout", "tuile", "toit"],
  ["pièce", "maison", "une partie d'un tout", "mur", "maison"],
  ["étage", "immeuble", "une partie d'un tout", "sommet", "montagne"],
  ["grain", "grappe", "une partie d'un tout", "écaille", "serpent"],
  ["mot", "phrase", "une unité d'un ensemble", "phrase", "paragraphe"],
  ["lettre", "alphabet", "une unité d'un ensemble", "chiffre", "système décimal"],
  ["arbre", "forêt", "une unité d'un ensemble", "maison", "quartier"],
  ["vache", "troupeau", "une unité d'un ensemble", "poisson", "banc"],
  ["chiot", "chien", "la forme juvénile de", "chaton", "chat"],
  ["poulain", "cheval", "la forme juvénile de", "veau", "vache"],
  ["agneau", "brebis", "la forme juvénile de", "lapereau", "lapin"],
  ["garçon", "homme", "la forme juvénile de", "fille", "femme"],
  ["ourson", "ours", "la forme juvénile de", "faon", "cerf"],
  ["plume", "oiseau", "une partie d'un tout", "rayon", "roue"],
];

/** Chaînes causales certaines : [cause, mécanisme, effet]. */
const CAUSES: ReadonlyArray<readonly [string, string, string]> = [
  ["La pluie est tombée toute la nuit sur le jardin", "l'eau s'accumule dans la terre en surface", "le sol est mouillé au matin"],
  ["La bougie a été privée d'oxygène sous un verre", "la combustion ne peut se poursuivre sans oxygène", "la flamme s'est éteinte"],
  ["L'eau du bassin est restée à 0 °C toute la nuit", "l'eau se solidifie à sa température de congélation", "une couche de glace s'est formée"],
  ["L'ampoule du couloir est grillée", "plus aucun filament ne peut émettre de lumière", "la pièce reste sombre quand on actionne l'interrupteur"],
  ["Les racines de la plante n'ont pas été arrosées pendant des semaines", "sans eau, la plante ne peut plus maintenir ses tissus fermes", "la plante a flétri"],
  ["La batterie du téléphone est tombée à zéro", "sans énergie stockée, l'électronique s'arrête", "le téléphone s'est éteint"],
  ["Le pneu avant s'est dégonflé sur l'autoroute", "un pneu sans pression ne roule plus normalement", "la voiture roule difficilement"],
  ["Le serveur a été privé d'alimentation électrique", "sans courant, aucun service ne peut tourner", "le site est indisponible"],
];

/** Procédures ordonnées (planification). */
const PROCEDURES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["préparer un gâteau", [
    "préchauffer le four",
    "mélanger la farine, les œufs et le sucre",
    "beurrer le moule",
    "verser la pâte dans le moule",
    "enfourner 30 minutes",
  ]],
  ["expédier un colis", [
    "emballer l'objet avec du papier bulle",
    "peser le colis",
    "coller l'étiquette d'expédition",
    "déposer le colis en point relais",
    "confirmer le numéro de suivi",
  ]],
  ["faire une lessive", [
    "trier le linge par couleur",
    "vider les poches",
    "choisir le programme adapté",
    "lancer la machine",
    "étendre le linge propre",
  ]],
  ["planter un arbuste", [
    "creuser le trou de plantation",
    "ajouter du terreau au fond",
    "placer la motte dans le trou",
    "reboucher avec la terre",
    "arroser généreusement",
  ]],
  ["préparer un départ en voyage", [
    "vérifier les papiers d'identité",
    "imprimer les billets",
    "faire la valise",
    "réserver le taxi vers l'aéroport",
    "verrouiller la maison",
  ]],
  ["repeindre un mur", [
    "poncer la surface",
    "poser une bâche de protection",
    "appliquer la sous-couche",
    "laisser sécher la sous-couche",
    "appliquer la couche de finition",
  ]],
];

// ─── Générateurs par famille (une paire par appel) ───────────────────────────

type Tirage = () => number;

function choisi<T>(t: Tirage, banque: readonly T[]): T {
  return banque[Math.floor(t() * banque.length) % banque.length];
}

function paireDeduction(t: Tirage): Omit<PaireRaisonnementIt94, "fond"> {
  const variante = Math.floor(t() * 3);
  const nom = choisi(t, PRENOMS);
  if (variante === 0) {
    const [x, y] = choisi(t, SOUS_ENSEMBLES);
    return {
      motif: `Tous les ${x} sont des ${y}. ${nom} fait partie des ${x}. Que peut-on en déduire ?`,
      reponse: `1) On raisonne par déduction : si les prémisses sont vraies, la conclusion est certaine. 2) Première prémisse : tous les ${x} sont des ${y}. 3) Seconde prémisse : ${nom} fait partie des ${x}. 4) Ce qui vaut pour tous les ${x} vaut aussi pour ${nom}. Donc : ${nom}, comme tous les ${x}, appartient aussi aux ${y}.`,
      theme: "raisonnement-deduction",
      famille: "deduction",
    };
  }
  if (variante === 1) {
    const [x, y] = choisi(t, SOUS_ENSEMBLES);
    return {
      motif: `Tous les ${x} sont des ${y}. On annonce que ${nom} fait partie des ${y}. Peut-on conclure que ${nom} fait partie des ${x} ?`,
      reponse: `1) On vérifie d'abord le sens de l'inférence. 2) La règle « tous les ${x} sont des ${y} » va des ${x} vers les ${y}. 3) La question demande le chemin inverse (${y} vers ${x}) : le conclure serait le sophisme de la converse. 4) Rien ne dit que ${nom} appartienne aux ${x} : il peut appartenir à une autre partie des ${y}. Donc : Non — on ne peut pas conclure que ${nom} fait partie des ${x}.`,
      theme: "raisonnement-deduction",
      famille: "deduction",
    };
  }
  const [x, y] = choisi(t, DISJOINTS);
  return {
    motif: `Aucun ${x} n'est un ${y}. ${nom} fait partie des ${x}. Que conclut-on ?`,
    reponse: `1) Première prémisse : aucun ${x} n'est un ${y}. 2) Seconde prémisse : ${nom} fait partie des ${x}. 3) ${nom} ne peut donc pas appartenir aux ${y}. Donc : ${nom} n'est pas un ${y}.`,
    theme: "raisonnement-deduction",
    famille: "deduction",
  };
}

function paireConditionnel(t: Tirage): Omit<PaireRaisonnementIt94, "fond"> {
  const [p, q] = choisi(t, REGLES);
  const variante = Math.floor(t() * 3);
  if (variante === 0) {
    return {
      motif: `Si ${p}, alors ${q}. On constate que ${p}. Que conclut-on ?`,
      reponse: `1) La règle est : si ${p}, alors ${q}. 2) On constate que ${p} : c'est l'affirmation de l'antécédent. 3) Le modus ponens s'applique : antécédent vrai + règle valide ⇒ conséquent certain. Donc : ${q}.`,
      theme: "raisonnement-conditionnel",
      famille: "conditionnel",
    };
  }
  if (variante === 1) {
    return {
      motif: `Si ${p}, alors ${q}. On observe que ${q} est faux. Que peut-on conclure ?`,
      reponse: `1) La règle est : si ${p}, alors ${q}. 2) On observe que ${q} est faux. 3) Le modus tollens s'applique : si le conséquent tombe, l'antécédent ne peut pas être vrai, sinon ${q} serait vrai. Donc : ${p} est faux.`,
      theme: "raisonnement-conditionnel",
      famille: "conditionnel",
    };
  }
  return {
    motif: `Si ${p}, alors ${q}. On observe que ${q}. Peut-on conclure que ${p} ?`,
    reponse: `1) La règle « si ${p}, alors ${q} » ne dit rien du chemin inverse. 2) Observer ${q} ne prouve pas ${p} : ${q} peut résulter d'une autre situation. 3) Conclure l'antécédent à partir du conséquent est l'erreur dite « affirmation du conséquent ». Donc : Non — on ne peut pas conclure que ${p}.`,
    theme: "raisonnement-conditionnel",
    famille: "conditionnel",
  };
}

function paireSpatial(t: Tirage): Omit<PaireRaisonnementIt94, "fond"> {
  const nbObjets = t() < 0.5 ? 3 : 4;
  const objets: string[] = [];
  while (objets.length < nbObjets) {
    const o = choisi(t, OBJETS);
    if (!objets.includes(o)) objets.push(o);
  }
  const [dir, oppose] = choisi(t, DIRECTIONS);
  const chaine = objets.map((o, i) => (i === 0 ? o : `${objets[i - 1]} est ${dir} ${o}`));
  const premier = objets[0];
  const dernier = objets[objets.length - 1];
  const rangs = objets.length - 1;
  const vers = t() < 0.5;
  if (vers) {
    const liens = objets.slice(1).map((o, i) => `${i + 1}) ${objets[i]} est ${dir} ${o}.`).join(" ");
    return {
      motif: `${chaine.join(". ")}. Où se trouve ${premier} par rapport à ${dernier} ?`,
      reponse: `1) ${liens} ${objets.length}) On enchaîne : la relation se transmet de rang en rang sur ${rangs} rangs. Donc : ${premier} se trouve ${dir} ${dernier}, à ${rangs} rangs d'écart.`,
      theme: "raisonnement-spatial",
      famille: "spatial",
    };
  }
  const liens = objets.slice(1).map((o, i) => `${i + 1}) ${objets[i]} est ${dir} ${o}.`).join(" ");
  return {
    motif: `${chaine.join(". ")}. Où se trouve ${dernier} par rapport à ${premier} ?`,
    reponse: `1) ${liens} ${objets.length}) On enchaîne : ${premier} est ${dir} ${dernier} (${rangs} rangs d'écart). 3) En regardant dans l'autre sens, la direction s'inverse. Donc : ${dernier} se trouve ${oppose} ${premier}.`,
    theme: "raisonnement-spatial",
    famille: "spatial",
  };
}

function paireTemporel(t: Tirage): Omit<PaireRaisonnementIt94, "fond"> {
  const e1 = choisi(t, EVENEMENTS);
  let e2 = choisi(t, EVENEMENTS);
  let e3 = choisi(t, EVENEMENTS);
  while (e2 === e1) e2 = choisi(t, EVENEMENTS);
  while (e3 === e1 || e3 === e2) e3 = choisi(t, EVENEMENTS);
  const d1 = 1 + Math.floor(t() * 6);
  const d2 = 1 + Math.floor(t() * 6);
  const variante = Math.floor(t() * 3);
  const total = d1 + d2;
  if (variante === 0) {
    return {
      motif: `${e1} a lieu ${d1} jours après ${e2.toLowerCase()}. ${e2} a lieu ${d2} jours après ${e3.toLowerCase()}. Combien de jours séparent ${e1.toLowerCase()} de ${e3.toLowerCase()} ?`,
      reponse: `1) ${e1} = ${e2.toLowerCase()} + ${d1} jours. 2) ${e2} = ${e3.toLowerCase()} + ${d2} jours. 3) En substituant : ${e1.toLowerCase()} = ${e3.toLowerCase()} + ${d2} + ${d1} jours. Donc : ${e1.toLowerCase()} a lieu ${total} jours après ${e3.toLowerCase()}.`,
      theme: "raisonnement-temporel",
      famille: "temporel",
    };
  }
  if (variante === 1) {
    return {
      motif: `${e1} a lieu ${d1} jours après ${e2.toLowerCase()}. ${e2} a lieu ${d2} jours après ${e3.toLowerCase()}. Lequel des trois événements a lieu en premier ?`,
      reponse: `1) ${e3.toLowerCase()} est suivi ${d2} jours plus tard par ${e2.toLowerCase()}. 2) Puis ${d1} jours après ${e2.toLowerCase()} vient ${e1.toLowerCase()}. 3) Chaque événement cité arrive donc après le précédent de la chaîne. Donc : ${e3.toLowerCase()} a lieu en premier.`,
      theme: "raisonnement-temporel",
      famille: "temporel",
    };
  }
  const j0 = Math.floor(t() * 7);
  const cible = (j0 + total) % 7;
  return {
    motif: `${e1} a lieu ${d1} jours après ${e2.toLowerCase()}. ${e2} a lieu ${d2} jours après ${e3.toLowerCase()}, qui tombe un ${JOURS[j0]}. Quel jour tombe ${e1.toLowerCase()} ?`,
    reponse: `1) ${e3.toLowerCase()} tombe un ${JOURS[j0]}. 2) ${e1.toLowerCase()} vient ${total} jours plus tard (${d2} + ${d1}). 3) ${total} mod 7 = ${total % 7} : on avance de ${total % 7} jour${total % 7 > 1 ? "s" : ""} dans la semaine. Donc : ${e1.toLowerCase()} tombe un ${JOURS[cible]}.`,
    theme: "raisonnement-temporel",
    famille: "temporel",
  };
}

function paireAnalogie(t: Tirage): Omit<PaireRaisonnementIt94, "fond"> {
  const [a, b, rel, c, d] = choisi(t, ANALOGIES);
  return {
    motif: `${a} est à ${b} ce que ${c} est à quoi ?`,
    reponse: `1) On identifie la relation entre « ${a} » et « ${b} » : ${rel}. 2) On applique exactement la même relation à « ${c} ». Donc : ${c} est à ${d}.`,
    theme: "raisonnement-analogie",
    famille: "analogie",
  };
}

function paireCausalite(t: Tirage): Omit<PaireRaisonnementIt94, "fond"> {
  const [cause, mecanisme, effet] = choisi(t, CAUSES);
  if (t() < 0.5) {
    return {
      motif: `${cause}. Quel est l'effet attendu ?`,
      reponse: `1) Le fait observé : ${cause.toLowerCase()}. 2) Le mécanisme causal : ${mecanisme}. Donc : l'effet attendu est que ${effet}.`,
      theme: "raisonnement-causalite",
      famille: "causalite",
    };
  }
  return {
    motif: `On constate que ${effet}. Quelle cause, parmi les suivantes, l'explique : (a) ${cause.toLowerCase()}, (b) une simple coïncidence de calendrier, (c) l'âge de la lune ?`,
    reponse: `1) L'effet constaté : ${effet}. 2) (b) et (c) n'ont aucun lien de causalité avec cet effet. 3) (a) fournit le mécanisme réel : ${mecanisme}. Donc : la bonne explication est (a) — ${cause.toLowerCase()}.`,
    theme: "raisonnement-causalite",
    famille: "causalite",
  };
}

function pairePlanification(t: Tirage): Omit<PaireRaisonnementIt94, "fond"> {
  const [but, etapes] = choisi(t, PROCEDURES);
  const numerotee = etapes.map((e, i) => `${i + 1}. ${e}`).join(", ");
  const idx = 1 + Math.floor(t() * etapes.length);
  const cible = etapes[idx - 1];
  const variante = Math.floor(t() * 4);
  if (variante === 0 && idx < etapes.length) {
    return {
      motif: `Pour ${but}, la procédure est : ${numerotee}. Quelle étape vient juste après « ${cible} » ?`,
      reponse: `1) La procédure déclarée : ${etapes.map((e, i) => `${i + 1}. ${e}`).join(" ; ")}. 2) « ${cible} » est l'étape ${idx}. 3) L'ordre imposé fait suivre l'étape ${idx} par l'étape ${idx + 1}. Donc : l'étape qui vient juste après « ${cible} » est « ${etapes[idx]} ».`,
      theme: "raisonnement-planification",
      famille: "planification",
    };
  }
  if (variante === 1 && idx > 1) {
    return {
      motif: `Pour ${but}, la procédure est : ${numerotee}. Quelle étape vient juste avant « ${cible} » ?`,
      reponse: `1) La procédure déclarée : ${etapes.map((e, i) => `${i + 1}. ${e}`).join(" ; ")}. 2) « ${cible} » est l'étape ${idx}. 3) L'étape qui la précède immédiatement est l'étape ${idx - 1}. Donc : l'étape qui vient juste avant « ${cible} » est « ${etapes[idx - 2]} ».`,
      theme: "raisonnement-planification",
      famille: "planification",
    };
  }
  if (variante === 2) {
    return {
      motif: `Pour ${but}, la procédure est : ${numerotee}. Combien d'étapes précèdent « ${cible} » ?`,
      reponse: `1) La procédure déclarée compte ${etapes.length} étapes. 2) « ${cible} » est l'étape ${idx}. 3) Les étapes ${Array.from({ length: idx - 1 }, (_, k) => k + 1).join(", ")} la précèdent. Donc : ${idx - 1} étape${idx - 1 > 1 ? "s" : ""} précède${idx - 1 > 1 ? "nt" : ""} « ${cible} ».`,
      theme: "raisonnement-planification",
      famille: "planification",
    };
  }
  return {
    motif: `Pour ${but}, la procédure est : ${numerotee}. Par quelle étape commence-t-on et par laquelle termine-t-on ?`,
    reponse: `1) La procédure déclarée : ${etapes.map((e, i) => `${i + 1}. ${e}`).join(" ; ")}. 2) La première étape est l'étape 1, la dernière est l'étape ${etapes.length}. Donc : on commence par « ${etapes[0]} » et on termine par « ${etapes[etapes.length - 1]} ».`,
    theme: "raisonnement-planification",
    famille: "planification",
  };
}

const GENERATEURS: ReadonlyArray<(t: Tirage) => Omit<PaireRaisonnementIt94, "fond">> = [
  paireDeduction,
  paireConditionnel,
  paireSpatial,
  paireTemporel,
  paireAnalogie,
  paireCausalite,
  pairePlanification,
];

/** Formulations d'évaluation : le FOND de la question est le même, la
 * FORMULATION est inédite (jamais servie au chat ni gravée telle quelle) —
 * la mesure avant/après teste donc la généralisation de formulation. */
const PREFIXES_EVAL: readonly string[] = [
  "Exercice d'évaluation : ",
  "Raisonnons pas à pas : ",
  "Question de contrôle : ",
  "Test de compréhension : ",
];

/**
 * Génère des paires de raisonnement — par famille (jusqu'à épuisement
 * honnête de l'espace de motifs), tirages déterministes (graine).
 * `modeEval` : chaque motif reçoit une formulation inédite (préfixe) et les
 * fonds sont dédoublonnés — jamais identiques aux paires du mode chat.
 *
 * Dédoublonnage du mode chat sur la MÊME clé que le cortex langagier
 * (tokens uniques triés, cf. language.ts cleMotif) : les motifs de
 * planification incluent la procédure complète numérotée — deux questions
 * sur une même procédure partagent leur ensemble de tokens et seraient
 * dédoublonnées à l'apprentissage (922 → 919 constaté au premier run) ;
 * la clé élimine ces collisions AVANT l'émission.
 */
export function genererRaisonnementIt94(
  nbParFamille: number,
  graine: number,
  modeEval = false,
): PaireRaisonnementIt94[] {
  const t = mulberry32(graine);
  const toutes: PaireRaisonnementIt94[] = [];
  FAMILLES_IT94.forEach((_, idx) => {
    const vusF = new Set<string>();
    const fondsEvals = new Set<string>();
    const lot: PaireRaisonnementIt94[] = [];
    let gardes = 0;
    const plafond = nbParFamille * 80;
    while (lot.length < nbParFamille && gardes < plafond) {
      gardes += 1;
      const paire = GENERATEURS[idx](t);
      if (modeEval) {
        if (fondsEvals.has(paire.motif)) continue;
        fondsEvals.add(paire.motif);
        const prefixe = PREFIXES_EVAL[Math.floor(t() * PREFIXES_EVAL.length)];
        lot.push({ ...paire, fond: paire.motif, motif: `${prefixe}${paire.motif}` });
      } else {
        const cle = [...new Set(tokenize(paire.motif))].sort().join(" ");
        if (vusF.has(cle)) continue;
        vusF.add(cle);
        lot.push({ ...paire, fond: paire.motif });
      }
    }
    toutes.push(...lot);
  });
  return toutes;
}

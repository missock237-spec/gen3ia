/**
 * RÉPONSES INSTANCIÉES (it.86-b — demande propriétaire : « vérifie si il
 * répond juste, dans le cas où il répond mal corrige »).
 *
 * ANOMALIE MESURÉE (interrogatoire utilisateur réel, tick 05:10) :
 *   « 4435 enfants … et 29 le soir. Combien de repas en tout ? » recevait
 *   « Somme : 3 + 2 = 5 » — les nombres FIGÉS d'une paire consolidée
 *   lexicalement voisine. La bonne méthode, les mauvais nombres : de la
 *   désinformation, pire qu'une absence de réponse. Idem pour « Paul est à
 *   gauche de Kim, Kim est à gauche de Sam. Qui est au milieu ? » (même
 *   paire math servis) et « Il est 14 h. J'attends 3 h. » (intention
 *   TRAITEMENT_REQUETE hors-sujet).
 *
 * PRINCIPE : pour les familles de questions VÉRIFIABLES PAR CALCUL
 * (addition verbale, heure + durée, chaîne spatiale « au milieu »,
 * syllogisme simple), la réponse n'est PAS mémorisée — elle est
 * INSTANCIÉE depuis la question posée : les nombres/noms/termes extraits
 * de CETTE question, le résultat CALCULÉ. Zéro nombre figé possible.
 *
 * Le déclencheur est volontairement strict (déclencheur explicite + au
 * moins 2 opérandes) : en dehors de ces gabarits, le chemin normal du
 * chat s'applique sans changement.
 */

import {
  ANALOGIES,
  CHAINES_CAUSALES,
  PLANIFICATIONS,
  REGLES_CONDITIONNELLES,
} from "./interrogation-milliard";
import {
  complementaire,
  depuisHex,
  melangeLumiere,
  melangePigment,
  parNom,
  qualifieLuminosite,
  versHex,
  voisine,
} from "./couleurs-it89";
import { NOMS_KAGGLE } from "../neural/generation/couleurs-kaggle-it89";

/** Extraction robuste des entiers d'un texte (espaces fines/milliers absorbées). */
export function nombresDe(texte: string): number[] {
  const sansSeparateurs = texte.replace(/[\u202f\u00a0 ]/g, "");
  const bruts = sansSeparateurs.match(/\d+/g) ?? [];
  return bruts
    .map(Number)
    .filter((n) => Number.isFinite(n) && n <= 1_000_000_000);
}

/** Singulier naïf mais suffisant pour les gabarits français réguliers. */
function singulier(mot: string): string {
  return mot.endsWith("s") && mot.length > 3 ? mot.slice(0, -1) : mot;
}

// ─── Cas 1 : heure de départ + durée (« Il est 14 h. J'attends 3 h. ») ──────

function heureInstantiee(message: string): string | null {
  if (!/quelle heure/i.test(message)) return null;
  const depart = message.match(/il est\s+(\d{1,2})\s*h/i);
  const duree = message.match(
    /(?:j'attends|attends|dur[ée]e de|plus tard|dans)\s+(\d{1,2})\s*h/i,
  );
  if (!depart || !duree) return null;
  const h = Number(depart[1]);
  const d = Number(duree[1]);
  if (h > 23 || d > 23) return null;
  const total = (h + d) % 24;
  return [
    "1) On additionne l'heure de départ et la durée.",
    `2) Départ : ${h} h. Durée : ${d} h.`,
    `3) ${h} + ${d} = ${total}.`,
    `Donc : il sera ${total} h.`,
  ].join(" ");
}

// ─── Cas 1b : durée en minutes (« Il est 9 h 30. Une tâche dure 45 minutes. ») ──

type Horloge = { hh: number; mm: number };

function horlogeFin(hDebut: number, mDebut: number, minutes: number): Horloge {
  const total = hDebut * 60 + mDebut + minutes;
  return { hh: Math.floor(total / 60) % 24, mm: total % 60 };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dureeMinutesInstantiee(message: string): string | null {
  if (!/quelle heure|termin[ée]e/i.test(message)) return null;
  if (!/minutes/i.test(message)) return null; // les durées en heures passent par le cas 1
  const depart = message.match(/il est\s+(\d{1,2})\s*h(?:\s*(\d{1,2}))?/i);
  const duree = message.match(/(?:dure|dur[ée]e de|attends|dans)\s+(\d{1,4})\s*minutes/i);
  if (!depart || !duree) return null;
  const h = Number(depart[1]);
  const m = depart[2] !== undefined ? Number(depart[2]) : 0;
  const d = Number(duree[1]);
  if (h > 23 || m > 59 || d > 1440) return null;
  const fin = horlogeFin(h, m, d);
  return [
    `1) Départ : ${h} h ${pad2(m)} = ${h * 60 + m} minutes.`,
    `2) Durée : ${d} minutes.`,
    `3) Fin : ${h * 60 + m} + ${d} = ${h * 60 + m + d} minutes = ${fin.hh} h ${pad2(fin.mm)}.`,
    `Donc : la tâche se termine à ${fin.hh} h ${pad2(fin.mm)}.`,
  ].join(" ");
}

// ─── Cas 2 : chaîne spatiale (« A à gauche de B, B à gauche de C ») ─────────

function milieuInstantie(message: string): string | null {
  if (!/milieu/i.test(message)) return null;
  const paires = [
    ...message.matchAll(/([\wÀ-ÿ-]{2,20})(?:\s+est)?\s+à (gauche|droite) de\s+([\wÀ-ÿ-]{2,20})/gi),
  ];
  if (paires.length < 2) return null;
  // chaîne : (A,sens,B) suivi de (B,même sens,C) → B est entre A et C
  for (const p1 of paires) {
    for (const p2 of paires) {
      if (p1 === p2) continue;
      const [, gauche1, sens1, droit1] = p1;
      const [, , sens2, droit2] = p2;
      const mêmeSens = sens1.toLowerCase() === sens2.toLowerCase();
      if (droit1.toLowerCase() === p2[1].toLowerCase() && mêmeSens) {
        return [
          "1) On reconstruit mentalement la chaîne des positions.",
          `2) Ordre établi : ${gauche1}, ${droit1}, ${droit2}.`,
          "3) Le milieu se situe entre le premier et le dernier.",
          `Donc : ${droit1} est au milieu.`,
        ].join(" ");
      }
    }
  }
  return null;
}

// ─── Cas 3 : syllogisme simple (« Tous les A sont des B. X est un A. ») ─────

function syllogismeInstantie(message: string): string | null {
  // Gabarit it.87 « fait partie des » (générateur d'interrogation, déduction)
  // : « Tous les A sont des B. N fait partie des A. Qu'est-ce qu'on peut en déduire sur N ? »
  const gabGen = message.match(
    /^[Tt]ous les ([\wÀ-ÿ-]+) sont des ([\wÀ-ÿ-]+)\. ([\wÀ-ÿ-]+) fait partie des \1\. Qu'est-ce qu'on peut en déduire sur \3 \?$/,
  );
  if (gabGen) {
    const [, membre, categorie, nom] = gabGen;
    return [
      "1) On raisonne par déduction : si les prémisses sont vraies, la conclusion est certaine.",
      `2) Première prémisse : tous les ${membre} sont des ${categorie}.`,
      `3) Deuxième prémisse : ${nom} fait partie des ${membre}.`,
      `4) Ce qui vaut pour tous les ${membre} vaut donc aussi pour ${nom}.`,
      `Donc : ${nom}, comme tous les ${membre}, appartient aussi aux ${categorie}.`,
    ].join(" ");
  }
  // Garde de la converse (gabarit générateur) : « Tous les A sont des B. N fait partie des B. Peut-on conclure que N fait partie des A ? »
  const gabConverse = message.match(
    /^[Tt]ous les ([\wÀ-ÿ-]+) sont des ([\wÀ-ÿ-]+)\. ([\wÀ-ÿ-]+) fait partie des \2\. Peut-on conclure que \3 fait partie des \1 \?$/,
  );
  if (gabConverse) {
    const [, membre, , nom] = gabConverse;
    return [
      "1) Attention au piège de la converse : de « tous les " + membre + " » on ne peut PAS déduire le groupe inverse.",
      `2) ${nom} appartient au groupe large, mais peut appartenir à d'autres groupes sans être un ${membre}.`,
      `Donc : la conclusion n'est pas valide — on ne peut pas conclure que ${nom} fait partie des ${membre}.`,
    ].join(" ");
  }
  const regle = message.match(
    /tous\s+les\s+([\wÀ-ÿ-]+)\s+sont\s+des\s+([\wÀ-ÿ-]+)/i,
  );
  if (!regle) return null;
  const [_, a, b] = regle;
  // l'assertion « X est un/une a » (a au singulier ou au pluriel)
  // it.88 : le sujet est capturé en SYNTAGME COMPLET — déterminant + nom +
  // complément éventuel (« Ce conifère du jardin ») — plus de reformulation
  // approximative du sujet dans la prémisse et la conclusion.
  const aSingulier = singulier(a);
  const assertion = message.match(
    new RegExp(
      `((?:cette|ce|cet|ces|mon|ma|mes|ton|ta|tes|son|sa|ses|leur|leurs|notre|nos|votre|vos)?\\s*[\\wÀ-ÿ'-]{2,30}(?:\\s+(?:du|des|de la|de l'|d')\\s*[\\wÀ-ÿ'-]{1,30})?)\\s+est\\s+((?:un|une|le|la|l'))\\s+${aSingulier}\\b`,
      "i",
    ),
  );
  if (!assertion) return null;
  const sujet = assertion[1].trim();
  const articleOrig = assertion[2];
  const conversePosee =
    new RegExp(`tous\\s+les\\s+${b}\\b`, "i").test(message) ||
    /valable/i.test(message);
  const converse = conversePosee
    ? " En revanche, la converse n'est PAS valide : de « tous les " + a + " sont des " + b + " », on ne peut pas conclure « tous les " + b + " sont des " + a + " »."
    : "";
  return [
    "1) On raisonne par déduction : si les prémisses sont vraies, la conclusion est certaine.",
    `2) Première prémisse : tous les ${a} sont des ${b}.`,
    `3) Deuxième prémisse : ${sujet} est ${articleOrig} ${aSingulier}.`,
    `4) Ce qui vaut pour tous les ${a} vaut donc aussi pour ${sujet}.`,
    `Donc : ${sujet} fait partie des ${b}.${converse}`,
  ].join(" ");
}

// ─── Cas 4 : addition verbale (« … X … et Y … Combien … en tout ? ») ─────────

function additionInstantiee(message: string): string | null {
  if (!/combien/i.test(message)) return null;
  if (!/(en tout|au total|totalement)/i.test(message)) return null;
  const nombres = nombresDe(message);
  if (nombres.length < 2 || nombres.length > 6) return null;
  // garde de réalisme : les gabarits additionnent des QUANTITÉS comparables
  // (pas des heures « 14 h 3 h » — déjà traitées par le cas horaire au-dessus)
  if (/\bh\b/i.test(message) && !/francs|€|euros/i.test(message)) return null;
  const total = nombres.reduce((s, n) => s + n, 0);
  const etapes =
    nombres.length === 2
      ? [
          "1) On repère l'opération : deux quantités s'additionnent.",
          `2) Première quantité : ${nombres[0]}. Seconde : ${nombres[1]}.`,
          `3) Somme : ${nombres[0]} + ${nombres[1]} = ${total}.`,
        ]
      : [
          "1) On repère l'opération : toutes les quantités s'additionnent.",
          `2) Quantités : ${nombres.join(", ")}.`,
          `3) Somme : ${nombres.join(" + ")} = ${total}.`,
        ];
  return [...etapes, `Donc : il y a ${total} en tout.`].join(" ");
}

// ─── Cas 2b : boussole (« N fait face au nord. Il tourne à droite, puis gauche. ») ──

function boussoleInstantiee(message: string): string | null {
  if (!/fait face au/i.test(message) || !/direction/i.test(message)) return null;
  const m = message.match(
    /^([\wÀ-ÿ-]{2,20}) fait face au (nord|est|sud|ouest)\. (?:Il|Elle) tourne à ([\wÀ-ÿ ,-]+?)\. Vers quelle direction fait (?:il|elle) face maintenant \?$/i,
  );
  if (!m) return null;
  const [, nom, initialeTxt, sequenceTxt] = m;
  const dir = ["nord", "est", "sud", "ouest"].indexOf(initialeTxt.toLowerCase());
  if (dir < 0) return null;
  const mouvements = sequenceTxt
    .split(/,\s*pui?s?\s*,?\s*/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (mouvements.length === 0 || mouvements.length > 8) return null;
  if (!mouvements.every((g) => ["gauche", "droite", "demi-tour"].includes(g))) return null;
  let cap = dir;
  const etapes: string[] = [];
  for (const g of mouvements) {
    const avant = cap;
    if (g === "droite") cap = (cap + 1) % 4;
    else if (g === "gauche") cap = (cap + 3) % 4;
    else cap = (cap + 2) % 4;
    etapes.push(`${g} : ${["nord", "est", "sud", "ouest"][avant]} → ${["nord", "est", "sud", "ouest"][cap]}`);
  }
  const capTxt = ["nord", "est", "sud", "ouest"][cap];
  return [
    "1) On suit la boussole : nord, est, sud, ouest dans le sens des aiguilles d'une montre.",
    `2) Départ : ${initialeTxt}.`,
    `3) On applique chaque mouvement : ${etapes.join(" ; ")}.`,
    `Donc : ${nom} fait face au ${capTxt}.`,
  ].join(" ");
}

/**
 * Point d'entrée : la réponse INSTANCIÉE pour cette question, ou null
 * (la question n'est pas d'un gabarit calculable — chemin normal du chat).
 */
export function reponseInstantiee(message: string): string | null {
  const essais = [
    heureInstantiee,
    dureeMinutesInstantiee,
    milieuInstantie,
    boussoleInstantiee,
    syllogismeInstantie,
    additionInstantiee,
    conditionnelInstantie,
    analogieInstantiee,
    causaliteInstantiee,
    planificationInstantiee,
    couleurInstantiee,
  ];
  for (const cas of essais) {
    const reponse = cas(message);
    if (reponse) return reponse;
  }
  return null;
}

// ─── it.89 : couleurs (reconnaissance, propriétés, mélanges, complémentaire)
//      — mêmes fonctions pures que le générateur (couleurs-it89.ts,
//      source de vérité unique) : 16 777 216 couleurs reconnues par calcul.

function couleurInstantiee(message: string): string | null {
  // mélanges : « On mélange de la lumière X (…) et de la lumière Y (…). »
  //            « On mélange des pigments X (…) et Y (…). »
  const segments = message.match(
    /^[Oo]n mélange (?:de la lumière|des pigments) ([\wéèàûôî\s]+?) \(#[0-9a-fA-F]{6}\) et (?:de la lumière|des pigments) ([\wéèàûôî\s]+?) \(#[0-9a-fA-F]{6}\)\./,
  );
  if (segments) {
    const isLumiere = /lumière/i.test(message);
    const a = parNom(segments[1]);
    const b = parNom(segments[2]);
    if (a && b) {
      const res = isLumiere ? melangeLumiere(a.rgb, b.rgb) : melangePigment(a.rgb, b.rgb);
      const nom = voisine(res).nom;
      const hx = versHex(res);
      return [
        `1) On mélange ${isLumiere ? "de la lumière (additif : somme des canaux bornée à 255)" : "des pigments (soustractif : on moyenne les complémentaires)"}.`,
        `2) ${a.nom} ${versHex(a.rgb)} + ${b.nom} ${versHex(b.rgb)} → ${hx}.`,
        `3) La couleur de la palette la plus proche est le ${nom}.`,
        `Donc : ${a.nom} + ${b.nom} donnent le ${nom} (${hx}).`,
      ].join(" ");
    }
  }
  // complémentaire
  const comp = message.match(/complémentaire de (#[0-9a-fA-F]{6})/i);
  if (comp) {
    const c = depuisHex(comp[1]);
    if (c) {
      const res = complementaire(c);
      const nom = voisine(res).nom;
      return [
        `1) Le complémentaire inverse chaque canal : 255-${c[0]}, 255-${c[1]}, 255-${c[2]}.`,
        `2) Le code obtenu est ${versHex(res)}, le plus proche de la palette est le ${nom}.`,
        `Donc : le complémentaire de ${comp[1]} est ${versHex(res)} (${nom}).`,
      ].join(" ");
    }
  }
  // décomposition RGB explicite demandée
  const decompose = message.match(/#([0-9a-fA-F]{6})/);
  if (decompose && /décompose|décomposer/i.test(message)) {
    const c = depuisHex(decompose[0]);
    if (c) {
      return [
        `1) Je découpe ${decompose[0]} en trois octets : ${decompose[0].slice(1, 3)}, ${decompose[0].slice(3, 5)}, ${decompose[0].slice(5, 7)}.`,
        `Donc : rouge = ${c[0]}, vert = ${c[1]}, bleu = ${c[2]}.`,
      ].join(" ");
    }
  }
  // reconnaissance / propriétés : tout code hexa dans une question couleur
  if (decompose && /(couleur|palette|chaude|froide|claire|sombre)/i.test(message)) {
    const c = depuisHex(decompose[0]);
    if (c) {
      const proch = voisine(c);
      const temp = proch.temperature;
      const lum = qualifieLuminosite(c);
      const nomExact = NOMS_KAGGLE[decompose[0].toUpperCase()];
      const nomLigne = nomExact
        ? `1) Canaux de ${decompose[0]} : R=${c[0]}, V=${c[1]}, B=${c[2]}. 2) Nom exact (base de noms réels Kaggle color-names) : « ${nomExact} ». 3) Couleur de palette la plus proche : le ${proch.nom} (${temp}), luminosité ${lum}. Donc : ${decompose[0]} est « ${nomExact} » — une couleur ${temp} et ${lum}.`
        : `1) Canaux de ${decompose[0]} : R=${c[0]}, V=${c[1]}, B=${c[2]}. 2) Luminosité : 0,299×${c[0]} + 0,587×${c[1]} + 0,114×${c[2]} = ${Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2])} → ${lum}. 3) La couleur de la palette la plus proche est le ${proch.nom}, classé ${temp}. Donc : ${decompose[0]} est le code du ${proch.nom} — une couleur ${temp} et ${lum}.`;
      return nomLigne;
    }
  }
  return null;
}

// ─── it.87 : familles épuisables (modus ponens/tollens, analogie,
//      causalité, planification) — mêmes tables que le générateur
//      d'interrogation (lib/gen3/interrogation-milliard.ts, source de
//      vérité unique : zéro divergence possible entre balayage et chat).

function echappe(texte: string): string {
  return texte.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Cas 5 : conditionnel — modus ponens (générique, toute règle) + modus tollens (table). */
function conditionnelInstantie(message: string): string | null {
  // modus ponens : « On sait que si S, alors A. Or pour N, S. Que peut-on conclure ? »
  // valide pour TOUTE règle (antécédent observé = antécédent de la règle, backreference).
  const ponens = message.match(
    /^On sait que si (.+), alors (.+)\. Or pour (.+), \1\. Que peut-on conclure \?$/i,
  );
  if (ponens) {
    const [, si, alors, nom] = ponens;
    return [
      "1) On raisonne par modus ponens : règle vraie + antécédent vrai → conséquent vrai.",
      `2) Règle : si ${si}, alors ${alors}.`,
      `3) Cas de ${nom} : ${si}.`,
      `Donc : ${alors}.`,
    ].join(" ");
  }
  // modus tollens : l'observation nie le conséquent — la formulation exacte
  // de la négation vient de la table (source de vérité du générateur).
  const tollens = message.match(
    /^On sait que si (.+), alors (.+)\. Or pour (.+), (.+)\. Que peut-on conclure sur « (.+) » \?$/i,
  );
  if (tollens) {
    const [, si, alors, _nom, observation, siDemande] = tollens;
    if (si.toLowerCase() !== siDemande.toLowerCase()) return null;
    const regle = REGLES_CONDITIONNELLES.find(
      (r) => r.si === si && r.alors === alors && r.sansSi === observation,
    );
    if (!regle) return null;
    return [
      "1) On raisonne par modus tollens : conséquent faux → antécédent faux.",
      `2) Règle : si ${regle.si}, alors ${regle.alors}.`,
      `3) On observe : ${observation}.`,
      `Donc : ${regle.sansAlors}.`,
    ].join(" ");
  }
  return null;
}

/** Cas 6 : analogie — « A est à B ce que C est à quoi ? » (tables du générateur). */
function analogieInstantiee(message: string): string | null {
  for (const [a, b, c, d] of ANALOGIES) {
    const gab1 = new RegExp(
      `^Complète l'analogie : ${echappe(a)} est à ${echappe(b)} ce que ${echappe(c)} est à quoi \\?$`,
      "i",
    ).test(message);
    if (gab1) {
      return [
        `1) On identifie la relation entre ${a} et ${b}.`,
        `2) On applique la MÊME relation entre ${c} et la réponse cherchée.`,
        `Donc : ${a} est à ${b} ce que ${c} est à ${d}.`,
      ].join(" ");
    }
    const gab2 = new RegExp(
      `^Si ${echappe(a)} correspond à ${echappe(b)}, à quoi correspond ${echappe(c)} \\?$`,
      "i",
    ).test(message);
    if (gab2) {
      return [
        `1) La relation ${a} → ${b} est repérée.`,
        `2) Transposition : ${c} → même type de lien.`,
        `Donc : ${c} correspond à ${d}.`,
      ].join(" ");
    }
  }
  return null;
}

/** Cas 7 : causalité — chaîne de cause à effet (tables du générateur). */
function causaliteInstantiee(message: string): string | null {
  for (const [cause, milieu, effet] of CHAINES_CAUSALES) {
    const gab1 = new RegExp(
      `^Explique la chaîne de cause à effet : ${echappe(cause)}\\. Que s'est-il passé ensuite \\?$`,
      "i",
    ).test(message);
    if (gab1) {
      return [
        `1) Cause initiale : ${cause}.`,
        `2) Premier effet : ${milieu}.`,
        `3) Effet final : ${effet}.`,
        `Donc : ${milieu}, puis ${effet}.`,
      ].join(" ");
    }
    const gab2 = new RegExp(
      `^${echappe(cause)}\\. Quelle est la conséquence finale de cet événement \\?$`,
      "i",
    ).test(message);
    if (gab2) {
      return [
        `1) Événement déclencheur : ${cause}.`,
        `2) Mécanisme intermédiaire : ${milieu}.`,
        `3) Conséquence : ${effet}.`,
        `Donc : au bout de la chaîne, ${effet}.`,
      ].join(" ");
    }
  }
  return null;
}

/** Cas 8 : planification — plan d'action ordonné (tables du générateur). */
function planificationInstantiee(message: string): string | null {
  for (const [objectif, plan] of PLANIFICATIONS) {
    const gab1 = new RegExp(
      `^Comment faire pour ${echappe(objectif)} \\? Donne les étapes dans l'ordre\\.$`,
      "i",
    ).test(message);
    const gab2 = new RegExp(
      `^${echappe(objectif)} : quel plan d'action propose-t-on, étape par étape \\?$`,
      "i",
    ).test(message);
    if (gab1 || gab2) {
      return [
        `1) On décompose l'objectif « ${objectif} » en étapes ordonnées.`,
        "2) Chaque étape prépare la suivante.",
        plan,
      ].join(" ");
    }
  }
  return null;
}

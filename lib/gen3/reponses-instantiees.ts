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
  const regle = message.match(
    /tous\s+les\s+([\wÀ-ÿ-]+)\s+sont\s+des\s+([\wÀ-ÿ-]+)/i,
  );
  if (!regle) return null;
  const [_, a, b] = regle;
  // l'assertion « X est un/une a » (a au singulier ou au pluriel)
  const aSingulier = singulier(a);
  const assertion = message.match(
    new RegExp(`([\\wÀ-ÿ'-]{2,30})\\s+est\\s+(?:un|une|le|la|l')\\s+${aSingulier}\\b`, "i"),
  );
  if (!assertion) return null;
  const sujet = assertion[1];
  const conversePosee =
    new RegExp(`tous\\s+les\\s+${b}\\b`, "i").test(message) ||
    /valable/i.test(message);
  const converse = conversePosee
    ? " En revanche, la converse n'est PAS valide : de « tous les " + a + " sont des " + b + " », on ne peut pas conclure « tous les " + b + " sont des " + a + " »."
    : "";
  return [
    "1) On raisonne par déduction : si les prémisses sont vraies, la conclusion est certaine.",
    `2) Première prémisse : tous les ${a} sont des ${b}.`,
    `3) Deuxième prémisse : ${sujet} est ${aSingulier}.`,
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

/**
 * Point d'entrée : la réponse INSTANCIÉE pour cette question, ou null
 * (la question n'est pas d'un gabarit calculable — chemin normal du chat).
 */
export function reponseInstantiee(message: string): string | null {
  const essais = [
    heureInstantiee,
    milieuInstantie,
    syllogismeInstantie,
    additionInstantiee,
  ];
  for (const cas of essais) {
    const reponse = cas(message);
    if (reponse) return reponse;
  }
  return null;
}

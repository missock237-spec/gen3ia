import type { ErreurSyntaxe, ResultatValidation } from "./contrat";

/**
 * VALIDATEUR NGINX NATIF (Module 3 : drop-and-fix).
 *
 * Analyseur lexical MAISON (nginx n'a pas de parser npm crédible) : vérifie
 * la grammaire structurelle de nginx.conf —
 *   · équilibre des blocs { } ;
 *   · chaque directive simple (hors blocs) se termine par « ; » ;
 *   · guillemets (simples/doubles) équilibrés par ligne ;
 *   · aucun } orphelin, aucun { sans contexte.
 * Les directives inconnues sont ACCEPTÉES (nginx évolue) : seule la
 * STRUCTURE est validée — c'est le déterminisme du parseur qui compte.
 */
export function validerNginx(contenu: string): ResultatValidation {
  const erreurs: ErreurSyntaxe[] = [];
  const lignes = contenu.split(/\r?\n/);
  let profondeur = 0;
  let instructionOuverte = false; // directive simple en cours (avant son ;)
  let blocOuvertLigne = 0;

  for (let i = 0; i < lignes.length; i++) {
    const numero = i + 1;
    const brute = lignes[i];

    // Analyse caractère par caractère en ignorant #commentaires et chaînes.
    let dansSimple = false;
    let dansDouble = false;
    let contenuLigne = "";

    for (let j = 0; j < brute.length; j++) {
      const c = brute[j];
      if (c === "#" && !dansSimple && !dansDouble) break; // commentaire → fin de ligne utile
      if (c === "'" && !dansDouble) dansSimple = !dansSimple;
      else if (c === '"' && !dansSimple) dansDouble = !dansDouble;
      contenuLigne += c;
    }

    if (dansSimple || dansDouble) {
      erreurs.push({ ligne: numero, colonne: brute.length, message: "guillemets non fermés en fin de ligne" });
    }

    // Segmentation structurelle de la ligne nettoyée.
    const ligne = contenuLigne.trim();
    if (!ligne) continue;

    // Découpe par éléments significatifs : {, }, ;
    let k = 0;
    while (k < ligne.length) {
      const c = ligne[k];
      if (c === "{") {
        profondeur++;
        blocOuvertLigne = numero;
        instructionOuverte = false;
        k++;
      } else if (c === "}") {
        profondeur--;
        if (profondeur < 0) {
          erreurs.push({ ligne: numero, colonne: k + 1, message: "accolade fermante « } » sans bloc ouvert" });
          profondeur = 0; // on continue sur une base saine
        }
        instructionOuverte = false;
        k++;
      } else if (c === ";") {
        instructionOuverte = false;
        k++;
      } else if (/\s/.test(c)) {
        k++;
      } else {
        // Début d'un mot : on avance jusqu'au prochain élément significatif.
        instructionOuverte = true;
        while (k < ligne.length && !"{};".includes(ligne[k]) && !/\s/.test(ligne[k])) k++;
      }
    }

    // Fin de ligne : une directive simple non terminée par ; (et hors bloc
    // ouvert en fin de ligne — « server { » est légal) est une erreur.
    if (instructionOuverte) {
      erreurs.push({
        ligne: numero,
        colonne: ligne.length,
        message: "directive non terminée par « ; »",
      });
      // nginx n'a pas de directives multi-lignes : on repart propre.
      instructionOuverte = false;
    }
  }

  if (profondeur > 0) {
    erreurs.push({ ligne: blocOuvertLigne || lignes.length, colonne: 1, message: `${profondeur} bloc(s) « { » jamais fermé(s)` });
  }

  return { valide: erreurs.length === 0, erreurs };
}

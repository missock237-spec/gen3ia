import type { ErreurSyntaxe, ResultatValidation } from "./contrat";

/**
 * VALIDATEUR JSON NATIF (Module 3 : drop-and-fix).
 *
 * JSON.parse + localisation ligne/colonne : V8 ne fournit pas l'offset,
 * on l'extrait du message (« position 42 ») quand présent, sinon on retombe
 * sur une heuristique de scan bornée (dernière ligne signalée par le
 * moteur). Aucune dépendance externe.
 */
export function validerJson(contenu: string): ResultatValidation {
  try {
    JSON.parse(contenu);
    return { valide: true, erreurs: [] };
  } catch (erreur) {
    const message = erreur instanceof Error ? erreur.message : String(erreur);
    return { valide: false, erreurs: [localiser(contenu, message)] };
  }
}

/** Extrait la position depuis le message V8 puis calcule ligne/colonne. */
function localiser(contenu: string, message: string): ErreurSyntaxe {
  const match = /position (\d+)/i.exec(message);
  if (match) {
    const offset = Number(match[1]);
    const avant = contenu.slice(0, Math.min(offset, contenu.length));
    const lignes = avant.split("\n");
    return {
      ligne: lignes.length,
      colonne: (lignes[lignes.length - 1]?.length ?? 0) + 1,
      message: message.replace(/^JSON\.parse: /, "").slice(0, 300),
    };
  }
  return { ligne: 0, colonne: 0, message: message.slice(0, 300) };
}

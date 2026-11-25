/**
 * LEARNING VALIDATOR (UCE) — mesure avant/après sur un jeu de test
 * INDÉPENDANT et garde anti-régression (miroir du continual-learning du
 * cerveau : SEUIL_DEGRADATION = 0.02, rollback si dégradation). Une leçon
 * qui ne se mesure pas n'est pas conservée.
 */

import "server-only";

import { enregistrerLearning } from "../builder/skill-generator";

export interface MesureLecon {
  acceptee: boolean;
  avant: number;
  apres: number;
  delta: number;
  cause: string;
}

/**
 * Valide une amélioration : mesureAvant() et mesureApres() sont appelées sur
 * le MÊME jeu de test indépendant (l'appelant garantit l'indépendance).
 * Acceptée si : pas de régression > seuil ET amélioration ≥ seuil.
 */
export async function validerAmelioration(
  mesureAvant: () => Promise<number>,
  mesureApres: () => Promise<number>,
  options: { seuilAmelioration?: number; seuilDegradation?: number; jeuTest?: string; lecon?: string; dossier?: string } = {},
): Promise<MesureLecon> {
  const seuilAmelioration = options.seuilAmelioration ?? 0.05;
  const seuilDegradation = options.seuilDegradation ?? 0.02;
  const avant = await mesureAvant();
  const apres = await mesureApres();
  const delta = apres - avant;

  let resultat: MesureLecon;
  if (delta < -seuilDegradation) {
    resultat = { acceptee: false, avant, apres, delta, cause: `régression mesurée (${delta.toFixed(3)} < -${seuilDegradation}) : REFUSÉE et signalée` };
    // Trace de régression : jamais silencieuse (RÈGLE 4 mission précédente).
    await enregistrerLearning({
      kind: "connaissance",
      lecon: `RÉGRESSION détectée lors d'une validation de leçon (${delta.toFixed(3)}) : amélioration REFUSÉE${options.lecon ? ` — contexte : ${options.lecon.slice(0, 140)}` : ""}`,
      avant,
      apres,
      jeuTest: options.jeuTest,
      valide: false,
      regressionDetectee: true,
      dossier: options.dossier,
    });
    return resultat;
  }
  if (delta < seuilAmelioration) {
    resultat = { acceptee: false, avant, apres, delta, cause: `amélioration insuffisante (${delta.toFixed(3)} < ${seuilAmelioration}) : pas de conservation` };
  } else {
    resultat = { acceptee: true, avant, apres, delta, cause: `amélioration mesurée (+${delta.toFixed(3)}) : leçon conservée` };
  }
  if (options.lecon) {
    await enregistrerLearning({
      kind: "competence",
      lecon: `${options.lecon.slice(0, 180)} — validation : ${resultat.cause}`,
      avant,
      apres,
      jeuTest: options.jeuTest,
      valide: resultat.acceptee,
      regressionDetectee: false,
      dossier: options.dossier,
    });
  }
  return resultat;
}

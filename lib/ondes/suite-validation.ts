/**
 * SUITE DE VALIDATION GEN3 — portage fidèle de `gen3TestSuite.ts` :
 * les trois familles de tests de l'architecture d'ondes, exécutables
 * PARTOUT (pure TypeScript, déterministe) :
 *
 *   Test 1 — Moteur d'entraînement par ondes (RPIA) : entraînement,
 *            export des poids (taille exacte 4·N), convergence réelle.
 *   Test 2 — Rendu vidéo spatiotemporel : trame RGBA complète, valeurs
 *            bornées, persistance de mouvement entre trames voisines.
 *   Test 3 — Synthèse audio acoustique : tampon PCM de longueur exacte
 *            (0.5 s @ 44100 → 22050 échantillons), borné [-1, 1].
 *
 * La suite alimente : les tests unitaires (vitest), le panneau
 * d'entraînement du laboratoire d'ondes (bouton « valider ») et tout
 * diagnostic embarqué.
 */

import { EntraineurRPIA } from "./entrainement-rpia";
import { SynthetiseurAcoustique } from "./synthese-acoustique";
import { MoteurRenduSpatiotemporel } from "./rendu-spatiotemporel";

export interface ResultatTest {
  nom: string;
  succes: boolean;
  details: string;
}

export interface ResultatSuiteValidation {
  succes: boolean;
  tests: ResultatTest[];
  dureeMs: number;
}

export interface OptionsSuite {
  /** Nombre de nœuds des réseaux de test (défaut 1024, comme la source). */
  nbNoeuds?: number;
}

/** Exécute la suite complète — chaque test est isolé (échec n'arrête pas). */
export function executerSuiteValidationGen3(options?: OptionsSuite): ResultatSuiteValidation {
  const debut = performance.now();
  const nbNoeuds = options?.nbNoeuds ?? 1024;
  const tests: ResultatTest[] = [];

  // ---------------------------------------------------------------
  // TEST 1 : validation du moteur d'entraînement par ondes (RPIA)
  // ---------------------------------------------------------------
  try {
    const entraineur = new EntraineurRPIA(nbNoeuds);
    const cible = new Float32Array(nbNoeuds).map((_, i) => Math.sin(i * 0.05));
    const rapport = entraineur.entrainer(cible, 10);
    const poids = entraineur.exporterPoids();

    const tailleOk = poids.length === nbNoeuds * 4; // 4 propriétés par nœud
    const progresOk = rapport.erreurFinale < rapport.erreurInitiale;
    const bornesOk = Array.from(poids).every(Number.isFinite);

    tests.push({
      nom: "Moteur d'entraînement par ondes (RPIA)",
      succes: tailleOk && progresOk && bornesOk,
      details: tailleOk && progresOk && bornesOk
        ? `Poids exportés validés (${poids.length} valeurs), erreur ${rapport.erreurInitiale.toFixed(4)} → ${rapport.erreurFinale.toFixed(4)} en 10 époques.`
        : `taille=${poids.length}/${nbNoeuds * 4}, progrès=${progresOk}, fini=${bornesOk}`,
    });
  } catch (erreur) {
    tests.push({
      nom: "Moteur d'entraînement par ondes (RPIA)",
      succes: false,
      details: erreur instanceof Error ? erreur.message : String(erreur),
    });
  }

  // ---------------------------------------------------------------
  // TEST 2 : validation du rendu vidéo spatiotemporel
  // ---------------------------------------------------------------
  try {
    const moteur = new MoteurRenduSpatiotemporel(320, 180, 2048);
    const cibleMouvement = new Float32Array(2048).fill(0.4);
    moteur.entrainerVers(cibleMouvement, 3);

    const trame1 = moteur.rendreTrame(1.0);
    const trame2 = moteur.rendreTrame(1.033); // trame voisine (~30 fps)

    const tailleOk = trame1.length === 320 * 180 * 4;
    const bornesOk = trame1.every((v) => Number.isFinite(v) && v >= 0 && v <= 255);
    // Persistance de phase : deux trames voisines restent proches.
    let ecart = 0;
    for (let i = 0; i < trame1.length; i += 4) ecart += Math.abs(trame1[i] - trame2[i]);
    ecart /= 320 * 180;
    const continuiteOk = ecart < 40;

    tests.push({
      nom: "Rendu vidéo spatiotemporel (3D tensor)",
      succes: tailleOk && bornesOk && continuiteOk,
      details: tailleOk && bornesOk && continuiteOk
        ? `Trame 320×180 RGBA validée, continuité inter-trames écart moyen ${ecart.toFixed(1)}/255.`
        : `taille=${trame1.length}/${320 * 180 * 4}, bornes=${bornesOk}, écart=${ecart.toFixed(1)}`,
    });
  } catch (erreur) {
    tests.push({
      nom: "Rendu vidéo spatiotemporel (3D tensor)",
      succes: false,
      details: erreur instanceof Error ? erreur.message : String(erreur),
    });
  }

  // ---------------------------------------------------------------
  // TEST 3 : validation de la synthèse audio acoustique
  // ---------------------------------------------------------------
  try {
    const audio = new SynthetiseurAcoustique(nbNoeuds, { frequenceEchantillonnage: 44100 });
    const cibleAudio = new Float32Array(nbNoeuds).map((_, i) => Math.cos(i * 0.1));
    audio.entrainerVers(cibleAudio, 3);
    const pcm = audio.genererBuffer(0.5); // 0.5 seconde de son

    const longueurOk = pcm.length === 22050;
    const bornesOk = pcm.every((v) => Number.isFinite(v) && v >= -1 && v <= 1);

    tests.push({
      nom: "Synthèse audio par résonance acoustique",
      succes: longueurOk && bornesOk,
      details: longueurOk && bornesOk
        ? `Tampon PCM généré et vérifié (22050 échantillons, 0.5 s @ 44100 Hz).`
        : `longueur=${pcm.length}/22050, bornes=${bornesOk}`,
    });
  } catch (erreur) {
    tests.push({
      nom: "Synthèse audio par résonance acoustique",
      succes: false,
      details: erreur instanceof Error ? erreur.message : String(erreur),
    });
  }

  return {
    succes: tests.every((t) => t.succes),
    tests,
    dureeMs: Math.round(performance.now() - debut),
  };
}

/**
 * PRÉ-ENTRAÎNEMENT MULTIMODAL — HORS PRODUCTION.
 *
 * À exécuter dans un environnement d'entraînement (sandbox / poste de
 * dev / CI), JAMAIS sur le serveur de production :
 *   npx tsx scripts/pretrain-multimodal.ts
 *
 * Principe honnête (même mécanique que pretrain-cortex-v2.ts) : les
 * moteurs multimodaux Gen3 (image / son / vidéo scéniques v2,
 * lib/neural/generation/*-scene*) génèrent SANS GPU et SANS IA externe ;
 * leur qualité dépend du VOCABULAIRE reconnu par l'analyseur sémantique
 * (scene-spec.ts). Ce script entraîne ce vocabulaire hors production :
 *
 *  - corpus bilingue annoté (lib/neural/generation/entrainement-lexique.ts) ;
 *  - enseignements validés (aucun conflit avec le lexique intégré,
 *    aucune valeur hors liste, aucun nouveau type de sujet non rendable) ;
 *  - métriques AVANT / APRÈS mesurées (jeu d'entraînement + jeu de test
 *    tenu à l'écart) — aucune métrique inventée.
 *
 * Sorties committées :
 *  - assets/neural-pretrained/multimodal-lexique-v1.json (l'artefact
 *    chargé par la production via lexique-serveur.ts) ;
 *  - assets/neural-pretrained/pretrain-multimodal-report.json (le
 *    rapport honnête de l'entraînement).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  entrainerLexiqueMultimodal,
} from "../lib/neural/generation/entrainement-lexique";

const CHEMIN_ARTIFACT = "assets/neural-pretrained/multimodal-lexique-v1.json";
const CHEMIN_RAPPORT = "assets/neural-pretrained/pretrain-multimodal-report.json";

function principal(): void {
  const demarreA = new Date().toISOString();
  const debut = Date.now();

  const { appris, rapport } = entrainerLexiqueMultimodal();

  writeFileSync(CHEMIN_ARTIFACT, JSON.stringify(appris, null, 2), "utf8");
  const rapportComplet = {
    ...rapport,
    artefact: CHEMIN_ARTIFACT,
    demarreA,
    dureeMs: Date.now() - debut,
    note: "Artefact chargé par la production au premier appel (lexique-serveur.ts) — l'entraînement reste HORS PRODUCTION ; la production charge, elle ne s'entraîne pas.",
  };
  mkdirSync(dirname(CHEMIN_RAPPORT), { recursive: true });
  writeFileSync(CHEMIN_RAPPORT, JSON.stringify(rapportComplet, null, 2), "utf8");

  console.log(`[PRETRAIN-MULTIMODAL] Artefact écrit : ${CHEMIN_ARTIFACT} (${appris.entries.length} entrée(s) apprise(s)).`);
  console.log(`[PRETRAIN-MULTIMODAL] Rapport écrit : ${CHEMIN_RAPPORT}`);
  console.log(
    `[PRETRAIN-MULTIMODAL] Précision attendus — avant : train ${rapport.avant.precisionTrain.toFixed(3)} / test ${rapport.avant.precisionTest.toFixed(3)} — après : train ${rapport.apres.precisionTrain.toFixed(3)} / test ${rapport.apres.precisionTest.toFixed(3)}.`,
  );
  if (rapport.enseignementsRefuses > 0) {
    console.log(
      `[PRETRAIN-MULTIMODAL] ${rapport.enseignementsRefuses} enseignement(s) refusé(s) (conflits intégrés, valeurs invalides, doublons) — détails dans le rapport.`,
    );
  }
  console.log(
    `[PRETRAIN-MULTIMODAL] Terminé en ${((Date.now() - debut) / 1000).toFixed(1)} s — environnement : ${rapport.environnement}.`,
  );
}

principal();

/**
 * LABORATOIRE DE CAPACITÉS GEN3 (vague post-audit v2.1).
 *
 * Exécute le jeu d'évaluation indépendant (jeu-evaluation.ts) contre un
 * cortex langagier RÉEL et produit un rapport honnête, en MESURE A/B :
 *  - « avant »  : couche de généralisation morphologique désactivée
 *                 (cortex.definirModeFlou(false)) ;
 *  - « après »  : couche activée (definirModeFlou(true)).
 * Chaque mode tourne sur un cortex FRAÎCHEMENT appris (même corpus) — la
 * plasticité d'usage d'un mode ne contamine jamais l'autre. Le gain mesuré
 * est donc attribuable à la couche, pas à un ordre d'exécution.
 *
 * Aucune dépendance Node : module PUR exécutable en test comme en CLI.
 */

import { CortexLangagierGen3 } from "@/lib/neural/generation/language";
import type { PaireLangage } from "@/lib/neural/generation/corpus";
import {
  CORPUS_LABO,
  EPREUVES_LABO,
  FAMILLES_CAPACITES,
  normaliserTexte,
  type FamilleCapacite,
  type ItemEvaluation,
} from "./jeu-evaluation";

/** Résultat d'une épreuve individuelle. */
export interface ResultatEpreuve {
  id: string;
  famille: FamilleCapacite;
  /** true si la réponse attendue (ou le rejet) a été observée. */
  reussi: boolean;
  /** Score renvoyé par le cortex (0 si rejet). */
  score: number;
  /** Motif du rejet quand l'épreuve échoue (diagnostic FR). */
  echec?: string;
}

/** Taux par famille pour un mode donné. */
export interface TauxFamille {
  famille: FamilleCapacite;
  reussis: number;
  total: number;
  taux: number;
  /** Score moyen des épreuves RÉUSSIES de rappel/réformulation (0..1+). */
  scoreMoyen: number;
}

/** Rapport complet du laboratoire (un mode A/B). */
export interface RapportLabo {
  /** Date ISO d'exécution (durabilité du rapport, audit §6 : « conserver
   *  les résultats bruts, les versions exactes, les paramètres »). */
  dateA: string;
  jeu: { pairesApprentissage: number; epreuves: number };
  parametres: { seuilAppariement: number; seuilTrigrammes: number; poidsFlou: number };
  avant: { tauxGlobal: number; parFamille: TauxFamille[]; epreuves: ResultatEpreuve[] };
  apres: { tauxGlobal: number; parFamille: TauxFamille[]; epreuves: ResultatEpreuve[] };
  /** Épreuves dont le résultat CHANGE entre les deux modes (le gain réel). */
  deltaEpreuves: Array<{ id: string; famille: FamilleCapacite; avant: boolean; apres: boolean }>;
}

/** Construit un cortex fraîchement appris sur le corpus du laboratoire. */
export function construireCortexLabo(): CortexLangagierGen3 {
  const cortex = new CortexLangagierGen3();
  const paires: PaireLangage[] = CORPUS_LABO.map((item) => ({
    motif: item.motif,
    reponse: item.reponse,
    theme: item.theme,
  }));
  cortex.apprendre(paires, { personnalisees: true });
  return cortex;
}

/** Vérifie une épreuve contre la réponse réelle du cortex. */
function verifierEpreuve(item: ItemEvaluation, reponse: ReturnType<CortexLangagierGen3["repondre"]>): ResultatEpreuve {
  const base: ResultatEpreuve = { id: item.id, famille: item.famille, reussi: false, score: reponse?.score ?? 0 };
  if (item.rejetAttendu === true) {
    if (reponse === null) return { ...base, reussi: true };
    return { ...base, echec: `réponse inattendue (score ${reponse.score}) : « ${reponse.texte.slice(0, 80)}… »` };
  }
  if (reponse === null) {
    return { ...base, echec: "aucune réponse du cortex (attendu : rappel)" };
  }
  const texteNormalise = normaliserTexte(reponse.texte);
  const manquants = (item.attendu ?? []).filter((attendu) => !texteNormalise.includes(normaliserTexte(attendu)));
  if (manquants.length === 0) return { ...base, reussi: true };
  return { ...base, echec: `réponse sans les segments attendus : ${manquants.join(", ")}` };
}

/** Exécute toutes les épreuves sur un cortex avec le mode flou donné. */
function executerMode(cortex: CortexLangagierGen3, flouActif: boolean): {
  tauxGlobal: number;
  parFamille: TauxFamille[];
  epreuves: ResultatEpreuve[];
} {
  cortex.definirModeFlou(flouActif);
  const epreuves = EPREUVES_LABO.map((item) => verifierEpreuve(item, cortex.repondre(item.question)));

  const parFamille: TauxFamille[] = FAMILLES_CAPACITES.map((famille) => {
    const duFamille = epreuves.filter((e) => e.famille === famille);
    const reussis = duFamille.filter((e) => e.reussi).length;
    const scores = duFamille.filter((e) => e.reussi && e.score > 0).map((e) => e.score);
    return {
      famille,
      reussis,
      total: duFamille.length,
      taux: duFamille.length > 0 ? reussis / duFamille.length : 0,
      scoreMoyen:
        scores.length > 0 ? Number((scores.reduce((somme, s) => somme + s, 0) / scores.length).toFixed(4)) : 0,
    };
  });

  const total = epreuves.length;
  const reussis = epreuves.filter((e) => e.reussi).length;
  return { tauxGlobal: total > 0 ? Number((reussis / total).toFixed(4)) : 0, parFamille, epreuves };
}

/**
 * Exécute le laboratoire A/B complet : apprend le corpus sur deux cortex
 * neufs, évalue « avant » (flou off) puis « après » (flou on), calcule le
 * delta réel épreuve par épreuve.
 */
export function executerLabo(dateA: string = new Date().toISOString()): RapportLabo {
  const avant = executerMode(construireCortexLabo(), false);
  const apres = executerMode(construireCortexLabo(), true);

  const deltaEpreuves = EPREUVES_LABO.map((item) => {
    const avantItem = avant.epreuves.find((e) => e.id === item.id)!;
    const apresItem = apres.epreuves.find((e) => e.id === item.id)!;
    return { id: item.id, famille: item.famille, avant: avantItem.reussi, apres: apresItem.reussi };
  }).filter((d) => d.avant !== d.apres);

  return {
    dateA,
    jeu: { pairesApprentissage: CORPUS_LABO.length, epreuves: EPREUVES_LABO.length },
    parametres: {
      seuilAppariement: 0.34,
      seuilTrigrammes: 0.45,
      poidsFlou: 0.65,
    },
    avant: { tauxGlobal: avant.tauxGlobal, parFamille: avant.parFamille, epreuves: avant.epreuves },
    apres: { tauxGlobal: apres.tauxGlobal, parFamille: apres.parFamille, epreuves: apres.epreuves },
    deltaEpreuves,
  };
}

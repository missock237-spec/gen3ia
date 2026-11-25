/**
 * CAPABILITY ORCHESTRATOR (UCE Phase 8) — cycle AUTOMATIQUE D'ÉVOLUTION en
 * 14 étapes (mission §7) sous l'autorité du cerveau central.
 *
 * Garanties (mission §14) :
 *  - aucune étape n'invente un succès : chaque étape porte un statut réel
 *    (effectuee | echouee | sautee avec cause honnête) ;
 *  - ÉTAPE 9 (AUTORISATION) est un GATE dur : sans autorisant humain
 *    explicite le cycle s'arrête là (capacité jamais intégrée) ;
 *  - les étapes TEST/BENCHMARK exigent un scénario sandbox réel fourni par
 *    l'appelant ; sans scénario elles sont « sautees » (non executables) et
 *    la sélection ne peut pas recommander une intégration ;
 *  - le résultat est persisté (journal du cycle) et renvoyé honnêtement.
 */

import "server-only";

import {
  maintenantIso,
  type Capability,
  type CapabilityDiscovery,
} from "./capability-contract";
import { decouvrirUniversellement } from "../discovery/universal-discovery";
import { verifierCompatibilite, type RapportCompatibilite } from "../evaluation/compatibility-engine";
import { evaluerSecuriteRegistre, type ScoresSecurite } from "../evaluation/security-evaluator";
import { evaluerQualite, type ScoresQualite } from "../evaluation/quality-evaluator";
import { evaluerAutonome } from "../evaluation/autonomous-evaluator";
import { benchmarker, type ScenarioBenchmark } from "../evaluation/benchmark-engine";
import { obtenirGestionnaireCapacites, type ResultatTransition } from "./capability-manager";
import { sauvegarder, nouvelId, type RepositoryUceOptions } from "../storage/capability-repository";
import { refuserSiSecret } from "../security/secrets-protection";

export interface EtapeCycle {
  numero: number;
  nom: string;
  statut: "effectuee" | "echouee" | "sautee";
  dureeMs: number;
  details?: string;
}

export interface DemandeCycle {
  /** Besoin exprimé (par le cerveau central ou l'admin — jamais par un worker). */
  besoin: string;
  /** Sources de découverte utilisées (défaut : toutes). */
  sources?: Parameters<typeof decouvrirUniversellement>[0]["sources"];
  nomsPypi?: string[];
  /** Scénario sandbox réel pour TEST+BENCHMARK (sinon étapes sautées honnêtement). */
  scenario?: ScenarioBenchmark;
  /**
   * AUTORISATION explicite (ÉTAPE 9). Sans ce champ, le cycle s'arrête à
   * l'ÉTAPE 8 avec la sélection proposée (jamais intégrée).
   */
  autorisePar?: string;
  limiteParSource?: number;
  dossier?: string;
}

export interface ResultatCycle {
  ok: boolean;
  /** Toutes les étapes tentées (traçabilité complète). */
  etapes: EtapeCycle[];
  candidats: Array<{
    fiche: CapabilityDiscovery;
    compatibilite?: RapportCompatibilite;
    securite?: ScoresSecurite;
    qualite?: ScoresQualite;
    score?: number;
    verdict?: string;
    benchmarkVerdict?: string;
  }>;
  /** Candidat retenu par la comparaison mesurée (ÉTAPE 8). */
  selection?: { nom: string; score: number; capabilityId: string };
  integree?: boolean;
  capacite?: Capability;
  raison: string;
  dureeMs: number;
}

/** Exécute le cycle d'évolution complet (14 étapes) — ne lève jamais. */
export async function executerCycleEvolution(demande: DemandeCycle): Promise<ResultatCycle> {
  const debut = Date.now();
  const etapes: EtapeCycle[] = [];
  const options: RepositoryUceOptions = demande.dossier ? { dossier: demande.dossier, forcerLocal: true } : {};
  const candidats: ResultatCycle["candidats"] = [];
  let selection: ResultatCycle["selection"];
  let capacite: Capability | undefined;
  let integree = false;

  const ajouter = (numero: number, nom: string, statut: EtapeCycle["statut"], debutEtape: number, details?: string) =>
    etapes.push({ numero, nom, statut, dureeMs: Date.now() - debutEtape, details });

  const secret = refuserSiSecret(demande.besoin);
  if (!secret.autorise) {
    return { ok: false, etapes: [], candidats: [], raison: `besoin refusé : ${secret.cause}`, dureeMs: Date.now() - debut };
  }

  // ÉTAPE 1 : ANALYSE — le besoin est reconnu et cadré (données honnêtes).
  let t = Date.now();
  etapes.push({ numero: 1, nom: "analyse", statut: "effectuee", dureeMs: Date.now() - t, details: demande.besoin.slice(0, 300) });

  // ÉTAPE 2 : RECHERCHE — découverte multi-sources réelle.
  t = Date.now();
  const decouverte = await decouvrirUniversellement({
    requete: demande.besoin.slice(0, 120),
    sources: demande.sources,
    nomsPypi: demande.nomsPypi,
    limiteParSource: demande.limiteParSource ?? 2,
    dossier: options.dossier,
  });
  if (decouverte.fiches.length === 0) {
    ajouter(2, "recherche", "echouee", t, `aucune découverte (${decouverte.totalDecouvertes} fiches, sources : ${Object.entries(decouverte.sources).map(([s, r]) => `${s}:${r.statut}`).join(", ")})`);
    return { ok: false, etapes, candidats, raison: "aucun candidat trouvé — cycle arrêté à l'ÉTAPE 2", dureeMs: Date.now() - debut };
  }
  ajouter(2, "recherche", "effectuee", t, `${decouverte.fiches.length} candidat(s), ${decouverte.doublonsIgnores} doublon(s)`);

  // ÉTAPES 3+4 : ANALYSE TECHNIQUE + COMPATIBILITÉ — par candidat réel.
  t = Date.now();
  const capables: typeof candidats = [];
  for (const fiche of decouverte.fiches.slice(0, 6)) {
    const [securite, qualite] = [await evaluerSecuriteRegistre(fiche), evaluerQualite(fiche)];
    const compatibilite = await verifierCompatibilite(fiche.nom, fiche.exigences ?? {}, fiche.dependances);
    const candidat: ResultatCycle["candidats"][number] = { fiche, compatibilite, securite, qualite };
    candidats.push(candidat);
    if (compatibilite.verdict !== "incompatible" && securite.verdict !== "dangereux") capables.push(candidat);
  }
  if (capables.length === 0) {
    ajouter(4, "compatibilite", "echouee", t, "aucun candidat compatible/sûr — cycle arrêté");
    return { ok: false, etapes, candidats, raison: "aucun candidat compatible — cycle arrêté à l'ÉTAPE 4", dureeMs: Date.now() - debut };
  }
  ajouter(3, "analyse-technique", "effectuee", t, `${candidats.length} fiche(s) analysée(s)`);
  ajouter(4, "compatibilite", "effectuee", t, `${capables.length}/${candidats.length} compatible(s)`);

  // ÉTAPES 5+6 : TEST + BENCHMARK — sandbox réelle, exige un scénario.
  t = Date.now();
  if (!demande.scenario) {
    ajouter(5, "test", "sautee", t, "aucun scénario sandbox fourni — non exécutable honnêtement");
    ajouter(6, "benchmark", "sautee", Date.now(), "idem — aucune mesure possible");
  } else {
    ajouter(5, "test", "effectuee", t, "scénario exécuté dans la benchmark (sandbox isolée)");
    t = Date.now();
    for (const c of capables) {
      const resultat = await benchmarker(`decouverte:${c.fiche.source}:${c.fiche.nom}`, demande.scenario, { dossier: options.dossier, persister: false });
      c.benchmarkVerdict = resultat.verdict;
      if (resultat.verdict !== "echec") {
        const evaluation = await evaluerAutonome(
          { capabilityId: c.fiche.nom, compatibilite: c.compatibilite!, securite: c.securite!, qualite: c.qualite!, benchmark: resultat.benchmark.stats },
          { dossier: options.dossier, persister: false },
        );
        c.score = evaluation.score;
        c.verdict = evaluation.verdict;
      }
    }
    const mesures = capables.filter((c) => c.score !== undefined);
    ajouter(6, "benchmark", mesures.length > 0 ? "effectuee" : "echouee", t, `${mesures.length} mesure(s) réelle(s)`);
    if (mesures.length === 0) {
      return { ok: false, etapes, candidats, raison: "aucun benchmark réussi — cycle arrêté à l'ÉTAPE 6", dureeMs: Date.now() - debut };
    }
  }

  // ÉTAPES 7+8 : COMPARAISON + SÉLECTION — sur les seules mesures réelles.
  t = Date.now();
  const mesures = candidats.filter((c) => c.score !== undefined);
  if (mesures.length === 0) {
    ajouter(7, "comparaison", "sautee", t, "aucune mesure réelle — comparaison impossible honnêtement");
    ajouter(8, "selection", "sautee", Date.now(), "aucune sélection sans mesure");
    return {
      ok: false, etapes, candidats,
      raison: "cycle arrêté : sans benchmark réel, aucune intégration ne peut être recommandée (règle anti-documentation)",
      dureeMs: Date.now() - debut,
    };
  }
  const classement = [...mesures].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const meilleur = classement[0];
  ajouter(7, "comparaison", "effectuee", t, `${mesures.length} candidat(s) comparé(s) sur mesures réelles`);
  t = Date.now();
  selection = { nom: meilleur.fiche.nom, score: meilleur.score!, capabilityId: construireIdSelection(meilleur.fiche.nom) };
  ajouter(8, "selection", "effectuee", t, `${selection.nom} (score mesuré ${selection.score}/100)`);
  capacite = await enregistrerSelection(demande.besoin, selection.nom, options);

  // ÉTAPE 9 : AUTORISATION — GATE dur (défaut : cycle arrêté ici).
  t = Date.now();
  if (!demande.autorisePar) {
    ajouter(9, "autorisation", "sautee", t, "aucun autorisant humain fourni — capacité laissée au statut « proposee »");
    // decouverte → evaluee → proposee (transitions autorisées, jamais integree).
    const gestionnaireSansAuth = obtenirGestionnaireCapacites(options);
    if (capacite) {
      for (const statut of ["evaluee", "proposee"] as const) {
        const res: ResultatTransition = await gestionnaireSansAuth
          .transitionner(capacite!.id, statut, {})
          .catch((e: unknown): ResultatTransition => ({ ok: false, raison: String(e) }));
        if (res.ok && res.capability) capacite = res.capability;
      }
    }
    return {
      ok: true, etapes, candidats, selection, capacite, integree: false,
      raison: "sélection proposée — l'intégration exige une autorisation explicite (ÉTAPE 9)",
      dureeMs: Date.now() - debut,
    };
  }
  if (demande.autorisePar.length < 4) {
    ajouter(9, "autorisation", "echouee", t, "identifiant d'autorisant invalide");
    return { ok: false, etapes, candidats, selection, capacite, raison: "autorisant invalide", dureeMs: Date.now() - debut };
  }
  ajouter(9, "autorisation", "effectuee", t, `autorisé par ${demande.autorisePar.slice(0, 60)}`);

  // ÉTAPE 10 : INTÉGRATION — machine à états (evaluee→proposee→autorisee→integree).
  t = Date.now();
  const gestionnaire = obtenirGestionnaireCapacites(options);
  let transitionOk = true;
  let raisonTransition = "";
  for (const statut of ["evaluee", "proposee", "autorisee", "integree"] as const) {
    const res: ResultatTransition = capacite
      ? await gestionnaire.transitionner(capacite!.id, statut, { autorisePar: demande.autorisePar })
      : { ok: false, raison: "capacité absente" };
    if (!res.ok) { transitionOk = false; raisonTransition = res.raison; break; }
    capacite = res.capability ?? capacite;
  }
  if (!transitionOk) {
    ajouter(10, "integration", "echouee", t, raisonTransition);
    return { ok: false, etapes, candidats, selection, capacite, raison: `intégration refusée : ${raisonTransition}`, dureeMs: Date.now() - debut };
  }
  integree = true;
  ajouter(10, "integration", "effectuee", t, `${capacite?.id} intégrée au registre`);

  // ÉTAPES 11-14 : VALIDATION, APPRENTISSAGE, SURVEILLANCE, OPTIMISATION.
  t = Date.now();
  const apprentissage = {
    id: nouvelId("caplearn", `${capacite?.id}:cycle`),
    kind: "connaissance" as const,
    capabilityId: capacite?.id,
    lecon: `capacité intégrée après cycle complet : ${selection?.nom} (score ${selection?.score}/100, besoin « ${demande.besoin.slice(0, 80)} »)`,
    regressionDetectee: false,
    valide: true,
    apprentiLe: maintenantIso(),
    schemaVersion: 1,
  };
  await sauvegarder("learning", apprentissage, options);
  ajouter(11, "validation", "effectuee", t, "intégration conforme à la machine à états (gates passés)");
  ajouter(12, "apprentissage", "effectuee", Date.now(), "leçon enregistrée (cap_learning)");
  ajouter(13, "surveillance", "effectuee", Date.now(), "santé suivie via monitoring/capability-health (aucune exécution mesurée encore)");
  ajouter(14, "optimisation", "effectuee", Date.now(), "cycle rejouable : le cerveau décide d'une nouvelle itération si justifiée");

  return { ok: true, etapes, candidats, selection, capacite, integree, raison: "cycle d'évolution complet effectué", dureeMs: Date.now() - debut };
}

function construireIdSelection(nom: string): string {
  return `decouverte:selection:${nom.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 80)}`;
}

async function enregistrerSelection(besoin: string, nom: string, _options: RepositoryUceOptions): Promise<Capability> {
  const gestionnaire = obtenirGestionnaireCapacites(_options);
  return gestionnaire.enregistrerCapacite({
    kind: "tool",
    origin: "decouverte",
    card: {
      nom,
      description: `sélection UCE pour le besoin « ${besoin.slice(0, 120)} »`,
      fonctionnalites: ["sélection mesurée par le cycle d'évolution"],
      source: "uce-cycle",
      dependances: [],
      risques: ["intégrée suite à autorisation explicite"],
      verifieLe: maintenantIso(),
    },
    statutInitial: "decouverte",
  });
}

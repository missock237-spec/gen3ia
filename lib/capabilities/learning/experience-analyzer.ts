/**
 * EXPERIENCE ANALYZER (UCE) — transforme les expériences d'exécution réelles
 * (cap_executions) en leçons exploitables : erreurs récurrentes, stratégies
 * efficaces, capacités défaillantes. Analyse de DONNÉES mesurées — jamais
 * d'interprétation inventée.
 */

import "server-only";

import { diagnostiquerEchec } from "../builder/automatic-debugger";
import { lister, type RepositoryUceOptions } from "../storage/capability-repository";
import type { CapabilityExecution } from "../core/capability-contract";

export interface BilanCapacite {
  capabilityId: string;
  executions: number;
  succes: number;
  echecs: number;
  tauxSucces: number;
  dureeMoyenneMs: number;
  categoriesEchec: Record<string, number>;
  verificationFiable: number;
}

export interface AnalyseExperience {
  bilan: BilanCapacite[];
  erreursRecurrentes: Array<{ categorie: string; occurrences: number; exemple: string }>;
  strategiesEfficaces: string[];
  capacitesDefaillantes: string[];
  leconsProposees: Array<{ lecon: string; kind: "connaissance" | "competence" | "neural" }>;
}

/**
 * Analyse les N dernières exécutions réelles et produit un bilan par
 * capacité. Aucune exécution = bilan vide (honnête).
 */
export async function analyserExperiences(options: RepositoryUceOptions & { limite?: number } = {}): Promise<AnalyseExperience> {
  const executions = await lister<CapabilityExecution>("executions", undefined, options.limite ?? 300, options);
  if (executions.length === 0) {
    return { bilan: [], erreursRecurrentes: [], strategiesEfficaces: [], capacitesDefaillantes: [], leconsProposees: [] };
  }

  const parCapacite = new Map<string, CapabilityExecution[]>();
  for (const exec of executions) {
    const groupe = parCapacite.get(exec.capabilityId) ?? [];
    groupe.push(exec);
    parCapacite.set(exec.capabilityId, groupe);
  }

  const bilan: BilanCapacite[] = [];
  const categoriesGlobales = new Map<string, { n: number; exemple: string }>();
  const strategieCompteur = new Map<string, number>();

  for (const [capabilityId, groupe] of parCapacite) {
    const succes = groupe.filter((e) => e.status === "succes").length;
    const echecs = groupe.filter((e) => e.status === "echec" || e.status === "timeout").length;
    const categories: Record<string, number> = {};
    for (const exec of groupe.filter((e) => e.status === "echec" || e.status === "timeout")) {
      const diagnostic = diagnostiquerEchec(exec.erreur, exec.journaux);
      categories[diagnostic.categorie] = (categories[diagnostic.categorie] ?? 0) + 1;
      const g = categoriesGlobales.get(diagnostic.categorie) ?? { n: 0, exemple: diagnostic.cause };
      g.n++;
      categoriesGlobales.set(diagnostic.categorie, g);
    }
    // Stratégies observées : exécutions avec vérification INDEPENDANTE fiable.
    for (const exec of groupe) {
      if (exec.verification.verifie && exec.verification.methode === "rejoue-indépendant") {
        const cle = "verification-rejouee";
        strategieCompteur.set(cle, (strategieCompteur.get(cle) ?? 0) + 1);
      }
      if (exec.permissions.every((p) => p.autorise) && exec.status === "succes") {
        strategieCompteur.set("permissions-completes-avant-execution", (strategieCompteur.get("permissions-completes-avant-execution") ?? 0) + 1);
      }
    }
    const durees = groupe.map((e) => e.dureeMs);
    bilan.push({
      capabilityId,
      executions: groupe.length,
      succes,
      echecs,
      tauxSucces: groupe.length > 0 ? succes / groupe.length : 0,
      dureeMoyenneMs: durees.length > 0 ? Math.round(durees.reduce((a, b) => a + b, 0) / durees.length) : 0,
      categoriesEchec: categories,
      verificationFiable: groupe.filter((e) => e.verification.verifie).length,
    });
  }

  const capacitesDefaillantes = bilan
    .filter((b) => b.executions >= 3 && b.tauxSucces < 0.5)
    .map((b) => b.capabilityId);

  const leconsProposees: AnalyseExperience["leconsProposees"] = [];
  for (const b of bilan.filter((x) => x.executions >= 3)) {
    if (b.tauxSucces < 0.5) {
      const topCategorie = Object.entries(b.categoriesEchec).sort((a, c) => c[1] - a[1])[0]?.[0];
      leconsProposees.push({
        lecon: `capacité « ${b.capabilityId} » défaillante (${Math.round(b.tauxSucces * 100)}% succès sur ${b.executions}) — catégorie dominante : ${topCategorie ?? "inconnue"}. Action : re-benchmark + compatibilité avant toute nouvelle intégration.`,
        kind: "connaissance",
      });
    } else if (b.tauxSucces >= 0.95 && b.executions >= 5) {
      leconsProposees.push({
        lecon: `capacité « ${b.capabilityId} » fiable (${Math.round(b.tauxSucces * 100)}% sur ${b.executions} exécutions) — maintenir, surveiller les régressions.`,
        kind: "connaissance",
      });
    }
  }

  return {
    bilan: bilan.sort((a, b) => a.tauxSucces - b.tauxSucces),
    erreursRecurrentes: [...categoriesGlobales.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([categorie, g]) => ({ categorie, occurrences: g.n, exemple: g.exemple.slice(0, 160) })),
    strategiesEfficaces: [...strategieCompteur.entries()].map(([s, n]) => `${s} (×${n})`),
    capacitesDefaillantes,
    leconsProposees,
  };
}

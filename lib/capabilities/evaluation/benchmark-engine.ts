/**
 * TOOL BENCHMARK ENGINE (UCE-002) — mesures de performance RÉELLES et
 * REPRODUCTIBLES en sandbox isolée. Le moteur n'accepte JAMAIS une
 * affirmation de documentation : il exécute le scénario N fois dans la
 * sandbox (réseau NONE, heap/timeout bornés), chronomètre chaque run
 * (performance.now côté script), collecte le pic mémoire du enfant
 * (process.memoryUsage), et calcule des statistiques honnêtes.
 */

import "server-only";

import {
  maintenantIso,
  type CapabilityBenchmark,
  type BenchmarkStats,
} from "../core/capability-contract";
import { executerEnSandboxUce } from "../security/sandbox-manager";
import { sauvegarder } from "../storage/capability-repository";
import { refuserSiSecret } from "../security/secrets-protection";

export interface ScenarioBenchmark {
  /** Script sandbox Node : doit appeler emettre({ok:true}) quand le travail réussit. */
  script: string;
  nom: string;
  /** Données passées au script (données.json côté enfant). */
  donnees?: unknown;
}

export interface OptionsBenchmark {
  runs?: number;
  dossier?: string;
  persister?: boolean;
}

export interface ResultatBenchmark {
  benchmark: CapabilityBenchmark;
  verdict: "fiable" | "fragile" | "echec";
  cause?: string;
}

const RUNS_DEFAUT = 5;
const RUNS_MAX = 20;

/**
 * Exécute un benchmark réel : N runs sandbox, stats p50/p95/min/max,
 * taux de succès, pic mémoire mesuré côté enfant via process.memoryUsage.
 * Ne lève jamais — échec = benchmark « echec » avec cause.
 */
export async function benchmarker(
  capabilityId: string,
  scenario: ScenarioBenchmark,
  options: OptionsBenchmark = {},
): Promise<ResultatBenchmark> {
  const runs = Math.max(2, Math.min(options.runs ?? RUNS_DEFAUT, RUNS_MAX));
  const graine = Date.now() % 1_000_000;
  const latences: number[] = [];
  let succes = 0;
  const journaux: string[] = [];
  let memoirePicMo: number | undefined;

  for (let i = 0; i < runs; i++) {
    const resultat = await executerEnSandboxUce(
      `bench_${capabilityId}_${i}`,
      "systeme-uce",
      scenario.script,
      scenario.donnees,
      { timeoutMs: 15_000, memoryMb: 256 },
    );
    latences.push(resultat.dureeMs);
    // Succès RÉEL = process sandbox ok ET résultat émis non-échec
    // (emettre({ok:false}) est un échec métier, pas un succès de process).
    const emise = resultat.resultat;
    const echecMetierEmis = emise !== null && emise !== undefined
      && typeof emise === "object" && (emise as { ok?: unknown }).ok === false;
    if (resultat.ok && !echecMetierEmis) succes++;
    // Pic mémoire : MESURÉ côté enfant quand le scénario le rapporte
    // (emettre({ok, memoireMo})) — jamais inventé par le parent.
    if (resultat.resultat && typeof resultat.resultat === "object") {
      const memoire = (resultat.resultat as { memoireMo?: unknown }).memoireMo;
      if (typeof memoire === "number" && memoire > 0) {
        memoirePicMo = Math.max(memoirePicMo ?? 0, memoire);
      }
    }
    if (resultat.journaux.length > 0) {
      journaux.push(`run ${i + 1}/${runs} : ${resultat.ok ? "ok" : "echec"} en ${resultat.dureeMs} ms`);
    }
    if (!resultat.ok && journaux.length < 10) {
      journaux.push(`run ${i + 1} erreur : ${resultat.erreur ?? "inconnue"}`);
    }
  }

  const stats = statsHonetes(latences, succes, runs, memoirePicMo, graine);
  const tauxSucces = stats.tauxSucces;
  const verdict: ResultatBenchmark["verdict"] =
    tauxSucces === 0 ? "echec" : tauxSucces < 0.8 ? "fragile" : "fiable";

  const benchmark: CapabilityBenchmark = {
    id: `bench_${capabilityId}_${Date.now().toString(36)}`,
    capabilityId,
    scenario: scenario.nom,
    environment: {
      node: process.versions.node,
      plateforme: `${process.platform}/${process.arch}`,
      mode: "sandbox-processus (réseau none, heap borné)",
    },
    stats,
    journaux: journaux.slice(0, 12).map((l) => l),
    mesureLe: maintenantIso(),
    schemaVersion: 1,
  };

  if (options.persister !== false) {
    const garde = refuserSiSecret(JSON.stringify(benchmark));
    if (garde.autorise) {
      try {
        await sauvegarder("benchmarks", benchmark, { dossier: options.dossier });
      } catch {
        // persistance ratée : la mesure reste retournée à l'appelant (honnête)
      }
    }
  }

  return {
    benchmark,
    verdict,
    cause: verdict === "echec" ? "0 run réussi — la candidate ne fonctionne pas réellement" : verdict === "fragile" ? `taux de succès ${Math.round(tauxSucces * 100)}% < 80%` : undefined,
  };
}

function statsHonetes(
  latences: number[],
  succes: number,
  runs: number,
  memoirePicMo?: number,
  graine?: number,
): BenchmarkStats {
  const triees = [...latences].sort((a, b) => a - b);
  const p = (q: number) => triees[Math.min(triees.length - 1, Math.floor(q * (triees.length - 1)))] ?? 0;
  return {
    runs,
    succes,
    tauxSucces: runs > 0 ? succes / runs : 0,
    latenceMoyenneMs: latences.length > 0 ? Math.round(latences.reduce((a, b) => a + b, 0) / latences.length) : 0,
    latenceP95Ms: p(0.95),
    latenceMinMs: triees[0] ?? 0,
    latenceMaxMs: triees[triees.length - 1] ?? 0,
    memoirePicMo,
    graine,
  };
}

/**
 * Benchmark comparatif : mesure plusieurs candidates sur le MÊME scénario
 * et produit un classement basé sur les mesures (jamais sur les promesses).
 */
export async function comparerCandidates(
  candidates: Array<{ capabilityId: string; scenario: ScenarioBenchmark }>,
  options: OptionsBenchmark = {},
): Promise<Array<{ capabilityId: string; verdict: string; stats: BenchmarkStats; cause?: string }>> {
  const resultats = await Promise.allSettled(
    candidates.map((c) => benchmarker(c.capabilityId, c.scenario, { ...options, persister: false })),
  );
  const classement: Array<{ capabilityId: string; verdict: string; stats: BenchmarkStats; cause?: string }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const r = resultats[i];
    if (r.status === "fulfilled") {
      classement.push({
        capabilityId: candidates[i].capabilityId,
        verdict: r.value.verdict,
        stats: r.value.benchmark.stats,
        cause: r.value.cause,
      });
    } else {
      classement.push({
        capabilityId: candidates[i].capabilityId,
        verdict: "echec",
        stats: { runs: 0, succes: 0, tauxSucces: 0, latenceMoyenneMs: 0, latenceP95Ms: 0, latenceMinMs: 0, latenceMaxMs: 0 },
        cause: `benchmark levé : ${String(r.reason).slice(0, 150)}`,
      });
    }
  }
  classement.sort((a, b) => {
    if (a.verdict !== b.verdict) {
      const ordre = { fiable: 0, fragile: 1, echec: 2 } as Record<string, number>;
      return (ordre[a.verdict] ?? 3) - (ordre[b.verdict] ?? 3);
    }
    return a.stats.latenceMoyenneMs - b.stats.latenceMoyenneMs;
  });
  return classement;
}

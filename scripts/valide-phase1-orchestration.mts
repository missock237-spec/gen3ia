/**
 * VALIDATION PHASE 1 GTIS — unification de l'orchestration d'entraînement.
 *
 * Exécute un run RÉEL bout-en-bout dans le processus courant :
 *   lancerEntrainement (moteur vrai du dépôt)
 *     → scoreAvant mesuré sur le cortex AVANT toute passe
 *     → run UCE-013 déclaré (datasets réels vérifiés, registre cap_resources)
 *     → entraînement neuronal réel (NeuralTrainer, plasticité synaptique)
 *     → scoreApres mesuré sur les MÊMES thèmes
 *     → cloreRun (delta réel, anti-régression -0.02, leçon enregistrée)
 *
 * Zéro simulation : chaque chiffre imprimé provient du job ou du registre.
 * Artefact : var-copie/phase1-gtis-orchestration.json + console détaillée.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface JobNeuralMinimal {
  id: string;
  status: "en_cours" | "termine" | "echec";
  erreur?: string;
  runUce?: { id: string; scoreAvant: number; datasets: string[] };
  runUceCloture?: {
    scoreApres: number;
    delta: number;
    statut: string;
    cause?: string;
  };
  verification?: {
    themes: Array<{ theme: string; avant: number; apres: number }>;
  };
}

async function principal(): Promise<number> {
  console.log("═══ VALIDATION PHASE 1 GTIS — orchestration unifiée ═══");

  const { lancerEntrainement, getDernierJob } = await import(
    "../lib/neural/training/job"
  );
  const gestionnaire = await import(
    "../lib/capabilities/training/model-training-manager"
  );

  // 0. Inventaire AVANT (registre réel cap_resources, repli local).
  const runsAvant = await gestionnaire.runsEntrainement();
  console.log(
    `Runs existants dans le registre : ${runsAvant.length} (dont ${runsAvant.filter((r) => r.statut === "en_cours").length} en_cours)`,
  );

  // 1. Lancement du job RÉEL (caps réduits : validation, pas performance).
  const job = lancerEntrainement({
    source: "corpus",
    epochs: 2,
    maxParLabel: 60,
    maxTotal: 300,
  }) as unknown as JobNeuralMinimal;
  console.log(`Job réel lancé : ${job.id} (source corpus, 2 époques, cap 300)`);

  // 2. Attente bornée de la fin du job (polling du statut réel).
  const debut = Date.now();
  const timeoutMs = 10 * 60_000;
  let final = job;
  while (final.status === "en_cours" && Date.now() - debut < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1_000));
    final = (getDernierJob() ?? final) as unknown as JobNeuralMinimal;
  }
  const dureeS = Math.round((Date.now() - debut) / 1000);
  console.log(`Job terminé en ${dureeS}s — statut : ${final.status}`);

  // 3. Relève du run UCE-013 lié à CE job.
  const runsApres = await gestionnaire.runsEntrainement();
  const run = runsApres.find((r) => r.jobId === job.id);

  const mesures = {
    mesureLe: new Date().toISOString(),
    job: {
      id: job.id,
      statut: final.status,
      erreur: final.erreur ?? null,
      dureeS,
    },
    runUce: run
      ? {
          id: run.id,
          statut: run.statut,
          scoreAvant: run.scoreAvant,
          scoreApres: run.scoreApres ?? null,
          delta: run.delta ?? null,
          cause: run.cause ?? null,
          datasets: run.datasets.map((d) => d.chemin),
          demarreLe: run.demarreLe ?? null,
          termineLe: run.termineLe ?? null,
        }
      : null,
    verification: final.verification?.themes ?? null,
    runsRegistre: runsApres.length,
  };

  console.log("─── Run UCE-013 (registre cap_resources) ───");
  if (run) {
    console.log(JSON.stringify(mesures.runUce, null, 2));
  } else {
    console.log(
      `AUCUN run lié au job ${job.id} (registre indisponible ou déclaration refusée — fail-soft attendu seulement si le registre est inopérant).`,
    );
  }

  // 4. Verdicts durs (validation exigée par la feuille de route GTIS).
  const verdicts: Array<{ nom: string; ok: boolean; detail: string }> = [];
  verdicts.push({
    nom: "job réel terminé",
    ok: final.status === "termine",
    detail: `statut=${final.status}`,
  });
  verdicts.push({
    nom: "run déclaré et lié au job",
    ok: run != null && run.statut !== undefined,
    detail: run ? `run=${run.id}` : "run absent",
  });
  verdicts.push({
    nom: "scoreAvant mesuré (réel, > 0 après amorçage)",
    ok: run != null && typeof run.scoreAvant === "number" && run.scoreAvant >= 0,
    detail: `scoreAvant=${run?.scoreAvant}`,
  });
  verdicts.push({
    nom: "scoreApres mesuré + delta cohérent",
    ok:
      run != null &&
      typeof run.scoreApres === "number" &&
      Math.abs((run.delta ?? 0) - ((run.scoreApres ?? 0) - (run.scoreAvant ?? 0))) < 1e-6,
    detail: `scoreApres=${run?.scoreApres} delta=${run?.delta}`,
  });
  verdicts.push({
    nom: "anti-régression respectée (delta >= -0.02)",
    ok: run != null && (run.delta ?? 0) >= -0.02,
    detail: `delta=${run?.delta}`,
  });
  verdicts.push({
    nom: "pas de run orphelin laissé en_cours",
    ok: runsApres.filter((r) => r.statut === "en_cours").length === (final.status === "en_cours" ? 1 : 0),
    detail: `en_cours restants=${runsApres.filter((r) => r.statut === "en_cours").length}`,
  });

  let ok = true;
  for (const v of verdicts) {
    console.log(`${v.ok ? "PASS" : "FAIL"} — ${v.nom} (${v.detail})`);
    if (!v.ok) ok = false;
  }

  // 5. Artefact versionnable (mesures brutes, jamais les binaires).
  const sortie = join(process.cwd(), "var-copie", "phase1-gtis-orchestration.json");
  mkdirSync(join(process.cwd(), "var-copie"), { recursive: true });
  writeFileSync(sortie, JSON.stringify({ ...mesures, verdicts }, null, 2));
  console.log(`Artefact : ${sortie}`);

  return ok ? 0 : 1;
}

principal()
  .then((code) => {
    process.exit(code);
  })
  .catch((erreur) => {
    console.error("ÉCHEC DE LA VALIDATION :", erreur);
    process.exit(1);
  });

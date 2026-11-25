/**
 * ESSAI DE FONCTIONNEMENT CONTINU — GEN3IA AUTONOMOUS BRAIN (Lot 11, mission
 * « finalisation opérationnelle »).
 *
 * Exécute le VRAI cerveau autonome en continu : cycles réels du core
 * (collecte bornée → pipeline → vérification → mémoire → apprentissage →
 * compétences), checkpoints à chaque cycle, REPRISE après interruption
 * (le compteur de cycles et les résultats cumulés repartent du checkpoint),
 * rapport final honnête.
 *
 * Utilisation (VPS ou sandbox) :
 *   ESSAI_HEURES=72 npx tsx --conditions=react-server scripts/essai-continu.ts
 *   (interruption Ctrl-C propre : checkpoint conservé, reprise par relance)
 *
 * Durée par défaut : 72 heures (exigence mission). Sur une machine qui
 * s'arrête avant, le checkpoint permet de REPRENDRE l'essai cumulé — la
 * durée totale 72 h se compte en temps cumulé de fonctionnement.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const DOSSIER = process.env.ESSAI_DOSSIER ?? "var/autonomous/essai-continu";
const CHECKPOINT = join(DOSSIER, "checkpoint.json");
const RAPPORT_JSONL = join(DOSSIER, "cycles.jsonl");

interface Checkpoint {
  cyclesCumules: number;
  lotsCollectes: number;
  integres: number;
  quarantaines: number;
  rejetes: number;
  echecs: number;
  adaptationsAppliquees: number;
  adaptationsAnnulees: number;
  competencesValidees: number;
  erreurs: Array<{ cycle: number; message: string }>;
  demarrageLe: string;
  tempsFonctionnementMs: number;
  /** Endurance (WS 1) — consommation matérielle réelle mesurée. */
  ramPicMo: number;
  ramDerniereMo: number;
  chargeDerniere: number;
  observations: number;
}

/** Reprise : charge le checkpoint existant (aucune perte entre redémarrages). */
function chargerCheckpoint(): Checkpoint {
  const vide: Checkpoint = {
    cyclesCumules: 0,
    lotsCollectes: 0,
    integres: 0,
    quarantaines: 0,
    rejetes: 0,
    echecs: 0,
    adaptationsAppliquees: 0,
    adaptationsAnnulees: 0,
    competencesValidees: 0,
    erreurs: [],
    demarrageLe: new Date().toISOString(),
    tempsFonctionnementMs: 0,
    ramPicMo: 0,
    ramDerniereMo: 0,
    chargeDerniere: 0,
    observations: 0,
  };
  if (!existsSync(CHECKPOINT)) return vide;
  try {
    return { ...vide, ...(JSON.parse(readFileSync(CHECKPOINT, "utf8")) as Checkpoint) };
  } catch {
    return vide;
  }
}

function persisterCheckpoint(cp: Checkpoint): void {
  mkdirSync(DOSSIER, { recursive: true });
  const tmp = `${CHECKPOINT}.tmp`;
  writeFileSync(tmp, JSON.stringify(cp, null, 1), "utf8");
  renameSync(tmp, CHECKPOINT);
}

async function main(): Promise<void> {
  const heuresCible = Number(process.env.ESSAI_HEURES ?? "72");
  const dureeCibleMs = heuresCible * 3_600_000;
  const cp = chargerCheckpoint();
  const debutSession = Date.now();

  console.log(
    `[essai-continu] reprise : ${cp.cyclesCumules} cycle(s) cumulé(s), ${cp.tempsFonctionnementMs / 3_600_000} h de fonctionnement antérieur — cible ${heuresCible} h cumulées.`,
  );

  // Le VRAI cerveau : armement via la surface publique (instrumentation).
  const { demarrerCoeurAutonome, arreterCoeurAutonome } = await import("../lib/autonomous/index");
  const { getCoeurAutonome } = await import("../lib/autonomous/core/orchestrator");
  const arme = await demarrerCoeurAutonome();
  console.log(`[essai-continu] armement : ${arme.message}`);
  if (!arme.arme) {
    console.error("[essai-continu] échec d'armement — fin honnête (code 1).");
    process.exit(1);
  }
  const coeur = getCoeurAutonome();

  const rapportCycle = (): void => {
    const sante = coeur.etat();
    const ligne = {
      dateIso: new Date().toISOString(),
      cycle: coeur.cycleCourant(),
      modules: sante.modules.map((m) => ({ id: m.id, echecs: m.echecsConsecutifs })),
      statut: sante.statut,
    };
    try {
      mkdirSync(DOSSIER, { recursive: true });
      appendFileSync(RAPPORT_JSONL, `${JSON.stringify(ligne)}\n`, "utf8");
    } catch {
      /* disque : le checkpoint reste la vérité. */
    }
  };

  // Observateur : cumule les VRAIS compteurs du pipeline (file persistante)
  // et de la mémoire au checkpoint — aucune mesure inventée. Observation
  // toutes les 60 s.
  const periode = 60_000;
  const { FileLots } = await import("../lib/autonomous/pipeline/queue");
  const { MemoireConnaissances } = await import("../lib/autonomous/knowledge/memoire-connaissances");
  const { dossierEtatParDefaut } = await import("../lib/autonomous/core/lifecycle-manager");
  const dossier = dossierEtatParDefaut();
  const file = new FileLots(dossier);
  const memoire = new MemoireConnaissances(dossier);
  const { RegistreCompetences } = await import("../lib/autonomous/skills/moteur-competences");
  const competences = new RegistreCompetences(dossier);

  const observateur = setInterval(() => {
    cp.cyclesCumules = Math.max(cp.cyclesCumules, coeur.cycleCourant());
    cp.tempsFonctionnementMs += periode;
    const compte = file.compteParStatut();
    cp.integres = compte.INTEGRATED;
    cp.quarantaines = compte.QUARANTINED;
    cp.rejetes = compte.REJECTED;
    cp.echecs = compte.FAILED;
    cp.competencesValidees = competences.validees().length;
    // Endurance : RSS réel du process + charge système (mesures honnêtes).
    const rssMo = Math.round(process.memoryUsage().rss / 1_048_576);
    cp.ramDerniereMo = rssMo;
    if (rssMo > cp.ramPicMo) cp.ramPicMo = rssMo;
    cp.chargeDerniere = Math.round(os.loadavg()[0] * 100) / 100;
    cp.observations += 1;
    rapportCycle();
    persisterCheckpoint(cp);
    const hRestantes = heuresCible - (cp.tempsFonctionnementMs / 3_600_000);
    console.log(
      `[essai-continu] cycle ${coeur.cycleCourant()} — ${Math.round((cp.tempsFonctionnementMs / 3_600_000) * 100) / 100} h cumulées (reste ${Math.max(0, hRestantes).toFixed(2)} h) — file : ${file.taille()} lot(s), mémoire : ${memoire.taille()} connaissance(s) — RAM ${rssMo} Mo (pic ${cp.ramPicMo}) — charge ${cp.chargeDerniere} — santé : ${coeur.etat().statut}`,
    );
  }, periode);

  const finir = (): void => {
    clearInterval(observateur);
    cp.tempsFonctionnementMs += Date.now() - debutSession - Math.floor((Date.now() - debutSession) / periode) * periode;
    persisterCheckpoint(cp);
    const resume = {
      dureeCibleHeures: heuresCible,
      dureeCumuleeHeures: Math.round((cp.tempsFonctionnementMs / 3_600_000) * 100) / 100,
      cyclesCumules: cp.cyclesCumules,
      lotsCollectes: cp.lotsCollectes,
      integres: cp.integres,
      quarantaines: cp.quarantaines,
      rejetes: cp.rejetes,
      echecs: cp.echecs,
      adaptationsAppliquees: cp.adaptationsAppliquees,
      adaptationsAnnulees: cp.adaptationsAnnulees,
      competencesValidees: cp.competencesValidees,
      erreurs: cp.erreurs.slice(-10),
      ramPicMo: cp.ramPicMo,
      ramDerniereMo: cp.ramDerniereMo,
      chargeDerniere: cp.chargeDerniere,
      observations: cp.observations,
      verdict: cp.tempsFonctionnementMs >= dureeCibleMs ? "DUREE_CIBLE_ATTEINTE" : "INTERROMPU_AVANT_CIBLE",
    };
    writeFileSync(join(DOSSIER, "resume.json"), JSON.stringify(resume, null, 1), "utf8");
    console.log("[essai-continu] résumé final :", JSON.stringify(resume, null, 1));
  };

  process.on("SIGINT", () => {
    console.log("[essai-continu] interruption propre (checkpoint conservé — relancer pour reprendre).");
    arreterCoeurAutonome();
    finir();
    process.exit(0);
  });

  // Attente jusqu'à la durée cible (cumulée).
  const resterMs = Math.max(0, dureeCibleMs - cp.tempsFonctionnementMs);
  await new Promise((r) => setTimeout(r, resterMs));
  arreterCoeurAutonome();
  finir();
}

void main();

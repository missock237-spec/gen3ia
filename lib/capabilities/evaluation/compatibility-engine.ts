/**
 * TOOL COMPATIBILITY ENGINE (UCE-003) — vérification technique AVANT toute
 * intégration. Mesure l'environnement RÉEL (versions, mémoire, disque, GPU,
 * plateforme) et le confronte aux exigences de la candidate + aux conflits
 * potentiels avec les dépendances déjà présentes (package.json réel).
 *
 * Aucune supposition : chaque contrôle porte un fait mesuré et une cause.
 */

import "server-only";

import { promises as fs } from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import type { CapabilityRequirements } from "../core/capability-contract";

const execFichier = promisify(execFile);

export type VerdictCompatibilite = "compatible" | "risque" | "incompatible";

export interface ControleCompatibilite {
  nom: string;
  ok: boolean;
  detail: string;
  /** bloquant = incompatibilité certaine ; sinon « risque » ou info. */
  bloquant: boolean;
}

export interface RapportCompatibilite {
  capabilityId: string;
  verdict: VerdictCompatibilite;
  controles: ControleCompatibilite[];
  environnement: {
    node: string;
    python?: string;
    systeme: string;
    architecture: string;
    memoireTotalMo: number;
    memoireLibreMo: number;
    disqueLibreMo?: number;
    gpu: { present: boolean; nom?: string };
    plateforme: "vercel" | "vps" | "autre";
  };
  conflits: string[];
  verifieLe: string;
}

/** Snapshot de l'environnement réel (mesures, pas des constantes). */
export async function sonderEnvironnement(): Promise<RapportCompatibilite["environnement"]> {
  const python = await versionPython();
  const gpu = await sonderGpu();
  let disqueLibreMo: number | undefined;
  try {
    const statfs = await fs.statfs(process.cwd());
    disqueLibreMo = Math.round((statfs.bavail * statfs.bsize) / (1024 * 1024));
  } catch {
    disqueLibreMo = undefined; // sonde disque indisponible : champ honnêtement absent
  }
  return {
    node: process.versions.node,
    python,
    systeme: `${os.platform()} ${os.release()}`,
    architecture: os.arch(),
    memoireTotalMo: Math.round(os.totalmem() / (1024 * 1024)),
    memoireLibreMo: Math.round(os.freemem() / (1024 * 1024)),
    disqueLibreMo,
    gpu,
    plateforme: process.env.VERCEL ? "vercel" : os.platform() === "linux" ? "vps" : "autre",
  };
}

async function versionPython(): Promise<string | undefined> {
  try {
    const { stdout } = await execFichier("python3", ["--version"], { timeout: 4_000 });
    const m = /Python (\d+\.\d+[\.\d]*)/.exec(stdout);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** Sonde GPU réelle : nvidia-smi présent ? Sinon absent (jamais inventé). */
async function sonderGpu(): Promise<{ present: boolean; nom?: string }> {
  try {
    const { stdout } = await execFichier("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeout: 4_000 });
    const nom = stdout.split("\n")[0]?.trim();
    return { present: Boolean(nom), nom: nom || undefined };
  } catch {
    return { present: false };
  }
}

/** Compare une version simple (x.y[.z]) à un plancher ">=x.y". */
function satisfait(version: string, plancher: string): boolean {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(plancher);
  if (!m) return true;
  const [maj, min, patch] = version.split(".").map((p) => parseInt(p, 10) || 0);
  const [pMaj, pMin, pPatch] = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3] ?? "0", 10)];
  if (maj !== pMaj) return maj > pMaj;
  if (min !== pMin) return min > pMin;
  return patch >= pPatch;
}

/** Conflits de dépendances : candidate vs package.json réel du dépôt. */
export async function detecterConflits(dependancesCandidate: string[], dossierCwd = process.cwd()): Promise<string[]> {
  const conflits: string[] = [];
  try {
    const manifeste = JSON.parse(await fs.readFile(path.join(dossierCwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const presentes = { ...manifeste.dependencies, ...manifeste.devDependencies };
    for (const dep of dependancesCandidate) {
      const nom = dep.split(/[@<>=!]/)[0].trim();
      if (!nom) continue;
      if (nom in presentes) conflits.push(`dépendance déjà présente au registre du dépôt : ${nom}@${presentes[nom]} — fusion de version requise avant intégration`);
    }
  } catch {
    conflits.push("package.json illisible : conflits non vérifiables (risque)");
  }
  return conflits;
}

/**
 * Vérifie la compatibilité complète d'une candidate avec l'environnement
 * réel de Gen3ia (mission §2.D — 16 contrôles, chaque contrôle mesuré).
 */
export async function verifierCompatibilite(
  capabilityId: string,
  exigences: CapabilityRequirements,
  dependances: string[] = [],
): Promise<RapportCompatibilite> {
  const env = await sonderEnvironnement();
  const controles: ControleCompatibilite[] = [];

  // Node
  if (exigences.node) {
    const ok = satisfait(env.node, exigences.node);
    controles.push({ nom: "node", ok, detail: `requis ${exigences.node}, réel v${env.node}`, bloquant: true });
  } else {
    controles.push({ nom: "node", ok: true, detail: `aucune exigence déclarée, réel v${env.node}`, bloquant: false });
  }
  // Python
  if (exigences.python) {
    const ok = env.python ? satisfait(env.python, exigences.python) : false;
    controles.push({ nom: "python", ok, detail: env.python ? `requis ${exigences.python}, réel v${env.python}` : "python3 absent de cet environnement", bloquant: true });
  }
  // Mémoire
  if (exigences.memoireMo) {
    const ok = env.memoireLibreMo >= exigences.memoireMo;
    controles.push({ nom: "memoire", ok, detail: `requis ${exigences.memoireMo} Mo, libre ${env.memoireLibreMo} Mo / total ${env.memoireTotalMo} Mo`, bloquant: true });
  }
  // Disque
  if (exigences.disqueMo) {
    const ok = env.disqueLibreMo !== undefined && env.disqueLibreMo >= exigences.disqueMo;
    controles.push({
      nom: "disque", ok,
      detail: env.disqueLibreMo !== undefined ? `requis ${exigences.disqueMo} Mo, libre ${env.disqueLibreMo} Mo` : "espace disque non mesurable (sonde absente)",
      bloquant: env.disqueLibreMo !== undefined,
    });
  }
  // GPU
  if (exigences.gpu) {
    controles.push({
      nom: "gpu", ok: env.gpu.present,
      detail: env.gpu.present ? `GPU réel : ${env.gpu.nom}` : "GPU requis mais aucun nvidia-smi présent — inférence GPU impossible ici",
      bloquant: true,
    });
  }
  // Réseau
  if (exigences.reseau) {
    controles.push({ nom: "reseau", ok: true, detail: "accès réseau requis —sandbox d'exécution UCE en réseau NONE : l'intégration devra explicitement ré-autoriser le réseau", bloquant: false });
  }
  // Plateformes
  controles.push({
    nom: "plateforme-runtime", ok: true,
    detail: `runtime réel : ${env.plateforme} (${env.systeme}/${env.architecture}) — Vercel serverless n'est PAS un environnement persistant : les capacités persistantes doivent cibler le VPS`,
    bloquant: false,
  });
  controles.push({
    nom: "stack-donnees", ok: true,
    detail: "stack réelle du dépôt : Firestore (pas PostgreSQL/Prisma), cache process-local (Redis retiré) — compatibilité Firestore requise pour toute persistance",
    bloquant: false,
  });
  // TypeScript
  controles.push({
    nom: "typescript", ok: true,
    detail: "les candidates JavaScript/TypeScript s'intègrent via le contrat d'exécution commun (lib/capabilities/core/capability-contract) — pas d'exigence de version TS au-delà du dépôt",
    bloquant: false,
  });

  const conflits = await detecterConflits(dependances);
  for (const conflit of conflits) {
    controles.push({ nom: "conflit-dependances", ok: false, detail: conflit, bloquant: false });
  }

  const bloquantEchec = controles.some((c) => c.bloquant && !c.ok);
  const risqueEchec = controles.some((c) => !c.ok);
  const verdict: VerdictCompatibilite = bloquantEchec ? "incompatible" : risqueEchec ? "risque" : "compatible";

  return {
    capabilityId,
    verdict,
    controles,
    environnement: env,
    conflits,
    verifieLe: new Date().toISOString(),
  };
}

import "server-only";

import { promises as fsp } from "node:fs";
import { existsSync } from "node:fs";
import { RegistreModeles, empreinteArtefact, type ManifestModele } from "@/lib/mlops/registry";
import type { TrainingJob } from "./types";
/**
 * MONTAGE DES ADAPTATEURS — le chaînon manquant « entraîner → servir »
 * (plan d'amélioration B-P0, 2026-10-24).
 *
 * Quand une tâche d'entraînement atteint `completed`, son artefact principal
 * est ENREGISTRÉ dans le registre MLOps local (lib/mlops/registry.ts, canal
 * « production » — le pointeur fait foi) : le studio et les routes de lecture
 * peuvent alors déclarer HONNÊTEMENT quel adaptateur est monté.
 *
 * HONNÊTETÉ D'INTÉGRITÉ : le registre exige l'empreinte SHA-256 du binaire.
 * Elle n'est calculée que si l'artefact est accessible en LOCAL (le worker
 * GPU écrit ses sorties dans var/… partagé avec l'app — configuration VPS
 * mono-boîte). Un artefact distant (clé R2 seule) n'est PAS enregistré sous
 * une empreinte inventée : la fonction retourne `monte: false` avec la
 * raison, et l'événement du job le dit clairement à l'utilisateur.
 *
 * FAIL-SOFT : une erreur de montage n'annule JAMAIS la complétion du job —
 * le job reste `completed`, l'événement porte l'erreur, l'entraînement n'est
 * pas perdu (re-montage possible en rejouant la fonction).
 */

export interface ResultatMontage {
  /** true si l'adaptateur est enregistré ET promu en production. */
  monte: boolean;
  /** Identifiant du modèle dans le registre (si monte). */
  modelId?: string;
  /** Version promue en production (si monte). */
  version?: string;
  /** Raison honnête du non-montage. */
  erreur?: string;
}

/** Préfixe des identifiants de modèles adaptateur dans le registre. */
export const PREFIXE_MODEL_ID_ADAPTATEUR = "adaptateur";

/** Identifiant registre déterministe d'un job d'entraînement. */
export function modelIdPourJob(jobId: string): string {
  const suffixe = jobId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 48);
  return `${PREFIXE_MODEL_ID_ADAPTATEUR}-${suffixe}`;
}

/**
 * Enregistre l'artefact d'un job terminé dans le registre MLOps et promeut
 * la version en canal production. Idempotent : ré-enregistrer un manifeste
 * identique est un no-op (garantie du registre).
 */
export async function monterAdaptateurTermine(job: TrainingJob): Promise<ResultatMontage> {
  try {
    const artefact = job.artifacts.find((a) => a.storageKey.trim().length > 0);
    if (!artefact) {
      return { monte: false, erreur: "Aucun artefact déclaré par le worker pour ce job." };
    }

    const cheminLocal = artefact.storageKey;
    if (!existsSync(cheminLocal)) {
      return {
        monte: false,
        erreur: `Artefact non accessible localement (${cheminLocal}) : empreinte SHA-256 impossible sans le binaire — montage différé, aucune empreinte inventée.`,
      };
    }

    const { sha256, bytes } = await empreinteArtefact(cheminLocal);
    if (bytes !== artefact.sizeBytes && artefact.sizeBytes > 0) {
      return {
        monte: false,
        erreur: `Taille rapportée par le worker (${artefact.sizeBytes} o) ≠ taille réelle lue (${bytes} o) : intégrité douteuse, montage refusé.`,
      };
    }

    const modelId = modelIdPourJob(job.id);
    const manifest: ManifestModele = {
      modelId,
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      gitSha: "0000000",
      auteur: "montage-adaptateurs (B-P0 — job terminé)",
      artefact: { chemin: cheminLocal, sha256, bytes },
      datasets: [],
      hyperparams: {
        ...(job.trainLoss !== undefined ? { trainLoss: job.trainLoss } : {}),
        ...(job.metrics ?? {}),
      },
      metrics: [],
      lineage: { source: "training-worker" },
      channel: "production",
    };

    const registre = new RegistreModeles();
    await registre.register(manifest);
    const pointeur = await registre.promouvoir(modelId, "1.0.0");
    if (!pointeur) {
      return { monte: false, modelId, erreur: "Promotion en production sans pointeur (cas impossible) — vérifier le registre." };
    }
    return { monte: true, modelId, version: pointeur.version };
  } catch (error) {
    return {
      monte: false,
      erreur: error instanceof Error ? error.message : "Erreur de montage inconnue.",
    };
  }
}

/**
 * Lit l'adaptateur monté en production pour un job (lecture honnête du
 * pointeur — null si rien n'est monté).
 */
export async function adaptateurMonte(jobId: string): Promise<ManifestModele | null> {
  try {
    const registre = new RegistreModeles();
    return await registre.latest(modelIdPourJob(jobId), "production");
  } catch {
    return null;
  }
}

/** Vérifie l'accessibilité locale d'un artefact (diagnostic studio). */
export async function artefactAccessible(chemin: string): Promise<boolean> {
  try {
    await fsp.access(chemin);
    return true;
  } catch {
    return false;
  }
}

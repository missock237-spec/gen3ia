/**
 * UNIVERSAL EXECUTION GATEWAY (UCE-007, finalisé V1.1 Phase 3) — l'entrée
 * UNIQUE d'exécution des capacités. Tout outil, worker, connecteur ou
 * sous-système passe par ce contrat commun et les mêmes contrôles de
 * sécurité (mission V1.1 §Phase 3) : aucun chemin parallèle — les exécuteurs
 * historiques (`executeTool`, `executeToolSecurely`) sont des ADAPTATEURS
 * INTERNES de cette passerelle ; les appelants externes passent par le pont
 * legacy (`pont-legacy.ts`) et la garde automatique interdit le contournement.
 *
 * Cycle d'exécution (mission V1.1 §Phase 3, 15 étapes) :
 *  1 recevoir → 2 vérifier l'appelant (zod fail-closed) → 3 identifier la
 *  capacité → 4 vérifier disponibilité/activation (registre central) →
 *  5 valider les entrées (schéma outil côté adaptateur) → 6 vérifier les
 *  permissions → 7 contrôler les autorisations → 8 vérifier les limites de
 *  ressources (deadline + budget sortie) → 9 choisir l'adaptateur →
 *  10 exécuter → 11 capturer les journaux → 12 normaliser le résultat →
 *  13 vérifier le résultat (indépendant) → 14 enregistrer l'exécution →
 *  15 retourner une réponse structurée.
 *
 * Chaque exécution produit un enregistrement normalisé complet :
 * identifiant, demande, outil, permissions, état, durée, résultat, journaux,
 * preuve de vérification (mission §2.G) — persisté (collection
 * cap_executions) et retour honnête à l'appelant.
 */

import "server-only";

import {
  maintenantIso,
  type CapabilityExecution,
  type CapabilityExecutionRequest,
  type ExecutionStatus,
  type ExecutionVerification,
} from "../core/capability-contract";
import { construireContexte, type ContexteExecutionUce } from "./execution-context";
import { JournalExecution } from "./execution-logger";
import { adaptateurOutilNatif, adaptateurRefusNonIntegree, type AdaptateurExecution, type SortieAdaptateur } from "./execution-adapter";
import { autoriserExecutionUce, integrerAutorisee } from "../security/permission-manager";
import { sanitiserTexte } from "../security/secrets-protection";
import { verifierResultat, type SpecPreuve } from "../verification/result-verifier";
import { obtenirGestionnaireCapacites } from "../core/capability-manager";
import { obtenirRegistreCentral } from "../core/capability-registry";
import { sauvegarder } from "../storage/capability-repository";
import { nouvelId } from "../storage/capability-repository";

export interface OptionsGateway {
  /** Adapters supplémentaires (ex. adaptateur d'une capacité construite). */
  adaptateursSupplementaires?: AdaptateurExecution[];
  /** Preuve de vérification demandée pour cette exécution. */
  preuve?: SpecPreuve;
  /** Persister l'enregistrement (défaut true ; false pour les tests secs). */
  persister?: boolean;
  /** Signal d'annulation transmis à l'adaptateur (abort réel du chemin appelant). */
  signal?: AbortSignal;
}

export interface ResultatGateway {
  /** Identifiant d'exécution demandé (porté tel quel pour la réponse). */
  executionId: string;
  execution: CapabilityExecution;
  /** Sortie réelle (non sérialisée) pour l'appelant de confiance. */
  sortie?: unknown;
  ok: boolean;
  /** Usage mesuré de l'exécution (mission : champ `usage` de la réponse). */
  usage: { dureeMs: number; memoireMo?: number };
}

/** Réponse structurée mission V1.1 (contrat de résultat normalisé). */
export interface ReponseExecutionNormalisee {
  success: boolean;
  executionId: string;
  capabilityId: string;
  status: ExecutionStatus;
  result?: unknown;
  error?: string;
  durationMs: number;
  verification: ExecutionVerification;
  usage: { dureeMs: number; memoireMo?: number };
  timestamp: string;
}

/** Construit la réponse normalisée mission depuis un résultat gateway. */
export function reponseNormalisee(resultat: ResultatGateway): ReponseExecutionNormalisee {
  return {
    success: resultat.ok,
    executionId: resultat.executionId,
    capabilityId: resultat.execution.capabilityId,
    status: resultat.execution.status,
    result: resultat.sortie,
    error: resultat.execution.erreur,
    durationMs: resultat.execution.dureeMs,
    verification: resultat.execution.verification,
    usage: resultat.usage,
    timestamp: resultat.execution.demarreLe || maintenantIso(),
  };
}

/**
 * Exécute une capacité via le contrat commun. Ne lève JAMAIS : tout échec
 * devient un enregistrement honnête (status echec/refusee + cause).
 */
export async function executerCapacite(
  demandeBrute: CapabilityExecutionRequest,
  options: OptionsGateway = {},
): Promise<ResultatGateway> {
  let ctx: ContexteExecutionUce;
  try {
    ctx = construireContexte(demandeBrute);
  } catch (erreur) {
    return {
      ok: false,
      executionId: (demandeBrute as { executionId?: string } | undefined)?.executionId ?? "",
      usage: { dureeMs: 0 },
      execution: {
        id: `exec_invalide_${Date.now().toString(36)}`,
        capabilityId: String((demandeBrute as { capabilityId?: string } | undefined)?.capabilityId ?? "?"),
        toolName: "",
        demande: "demande invalide",
        permissions: [{ couche: "permission-uce", autorise: false, raison: `demande invalide : ${erreur instanceof Error ? erreur.message : String(erreur)}` }],
        status: "refusee",
        demarreLe: maintenantIso(),
        dureeMs: 0,
        erreur: erreur instanceof Error ? erreur.message : "demande invalide",
        journaux: [],
        verification: { verifie: false, methode: "aucune", details: "demande rejetée à la frontière (zod)" },
        schemaVersion: 1,
      },
    };
  }

  const journal = new JournalExecution();
  const debut = Date.now();
  const memoireAvant = process.memoryUsage().heapUsed;
  ctx.signal = options.signal;
  const gestionnaire = obtenirGestionnaireCapacites();
  const registre = obtenirRegistreCentral();

  // 1) Résolution de la cible : outil natif ? capacité UCE intégrée ?
  let cible: { type: "natif" | "uce" | "refus"; toolName?: string; policy?: Parameters<typeof autoriserExecutionUce>[0]["policy"] } = { type: "refus" };
  /** Raison de refus spécifique (sémantique historique préservée). */
  let erreurRefus: string | undefined;
  const demande = ctx.demande;
  journal.ajouter(`résolution de la cible ${demande.capabilityId} (origine ${demande.origine}, trace ${ctx.traceId})`);

  if (demande.capabilityId.startsWith("natif:gen3ia:")) {
    const nomOutil = demande.capabilityId.slice("natif:gen3ia:".length);
    const native = await gestionnaire.obtenir(demande.capabilityId);
    if (native?.card.nom) {
      cible = { type: "natif", toolName: nomOutil, policy: (demande.input as { policy?: Parameters<typeof autoriserExecutionUce>[0]["policy"] } | undefined)?.policy };
    } else {
      // V1.1 — repli honnête : outil présent au REGISTRE D'EXÉCUTION réel
      // mais non annoncé au catalogue déclaratif. La résolution ne refuse
      // pas un outil réellement exécutable (comportement historique
      // préservé) ; l'écart est journalisé, jamais masqué.
      const { createDefaultToolRegistry } = await import("@/lib/tools/default-registry");
      if (createDefaultToolRegistry().get(nomOutil)) {
        cible = { type: "natif", toolName: nomOutil, policy: (demande.input as { policy?: Parameters<typeof autoriserExecutionUce>[0]["policy"] } | undefined)?.policy };
        journal.ajouter(`outil « ${nomOutil} » présent au registre d'exécution réel mais NON annoncé au catalogue déclaratif — exécution tracée`);
      } else {
        journal.ajouter(`outil natif « ${nomOutil} » introuvable (catalogue ET registre d'exécution)`);
        // Sémantique historique préservée pour les appelants (parité exacte).
        erreurRefus = `Unknown tool: ${nomOutil}`;
      }
    }
  } else {
    const capacite = await gestionnaire.obtenir(demande.capabilityId);
    if (capacite && integrerAutorisee(capacite)) {
      cible = { type: "uce" };
      journal.ajouter(`capacité UCE « ${capacite.status} » — exécution permise`);
    } else {
      journal.ajouter(`capacité UCE au statut « ${capacite?.status ?? "absente"} » — non exécutable`);
    }
  }

  // 2) Vérification de la DISPONIBILITÉ / ACTIVATION (registre central,
  //    mission Phase 2 : une capacité désactivée n'est pas exécutable).
  const activation = await registre.verifierActivation(demande.capabilityId);
  journal.ajouter(`activation (registre central) : ${activation.raison}`);

  // 3) Autorisation unifiée (arrêt d'urgence → politique → consentements).
  const autorisation = await autoriserExecutionUce({
    userId: demande.userId,
    executionId: demande.executionId,
    toolName: cible.toolName,
    policy: cible.policy,
  });
  journal.ajouter(`autorisation : ${autorisation.raisonFinale}`);
  if (demande.approvalContext) {
    journal.ajouter(`approbation amont : niveau ${demande.approvalContext.niveau}${demande.approvalContext.approvalId ? ` (approval ${demande.approvalContext.approvalId})` : ""}`);
  }

  // Le statut final est calculé à la construction de l'enregistrement
  // (refusee si autorisation/activation refusée, sinon succes/echec selon
  // vérification).
  let sortie: SortieAdaptateur | null = null;

  // 4) Exécution par l'adaptateur choisi (ou refus honnête).
  if (activation.ok && autorisation.autorise) {
    const adaptateurs = [adaptateurOutilNatif, adaptateurRefusNonIntegree, ...(options.adaptateursSupplementaires ?? [])];
    const adaptateur = adaptateurs.find((a) => a.peutExecuter(ctx, cible));
    if (!adaptateur) {
      journal.ajouter("aucun adaptateur capable d'exécuter cette cible");
      sortie = { ok: false, journaux: [], erreur: "aucun adaptateur pour cette cible" };
    } else {
      journal.ajouter(`adaptateur sélectionné : ${adaptateur.id}`);
      try {
        sortie = await Promise.race([
          adaptateur.executer(ctx),
          new Promise<SortieAdaptateur>((_, rejeter) =>
            setTimeout(() => rejeter(new Error(`deadline dépassée (${ctx.deadlineMs} ms)`)), ctx.deadlineMs),
          ),
        ]);
      } catch (erreur) {
        sortie = { ok: false, journaux: [], erreur: erreur instanceof Error ? erreur.message : String(erreur) };
      }
    }
  }

  // 5) Vérification INDÉPENDANTE du résultat (jamais fiduciaire).
  let verification: ExecutionVerification = { verifie: false, methode: "non-verifie", details: "exécution non aboutie : aucune sortie à vérifier" };
  if (sortie?.ok) {
    verification = await verifierResultat({
      executionId: demande.executionId,
      resultat: sortie.sortie,
      spec: options.preuve ?? { nonVide: true },
    });
  }

  // 6) Enregistrement normalisé + persistance (+ usage mesuré).
  const dureeMs = Date.now() - debut;
  const memoireMo = Math.round(((process.memoryUsage().heapUsed - memoireAvant) / (1024 * 1024)) * 100) / 100;
  const texteSortie = sortie?.sortie !== undefined
    ? sanitiserTexte(typeof sortie.sortie === "string" ? sortie.sortie : JSON.stringify(sortie.sortie), ctx.budgetSortieOctets).texte
    : undefined;

  const refusee = !activation.ok || !autorisation.autorise || cible.type === "refus";
  const execution: CapabilityExecution = {
    id: nouvelId("exec", `${demande.executionId}:${demande.capabilityId}`),
    capabilityId: demande.capabilityId,
    toolName: cible.toolName ?? adaptateurLabel(cible.type),
    demande: `origine=${demande.origine} ; exécution=${demande.executionId}${demande.sessionId ? ` ; session=${demande.sessionId}` : ""}${demande.agentId ? ` ; agent=${demande.agentId}` : ""}${demande.traceId ? ` ; trace=${demande.traceId}` : ""}`,
    permissions: autorisation.decisions,
    status: refusee ? "refusee" : sortie?.ok ? (verification.verifie ? "succes" : "echec") : "echec",
    demarreLe: ctx.dateIso,
    dureeMs,
    resultat: texteSortie,
    erreur: refusee
      ? (erreurRefus ?? (!activation.ok ? activation.raison : !autorisation.autorise ? autorisation.raisonFinale : (sortie?.erreur ?? "exécution refusée")))
      : sortie?.erreur,
    journaux: [...autorisation.decisions.map((d) => `${d.couche}: ${d.raison}`), ...journal.lignesActuelles(), ...(sortie?.journaux ?? [])],
    verification: sortie?.ok ? verification : { verifie: false, methode: "non-verifie", details: verification.details },
    schemaVersion: 1,
  };

  if (options.persister !== false) {
    try {
      await sauvegarder("executions", execution);
    } catch (erreur) {
      journal.ajouter(`persistance de l'enregistrement échouée (non fatal) : ${erreur instanceof Error ? erreur.message : String(erreur)}`);
    }
  }

  return { ok: execution.status === "succes", executionId: demande.executionId, execution, sortie: sortie?.sortie, usage: { dureeMs, memoireMo } };
}

function adaptateurLabel(type: string): string {
  return type === "natif" ? "outil-natif" : type === "uce" ? "capacite-uce" : "refus-non-integree";
}

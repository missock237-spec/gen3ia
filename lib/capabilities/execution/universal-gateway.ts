/**
 * UNIVERSAL EXECUTION GATEWAY (UCE-007) — l'entrée UNIQUE d'exécution des
 * capacités. Tout outil, worker, connecteur ou sous-système passe par ce
 * contrat commun et les mêmes contrôles de sécurité (mission §3) : aucun
 * chemin parallèle n'est créé — les exécuteurs existants restent les
 * implémentations déléguées.
 *
 * Chaque exécution produit un enregistrement normalisé complet :
 * identifiant, demande, outil, permissions, état, durée, résultat, journaux,
 * preuve de vérification (mission §2.G) — persisté (collection
 * cap_executions) et retour honnête à l'appelant.
 */

import "server-only";

import {
  EXECUTION_STATUSES,
  maintenantIso,
  type CapabilityExecution,
  type CapabilityExecutionRequest,
  type ExecutionVerification,
} from "../core/capability-contract";
import { construireContexte, type ContexteExecutionUce } from "./execution-context";
import { JournalExecution } from "./execution-logger";
import { adaptateurOutilNatif, adaptateurRefusNonIntegree, type AdaptateurExecution, type SortieAdaptateur } from "./execution-adapter";
import { autoriserExecutionUce, integrerAutorisee } from "../security/permission-manager";
import { sanitiserTexte } from "../security/secrets-protection";
import { verifierResultat, type SpecPreuve } from "../verification/result-verifier";
import { obtenirGestionnaireCapacites } from "../core/capability-manager";
import { sauvegarder } from "../storage/capability-repository";
import { nouvelId } from "../storage/capability-repository";

export interface OptionsGateway {
  /** Adapters supplémentaires (ex. adaptateur d'une capacité construite). */
  adaptateursSupplementaires?: AdaptateurExecution[];
  /** Preuve de vérification demandée pour cette exécution. */
  preuve?: SpecPreuve;
  /** Persister l'enregistrement (défaut true ; false pour les tests secs). */
  persister?: boolean;
}

export interface ResultatGateway {
  execution: CapabilityExecution;
  /** Sortie réelle (non sérialisée) pour l'appelant de confiance. */
  sortie?: unknown;
  ok: boolean;
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
  const gestionnaire = obtenirGestionnaireCapacites();

  // 1) Résolution de la cible : outil natif ? capacité UCE intégrée ?
  let cible: { type: "natif" | "uce" | "refus"; toolName?: string; policy?: Parameters<typeof autoriserExecutionUce>[0]["policy"] } = { type: "refus" };
  const demande = ctx.demande;
  journal.ajouter(`résolution de la cible ${demande.capabilityId} (origine ${demande.origine})`);

  if (demande.capabilityId.startsWith("natif:gen3ia:")) {
    const nomOutil = demande.capabilityId.slice("natif:gen3ia:".length);
    const native = await gestionnaire.obtenir(demande.capabilityId);
    if (native?.card.nom) {
      cible = { type: "natif", toolName: nomOutil, policy: (demande.input as { policy?: Parameters<typeof autoriserExecutionUce>[0]["policy"] } | undefined)?.policy };
    } else {
      journal.ajouter(`outil natif « ${nomOutil} » introuvable dans le catalogue`);
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

  // 2) Autorisation unifiée (arrêt d'urgence → politique → consentements).
  const autorisation = await autoriserExecutionUce({
    userId: demande.userId,
    executionId: demande.executionId,
    toolName: cible.toolName,
    policy: cible.policy,
  });
  journal.ajouter(`autorisation : ${autorisation.raisonFinale}`);

  const statutFinal: (typeof EXECUTION_STATUSES)[number] = autorisation.autorise ? "succes" : "refusee";
  let sortie: SortieAdaptateur | null = null;

  // 3) Exécution par l'adaptateur choisi (ou refus honnête).
  if (autorisation.autorise) {
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

  // 4) Vérification INDÉPENDANTE du résultat (jamais fiduciaire).
  let verification: ExecutionVerification = { verifie: false, methode: "non-verifie", details: "exécution non aboutie : aucune sortie à vérifier" };
  if (sortie?.ok) {
    verification = await verifierResultat({
      executionId: demande.executionId,
      resultat: sortie.sortie,
      spec: options.preuve ?? { nonVide: true },
    });
  }

  // 5) Enregistrement normalisé + persistance.
  const dureeMs = Date.now() - debut;
  const texteSortie = sortie?.sortie !== undefined
    ? sanitiserTexte(typeof sortie.sortie === "string" ? sortie.sortie : JSON.stringify(sortie.sortie), 2_000).texte
    : undefined;

  const execution: CapabilityExecution = {
    id: nouvelId("exec", `${demande.executionId}:${demande.capabilityId}`),
    capabilityId: demande.capabilityId,
    toolName: cible.toolName ?? adaptateurLabel(cible.type),
    demande: `origine=${demande.origine} ; exécution=${demande.executionId}`,
    permissions: autorisation.decisions,
    status: !autorisation.autorise ? "refusee" : sortie?.ok ? (verification.verifie ? "succes" : "echec") : "echec",
    demarreLe: ctx.dateIso,
    dureeMs,
    resultat: texteSortie,
    erreur: !autorisation.autorise ? autorisation.raisonFinale : sortie?.erreur,
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

  return { ok: execution.status === "succes", execution, sortie: sortie?.sortie };
}

function adaptateurLabel(type: string): string {
  return type === "natif" ? "outil-natif" : type === "uce" ? "capacite-uce" : "refus-non-integree";
}

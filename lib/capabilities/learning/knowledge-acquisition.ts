/**
 * KNOWLEDGE ACQUISITION (UCE-004) — acquisition de connaissances TECHNIQUES
 * depuis les résultats UCE. Réutilise la mémoire de connaissances du cerveau
 * (MemoireConnaissances, JSONL « dernier record gagne ») — l'UCE n'invente
 * PAS un second stockage de connaissances.
 *
 * Garde-fous : aucun secret dans les connaissances ; aucune instruction du
 * contenu externe n'est traitée comme directive (les découvertes restent des
 * données : seules des phrases de connaissance structurées sont enregistrées).
 */

import "server-only";

import { maintenantIso, type CapabilityLearning } from "../core/capability-contract";
import { sauvegarder } from "../storage/capability-repository";
import { refuserSiSecret } from "../security/secrets-protection";
import type { EnregistrementStructure, Provenance } from "@/lib/autonomous/intelligence/traiter";
import type { Connaissance } from "@/lib/autonomous/knowledge/memoire-connaissances";

export interface DemandeConnaissance {
  concept: string;
  domaine: string;
  resume: string;
  proprietes?: Array<{ nom: string; valeur: string }>;
  relations?: Array<{ cible: string; type: string }>;
  /** Source factuelle (ex. "benchmark cap_x 2026-11-25"). */
  provenance: string;
  /** Vrai uniquement si le résultat source a été VÉRIFIÉ (result-verifier). */
  verifie: boolean;
  dossierMemoire?: string;
}

export interface ResultatAcquisition {
  ok: boolean;
  connaissance?: Connaissance;
  learning?: CapabilityLearning;
  cause?: string;
}

/**
 * Acquiert une connaissance technique depuis un résultat UCE VALIDÉ.
 * Retourne un échec honnête si le contenu est suspect (secret) ou vide.
 */
export async function acquerirConnaissance(demande: DemandeConnaissance): Promise<ResultatAcquisition> {
  if (!demande.concept.trim() || !demande.resume.trim()) {
    return { ok: false, cause: "concept ou resume vide : rien à acquérir" };
  }
  // Garde du pipeline cerveau : integrer() est réservé aux connaissances
  // VÉRIFIÉES (contrat Lot 5) — une source non vérifiée n'est jamais intégrée.
  if (!demande.verifie) {
    return { ok: false, cause: "source non vérifiée : intégration dans la mémoire du cerveau refusée (contrat Lot 5)" };
  }
  const garde = refuserSiSecret(`${demande.concept}\n${demande.resume}\n${demande.proprietes?.map((p) => p.valeur).join("\n") ?? ""}`);
  if (!garde.autorise) {
    return { ok: false, cause: "contenu refusé : motif de secret détecté — jamais persisté dans la mémoire" };
  }

  // Enregistrement structuré conforme au pipeline du cerveau (Lot 5) :
  // statut pending_validation + provenance réelle (integrity du pipeline).
  const provenance: Provenance = {
    lotId: `uce_${Date.now().toString(36)}`,
    sourceId: "uce-knowledge-acquisition",
    url: demande.provenance,
    collecteLe: maintenantIso(),
  };
  const enregistrement: EnregistrementStructure = {
    idConcept: `uce_${demande.concept.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 80)}`,
    concept: demande.concept,
    domaine: null, // hors des 18 domaines du routeur lexical : honnêtement null
    proprietes: (demande.proprietes ?? []).map((p) => ({ cle: p.nom, valeur: p.valeur })),
    relations: (demande.relations ?? []).map((r) => ({ relation: r.type, cible: r.cible })),
    resume: demande.resume,
    langue: "fr",
    qualite: 0.8,
    provenance,
    contentType: "text/plain",
    statut: "pending_validation",
  };

  // Persistance dans la mémoire du cerveau (réutilisation, pas de doublon) :
  // integrer() assure versionnement + détection de contradictions.
  let connaissance: Connaissance | undefined;
  let memoireOk = false;
  if (demande.dossierMemoire) {
    try {
      const { MemoireConnaissances } = await import("@/lib/autonomous/knowledge/memoire-connaissances");
      const memoire = new MemoireConnaissances(demande.dossierMemoire);
      connaissance = memoire.integrer(enregistrement, 1);
      memoireOk = true;
    } catch (erreur) {
      return { ok: false, cause: `mémoire de connaissances indisponible : ${erreur instanceof Error ? erreur.message : String(erreur)}` };
    }
  }

  // Trace UCE (cap_learning) : traçabilité complète des acquisitions.
  const learning: CapabilityLearning = {
    id: `learn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind: "connaissance",
    lecon: `${demande.resume} (source : ${demande.provenance}${memoireOk ? ", mémorisée dans le cerveau" : ", trace UCE seule"})`,
    regressionDetectee: false,
    valide: true,
    apprentiLe: maintenantIso(),
    schemaVersion: 1,
  };
  try {
    await sauvegarder("learning", learning);
  } catch {
    // non fatal
  }

  return { ok: true, connaissance, learning };
}

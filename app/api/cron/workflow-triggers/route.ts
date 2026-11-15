import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

import { verifyTickRequest } from "@/lib/queue/tick-queue";
import { adminDb } from "@/lib/firebase/admin";
import { runWorkflowGraph } from "@/lib/workflows/executor";
import type { Workflow } from "@/lib/workflows/types";
import {
  CHAMP_DERNIER,
  CHAMP_INTERVALE,
  CHAMP_TOKEN_HASH,
  estDue,
  parserIntervale,
} from "@/lib/workflows/triggers";
import { executionLogger } from "@/lib/observability/logger";

/**
 * SENTINELLE CRON DES DÉCLENCHEURS DE WORKFLOW (P2) — POST /api/cron/workflow-triggers
 *
 * Appelée par le cron plateforme (vercel.json / planificateur VPS, bearer
 * CRON_SECRET ou signature de tick interne — même contrat que les autres
 * routes /api/cron). Parcourt les workflows portant un intervalle de
 * déclenchement (`triggerIntervalMinutes`) et lance ceux dont l'échéance
 * est due (jamais déclenché, ou dernier déclenchement plus ancien que
 * l'intervalle − marge 15 s).
 *
 * GARANTIES :
 *  - seul un workflow AYANT un hash de token actif est éligible (le cron ne
 *    réveille pas les workflows jamais configurés pour le déclenchement) ;
 *  - horodatage `triggerLastFiredAt` écrit AVANT l'exécution : un run long
 *    ou en échec ne fait pas boucler la sentinelle (au pire un tick perdu) ;
 *  - chaque exécution est isolée (try/catch par document) : un workflow en
 *    panne n'empêche jamais les autres de partir ;
 *  - facturation au propriétaire (userId du document), comme l'UI.
 */

export const runtime = "nodejs";
export const maxDuration = 120;

const LIMITE_PAR_PASSE = 25;

// ROTATION ÉQUITAABLE (audit 2026-10-28) : la requête historique
// limit(25) SANS ordre renvoyait toujours les MÊMES 25 premiers workflows
// (ordre de scan) — au-delà de 25 planifications, les suivants n'étaient
// JAMAIS déclenchés (starvation). Correctif compatible moteur r2fs (pas de
// startAfter) : balayage SANS limite du filtre d'inégalité (cap interne
// r2fs ~2000), puis sélection EN MÉMOIRE des workflows DUS et VALIDES,
// triés du « dernier tir le plus ancien » (jamais tirés en tête) vers le
// plus récent, plafonnés à LIMITE_PAR_PASSE par passe. Les workflows
// invalides (sans token / intervalle) ne consomment plus de créneau : la
// starvation disparaît même si des dizaines de workflows morts existent.

export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyTickRequest(raw, request.headers.get("authorization"), request.headers.get("x-gen3a-tick"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const log = executionLogger({ requestId });
  const maintenant = Date.now();

  try {
    const snapshot = await adminDb
      .collection("workflows")
      // UN SEUL filtre d'inégalité (auto-indexé) : la présence du hash de
      // token est vérifiée en mémoire — deux `!=` sur champs différents
      // exigeraient un index composite (échec production).
      .where(CHAMP_INTERVALE, "!=", null)
      .get();

    const resultats: Array<{ workflowId: string; action: string; runId?: string; erreur?: string }> = [];

    // Passe 1 — collecte en mémoire : valides et dus uniquement.
    interface Dû {
      doc: (typeof snapshot.docs)[number];
      dernierTir: number;
    }
    const dus: Dû[] = [];
    let invalides = 0;
    let pasDus = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data() as {
        userId?: string;
        [CHAMP_INTERVALE]?: unknown;
        [CHAMP_TOKEN_HASH]?: unknown;
        [CHAMP_DERNIER]?: unknown;
      };
      const intervalle = parserIntervale(data[CHAMP_INTERVALE]);
      if (intervalle === null) {
        invalides += 1;
        continue;
      }
      // Un workflow sans token actif n'est pas déclenchable par design.
      if (typeof data[CHAMP_TOKEN_HASH] !== "string" || data[CHAMP_TOKEN_HASH].length !== 64) {
        invalides += 1;
        continue;
      }
      if (!estDue(intervalle, data[CHAMP_DERNIER], maintenant)) {
        pasDus += 1;
        continue;
      }
      const proprietaire = String(data.userId ?? "");
      if (!proprietaire) {
        invalides += 1;
        continue;
      }
      dus.push({
        doc,
        // Jamais tiré = le plus prioritaire (rotation démarrée en tête).
        dernierTir: typeof data[CHAMP_DERNIER] === "number" ? data[CHAMP_DERNIER] : 0,
      });
    }

    // Passe 2 — rotation équitable : le plus ancien tir d'abord, plafond
    // LIMITE_PAR_PASSE (protection contre un emballement d'exécutions).
    dus.sort((a, b) => a.dernierTir - b.dernierTir);
    const retenus = dus.slice(0, LIMITE_PAR_PASSE);
    const nonRetenus = dus.length - retenus.length;

    // Verbose historique conservé pour une petite base : au-delà, les
    // « pas-due / ignore » satureraient la réponse à chaque passe (×5 min).
    const verbose = snapshot.size <= LIMITE_PAR_PASSE;

    for (const { doc } of retenus) {
      const data = doc.data() as Record<string, unknown>;
      // Horodatage AVANT exécution : un run long/échoué ne re-boucle pas.
      await doc.ref.update({ [CHAMP_DERNIER]: maintenant });

      try {
        const workflow = doc.data() as unknown as Workflow;
        const state = await runWorkflowGraph({ userId: String(data.userId ?? ""), workflow });
        resultats.push({ workflowId: doc.id, action: "lance", runId: state.runId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "échec inconnu";
        log.warn(
          { workflowId: doc.id },
          `workflow-trigger: exécution cron échouée (isolée) — ${message}`,
        );
        resultats.push({ workflowId: doc.id, action: "echec", erreur: message });
      }
    }
    if (verbose) {
      for (const doc of snapshot.docs) {
        if (!retenus.some(({ doc: r }) => r.id === doc.id)) {
          resultats.push({ workflowId: doc.id, action: "pas-due-ou-invalide" });
        }
      }
    }

    return NextResponse.json({
      requestId,
      parcourus: snapshot.size,
      dus: dus.length,
      retenus: retenus.length,
      nonRetenus,
      pasDus,
      invalides,
      resultats,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sentinelle en échec.";
    log.error(`workflow-triggers: passage en échec — ${message}`);
    return NextResponse.json({ error: message, requestId }, { status: 503 });
  }
}

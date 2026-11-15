import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { franchirPorteV1, ErrorAccesV1 } from "@/lib/api/v1/porte-v1";
import { errorBody, errorStatus } from "@/lib/security/http-errors";

/**
 * GET /api/v1/essaim/manifeste — le MANIFESTE DU NŒUD NAVIGATEUR, défini par
 * la plateforme (plan d'amélioration E-P0 : « le navigateur devient un nœud
 * de l'essaim »).
 *
 * RÈGLE ABSOLUE DE L'ESSAIM (lib/essaim-agents/orchestrateur.ts) : tous les
 * agents passent par le cortex Gen3 — aucun agent ne « parle » librement.
 * L'extension navigateur respecte ce contrat : elle réclame des tâches de SA
 * spécialité, exécute localement ce qui est local (lecture de page, tri,
 * extraction), et remonte TOUT compte rendu au cortex via /api/v1/chat.
 *
 * CONFIDENTIALITÉ (contrat du nœud navigateur) :
 *  - le contenu d'une page ne quitte JAMAIS le navigateur sans l'action
 *    explicite de l'utilisateur (envoi d'un message ou d'une tâche) ;
 *  - la clé `g3a_` ne transite QUE vers l'instance gen3ia configurée ;
 *  - aucune télémétrie de navigation, aucun historique, aucun stockage
 *    serveur du contexte de page.
 */
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const porte = await franchirPorteV1(request, "essaim-manifeste");

    return NextResponse.json(
      {
        noeud: {
          type: "navigateur",
          version_manifeste: "1.0.0",
          transport: "https (API gen3ia) — WebRTC P2P prévu en P1 (signaling /api/ondes/signaling)",
          cortex: "TOUT compte rendu remonte au cortex via POST /api/v1/chat (règle absolue de l'essaim).",
        },
        specialites: [
          {
            id: "veille",
            nom: "Sentinelle",
            navigateur: true,
            description: "Compare deux instantanés d'une page (rechargement) et signale les ruptures.",
            locale: true,
          },
          {
            id: "tri",
            nom: "Trieur",
            navigateur: true,
            description: "Trie et regroupe le contenu de la page courante (listes, tableaux, sections).",
            locale: true,
          },
          {
            id: "calcul",
            nom: "Calculateur",
            navigateur: true,
            description: "Extrait les nombres de la page et calcule totaux/moyennes localement.",
            locale: true,
          },
          {
            id: "code",
            nom: "Artisan",
            navigateur: false,
            description: "Tâches de code exécutées par le cortex (jamais dans le navigateur).",
            locale: false,
          },
          {
            id: "automatisation",
            nom: "Automatiseur",
            navigateur: false,
            description: "Actions hors navigateur réservées au cortex + approbations utilisateur.",
            locale: false,
          },
        ],
        confidentialite: {
          contexte_page: "sur-action-utilisateur-uniquement",
          cle_api: "chrome.storage.local, transmise uniquement à l'instance gen3ia configurée",
          telemetrie_navigation: "aucune",
          stockage_serveur_contexte: "aucun",
        },
        endpoints: {
          chat: "POST /api/v1/chat",
          portefeuille: "GET /api/v1/wallet",
          capacites: "GET /api/v1/capabilities",
        },
        requestId,
      },
      { status: 200, headers: { "x-request-id": requestId, ...porte.enTetesLimite } },
    );
  } catch (error) {
    if (error instanceof ErrorAccesV1) {
      return NextResponse.json(
        { error: error.message, requestId },
        { status: error.statut, headers: { "x-request-id": requestId, ...error.enTetes } },
      );
    }
    return NextResponse.json(errorBody(error), {
      status: errorStatus(error, 500),
      headers: { "x-request-id": requestId },
    });
  }
}

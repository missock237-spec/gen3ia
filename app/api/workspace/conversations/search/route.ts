/**
 * Recherche de conversations — sémantique (Qdrant) avec repli textuel.
 *
 * Deux modes de réponse :
 *  - mode "semantic" : la requête est encodée en vecteur (HuggingFace) et
 *    comparée aux messages indexés de l'utilisateur. Les résultats portent
 *    un extrait du message retrouvé — on retrouve une conversation par le
 *    SENS de son contenu, pas seulement par son titre.
 *  - mode "text" (repli) : Qdrant/embeddings indisponibles, requête trop
 *    courte, ou aucun hit — correspondance littérale historique sur les
 *    titres via Firestore.
 *
 * Sécurité : le filtre userId est OBLIGATOIRE côté Qdrant (aucune traversée
 * multi-tenant possible) et chaque conversation retournée est re-vérifiée
 * dans Firestore comme appartenant à l'utilisateur (défense en profondeur :
 * un payload Qdrant falsifié ne peut jamais exposer la conversation d'un
 * autre compte).
 */

import { NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/security/authenticated-request";

import { enforceRateLimit } from "@/lib/security/rate-limit";

import { securityHeaders } from "@/lib/security/request-security";

import { adminDb } from "@/lib/firebase/admin";

import {
  bestHitPerConversation,
  searchConversationMessages,
  type ConversationSearchHit,
} from "@/lib/chat/vector-index";

import { listConversations } from "@/lib/chat/repository";

export const dynamic = "force-dynamic";

interface SearchConversationResult {
  conversationId: string;

  title: string;

  updatedAt: string;

  messageCount: number;

  /** Extrait du message retrouvé (mode sémantique uniquement). */
  excerpt?: string;

  role?: string;

  score?: number;
}

const MIN_SEMANTIC_QUERY_LENGTH = 3;

/**
 * Score de similarité minimal (cosinus) pour retenir un hit sémantique :
 * sans seuil, la recherche renvoyait TOUTES les conversations (scores
 * ~0,06 !) et noyait la pertinence (audit 25-a). Sous ce plancher, on
 * bascule sur le repli textuel, plus honnête.
 */
const MIN_SEMANTIC_SCORE = 0.25;

const MAX_RESULTS = 10;

async function chargerConversations(
  userId: string,
  conversationIds: string[],
): Promise<Map<string, { title: string; updatedAt: string; messageCount: number }>> {
  const map = new Map<string, { title: string; updatedAt: string; messageCount: number }>();
  if (conversationIds.length === 0) return map;

  const unique = [...new Set(conversationIds)].slice(0, 20);
  const refs = unique.map((id) => adminDb.collection("chatConversations").doc(id));
  const snapshots = await adminDb.getAll(...refs);

  for (const snap of snapshots) {
    if (!snap.exists) continue;
    const data = snap.data();
    // Défense en profondeur : ne JAMAIS retourner une conversation dont
    // l'utilisateur authentifié n'est pas propriétaire (même si le payload
    // vectoriel prétendait le contraire).
    if (data?.userId !== userId) continue;
    map.set(snap.id, {
      title: typeof data?.title === "string" ? data.title : "Conversation",
      updatedAt:
        typeof data?.updatedAt?.toDate === "function"
          ? data.updatedAt.toDate().toISOString()
          : typeof data?.updatedAt === "string"
            ? data.updatedAt
            : new Date(0).toISOString(),
      messageCount: Number(data?.messageCount ?? 0),
    });
  }
  return map;
}

function meilleursHitsParConversation(hits: ConversationSearchHit[]): ConversationSearchHit[] {
  // Un même message peut être retourné deux fois (réédition) : dédoublonnage
  // par messageId ; puis on ne garde que le MEILLEUR hit de chaque
  // conversation (le plus pertinent), triés par score décroissant.
  return bestHitPerConversation(hits);
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);

    const params = new URL(request.url).searchParams;
    const query = (params.get("q") ?? "").trim();
    const projectId = params.get("projectId") ?? undefined;

    if (query.length < 2) {
      return NextResponse.json(
        { mode: "text", results: [] as SearchConversationResult[] },
        { headers: securityHeaders() },
      );
    }

    const limited = await enforceRateLimit(`conv-search:${user.uid}`, {
      limit: 60,
      windowMs: 5 * 60 * 1000,
    });
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Trop de recherches. Réessayez dans un instant." },
        { status: 429, headers: { ...Object.fromEntries(securityHeaders().entries()), "retry-after": String(Math.max(1, Math.ceil(limited.retryAfterMs / 1000))) } },
      );
    }

    let mode: "semantic" | "text" = "text";
    let results: SearchConversationResult[] = [];

    // Chemin sémantique : embedding + kNN Qdrant filtré par utilisateur.
    if (query.length >= MIN_SEMANTIC_QUERY_LENGTH) {
      const hits = await searchConversationMessages(user.uid, query, {
        limit: 20,
        projectId: projectId ?? null,
      });

      if (hits !== null && hits.length > 0) {
        // Seuil de pertinence : les hits trop éloignés de la requête sont
        // écartés (le meilleur hit d'une conversation hors sujet à 0,1 ne
        // doit pas évincer le repli textuel).
        const relevant = hits.filter((hit) => hit.score >= MIN_SEMANTIC_SCORE);
        const best = meilleursHitsParConversation(relevant).slice(0, MAX_RESULTS);
        const conversations = await chargerConversations(
          user.uid,
          best.map((h) => h.conversationId),
        );

        results = best
          .filter((hit) => conversations.has(hit.conversationId))
          .map((hit) => {
            const conversation = conversations.get(hit.conversationId)!;
            return {
              conversationId: hit.conversationId,
              title: conversation.title,
              updatedAt: conversation.updatedAt,
              messageCount: conversation.messageCount,
              excerpt: hit.preview,
              role: hit.role,
              score: Math.round(hit.score * 100) / 100,
            };
          });

        if (results.length > 0) {
          mode = "semantic";
        }
      }
    }

    // Repli textuel : Qdrant indisponible, aucun hit, ou requête courte.
    // On conserve le comportement historique (titres correspondants).
    if (mode === "text") {
      const conversations = await listConversations(user.uid, 20, {
        projectId,
        query,
      });
      results = conversations.slice(0, MAX_RESULTS).map((conversation) => ({
        conversationId: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.messageCount,
      }));
    }

    return NextResponse.json({ mode, results }, { headers: securityHeaders() });
  } catch (error) {
    const status = (error as { status?: number })?.status ?? 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Recherche indisponible." },
      { status, headers: securityHeaders() },
    );
  }
}

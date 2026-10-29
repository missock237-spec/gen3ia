import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { getApp } from "firebase-admin/app";

import { requireUser } from "@/lib/security/authenticated-request";
import { adminDb } from "@/lib/firebase/admin";
import { clearSessionCookieHeader } from "@/lib/server/session-cookie";
import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { errorStatus } from "@/lib/security/http-errors";
import { deleteIdentityForAccount } from "@/lib/identity/service";
import { removePrefix, userDir } from "@/lib/storage/user-data-store";
import { logger } from "@/lib/observability/logger";

export const runtime = "nodejs";

/** Taille maximale des lots de suppression Firestore (limite plateforme). */
const BATCH_LIMIT = 400;

/** Nombre maximal d'objets par passe removePrefix (taille de page R2). */
const R2_PURGE_PAGE = 1000;

/** Nombre maximal de passes de purge R2 d'un namespace nommé (garde anti-dérive : 50 000 objets). */
const R2_PURGE_MAX_PASSES = 50;

/**
 * Nombre maximal de passes de la purge RACINE `users/{uid}/` (100 000 objets).
 * La racine agrège tous les namespaces de l'utilisateur (conversations,
 * mémoire, agents, training, exports, prompt-templates, runs…) : sa borne
 * est plus large qu'une purge de namespace isolé.
 */
const R2_ROOT_PURGE_MAX_PASSES = 100;

const FIREBASE_IDENTITY_API = "https://identitytoolkit.googleapis.com/v1/accounts:delete";
const FIREBASE_API_KEY = process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "";

/**
 * Fallback RGPD : suppression via l'API identitytoolkit client avec le jeton
 * ID de l'utilisateur lui-meme. Utilisée quand l'Admin SDK échoue (ex. état
 * "soft-deleted" remonté par le projet côté Google alors que l'auth client
 * reste opérationnelle). L'utilisateur ne peut supprimer que son propre
 * compte : le jeton est celui qu'il vient de présenter.
 */
async function deleteAuthAccountViaIdentityToolkit(idToken: string): Promise<boolean> {
  if (!FIREBASE_API_KEY || !idToken) return false;
  try {
    const response = await fetch(`${FIREBASE_IDENTITY_API}?key=${FIREBASE_API_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function deleteWhere(
  collection: string,
  field: string,
  userId: string,
): Promise<number> {
  let deleted = 0;
  // Boucle jusqu'a epuisement : les collections volumineuses peuvent
  // depasser un seul lot.
  for (;;) {
    const snap = await adminDb
      .collection(collection)
      .where(field, "==", userId)
      .limit(BATCH_LIMIT)
      .get();
    if (snap.empty) break;
    const batch = adminDb.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < BATCH_LIMIT) break;
  }
  return deleted;
}

/**
 * Purge COMPLETE d'un préfixe R2 utilisateur : removePrefix est borné
 * (taille de page) — on boucle jusqu'à ce qu'une passe ne ramène plus rien
 * (parité avec l'ancienne purge par lots itérés). Une panne R2 se propage :
 * la suppression du compte est interrompue, l'utilisateur peut réessayer
 * (purges idempotentes) — aucune donnée ne doit survivre à un compte effacé.
 */
async function purgerPrefixeUtilisateur(prefix: string): Promise<number> {
  let supprimes = 0;
  for (let passe = 0; passe < R2_PURGE_MAX_PASSES; passe += 1) {
    const supprimesDeLaPasse = await removePrefix(prefix, { maxObjects: R2_PURGE_PAGE });
    supprimes += supprimesDeLaPasse;
    if (supprimesDeLaPasse === 0) break;
  }
  return supprimes;
}

/**
 * Purge du préfixe RACINE `users/{uid}/` — même boucle, borne de passes
 * relevée (la racine agrège tous les namespaces de l'utilisateur).
 */
async function purgerPrefixeRacineUtilisateur(prefix: string): Promise<number> {
  let supprimes = 0;
  for (let passe = 0; passe < R2_ROOT_PURGE_MAX_PASSES; passe += 1) {
    const supprimesDeLaPasse = await removePrefix(prefix, { maxObjects: R2_PURGE_PAGE });
    supprimes += supprimesDeLaPasse;
    if (supprimesDeLaPasse === 0) break;
  }
  return supprimes;
}

/**
 * DELETE /api/auth/account — droit a l'effacement (RGPD art. 17) — ÉTANCHE.
 *
 * Supprime l'ensemble des donnees personnelles rattachees a l'utilisateur :
 * identité (base R2, Task 108-b), profil, portefeuille, equipes, agents,
 * executions, documents, retours IA (aiFeedback + leçons), artefacts de
 * conversation, consentements outils, memoire conversationnelle R2 (Task 109 :
 * users/{uid}/conversations + memoire KV users/{uid}/memories et
 * memory-items), puis le compte Firebase Auth lui-meme.
 *
 * Filet d'étanchéité R2 (Job 478451 it.27) : après les purges nommées à
 * vocation de MÉTRIQUES, le préfixe RACINE `users/{uid}/` est purgé en
 * entier — aucun objet personnel ne peut survivre à l'effacement, y
 * compris dans les namespaces créés après cette migration (agents,
 * exports RGPD, training*, prompt-templates, runs, privacy/consent…).
 * Toute future section utilisateur stockée sous `users/{uid}/` est
 * automatiquement couverte, sans modification de ce fichier.
 *
 * Les evenements d'audit (interet legitime securite) sont conserves mais
 * anonymises par la suppression du profil.
 */
export async function DELETE(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const uid = user.uid;

    // 1. Donnees applicatives rattlees a l'utilisateur.
    const agents = await deleteWhere("agents", "ownerId", uid);
    const executions = await deleteWhere("executions", "userId", uid);
    const documents = await deleteWhere("documents", "ownerId", uid);
    // 1-ter. Données personnelles Firestore longtemps oubliées (it.27) :
    // retours IA, leçons apprises, artefacts de conversation, consentements
    // outils — toutes rattachées à l'utilisateur par le champ `userId`.
    const aiFeedback = await deleteWhere("aiFeedback", "userId", uid);
    const aiFeedbackLessons = await deleteWhere("aiFeedbackLessons", "userId", uid);
    const artifacts = await deleteWhere("conversationArtifacts", "userId", uid);
    const toolConsents = await deleteWhere("toolConsents", "userId", uid);

    // 1-bis. Mémoire R2 PAR UTILISATEUR (Task 109) : conversations + messages
    // (un objet par message sous conversations/{cid}/messages/) et mémoire
    // KV / items épisodiques. Les anciennes collections Firestore
    // chatConversations/chatMessages ne sont plus lues ni écrites : rien à
    // y supprimer (abandon des données legacy, directive « à partir de zéro »).
    const conversations = await purgerPrefixeUtilisateur(`${userDir(uid, "conversations")}/`);
    const memories = await purgerPrefixeUtilisateur(`${userDir(uid, "memories")}/`);
    const memoryItems = await purgerPrefixeUtilisateur(`${userDir(uid, "memory-items")}/`);
    // Les messages vivent DANS le préfixe conversations (plus de collection
    // séparée) : compteur conservé à 0 pour la forme de réponse historique.
    const messages = 0;

    // 2-bis. FILET D'ÉTANCHÉITÉ R2 (it.27) : purge du préfixe RACINE de
    // l'utilisateur. Les purges nommées ci-dessus produisent les métriques
    // d'audit ; celle-ci GARANTIT qu'aucun objet personnel ne survit —
    // quel que soit le namespace (agents, exports, training*, runs,
    // prompt-templates, privacy/consent, namespaces futurs…). Idempotente :
    // une panne R2 interrompt la suppression, l'utilisateur peut réessayer.
    const racine = await purgerPrefixeRacineUtilisateur(`${userDir(uid)}/`);

    const research = await deleteWhere("researchJobs", "userId", uid);

    // 2. Documents singleton (profil, portefeuille, equipes).
    await adminDb.recursiveDelete(adminDb.collection("userTeams").doc(uid));
    await adminDb.recursiveDelete(adminDb.collection("userWallets").doc(uid));
    await adminDb.recursiveDelete(adminDb.collection("users").doc(uid));

    // 3. Identité dans la base R2 (Task 108-b). Une panne R2 ne doit JAMAIS
    // empêcher la suppression Auth/Firestore : l'utilisateur prime sur
    // l'infrastructure — on journalise et on continue.
    let identityDeleted = false;
    try {
      await deleteIdentityForAccount(uid);
      identityDeleted = true;
    } catch (error) {
      logger.warn({ err: error, uid }, "auth.account.identity_delete_failed_continued");
    }

    // 4. Compte d'authentification Firebase. Admin SDK d'abord ; en cas
    // d'échec côté projet (ex. PROJECT_SOFT_DELETED), repli sur l'API
    // identitytoolkit avec le jeton ID présenté par l'utilisateur.
    const idToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    try {
      await getAuth(getApp()).deleteUser(uid);
    } catch (adminError) {
      const deleted = await deleteAuthAccountViaIdentityToolkit(idToken);
      if (!deleted) {
        throw adminError instanceof Error ? adminError : new Error("Suppression du compte d'authentification impossible.");
      }
    }

    // 5. Trace d'audit de l'effacement (sans donnee personnelle).
    await appendSecurityAuditEvent({
      userId: uid,
      executionId: `account_deletion_${Date.now()}`,
      toolName: "gdpr.account_deleted",
      event: "completed",
      input: { agents, executions, documents, aiFeedback, aiFeedbackLessons, artifacts, toolConsents, conversations, messages, memories, memoryItems, r2RacinePurge: racine, researchJobs: research, identityDeleted },
    }).catch(() => undefined);

    return new NextResponse(
      JSON.stringify({ success: true, deleted: { agents, executions, documents, aiFeedback, aiFeedbackLessons, artifacts, toolConsents, conversations, messages, research, r2RacinePurge: racine, identityDeleted } }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Set-Cookie": clearSessionCookieHeader(),
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Suppression du compte impossible." },
      { status: errorStatus(error, 400) },
    );
  }
}

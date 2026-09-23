import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { getApp } from "firebase-admin/app";

import { requireUser } from "@/lib/security/authenticated-request";
import { adminDb } from "@/lib/firebase/admin";
import { clearSessionCookieHeader } from "@/lib/server/session-cookie";
import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { errorStatus } from "@/lib/security/http-errors";

export const runtime = "nodejs";

/** Taille maximale des lots de suppression Firestore (limite plateforme). */
const BATCH_LIMIT = 400;

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
 * DELETE /api/auth/account — droit a l'effacement (RGPD art. 17).
 *
 * Supprime l'ensemble des donnees personnelles rattachees a l'utilisateur :
 * profil, portefeuille, equipes, agents, executions, documents,
 * conversations de chat, puis le compte Firebase Auth lui-meme.
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
    const conversations = await deleteWhere("chatConversations", "userId", uid);
    const messages = await deleteWhere("chatMessages", "userId", uid);
    const research = await deleteWhere("researchJobs", "userId", uid);

    // 2. Documents singleton (profil, portefeuille, equipes).
    await adminDb.recursiveDelete(adminDb.collection("userTeams").doc(uid));
    await adminDb.recursiveDelete(adminDb.collection("userWallets").doc(uid));
    await adminDb.recursiveDelete(adminDb.collection("users").doc(uid));

    // 3. Compte d'authentification Firebase. Admin SDK d'abord ; en cas
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

    // 4. Trace d'audit de l'effacement (sans donnee personnelle).
    await appendSecurityAuditEvent({
      userId: uid,
      executionId: `account_deletion_${Date.now()}`,
      toolName: "gdpr.account_deleted",
      event: "completed",
      input: { agents, executions, documents, conversations, messages, researchJobs: research },
    }).catch(() => undefined);

    return new NextResponse(
      JSON.stringify({ success: true, deleted: { agents, executions, documents, conversations, messages, research } }),
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

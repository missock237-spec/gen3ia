/**
 * Backfill : indexe dans Qdrant les messages de conversation existants
 * (écrits AVANT l'activation de l'index vectoriel), pour que la recherche
 * sémantique couvre tout l'historique et pas seulement les nouveaux tours.
 *
 * Idempotent : les points Qdrant portent un UUID v5 dérivé du messageId —
 * rejouer le script met à jour les points au lieu de créer des doublons.
 *
 * Usage :
 *   # 1. Récupérer les variables d'environnement Vercel (Firebase admin,
 *   #     QDRANT_URL, QDRANT_API_KEY, HF_TOKEN, HF_EMBEDDING_MODEL) :
 *   vercel env pull .env.production.local --environment=production
 *   # 2. Lancer (dry-run d'abord pour estimer le volume) :
 *   npx tsx --env-file=.env.production.local scripts/backfill_conversation_index.ts --dry-run
 *   npx tsx --env-file=.env.production.local scripts/backfill_conversation_index.ts
 *
 * Progression : lecture de `chatMessages` par lots de 200 documents
 * (orderBy conversationId), affichage du compteur toutes les 50 messages.
 * Un message déjà indexé ne coûte qu'un upsert (~quelques ms) : le rejeu
 * complet reste rapide et sûr.
 */

import { adminDb } from "../lib/firebase/admin";
import { indexConversationMessage } from "../lib/chat/vector-index";

interface Options {
  dryRun: boolean;
}

function parseArgs(): Options {
  return { dryRun: process.argv.includes("--dry-run") };
}

async function main() {
  const { dryRun } = parseArgs();

  console.log(`Backfill index sémantique des conversations — mode : ${dryRun ? "DRY-RUN (aucun écrit)" : "ÉCRITURE RÉELLE"}`);

  const messages = adminDb.collection("chatMessages");
  const snapshot = await messages.get();

  const docs = snapshot.docs;
  console.log(`Messages Firestore trouvés : ${docs.length}`);

  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const data = doc.data();

    const content = typeof data?.content === "string" ? data.content : "";
    const userId = typeof data?.userId === "string" ? data.userId : "";
    const conversationId = typeof data?.conversationId === "string" ? data.conversationId : "";

    if (!content.trim() || !userId || !conversationId) {
      skipped += 1;
      continue;
    }

    if (dryRun) {
      indexed += 1;
    } else {
      const createdAt =
        typeof data?.createdAt?.toDate === "function"
          ? data.createdAt.toDate().toISOString()
          : typeof data?.createdAt === "string"
            ? data.createdAt
            : undefined;

      const role = typeof data?.role === "string" ? data.role : "user";

      const ok = await indexConversationMessage({
        messageId: doc.id,
        conversationId,
        userId,
        role,
        content,
        createdAt,
        projectId: typeof data?.projectId === "string" ? data.projectId : null,
      });
      if (ok) indexed += 1;
      else failed += 1;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  progression : ${i + 1}/${docs.length} (indexés ${indexed}, ignorés ${skipped}, échecs ${failed})`);
    }
  }

  console.log(`Terminé. indexés=${indexed} ignorés=${skipped} échecs=${failed}${dryRun ? " (dry-run : rien n'a été écrit)" : ""}`);
  if (failed > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error("FATAL:", error);
  process.exit(1);
});

/**
 * QA réel bout-en-bout : embedding HuggingFace + upsert Qdrant + recherche
 * sémantique par le SENS (les mots de la requête n'existent pas dans le
 * message indexé). Usage : npx tsx --env-file=.env.runtime.local scripts/qa_semantic_search.ts
 */
import { indexConversationMessage, searchConversationMessages } from "../lib/chat/vector-index";

async function main() {
  const messageId = "test-qa-" + Date.now();

  const ok = await indexConversationMessage({
    messageId,
    conversationId: "conv-qa-test",
    userId: "qa-vector-test",
    role: "user",
    content: "Je veux lancer une campagne publicitaire sur Facebook pour vendre des chaussures à Douala.",
    createdAt: new Date().toISOString(),
  });
  console.log("indexation:", ok);

  const hits = await searchConversationMessages(
    "qa-vector-test",
    "comment promouvoir mes produits sur les réseaux sociaux ?",
    { limit: 3 },
  );
  console.log("recherche sémantique:", hits === null ? "NULL (indispo)" : `${hits.length} hit(s)`);
  if (hits && hits.length) {
    console.log("1er hit — score:", hits[0].score, "| extrait:", hits[0].preview.slice(0, 60));
  }
}

main().catch((error) => {
  console.error("FATAL:", error);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * CYCLE 2/10 — Test production : chat Gen réel + streaming.
 *  - réponses réelles (qualité, langue, latence) ;
 *  - continuité de conversation (mémoire du tour précédent) ;
 *  - validation des entrées (vide, trop long, connecteur invalide) ;
 *  - route streaming déployée et protégée ;
 *  - quotas visiteur (429 + retry-after).
 */
const BASE = "https://gen3ia.online";
let passed = 0, failed = 0;
const results = [];
function check(name, ok, detail = "") {
  if (ok) { passed++; results.push(`OK ${name}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; results.push(`KO ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function chat(message, conversationId) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/gen/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(conversationId ? { message, conversationId } : { message }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, headers: r.headers, latencyMs: Date.now() - t0 };
}

// 1) Réponses réelles.
const t1 = await chat("Bonjour ! Peux-tu te présenter en une phrase ?");
check("chat répond 200", t1.status === 200, String(t1.status));
check("réponse non vide", typeof t1.body.reply === "string" && t1.body.reply.length > 10, `${(t1.body.reply ?? "").length} car., ${t1.latencyMs}ms`);
check("latence raisonnable (<30s)", t1.latencyMs < 30_000, `${t1.latencyMs}ms`);
check("conversationId retourné", typeof t1.body.conversationId === "string" && t1.body.conversationId.length >= 8, t1.body.conversationId ?? "absent");
const replyFr = (t1.body.reply ?? "").toLowerCase();
check("réponse en français", /bonjour|salut|assistant|aide|voici|je suis/.test(replyFr), replyFr.slice(0, 60));

// 2) Continuité de conversation : le tour 2 renvoie l'historique client
//    (comme le fait l'UI pour les visiteurs anonymes) et doit retrouver
//    l'information donnée au tour 1 (rappel pur, non ambigu).
const convId = t1.body.conversationId;
const t2 = await fetch(`${BASE}/api/gen/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: "Quel est mon animal préféré ? Réponds uniquement par le nom de l'animal.",
    conversationId: convId,
    history: [
      { role: "user", content: "Je te donne une information importante : mon animal préféré est le panda rouge." },
      { role: "assistant", content: "C'est noté ! Le panda rouge, excellent choix." },
    ],
  }),
});
const t2Body = await t2.json().catch(() => ({}));
check("tour 2 répond 200", t2.status === 200, String(t2.status));
const memoire = /panda\s+rouge/i.test(t2Body.reply ?? "");
check("mémoire conversationnelle (retrouve « panda rouge »)", memoire, (t2Body.reply ?? "").slice(0, 80));

// 3) Validation des entrées.
const empty = await chat("");
check("message vide → 400", empty.status === 400, String(empty.status));
const tooLong = await chat("x".repeat(2001));
check("message >2000 car → 400", tooLong.status === 400, String(tooLong.status));
const badConnector = await chat("test", undefined);
// connecteur invalide ne peut pas être envoyé via ce client sans conversationId — test direct
const badConn = await fetch(`${BASE}/api/gen/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "salut", selectedConnectors: ["INVALIDE!!"] }),
});
check("connecteur invalide → 400", badConn.status === 400, String(badConn.status));
const badJson = await fetch(`${BASE}/api/gen/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{corrompu",
});
check("JSON corrompu → 400", badJson.status === 400, String(badJson.status));

// 4) Route streaming : déployée + protégée (401 sans session).
const stream = await fetch(`${BASE}/api/workspace/conversations/conv-test-1234/messages/stream`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: "test" }),
});
check("streaming déployé + protégé (401)", stream.status === 401, String(stream.status));

// 5) Un dernier message OK (quota pas encore épuisé après 4 tests + 2 validations).
const t3 = await chat("Merci ! Réponds juste : ok.");
check("chat toujours opérationnel", t3.status === 200 || t3.status === 429, String(t3.status));
if (t3.status === 429) {
  check("429 porte retry-after", !!t3.headers.get("retry-after"), t3.headers.get("retry-after") ?? "absent");
}

for (const line of results) console.log(line);
console.log(`\nCYCLE 2 : ${passed} VERTS / ${failed} ROUGES`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env node
/**
 * E2E production Gen3ia — vague Redis/Qdrant + commercial + Gen + infra.
 *
 * 1. Crée un compte réel Firebase (identitytoolkit signUp, projet gen3ia).
 * 2. Échange l'ID token contre un cookie de session (/api/auth/session).
 * 3. GET  /api/health/infra                      : Redis PING + Qdrant + sandbox.
 * 4. POST /api/agents                            : crée un agent (support commercial).
 * 5. POST /api/commercial                        : fiche entreprise → lien client.
 * 6. GET  /api/public/commercial/<slug>          : salon public lisible.
 * 7. POST /api/public/commercial/<slug>          : le client reçoit une vraie réponse.
 * 8. POST /api/gen/chat (authentifié)            : Gen répond.
 * 9. POST /api/gen/chat (anonyme)                : Gen répond en mode visiteur.
 * 10. GET  /api/integrations/catalog?limit=5     : catalogue (cache Redis) + logos.
 */

const BASE = process.env.BASE_URL || "https://gen3ia.online";
const API_KEY = "AIzaSyCWeyTdWPj0HjIfo0EyLPldAeRrSIyBJbQ";
const EMAIL = `e2e-wave14-${Date.now()}@gen3ia.test`;
const PASSWORD = "Gen3iaE2E!2026";

let failures = 0;
function check(step, ok, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} [${step}] ${ok ? "" : "— ÉCHEC"}${extra ? " " + extra : ""}`);
  if (!ok) failures += 1;
}

function log(step, ...parts) {
  console.log(`[${step}]`, ...parts);
}

/** Lit un corps JSON en signalant clairement une réponse HTML (challenge, 404…). */
async function readJson(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: réponse non-JSON (HTTP ${response.status}) : ${text.slice(0, 120).replace(/\s+/g, " ")}`);
  }
}

async function signUp() {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  const data = await readJson(response, "signUp");
  if (!response.ok) throw new Error(`signUp: ${JSON.stringify(data).slice(0, 200)}`);
  log("1/auth", `compte créé ${EMAIL}`);
  return data;
}

async function createSession(idToken) {
  const response = await fetch(`${BASE}/api/auth/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${idToken}` },
  });
  const data = await readJson(response, "session");
  if (!response.ok || !data.authenticated) throw new Error(`session: HTTP ${response.status}`);
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("session: aucun cookie posé");
  log("2/session", `authentifié · wallet ${data.wallet ? Math.round(data.wallet.balanceMinor / 100) + " " + data.wallet.currency : "dégradé"}`);
  return cookie;
}

async function main() {
  const auth = await signUp();
  const cookie = await createSession(auth.idToken);
  const headers = { "content-type": "application/json", cookie };

  // 3. Infra
  const infra = await fetch(`${BASE}/api/health/infra`, { headers: { cookie } });
  const infraData = await readJson(infra, "infra");
  check("3/infra", infra.ok && infraData.layers?.redis?.configured === true && infraData.layers?.redis?.ping === true,
    `redis.ping=${infraData.layers?.redis?.ping} qdrant=${infraData.layers?.qdrant?.configured} sandbox=${infraData.layers?.sandbox?.mode}`);

  // 4. Agent
  const agentResponse = await fetch(`${BASE}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Commercial E2E", description: "Agent commercial de test E2E.", type: "universal", systemPrompt: "Tu es un assistant commercial poli et efficace." }),
  });
  const agentData = await readJson(agentResponse, "agent");
  const agentId = agentData.agent?.id ?? agentData.agents?.[0]?.id ?? null;
  check("4/agent", agentResponse.ok && Boolean(agentId), agentResponse.ok ? `agentId=${agentId?.slice(0, 8)}…` : JSON.stringify(agentData).slice(0, 150));

  // 5. Commercial config
  let slug = null;
  const commercialResponse = await fetch(`${BASE}/api/commercial`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agentId,
      companyName: "Boutique E2E",
      sector: "E-commerce",
      products: ["T-shirt premium :: coton bio :: 15€"],
      pricing: ["T-shirt premium : 15€"],
      faq: [{ question: "Livrez-vous ?", answer: "Oui, sous 48h partout au Cameroun." }],
      language: "fr-FR",
      welcomeMessage: "Bonjour ! Boutique E2E à votre service.",
    }),
  });
  const commercialData = await readJson(commercialResponse, "commercial");
  slug = commercialData.config?.clientSlug ?? null;
  check("5/commercial", commercialResponse.ok && Boolean(slug), commercialResponse.ok ? `slug=${slug}` : JSON.stringify(commercialData).slice(0, 180));

  // 6. Salon public GET
  const publicGet = await fetch(`${BASE}/api/public/commercial/${slug}`, { cache: "no-store" });
  const publicData = await readJson(publicGet, "salon-get");
  check("6/salon-get", publicGet.ok && publicData.companyName === "Boutique E2E", `companyName=${publicData.companyName}`);

  // 7. Salon public POST (le client discute)
  const clientPost = await fetch(`${BASE}/api/public/commercial/${slug}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Bonjour, combien coûte le T-shirt premium et livrez-vous à Douala ?", clientName: "Client Test", clientContact: "+237600000000" }),
  });
  const clientData = await readJson(clientPost, "salon-post");
  const clientOk = clientPost.ok && typeof clientData.text === "string" && clientData.text.length > 10 && clientData.text.includes("15");
  check("7/salon-post", clientOk, clientOk ? `réponse: « ${clientData.text.slice(0, 80)}… »` : JSON.stringify(clientData).slice(0, 200));

  // 8. Gen chat authentifié
  const genAuth = await fetch(`${BASE}/api/gen/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "Bonjour Gen, qu'est-ce que Gen3ia peut faire pour mon entreprise ?" }),
  });
  const genAuthData = await readJson(genAuth, "gen-auth");
  check("8/gen-auth", genAuth.ok && typeof genAuthData.reply === "string" && genAuthData.reply.length > 10,
    genAuth.ok ? `« ${genAuthData.reply.slice(0, 70)}… »` : JSON.stringify(genAuthData).slice(0, 160));

  // 9. Gen chat anonyme (IP du sandbox ; un 429 serait aussi un comportement correct)
  const genAnon = await fetch(`${BASE}/api/gen/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Quels connecteurs sont disponibles sur Gen3ia ?" }),
  });
  const genAnonData = await readJson(genAnon, "gen-anon");
  check("9/gen-anon", (genAnon.ok && typeof genAnonData.reply === "string") || genAnon.status === 429,
    genAnon.ok ? `« ${genAnonData.reply.slice(0, 60)}… »` : `status=${genAnon.status}`);

  // 10. Catalogue (cache Redis) — les logos Composio doivent circuler
  const catalog = await fetch(`${BASE}/api/integrations/catalog?limit=8`, { headers: { cookie } });
  const catalogData = await readJson(catalog, "catalog");
  const logos = (catalogData.items ?? []).filter((item) => typeof item.logo === "string" && item.logo.startsWith("https://")).length;
  check("10/catalog", catalog.ok && (catalogData.items?.length ?? 0) > 0 && catalogData.source === "composio",
    `items=${catalogData.items?.length} logos=${logos} source=${catalogData.source}`);

  console.log(failures === 0 ? "\nE2E VAGUE 14 : TOUT EST VERT" : `\nE2E VAGUE 14 : ${failures} ÉCHEC(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("E2E fatal:", error.message);
  process.exit(1);
});

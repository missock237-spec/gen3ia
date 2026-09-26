#!/usr/bin/env node
/**
 * Test RÉEL du service email Resend — token fourni par l'utilisateur.
 * 1. Validation du token (liste des domaines vérifiés).
 * 2. Envoi réel d'un email depuis noreply@gen3ia.online (domaine vérifié,
 *    eu-west-1) vers delivered@resend.dev (adresse de test Resend qui
 *    simule une remise réussie) — version texte + HTML.
 * 3. Interrogation du statut de l'email envoyé (GET /emails/{id}) :
 *    last_event doit atteindre « delivered ».
 *
 * Usage : RESEND_API_KEY=bre_... node scripts/test_resend_email.mjs
 */

const API_KEY = process.env.RESEND_API_KEY || "bre_MqAHtznS_6UMmnK1MR5zfsv4ntVyqsCht";
const FROM = process.env.EMAIL_FROM_ADDRESS || "Gen3ia <noreply@gen3ia.online>";
const TO = process.env.TEST_TO || "delivered@resend.dev";

let failures = 0;
function check(step, ok, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} [${step}]${extra ? " " + extra : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  console.log("=== TEST SERVICE EMAIL RESEND — gen3ia.online ===");

  // 1. Domaines vérifiés du compte
  const domainsRes = await fetch("https://api.resend.com/domains", {
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  const domainsData = await domainsRes.json().catch(() => ({}));
  const gen3ia = (domainsData.data ?? []).find((d) => d.name === "gen3ia.online");
  check(
    "1/token-et-domaine",
    domainsRes.ok && gen3ia?.status === "verified" && gen3ia?.capabilities?.sending === "enabled",
    gen3ia ? `gen3ia.online status=${gen3ia.status} sending=${gen3ia.capabilities?.sending} région=${gen3ia.region}` : JSON.stringify(domainsData).slice(0, 200),
  );

  // 2. Envoi réel (texte + HTML)
  const subject = `[Gen3ia] Test du service email — ${new Date().toISOString()}`;
  const text = "Ceci est un test réel du service email Gen3ia envoyé via Resend depuis noreply@gen3ia.online.";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#7C5CFF">Test du service email Gen3ia</h2>
      <p>Cet email prouve que l'envoi réel fonctionne : token Resend configuré, domaine vérifié, remise effective.</p>
      <p style="color:#666;font-size:12px">Envoyé automatiquement par le script de vérification e2e — ${subject}.</p>
    </div>`;
  const sendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [TO], subject, text, html }),
  });
  const sendData = await sendRes.json().catch(() => ({}));
  const emailId = sendData.id;
  check("2/envoi-reel", sendRes.ok && Boolean(emailId),
    sendRes.ok ? `id=${emailId} · de=${FROM} · vers=${TO}` : `HTTP ${sendRes.status} · ${JSON.stringify(sendData).slice(0, 240)}`);

  // 3. Statut de remise (last_event → delivered)
  if (emailId) {
    let lastEvent = "";
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      const statusRes = await fetch(`https://api.resend.com/emails/${emailId}`, {
        headers: { authorization: `Bearer ${API_KEY}` },
      });
      const statusData = await statusRes.json().catch(() => ({}));
      lastEvent = statusData.last_event ?? "";
      if (["delivered", "bounced", "complained"].includes(lastEvent)) break;
    }
    check("3/remise", lastEvent === "delivered", `last_event=${lastEvent || "(indisponible)"}`);
  }

  console.log(failures === 0 ? "\n✅ SERVICE EMAIL OPÉRATIONNEL" : `\n❌ ${failures} contrôle(s) en échec`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });

import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { assertSafeDestinationUrl, resolveJobOrigin } from "./origin";

/**
 * Client QStash (Upstash) — file d'attente HTTP des missions longues
 * (recommandation A de l'audit de production).
 *
 * POURQUOI QSTASH : sur Vercel serverless, une fonction est coupée par la
 * plateforme (fenêtre de 60 s en plan Hobby). Une mission agent multi-étapes
 * exécutée DANS la requête HTTP mourait avec elle. QStash est une file
 * d'attente HTTP : elle publie un POST signé vers /api/queue/mission-tick,
 * qui exécute une TRANCHE bornée du plan (deadline → pause propre, checkpoint
 * conservé) puis se ré-enfile jusqu'à complétion. BullMQ est écarté : il
 * exige un worker process permanent, incompatible avec le serverless.
 *
 * SÉCURITÉ DU RECEIVER : QStash signe chaque délivrance
 * `Upstash-Signature: v1,<hmac>` avec hmac = HMAC-SHA256(clé, `clé\n corps`).
 * Pendant une rotation de clés, DEUX signatures peuvent coexister — la
 * vérification accepte la clé courante OU la suivante, en comparaison à
 * temps constant. Sans clés de signature configurées, la file n'est PAS
 * activée (un receiver non vérifiable serait une porte ouverte).
 *
 * SÉMANTIQUE D'EXÉCUTION : at-least-once. Une redélivrance QStash (ou une
 * reprise après kill plateforme) peut ré-exécuter une étape dont le travail
 * a démarré juste avant la coupure — même compromis que la reprise manuelle
 * existante (« Continuer la mission », Task 46) ; le bail d'exécution
 * (lease) rend les doubles délivrances concurrentes impossibles.
 *
 * SÉCURITÉ DE LA DESTINATION (fix CodeQL js/request-forgery) : l'URL des
 * receivers est construite depuis l'ORIGINE CANONIQUE du serveur
 * (GEN3IA_APP_ORIGIN, validée contre une allowlist d'hôtes — voir
 * lib/queue/origin.ts), JAMAIS depuis l'origine de la requête entrante
 * (falsifiable par l'appelant : un enfilement induit pourrait sinon
 * rediriger un POST signé vers un serveur tiers). Les fonctions
 * publishMissionTick/publishDispatchTick ne prennent PLUS d'origine en
 * paramètre : elles résolvent l'origine en interne et refusent de publier
 * (retour null, contrat « non configuré ») si elle est absente/invalide —
 * la continuation par sondage existante prend le relais. En dernière ligne
 * de défense, publishToDestination valide TOUTE destination contre
 * assertSafeDestinationUrl (https + hôte allowlisté) avant tout fetch.
 */

const QSTASH_BASE_URL = "https://qstash.upstash.io";

/** Durée maximale d'un appel HTTP QStash (publish) — jamais bloquant au-delà. */
const PUBLISH_TIMEOUT_MS = 10_000;

/** Repli du nombre de tentatives QStash pour une délivrance de tick. */
const TICK_RETRIES = 3;

/**
 * Publie un corps vers une URL destination ABSOLUE via QStash.
 *
 * PATH BRUT OU ENCODÉ (Task 62) : la build QStash de ce compte (instance
 * régionale + global vérifiés en sondes réelles) rejette les chemins
 * URL-encodés (« invalid destination url… invalid scheme ») et exige la
 * destination BRUTE dans le path — `:` et `/` sont licites dans un segment
 * de chemin (RFC 3986). L'ancien code encodait (encodeURIComponent) : chaque
 * publish de production échouait 400 et les missions « auto » repliaient
 * silencieusement en sync — la file n'a jamais délivré. Le path brut est
 * désormais la forme primaire ; en cas de 400 « invalid destination »,
 * un second essai ENCODÉ couvre les builds QStash historiques qui exigent
 * l'inverse (compatibilité sans env var).
 */
/**
 * Résultat discriminé d'une publication QStash : l'appelant distingue
 * « file non configurée » (continuation par sondage possible) d'un échec
 * réel (à journaliser — jamais de fantôme « queued » silencieux).
 */
export type QStashPublishResult =
  | { ok: true; mode: "qstash"; messageId: string }
  | { ok: false; mode: "unconfigured" }
  | { ok: false; mode: "error"; message: string };

export async function publishToDestination(
  config: QStashConfig,
  destinationUrl: string,
  body: string,
  options: { delaySeconds?: number; retries?: number } = {},
): Promise<{ messageId: string }> {
  // Défense en profondeur : aucune publication vers une destination dont
  // le schéma/l'hôte ne passe pas l'allowlist serveur (anti request-forgery).
  assertSafeDestinationUrl(destinationUrl);
  const headers = {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
    "Upstash-Retries": String(options.retries ?? TICK_RETRIES),
    ...(options.delaySeconds && options.delaySeconds > 0
      ? { "Upstash-Delay": `${Math.round(options.delaySeconds)}s` }
      : {}),
  };

  const attempt = async (path: string): Promise<Response> =>
    fetch(`${QSTASH_BASE_URL}${path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });

  // 1) Path BRUT (forme exigée par la build QStash de ce compte).
  let response = await attempt(`/v2/publish/${destinationUrl}`);
  if (response.status === 400) {
    // 2) Compatibilité : build historique exigeant la destination encodée.
    response = await attempt(`/v2/publish/${encodeURIComponent(destinationUrl)}`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`QStash publish ${response.status}: ${detail.slice(0, 300)}`);
  }
  const payload = (await response.json().catch(() => null)) as { messageId?: string } | null;
  return { messageId: payload?.messageId ?? "unknown" };
}

export interface QStashConfig {
  token: string;
  currentSigningKey: string;
  nextSigningKey: string;
}

/**
 * Configuration lue À L'APPEL (jamais au chargement du module) : une variable
 * ajoutée dans Vercel devient active sans redéploiement du code — même
 * politique que le routage qualité (Task 52).
 */
export function qstashConfig(): QStashConfig | null {
  const token = process.env.QSTASH_TOKEN?.trim();
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  if (!token || !currentSigningKey || !nextSigningKey) return null;
  return { token, currentSigningKey, nextSigningKey };
}

/** La file d'attente des missions est-elle activable dans cet environnement ? */
export function missionQueueConfigured(): boolean {
  return qstashConfig() !== null;
}

/**
 * Publication partagée « haute niveau » pour les files de l'application
 * (missions, rendu vidéo, production vidéo) : applique le pattern PATH BRUT
 * → repli encodé, distingue file non configurée / échec réel, ne lève
 * JAMAIS (le résultat discriminé est inspectable par l'appelant — un échec
 * silencieux laisserait un job fantôme « queued » pour toujours, un échec
 * levé casserait une entrée déjà validée ; ici l'appelant décide).
 */
export async function publishJsonDestination(
  destinationUrl: string,
  body: string,
  options: { delaySeconds?: number } = {},
): Promise<QStashPublishResult> {
  const config = qstashConfig();
  if (!config) return { ok: false, mode: "unconfigured" } as const;
  try {
    const { messageId } = await publishToDestination(config, destinationUrl, body, options);
    return { ok: true, mode: "qstash", messageId } as const;
  } catch (error) {
    return { ok: false, mode: "error", message: error instanceof Error ? error.message : String(error) } as const;
  }
}

/**
 * URL absolue du receiver — fonction PURE : appelée UNIQUEMENT avec
 * l'origine canonique résolue côté serveur (jamais une origine requête).
 */
export function missionTickUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/queue/mission-tick`;
}

/** URL absolue du receiver de la boucle de dispatch planifié (Task 62). */
export function dispatchTickUrl(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/queue/dispatch-tick`;
}

/**
 * Publie un tick de mission. `delaySeconds` diffère la délivrance (utilisé
 * pour le ré-enfilement : laisse le temps au checkpoint d'être visible).
 * Retourne l'identifiant QStash du message, ou null si la file n'est pas
 * configurée OU si l'origine canonique n'est pas résolue (même contrat :
 * la continuation par sondage existante prend le relais — JAMAIS de repli
 * sur l'origine de la requête, falsifiable). Une erreur réseau/HTTP est
 * PROPAGÉE : l'appelant (route d'entrée) doit savoir que la mission n'a
 * pas été enfilée — un échec silencieux laisserait une mission fantôme
 * « queued » pour toujours.
 */
export async function publishMissionTick(
  runId: string,
  options: { delaySeconds?: number } = {},
): Promise<{ messageId: string } | null> {
  const resolved = resolveJobOrigin();
  if (!resolved.ok) {
    // Origine canonique absente/invalide : refus de publier (aucune
    // destination falsifiable) — visible en console, sondage en relais.
    console.warn(
      `[queue/qstash] Tick de mission ${runId} non publié : origine canonique non résolue (${resolved.reason}).`,
    );
    return null;
  }
  const config = qstashConfig();
  if (!config) return null;
  return publishToDestination(config, missionTickUrl(resolved.origin), JSON.stringify({ runId }), {
    delaySeconds: options.delaySeconds,
  });
}

/**
 * Publie le tick SUIVANT de la boucle de dispatch planifié (Task 62).
 * `delaySeconds` = secondes jusqu'au début du slot suivant — la délivrance
 * tombe au bon moment, sans registre de planification côté QStash.
 * Origine canonique résolue EN INTERNE (aucun paramètre origin falsifiable) :
 * non résolue → null (la réservation du slot est libérée par l'appelant et
 * le cron quotidien — sentinelle — relancera la boucle). Même sémantique
 * d'erreur que publishMissionTick (échec réseau/HTTP PROPAGÉ).
 */
export async function publishDispatchTick(
  options: { delaySeconds: number; slotEpoch: number },
): Promise<{ messageId: string } | null> {
  const resolved = resolveJobOrigin();
  if (!resolved.ok) {
    console.warn(
      `[queue/qstash] Tick de dispatch (slot ${options.slotEpoch}) non publié : origine canonique non résolue (${resolved.reason}).`,
    );
    return null;
  }
  const config = qstashConfig();
  if (!config) return null;
  return publishToDestination(config, dispatchTickUrl(resolved.origin), JSON.stringify({ slotEpoch: options.slotEpoch }), {
    delaySeconds: Math.max(0, Math.min(options.delaySeconds, 86_400)),
    retries: TICK_RETRIES,
  });
}

/** Une entrée `v1,<hex>` du header Upstash-Signature. */
interface ParsedSignature {
  version: string;
  hex: string;
}

/** Parse le header Upstash-Signature (« v1,abc,v1,def » pendant les rotations). */
export function parseUpstashSignature(header: string | null): ParsedSignature[] {
  if (!header) return [];
  const entries: ParsedSignature[] = [];
  const parts = header.split(",").map((part) => part.trim());
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const version = parts[i];
    const hex = parts[i + 1];
    if (version && hex && /^[0-9a-f]+$/i.test(hex)) entries.push({ version, hex: hex.toLowerCase() });
  }
  return entries;
}

/**
 * Calcule la signature QStash d'un corps — exporté pour les vecteurs de
 * test. Schéma officiel : HMAC-SHA256(cléDeSignature, `cléDeSignature\ncorps`).
 */
export function computeUpstashSignature(signingKey: string, body: string): string {
  return createHmac("sha256", signingKey).update(`${signingKey}\n${body}`).digest("hex");
}

/* ---------------------------------------------------------------- */
/* SCHÉMA JWT (2026) — Upstash-Signature: <header>.<payload>.<sig>    */
/* ---------------------------------------------------------------- */

/** Comparaison temps constante de deux chaînes (longueurs quelconques). */
function egalTempsConstant(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Longueurs différentes : comparer quand même contre un buffer factice
    // pour garder un temps ~constant, puis rejeter.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Encode un digeste HMAC en base64url (avec padding) et base64 standard. */
function hmacEncodings(digest: Buffer): string[] {
  return [
    digest.toString("base64url"),
    digest.toString("base64"),
    digest.toString("hex"),
  ];
}

/** HMAC-SHA256 brut d'une chaîne UTF-8. */
function hmacRaw(key: string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/**
 * Vérifie une signature QStash au format JWT (schéma 2026) :
 * `base64url(headerJson).base64url(payloadJson).base64url(hmac)`.
 * Vérifications (clé courante OU suivante) :
 *  1. alg === HS256 (jamais « none ») ;
 *  2. le 3e segment = HMAC-SHA256(clé, `${header}.${payload}`) ;
 *  3. la claim `body` du payload = HMAC-SHA256(clé, corpsReçu) — c'est LE
 *     lien au corps réel de la requête (sans elle, le JWT serait rejouable
 *     avec un autre corps).
 */
export function verifyUpstashSignatureJwt(
  config: QStashConfig,
  rawBody: string,
  signatureHeader: string,
): boolean {
  const parts = signatureHeader.trim().split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return false;
  let headerJson: Record<string, unknown>;
  let payloadJson: Record<string, unknown>;
  try {
    headerJson = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payloadJson = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!headerJson || typeof headerJson !== "object") return false;
  if ((headerJson as Record<string, unknown>).alg !== "HS256") return false;
  const bodyClaim = (payloadJson as Record<string, unknown>).body;
  if (typeof bodyClaim !== "string" || bodyClaim.length === 0) return false;

  const signingInput = `${parts[0]}.${parts[1]}`;
  for (const key of [config.currentSigningKey, config.nextSigningKey]) {
    // 1) Signature du JWT elle-même (header.payload).
    const jwtSigOk = egalTempsConstant(parts[2], hmacRaw(key, signingInput).toString("base64url"))
      || egalTempsConstant(parts[2], hmacRaw(key, signingInput).toString("base64"));
    if (!jwtSigOk) continue;
    // 2) Lien au corps : la claim `body` doit valoir HMAC(clé, corpsReçu).
    const digest = hmacRaw(key, rawBody);
    const bodyOk = hmacEncodings(digest).some((enc) => egalTempsConstant(bodyClaim, enc));
    if (bodyOk) return true;
  }
  return false;
}

/**
 * Vérifie la signature d'une délivrance QStash en TEMPS CONSTANT, contre la
 * clé courante OU la clé suivante (rotation). Aucune dépendance : le corps
 * brut doit être fourni AVANT tout parsing (le moindre réencodage change
 * l'octet, donc la signature).
 */
export function verifyUpstashSignature(
  config: QStashConfig,
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader) return false;
  // SCHÉMA 2026 (JWT HS256) : Upstash-Signature est un JWT portant la claim
  // `body` (HMAC du corps). Détecté par la forme `<b64>.<b64>.<b64>` — le
  // schéma historique `v1,<hex>` ne contient jamais de point.
  if (signatureHeader.includes(".") && !signatureHeader.includes(",")) {
    return verifyUpstashSignatureJwt(config, rawBody, signatureHeader);
  }
  const candidates = parseUpstashSignature(signatureHeader).filter((entry) => entry.version === "v1");
  if (candidates.length === 0) return false;
  const expected = new Set(
    [config.currentSigningKey, config.nextSigningKey].map((key) => computeUpstashSignature(key, rawBody)),
  );
  for (const candidate of candidates) {
    for (const expectedHex of expected) {
      const a = Buffer.from(candidate.hex, "utf8");
      const b = Buffer.from(expectedHex, "utf8");
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
  }
  return false;
}

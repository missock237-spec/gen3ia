import { createHash, createHmac } from "crypto";

import { NextResponse } from "next/server";

import { securityHeaders } from "./request-security";
import { timingSafeStringEqual } from "./timing-safe";

/**
 * IDENTITÉ DE SERVICE INTERNE (Pilier 3 — Zero Trust, BeyondProd local).
 *
 * Principe : AUCUNE confiance par position réseau. Un appel « interne »
 * (cron, worker, moteur IA → routes système) prouve son identité par une
 * SIGNATURE CRYPTOGRAPHIQUE portée par des en-têtes, pas par son adresse
 * IP ni par la simple présence sur le même hôte :
 *
 *   X-Gen3ia-Service    : nom logique du service appelant (ex. « cron »)
 *   X-Gen3ia-Timestamp  : horodatage epoch SECONDES de l'émission
 *   X-Gen3ia-Signature  : « sha256= » + hex(HMAC-SHA256(secret du service,
 *                         `${service}:${method}:${path}:${timestamp}:${sha256(corps)}`))
 *
 * Le registre des secrets vit dans la variable d'environnement
 * GEN3IA_SERVICE_TOKENS au format « nom1:secret1,nom2:secret2 »
 * (génération d'un secret : `openssl rand -hex 32`).
 *
 * RÉTROCOMPATIBILITÉ STRICTE (jamais de rupture de service en prod) :
 *   - GEN3IA_SERVICE_TOKENS ABSENT/VIDE → verifyServiceRequest échoue
 *     proprement (raison « non_configure ») ET allowIfUnconfigured()
 *     retourne true : les routes qui l'utilisent continuent alors avec
 *     leur authentification historique (bearer CRON_SECRET, etc.) et un
 *     warning est loggé une fois par instance pour rappeler d'activer
 *     l'identité de service.
 *   - GEN3IA_SERVICE_TOKENS DÉFINIE → la signature de service est acceptée
 *     EN PLUS de l'authentification historique (jamais à sa place) : les
 *     appelants peuvent basculer progressivement.
 *
 * STRATÉGIE RECOMMANDÉE : définir GEN3IA_SERVICE_TOKENS au prochain
 * déploiement (la valeur peut être ajoutée sans impact), migrer les
 * appelants vers les en-têtes signés, puis retirer les secrets partagés
 * historiques (CRON_SECRET…) quand plus aucun appelant ne les utilise.
 *
 * ANTI-REPLAY : la fenêtre de fraîcheur (maxAgeSec, défaut 300 s) borne la
 * réutilisation d'une requête capturée — la signature couvre le couple
 * (méthode, chemin, horodatage, corps), donc une capture ne vaut QUE dans
 * cette fenêtre, pour CE chemin et CE corps. La fenêtre doit rester
 * courte et le transport HTTPS obligatoire (tunnel nginx en prod).
 */

/** Nom de la variable d'environnement du registre de secrets de service. */
export const SERVICE_TOKENS_ENV = "GEN3IA_SERVICE_TOKENS";

/** En-têtes du protocole d'identité de service. */
export const SERVICE_HEADER_NAME = "x-gen3ia-service";
export const SERVICE_HEADER_TIMESTAMP = "x-gen3ia-timestamp";
export const SERVICE_HEADER_SIGNATURE = "x-gen3ia-signature";

/** Fenêtre de fraîcheur par défaut (secondes) — anti-replay glissant. */
export const DEFAULT_MAX_AGE_SEC = 300;

/* ------------------------------------------------------------------ */
/* Registre de secrets                                                  */
/* ------------------------------------------------------------------ */

/**
 * Parse GEN3IA_SERVICE_TOKENS (« nom:secret,nom2:secret2 ») de manière
 * ROBUSTE : les entrées malformées (pas de « : », nom ou secret vide,
 * virgule traînante) sont IGNORÉES sans lever ; le nom est nettoyé des
 * espaces de bord ; en cas de doublon, la PREMIÈRE occurrence gagne (et
 * une entrée est notifiée en warning). Un registre vide/absent déclenche
 * UN warning unique par instance.
 */
export function parseServiceTokens(
  raw: string | undefined,
  options: { silent?: boolean } = {},
): Map<string, string> {
  const tokens = new Map<string, string>();
  const brut = raw?.trim() ?? "";

  if (!brut) {
    avertirUneFois(options.silent);
    return tokens;
  }

  for (const entree of brut.split(",")) {
    const morceau = entree.trim();
    if (!morceau) continue; // virgule traînante / espaces
    const separateur = morceau.indexOf(":");
    if (separateur <= 0) {
      if (!options.silent) console.warn("[service-identity] entrée GEN3IA_SERVICE_TOKENS malformée ignorée (attendu « nom:secret »).");
      continue;
    }
    const nom = morceau.slice(0, separateur).trim();
    const secret = morceau.slice(separateur + 1).trim();
    if (!nom || !secret || /\s/.test(nom)) {
      if (!options.silent) console.warn(`[service-identity] entrée GEN3IA_SERVICE_TOKENS ignorée (nom/secret vide ou nom avec espace) : « ${nom || "(vide)"} ».`);
      continue;
    }
    if (tokens.has(nom)) {
      if (!options.silent) console.warn(`[service-identity] doublon GEN3IA_SERVICE_TOKENS pour le service « ${nom} » — première occurrence conservée.`);
      continue;
    }
    tokens.set(nom, secret);
  }

  if (tokens.size === 0) avertirUneFois(options.silent);
  return tokens;
}

/** Warning « registre vide » loggé UNE seule fois par instance (pas de spam). */
let warningRegistreVideLogge = false;
function avertirUneFois(silent: boolean): void {
  if (warningRegistreVideLogge || silent) return;
  warningRegistreVideLogge = true;
  console.warn(
    "[service-identity] GEN3IA_SERVICE_TOKENS absente ou vide — identité de service désactivée : les routes internes retombent sur leur authentification historique (bearer). Définissez la variable au prochain déploiement (openssl rand -hex 32 par service).",
  );
}

/** Le registre de secrets de service est-il configuré ? */
export function serviceTokensConfigured(): boolean {
  return Boolean(process.env[SERVICE_TOKENS_ENV]?.trim());
}

/**
 * Rétrocompatibilité EXPLICITE : vrai quand l'identité de service n'est
 * PAS configurée — l'appelant peut alors conserver son comportement
 * historique (auth bearer…) avec warning. À utiliser UNIQUEMENT comme
 * repli : la cible est un déploiement où les tokens sont définis et où
 * ce helper ne s'applique plus.
 */
export function allowIfUnconfigured(): boolean {
  if (serviceTokensConfigured()) return false;
  avertirUneFois(false);
  return true;
}

/* ------------------------------------------------------------------ */
/* Signature côté émetteur                                              */
/* ------------------------------------------------------------------ */

export interface ServiceRequestDescriptor {
  /** Nom logique du service appelant (clé du registre GEN3IA_SERVICE_TOKENS). */
  service: string;

  /** Méthode HTTP (normalisée en majuscules). */
  method: string;

  /** Chemin EXACT signé (pathname, sans query — documenté). */
  path: string;

  /** Corps brut (chaîne) — absent/vide → haché du corps vide. */
  body?: string;
}

export interface ServiceSignedHeaders {
  "X-Gen3ia-Service": string;
  "X-Gen3ia-Timestamp": string;
  "X-Gen3ia-Signature": string;
}

/** Haché SHA-256 hexadécimal (minuscule) du corps — étape de la signature. */
export function sha256Hex(contenu: string): string {
  return createHash("sha256").update(contenu, "utf8").digest("hex");
}

/** Message signé : service:méthode:chemin:horodatage:hachéDuCorps. */
function messageSignature(
  service: string,
  method: string,
  path: string,
  timestamp: string,
  body: string,
): string {
  return `${service}:${method.toUpperCase()}:${path}:${timestamp}:${sha256Hex(body)}`;
}

/**
 * Signe une requête de service → en-têtes à poser sur le fetch. Lève si
 * le service est inconnu du registre (fail LOUD côté émetteur : mieux
 * vaut un crash du worker qu'un appel silencieusement non signé).
 */
export function signServiceRequest(
  descriptor: ServiceRequestDescriptor,
  options: { nowMs?: number } = {},
): ServiceSignedHeaders {
  const { service, method, path, body } = descriptor;
  const secret = parseServiceTokens(process.env[SERVICE_TOKENS_ENV], { silent: true }).get(service);
  if (!service || !secret) {
    throw new Error(
      `service-identity : service « ${service || "(vide)"} » inconnu de ${SERVICE_TOKENS_ENV} — impossible de signer la requête.`,
    );
  }

  const timestamp = String(Math.floor((options.nowMs ?? Date.now()) / 1000));
  const signature = createHmac("sha256", secret)
    .update(messageSignature(service, method, path, timestamp, body ?? ""), "utf8")
    .digest("hex");

  return {
    "X-Gen3ia-Service": service,
    "X-Gen3ia-Timestamp": timestamp,
    "X-Gen3ia-Signature": `sha256=${signature}`,
  };
}

/* ------------------------------------------------------------------ */
/* Vérification côté récepteur                                          */
/* ------------------------------------------------------------------ */

export type ServiceVerifyReason =
  | "non_configure"
  | "entetes_manquants"
  | "timestamp_invalide"
  | "timestamp_perime"
  | "service_inconnu"
  | "service_non_autorise"
  | "signature_invalide";

export type ServiceVerifyResult =
  | { ok: true; service: string }
  | { ok: false; reason: ServiceVerifyReason };

export interface VerifyServiceOptions {
  /** Fenêtre de fraîcheur (défaut 300 s) — anti-replay glissant. */
  maxAgeSec?: number;

  /** Allowlist des services admis sur cette route (défaut : tous). */
  services?: string[];

  /** Corps BRUT déjà lu par la route (POST) — vide pour GET. */
  body?: string;

  /** Horloge injectable (tests). */
  nowMs?: number;
}

/**
 * Vérifie l'identité de service d'une requête entrante. TOUTES les
 * comparaisons sensibles passent par timingSafeStringEqual : le nom de
 * service est comparé à temps constant contre chaque candidat (aucun
 * oracle de nom), la signature l'est contre la valeur attendue.
 */
export function verifyServiceRequest(
  request: NextRequest,
  options: VerifyServiceOptions = {},
): ServiceVerifyResult {
  const tokens = parseServiceTokens(process.env[SERVICE_TOKENS_ENV], { silent: true });
  if (tokens.size === 0) return { ok: false, reason: "non_configure" };

  const service = request.headers.get(SERVICE_HEADER_NAME)?.trim() ?? "";
  const timestampBrut = request.headers.get(SERVICE_HEADER_TIMESTAMP)?.trim() ?? "";
  const signatureRecue = request.headers.get(SERVICE_HEADER_SIGNATURE)?.trim() ?? "";
  if (!service || !timestampBrut || !signatureRecue) {
    return { ok: false, reason: "entetes_manquants" };
  }

  // Anti-replay : horodatage epoch secondes, fenêtre glissante ±maxAgeSec.
  if (!/^\d{1,16}$/.test(timestampBrut)) {
    return { ok: false, reason: "timestamp_invalide" };
  }
  const maxAgeSec = options.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
  const maintenantSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const age = Math.abs(maintenantSec - Number(timestampBrut));
  if (age > maxAgeSec) {
    return { ok: false, reason: "timestamp_perime" };
  }

  // Lookup du secret à temps constant (le nom ne doit pas fuir par timing).
  let secret: string | undefined;
  for (const [nom, secretCandidat] of tokens) {
    if (timingSafeStringEqual(service, nom)) {
      secret = secretCandidat;
      break;
    }
  }
  if (!secret) return { ok: false, reason: "service_inconnu" };

  // Allowlist de la route (comparaison timing-safe, même principe).
  const admis = options.services;
  if (admis && admis.length > 0) {
    let autorise = false;
    for (const nom of admis) {
      if (timingSafeStringEqual(service, nom)) {
        autorise = true;
        break;
      }
    }
    if (!autorise) return { ok: false, reason: "service_non_autorise" };
  }

  const signatureAttendue = `sha256=${createHmac("sha256", secret)
    .update(
      messageSignature(
        service,
        request.method,
        new URL(request.url).pathname,
        timestampBrut,
        options.body ?? "",
      ),
      "utf8",
    )
    .digest("hex")}`;

  if (!timingSafeStringEqual(signatureRecue, signatureAttendue)) {
    return { ok: false, reason: "signature_invalide" };
  }

  return { ok: true, service };
}

/* ------------------------------------------------------------------ */
/* Garde de route                                                       */
/* ------------------------------------------------------------------ */

export interface ServiceGuardOptions {
  /** Fenêtre de fraîcheur (défaut 300 s). */
  maxAgeSec?: number;

  /** Corps BRUT déjà lu par la route (POST) — vide pour GET. */
  body?: string;
}

export type ServiceGuardResult =
  | { ok: true; service: string }
  | { ok: false; response: NextResponse };

/**
 * Garde des routes API INTERNES : `requireService(request, "cron")` ou
 * `requireService(request, { body: rawBody }, "worker")`. Retourne soit
 * l'identité vérifiée, soit une réponse 401 prête à renvoyer.
 *
 * RÉTROCOMPATIBILITÉ : si le registre n'est pas configuré, la garde
 * échoue proprement (401 « non configuré ») — l'appelant décide alors,
 * via allowIfUnconfigured(), de retomber sur son authentification
 * historique (bearer CRON_SECRET…) SANS rupture :
 *
 *   const service = requireService(request, "cron");
 *   if (!service.ok && !isAuthorizedBearerHistorique(request)) {
 *     return service.response;
 *   }
 */
export function requireService(
  request: NextRequest,
  ...args: Array<string | ServiceGuardOptions>
): ServiceGuardResult {
  const noms: string[] = [];
  let options: ServiceGuardOptions = {};
  for (const arg of args) {
    if (typeof arg === "string") noms.push(arg);
    else options = { ...options, ...arg };
  }

  const verdict = verifyServiceRequest(request, {
    maxAgeSec: options.maxAgeSec,
    body: options.body,
    ...(noms.length > 0 ? { services: noms } : {}),
  });

  if (verdict.ok) return { ok: true, service: verdict.service };

  return {
    ok: false,
    response: reponseNonAutorise(),
  };
}

function reponseNonAutorise(): NextResponse {
  const jsonResponse = NextResponse.json(
    {
      success: false,
      error:
        "Identité de service requise : signature de service absente ou invalide (X-Gen3ia-Service / X-Gen3ia-Timestamp / X-Gen3ia-Signature).",
    },
    { status: 401 },
  );
  securityHeaders(jsonResponse.headers);
  return jsonResponse;
}

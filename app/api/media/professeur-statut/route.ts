import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/security/authenticated-request";
import { errorBody, errorStatus, errorCode } from "@/lib/security/http-errors";
import { professeurDisponible, configurationProfesseur, professeurVoix } from "@/lib/neural/professeur-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/media/professeur-statut — DIAGNOSTIC du professeur média temporaire
 * (loi CONTRAINTE-ONDES). N'expose AUCUN secret : uniquement l'état de la
 * configuration (trouvée ? quel chemin ? champ apiKey/token présents ?) et
 * un ping TTS réel (mot unique) pour prouver le bout-en-bout.
 *
 * Familles de chemins sondés (même liste que le module professeur) :
 *   ZAI_CONFIG_JSON (env) → /etc/.z-ai-config → $HOME → cwd → /opt/gen3ia.
 */

interface DiagnosticChemin {
  chemin: string;
  présent: boolean;
  erreur: string | null;
  jsonValide: boolean;
  apiKeyPrésente: boolean;
  tokenPrésent: boolean;
}

/** Répète la lecture du module pour le diagnostic (erreurs incluses). */
function sonderChemins(): DiagnosticChemin[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const chemins = [
    "/etc/.z-ai-config",
    `${process.env.HOME ?? "/root"}/.z-ai-config`,
    `${process.cwd()}/.z-ai-config`,
    "/opt/gen3ia/.z-ai-config",
    ...(process.env.GEN3IA_ROOT ? [`${process.env.GEN3IA_ROOT}/.z-ai-config`] : []),
  ];
  return chemins.map((chemin) => {
    try {
      const brut = readFileSync(chemin, "utf-8");
      try {
        const parsed = JSON.parse(brut) as Record<string, unknown>;
        return {
          chemin,
          présent: true,
          erreur: null,
          jsonValide: true,
          apiKeyPrésente: typeof parsed.apiKey === "string" && parsed.apiKey.length > 0,
          tokenPrésent: typeof parsed.token === "string" && parsed.token.length > 0,
        };
      } catch {
        return { chemin, présent: true, erreur: null, jsonValide: false, apiKeyPrésente: false, tokenPrésent: false };
      }
    } catch (erreur) {
      return {
        chemin,
        présent: false,
        erreur: erreur instanceof Error ? `${erreur.name}: ${erreur.message}` : String(erreur),
        jsonValide: false,
        apiKeyPrésente: false,
        tokenPrésent: false,
      };
    }
  });
}

export async function GET(_request: NextRequest) {
  try {
    await requireUser(_request);
  } catch (error) {
    // Sans ce filet, le HttpError(401) de requireUser se propage et Next.js
    // répond « 500 » avec corps vide au lieu du 401 JSON attendu (aligné sur
    // l'idiome maison : settings/preferences, essaim/etat…).
    return NextResponse.json(errorBody(error), {
      status: errorStatus(error),
      headers: { "x-gen3ia-error-code": errorCode(error) },
    });
  }

  const disponible = professeurDisponible();
  const config = configurationProfesseur();
  const chemins = sonderChemins();

  const diagnostic: Record<string, unknown> = {
    professeurDisponible: disponible,
    envZaiConfigJson: typeof process.env.ZAI_CONFIG_JSON === "string" && process.env.ZAI_CONFIG_JSON.length > 0,
    nodeEnv: process.env.NODE_ENV ?? null,
    cwd: process.cwd(),
    configChargee: config
      ? {
          baseUrlHôte: (() => { try { return new URL(config.baseUrl).host; } catch { return "invalide"; } })(),
          apiKeyLongueur: config.apiKey.length,
          tokenLongueur: config.token?.length ?? 0,
          voix: config.voix ?? "tongtong",
        }
      : null,
    chemins,
  };

  // Ping réel (TTS 1 mot) — prouve le bout-en-bout réseau + auth.
  if (disponible) {
    const début = Date.now();
    try {
      const œuvre = await professeurVoix({ texte: "Bonjour." });
      diagnostic.ping = {
        réussi: true,
        duréeMs: Date.now() - début,
        octets: œuvre.buffer.length,
        mime: œuvre.mime,
      };
    } catch (erreur) {
      diagnostic.ping = {
        réussi: false,
        duréeMs: Date.now() - début,
        erreur: erreur instanceof Error ? erreur.message.slice(0, 300) : String(erreur),
      };
    }
  }

  return NextResponse.json(diagnostic);
}

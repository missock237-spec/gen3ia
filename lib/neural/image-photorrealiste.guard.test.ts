/**
 * GARDE IMAGE PHOTORÉALISTE (incidence réelle it.144, 2026-11-10, demande
 * propriétaire : « gen3 ne génère pas d'images photos réaliste… corrige sa
 * puis assure toi que gen3 le réalise bien en production »).
 *
 * Constat mesuré en production : la passerelle /images/generations répond
 * en ~34 s mais parfois > 55 s — le timeout de 55 s faisait échouer le
 * professeur SILENCIEusement et l'utilisateur recevait la composition
 * abstraite locale (scène plate) au lieu d'un photoréalisme.
 *
 * Verrous :
 *  1. LE CONTRAT : professeurImage appelle POST /images/generations avec
 *     { prompt durci, size }, accepte base64 OU url, borne honnête
 *     (echafaudage: true, moteur nommé) ;
 *  2. LE TIMEOUT : 150 s génération + 120 s téléchargement (jamais 55 s) ;
 *  3. LE ROUTAGE : photoréaliste → professeur AVANT le WebGPU (WebGPU
 *     uniquement sans professeur — son repli serveur passe par le
 *     professeur) ;
 *  4. L'HONNÊTETÉ : l'outil image.generate nomme le moteur RÉEL
 *     (professeur photoréaliste / local abstrait « PAS photoréaliste »).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfigurationProfesseur } from "@/lib/neural/professeur-media";

const RACINE = path.join(import.meta.dirname, "..");

function lire(relatif: string): string {
  return readFileSync(path.join(RACINE, relatif), "utf8");
}

const CONFIG_FICTIVE: ConfigurationProfesseur = {
  baseUrl: "https://passerelle.exemple",
  apiKey: "cle-de-test-fictive",
};

async function professeurFrais() {
  vi.stubEnv("ZAI_CONFIG_JSON", JSON.stringify(CONFIG_FICTIVE));
  vi.resetModules();
  return import("@/lib/neural/professeur-media");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("durcirPromptImage — sujet INTACT, rendu photo ajouté", () => {
  it("ajoute les noyaux photoréalistes quand le prompt est neutre", async () => {
    const { durcirPromptImage } = await professeurFrais();
    const durci = durcirPromptImage("un homme assis sur un arbre");
    expect(durci.startsWith("un homme assis sur un arbre")).toBe(true);
    expect(durci).toContain("photographier, rendu photoréaliste");
    expect(durci).toContain("lumière naturelle");
    expect(durci).toContain("profondeur de champ réaliste");
  });

  it("ne duplique PAS la mention photo quand elle est déjà là (sujet intact)", async () => {
    const { durcirPromptImage } = await professeurFrais();
    const durci = durcirPromptImage("un homme sur un arbre ultra-réaliste");
    expect(durci.startsWith("un homme sur un arbre ultra-réaliste")).toBe(true);
    expect(durci).not.toContain("photographier, rendu photoréaliste");
    expect((durci.match(/ultra[- ]?r[eé]aliste/g) ?? []).length).toBe(1);
  });

  it("borne la longueur (1200 caractères max)", async () => {
    const { durcirPromptImage } = await professeurFrais();
    const durci = durcirPromptImage("scène ".repeat(400));
    expect(durci.length).toBeLessThanOrEqual(1200);
  });
});

describe("professeurImage — contrat gateway (fetch mocké)", () => {
  it("POST /images/generations avec prompt durci + size ; base64 accepté ; méta honnête", async () => {
    let corpsReçu: Record<string, unknown> | null = null;
    let urlAppelée = "";
    vi.stubGlobal("fetch", (async (url: string | URL, init?: RequestInit) => {
      urlAppelée = String(url);
      corpsReçu = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const png1x1 = Buffer.concat([
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          "base64",
        ),
        Buffer.alloc(2048, 7), // > seuil 1024 octets (garde anti-réponse vide)
      ]);
      return new Response(JSON.stringify({ data: [{ base64: png1x1.toString("base64") }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch);

    const { professeurImage } = await professeurFrais();
    const œuvre = await professeurImage({ prompt: "un homme assis sur un arbre", ratio: "3:2" });
    expect(urlAppelée).toBe("https://passerelle.exemple/images/generations");
    expect(String(corpsReçu!["prompt"])).toContain("un homme assis sur un arbre");
    expect(corpsReçu!["prompt"]).toContain("rendu photoréaliste");
    expect(corpsReçu!["size"]).toBe("1248x832"); // 3:2
    expect(œuvre.buffer.length).toBeGreaterThan(0);
    expect(œuvre.meta["echafaudage"]).toBe(true);
    expect(œuvre.meta["moteur"]).toBe("professeur-image-temporaire");
  });

  it("erreur gateway → exception honnête (le repli local reste la responsabilité de l'appelant)", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ error: "surcharge" }), { status: 503 })) as unknown as typeof fetch,
    );
    const { professeurImage } = await professeurFrais();
    await expect(professeurImage({ prompt: "test" })).rejects.toThrow(/503/);
  });
});

describe("VERROUS STRUCTURELS (balayage des sources)", () => {
  const sourceProfesseur = lire("neural/professeur-media.ts");
  const sourceEngineMedia = lire("domain/conversations/engine-media.ts");
  const sourceOutil = lire("tools/media/generate-image-neural.ts");

  it("timeout image = 150 s génération + 120 s téléchargement (jamais 55 s)", () => {
    // la section IMAGE porte les bornes corrigées
    expect(sourceProfesseur).toContain("150_000");
    expect(sourceProfesseur).toContain("120_000");
    expect(sourceProfesseur).toContain("incidence réelle it.144");
  });

  it("routage : photoréaliste → professeur d'abord (WebGPU seulement sans professeur)", () => {
    expect(sourceEngineMedia).toContain(
      "looksLikePhotorealRequest(ctx.message) && !professeurDisponible()",
    );
    expect(sourceEngineMedia).toContain('from "@/lib/neural/professeur-media"');
  });

  it("outil image.generate honnête : deux modes nommés, local jamais prétendu photo", () => {
    expect(sourceOutil).toContain("IMAGE PHOTORÉALISTE RÉELLE via le professeur média temporaire");
    expect(sourceOutil).toContain("JAMAIS photoréaliste — signalé");
    expect(sourceOutil).toContain('moteur.startsWith("professeur")');
    expect(sourceOutil).toContain("PAS photoréaliste");
    // l'ancien label menteur est interdit
    expect(sourceOutil.includes("aucune IA externe")).toBe(false);
  });
});

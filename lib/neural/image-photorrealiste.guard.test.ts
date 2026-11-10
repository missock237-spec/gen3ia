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

async function professeurFrais(surcharge: Partial<ConfigurationProfesseur> = {}) {
  vi.stubEnv("ZAI_CONFIG_JSON", JSON.stringify({ ...CONFIG_FICTIVE, ...surcharge }));
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

  it("gateway 503 + pas de hfToken → erreur honnête agrégée (jamais de média faux)", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ error: "surcharge" }), { status: 503 })) as unknown as typeof fetch,
    );
    const { professeurImage } = await professeurFrais();
    // 503 = passerelle injoignable (sonde) → échelle épuisée sans hfToken :
    // l'erreur honnête liste les moteurs essayés.
    await expect(professeurImage({ prompt: "test" })).rejects.toThrow(/Aucun moteur d'image disponible/);
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

  it("routage : photoréaliste → professeur d'abord (WebGPU seulement sans moteur image réel)", () => {
    expect(sourceEngineMedia).toContain(
      "looksLikePhotorealRequest(ctx.message) && !(await professeurImageDisponibleAsync())",
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

describe("professeurImageEspace — contrat gradio HF Spaces (quota ZeroGPU du jeton)", () => {
  const SSE_COMPLET =
    'event: complete\ndata: [{"path": "/tmp/gradio/x/image.webp", "url": "https://black-forest-labs-flux-1-schnell.hf.space/gradio_api/file=/tmp/gradio/x/image.webp", "meta": {"_type": "gradio.FileData"}}]';

  function stubEspace(options: { sse?: string; statusFlux?: number; octets?: number } = {}) {
    const appels: Array<{ url: string; init?: RequestInit }> = [];
    const png = Buffer.concat([
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
      Buffer.alloc(options.octets ?? 2048, 7),
    ]);
    vi.stubGlobal("fetch", (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      appels.push({ url: u, init });
      if (u.startsWith("https://passerelle.exemple")) {
        return new Response("indisponible", { status: 503 }); // passerelle privée injoignable
      }
      if (u.startsWith("https://router.huggingface.co/")) {
        return new Response('{"error":"Purchase pre-paid credits"}', { status: 402 });
      }
      if (u === "https://black-forest-labs-flux-1-schnell.hf.space/gradio_api/call/infer") {
        return new Response(JSON.stringify({ event_id: "e1" }), { status: 200 });
      }
      if (u.includes("/gradio_api/call/infer/e1")) {
        return new Response(options.sse ?? SSE_COMPLET, {
          status: options.statusFlux ?? 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (u.includes("/gradio_api/file=")) {
        return new Response(new Uint8Array(png), { status: 200 });
      }
      return new Response("introuvable", { status: 404 });
    }) as typeof fetch);
    return appels;
  }

  it("contrat gradio : Bearer sur les 3 appels, data [prompt durci, 0, true, W, H, 4], méta honnête", async () => {
    const appels = stubEspace();
    const { professeurImage } = await professeurFrais({ hfToken: "hf_test_fictif" });
    const œuvre = await professeurImage({ prompt: "un homme assis sur un arbre", ratio: "3:2" });
    const lancement = appels.find((a) => a.url.endsWith("/gradio_api/call/infer"));
    const flux = appels.find((a) => a.url.includes("/call/infer/e1"));
    const fichier = appels.find((a) => a.url.includes("/gradio_api/file="));
    expect(lancement).toBeTruthy();
    expect(flux).toBeTruthy();
    expect(fichier).toBeTruthy();
    // les 2 appels gradio portent le Bearer ; le téléchargement du fichier
    // généré est une URL publique (pas de Bearer requis)
    for (const a of [lancement!, flux!]) {
      expect(String(a.init?.headers?.Authorization ?? "")).toBe("Bearer hf_test_fictif");
    }
    const corps = JSON.parse(String(lancement!.init?.body ?? "{}")) as { data: unknown[] };
    expect(corps.data[0]).toContain("un homme assis sur un arbre");
    expect(corps.data[0]).toContain("rendu photoréaliste");
    expect(corps.data[1]).toBe(0);
    expect(corps.data[2]).toBe(true);
    expect(corps.data[3]).toBe(1248); // 3:2
    expect(corps.data[4]).toBe(832);
    expect(corps.data[5]).toBe(4);
    expect(œuvre.meta["moteur"]).toBe("professeur-image-espace-flux-schnell");
    expect(œuvre.meta["echafaudage"]).toBe(true);
    expect(œuvre.meta["espace"]).toBe("black-forest-labs/FLUX.1-schnell");
    expect(œuvre.buffer.length).toBeGreaterThan(1024);
  });

  it("file d'attente « error » → échec honnête citant la marche espace (jamais de média faux)", async () => {
    stubEspace({ sse: "event: error\ndata: null" });
    const { professeurImage } = await professeurFrais({ hfToken: "hf_test_fictif" });
    await expect(professeurImage({ prompt: "un arbre photoréaliste" })).rejects.toThrow(
      /espace hf : espace gradio : file d'attente « error »/,
    );
  });

  it("event_id absent → échec honnête", async () => {
    const appels: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      appels.push({ url: u, init });
      if (u.startsWith("https://passerelle.exemple")) return new Response("", { status: 503 });
      if (u.startsWith("https://router.huggingface.co/")) return new Response("", { status: 402 });
      if (u.endsWith("/gradio_api/call/infer")) return new Response("{}", { status: 200 });
      return new Response("introuvable", { status: 404 });
    }) as typeof fetch);
    const { professeurImage } = await professeurFrais({ hfToken: "hf_test_fictif" });
    await expect(professeurImage({ prompt: "un arbre" })).rejects.toThrow(/event_id absent/);
  });

  it("échelle complète : passerelle + router + espace tous en échec → erreur agrégée citant les trois", async () => {
    stubEspace({ sse: "event: error\ndata: null" });
    const { professeurImage } = await professeurFrais({ hfToken: "hf_test_fictif" });
    await expect(professeurImage({ prompt: "un arbre" })).rejects.toThrow(
      /Aucun moteur d'image disponible — passerelle : .*hugging face : .*espace hf : /,
    );
  });
});

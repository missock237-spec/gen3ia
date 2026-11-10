/**
 * GARDE CANAL R2 DU PROFESSEUR MÉDIA (incidence réelle it.144, 2026-11-10,
 * demande propriétaire : images photoréalistes RÉELLES en production).
 *
 * Constat mesuré : le canal SSH du CD est muet et l'étape « Installer la
 * config du professeur média » n'a JAMAIS réussi en mode pull (runs skippés
 * #79→#471) — la production n'a donc JAMAIS eu de professeur, d'où les
 * scènes abstraites servies aux utilisateurs. Nouveau canal : le runner CD
 * dépose la config dans le bucket R2 PRIVÉ de l'application, et
 * professeur-media la lit au runtime (candidat R2, cache 6 h/10 min).
 *
 * Verrous : résolution locale > R2, cache (1 seul appel R2), échec R2 ⇒
 * null honnête, professorImage consomme la config async, le script de
 * publication refuse les configs vides et ne touche JAMAIS à la release
 * publique, et les call-sites utilisent la variante async.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const RACINE = path.join(import.meta.dirname, "..");

function lire(relatif: string): string {
  return readFileSync(path.join(RACINE, relatif), "utf8");
}

const CONFIG_FICTIVE = {
  baseUrl: "https://passerelle.exemple",
  apiKey: "cle-de-test-fictive",
};

/** Module frais : PAS de config locale (interrupteur fichiers-local OFF) + R2 mocké. */
async function moduleFraisAvecR2(
  corpsR2: Buffer | "erreur",
): Promise<{ appelsR2: () => number; mod: typeof import("@/lib/neural/professeur-media") }> {
  vi.stubEnv("ZAI_CONFIG_JSON", ""); // pas de candidat env
  vi.stubEnv("GEN3_PROFESSEUR_MEDIA", "");
  vi.stubEnv("GEN3_PROFESSEUR_FICHIERS_LOCALS", "0"); // ignore /etc, $HOME, cwd, /opt
  let appels = 0;
  vi.doMock("@/lib/storage/r2", () => ({
    downloadFromR2: vi.fn(async () => {
      appels += 1;
      if (corpsR2 === "erreur") throw new Error("NoSuchKey");
      return corpsR2;
    }),
  }));
  vi.resetModules();
  const mod = await import("@/lib/neural/professeur-media");
  return { appelsR2: () => appels, mod };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/storage/r2");
  vi.resetModules();
});

describe("configurationProfesseurAsync — candidats locaux puis R2", () => {
  it("config locale présente → utilisée SANS aucun appel R2", async () => {
    vi.stubEnv("ZAI_CONFIG_JSON", JSON.stringify(CONFIG_FICTIVE));
    vi.stubEnv("GEN3_PROFESSEUR_MEDIA", "");
    vi.doMock("@/lib/storage/r2", () => ({
      downloadFromR2: vi.fn(async () => {
        throw new Error("ne doit JAMAIS être appelé quand la config locale existe");
      }),
    }));
    vi.resetModules();
    const mod = await import("@/lib/neural/professeur-media");
    const config = await mod.configurationProfesseurAsync();
    expect(config?.baseUrl).toBe(CONFIG_FICTIVE.baseUrl);
  });

  it("pas de config locale + R2 valide → config lue, MIS EN CACHE (1 seul appel R2)", async () => {
    const { appelsR2, mod } = await moduleFraisAvecR2(Buffer.from(JSON.stringify(CONFIG_FICTIVE)));
    const première = await mod.configurationProfesseurAsync();
    expect(première?.baseUrl).toBe(CONFIG_FICTIVE.baseUrl);
    expect(première?.baseUrl.endsWith("/")).toBe(false);
    const seconde = await mod.configurationProfesseurAsync();
    expect(seconde?.baseUrl).toBe(CONFIG_FICTIVE.baseUrl);
    expect(appelsR2()).toBe(1); // cache positif — pas de martèlement de R2
    // garde anti-réseau en test (contrat vocal it.140) : sous NODE_ENV=test,
    // la DISPONIBILITÉ est volontairement false même si la config résout
    expect(await mod.professeurDisponibleAsync()).toBe(false);
  });

  it("pas de config locale + R2 en échec (clé absente) → null honnête + cache négatif", async () => {
    const { appelsR2, mod } = await moduleFraisAvecR2("erreur");
    expect(await mod.configurationProfesseurAsync()).toBeNull();
    expect(await mod.configurationProfesseurAsync()).toBeNull();
    expect(appelsR2()).toBe(1); // cache négatif 10 min
    expect(await mod.professeurDisponibleAsync()).toBe(false);
  });

  it("R2 renvoie un JSON invalide → null honnête (jamais de throw)", async () => {
    const { mod } = await moduleFraisAvecR2(Buffer.from("{{{pas du json"));
    expect(await mod.configurationProfesseurAsync()).toBeNull();
  });

  it("normaliserConfigurationProfesseur : refuse baseUrl/apiKey manquants, purge le / final", async () => {
    const { mod } = await moduleFraisAvecR2("erreur");
    expect(mod.normaliserConfigurationProfesseur({ baseUrl: "https://x", })).toBeNull();
    expect(mod.normaliserConfigurationProfesseur({ apiKey: "k" })).toBeNull();
    expect(mod.normaliserConfigurationProfesseur({ baseUrl: "https://x/", apiKey: "k" })?.baseUrl)
      .toBe("https://x");
  });
});

describe("VERROUS STRUCTURELS (balayage des sources)", () => {
  const sourceMediaService = lire("neural/media-service.ts");
  const sourceEngineMedia = lire("domain/conversations/engine-media.ts");
  const sourceWorkflow = readFileSync(path.join(RACINE, "..", ".github/workflows/deploy-vps.yml"), "utf8");
  const sourceScript = readFileSync(
    path.join(RACINE, "..", "scripts/publie-professeur-r2.mjs"), "utf8");

  it("media-service attend le professeur ASYNC aux 3 sites (image/audio/vidéo)", () => {
    expect((sourceMediaService.match(/professeurDisponibleAsync\(\)/g) ?? []).length).toBe(3);
    expect(sourceMediaService.includes("professeurDisponible()")).toBe(false);
  });

  it("routage photoréaliste : moteur image réel AVANT la branche WebGPU", () => {
    expect(sourceEngineMedia).toContain(
      "looksLikePhotorealRequest(ctx.message) && !(await professeurImageDisponibleAsync())",
    );
  });

  it("workflow : le runner publie la config dans R2 (canal pull, jamais la release)", () => {
    expect(sourceWorkflow).toContain("Publier la config du professeur média dans R2 (canal pull)");
    expect(sourceWorkflow).toContain("node scripts/publie-professeur-r2.mjs");
    expect(sourceWorkflow).toContain("ZAI_CONFIG_JSON_B64");
    // l'ancienne étape SSH reste pour le canal SSH quand il revient — mais le
    // canal R2 ne dépend PAS de steps.scp (pas de condition scp sur la R2)
    const blocR2 = sourceWorkflow.split("Publier la config du professeur média dans R2")[1] ?? "";
    expect(blocR2.slice(0, 400)).not.toContain("steps.scp");
  });

  it("script de publication : refuse config vide/incomplète, creds manquantes → exit 0 honnête, clé R2 fixe privée", () => {
    expect(sourceScript).toContain("private/professeur-media/z-ai-config.json");
    expect(sourceScript).toContain("config professeur vide — non publiée");
    expect(sourceScript).toContain("config professeur incomplète");
    expect(sourceScript).toContain("credentials R2 absentes du .env.production");
    // le script n'écrit JAMAIS dans le dépôt ni dans la release (aucun gh/commit)
    expect(sourceScript.includes("gh release")).toBe(false);
    expect(sourceScript.includes("writeFileSync(")).toBe(false);
    // jamais bloquant : échec → exit 0 avec warning
    expect(sourceScript).toContain("process.exit(0); // jamais bloquant");
    // GUILLEMETS DOTENV (incidence réelle run #471) : les valeurs .env
    // entourées de guillemets sont strippées — sinon le hostname S3 part
    // avec des « "… » et getaddrinfo ENOTFOUND tue la publication
    expect(sourceScript).toContain("startsWith('\"') && valeur.endsWith('\"')");
    expect(sourceScript).toContain("valeur.slice(1, -1).trim()");
  });

  it("professeur-media : la clé R2 est privée et bornée (lecture 64 Ko max)", () => {
    const source = lire("neural/professeur-media.ts");
    expect(source).toContain('CLE_R2_CONFIG_PROFESSEUR = "private/professeur-media/z-ai-config.json"');
    expect(source).toContain("downloadFromR2(CLE_R2_CONFIG_PROFESSEUR, 64 * 1024)");
    expect(source).toContain("TTL_R2_POSITIF_MS");
    expect(source).toContain("TTL_R2_NEGATIF_MS");
  });
});

describe("ÉCHELLE D'IMAGES — passerelle puis Hugging Face (réseau réel it.144)", () => {
  it("hfToken/hfModel traversent le normalisateur", async () => {
    const { mod } = await moduleFraisAvecR2("erreur");
    const config = mod.normaliserConfigurationProfesseur({
      baseUrl: "https://passerelle.exemple",
      apiKey: "cle",
      hfToken: "hf_test_fictif",
      hfModel: "org/modele",
    });
    expect(config?.hfToken).toBe("hf_test_fictif");
    expect(config?.hfModel).toBe("org/modele");
  });

  it("professeurImage : passerelle injoignable + hfToken → moteur HF (POST router.huggingface.co, image RAW)", async () => {
    vi.stubEnv("ZAI_CONFIG_JSON", JSON.stringify({
      baseUrl: "https://passerelle.exemple",
      apiKey: "cle",
      hfToken: "hf_test_fictif",
    }));
    vi.stubEnv("GEN3_PROFESSEUR_MEDIA", "");
    vi.stubEnv("GEN3_PROFESSEUR_FICHIERS_LOCALS", "0");
    let corpsHf: Record<string, unknown> | null = null;
    let urlHf = "";
    // passerelle : toujours injoignable (sonde → fetch failed)
    // HF : répond une image RAW > 1 Ko
    vi.stubGlobal("fetch", (async (url: string | URL, init?: RequestInit) => {
      const cible = String(url);
      if (cible === "https://passerelle.exemple") throw new TypeError("fetch failed");
      if (cible.startsWith("https://router.huggingface.co/")) {
        urlHf = cible;
        corpsHf = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(Buffer.alloc(4096, 9), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      throw new Error(`URL inattendue : ${cible}`);
    }) as unknown as typeof fetch);
    vi.resetModules();
    const { professeurImage } = await import("@/lib/neural/professeur-media");
    const œuvre = await professeurImage({ prompt: "un homme sur un arbre", ratio: "4:3" });
    expect(œuvre.meta["moteur"]).toBe("professeur-image-hf");
    expect(urlHf).toBe("https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-3-medium-diffusers");
    expect(String(corpsHf!["inputs"])).toContain("un homme sur un arbre");
    expect((corpsHf!["parameters"] as Record<string, number>)).toEqual({ width: 1152, height: 864 });
    expect(œuvre.buffer.length).toBeGreaterThan(1024);
  });

  it("professeurImage : aucun moteur → erreur honnête CITANT les deux échecs (jamais de média faux)", async () => {
    vi.stubEnv("ZAI_CONFIG_JSON", JSON.stringify({ baseUrl: "https://passerelle.exemple", apiKey: "cle" }));
    vi.stubEnv("GEN3_PROFESSEUR_MEDIA", "");
    vi.stubEnv("GEN3_PROFESSEUR_FICHIERS_LOCALS", "0");
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    vi.resetModules();
    const { professeurImage } = await import("@/lib/neural/professeur-media");
    await expect(professeurImage({ prompt: "test" })).rejects.toThrow(/Aucun moteur d'image disponible.*injoignable/s);
  });

  it("source : l'échelle est codée (passerelle → hfToken → erreur honnête) et la sonde cache 10 min", () => {
    const source = lire("neural/professeur-media.ts");
    expect(source).toContain("professeurGatewayAtteignable");
    expect(source).toContain("router.huggingface.co/hf-inference/models/");
    expect(source).toContain("Aucun moteur d'image disponible");
    expect(source).toContain("professeurImageDisponibleAsync");
    expect(source).toContain("hfToken");
  });
});

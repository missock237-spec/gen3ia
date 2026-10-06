import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests du client ElevenLabs (Task 103-b) :
 * - clonage vocal RÉEL via POST /v1/voices/add (multipart/form-data, champ
 *   "files") — comportemental avec fetch mocké (succès, erreurs API FR) ;
 * - gardes structurels : le clonage est branché (client), idempotent
 *   (voice-service), l'audio de voice.speak est persisté avec repli inline
 *   (tools).
 */

import { addElevenLabsVoice } from "@/lib/integrations/elevenlabs/client";

const SAMPLE_WEBM = Buffer.from("faux-audio-webm");

function sampleDataUri(): string {
  return `data:audio/webm;base64,${SAMPLE_WEBM.toString("base64")}`;
}

beforeEach(() => {
  vi.stubEnv("ELEVENLABS_API_KEY", "test-api-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// addElevenLabsVoice — clonage (comportemental, fetch mocké)
// ────────────────────────────────────────────────────────────────────────────

describe("addElevenLabsVoice — clonage ElevenLabs", () => {
  it("POST multipart /v1/voices/add (champ files) et retourne le voiceId", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ voice_id: "voice-cloned-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await addElevenLabsVoice({
      name: "Ma voix",
      audioDataUri: sampleDataUri(),
      description: "Voix documentaire attestée",
    });

    expect(result).toEqual({ voiceId: "voice-cloned-1" });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/voices/add");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("test-api-key");

    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("name")).toBe("Ma voix");
    expect(form.get("description")).toBe("Voix documentaire attestée");
    const file = form.get("files");
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).size).toBe(SAMPLE_WEBM.byteLength);
  });

  it("description absente : le champ n'est pas envoyé (contrat API optionnel)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ voice_id: "voice-cloned-2" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await addElevenLabsVoice({ name: "Sans description", audioDataUri: sampleDataUri() });

    const form = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get("name")).toBe("Sans description");
    expect(form.has("description")).toBe(false);
  });

  it("échec API (402 quota) : erreur FR claire avec statut + message API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("quota_exceeded: elevenlabs", { status: 402 })),
    );

    await expect(
      addElevenLabsVoice({ name: "Ma voix", audioDataUri: sampleDataUri() }),
    ).rejects.toThrow(/Le clonage de la voix a échoué \(ElevenLabs 402\).*quota_exceeded/);
  });

  it("réponse sans voice_id : erreur FR explicite", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 })),
    );

    await expect(
      addElevenLabsVoice({ name: "Ma voix", audioDataUri: sampleDataUri() }),
    ).rejects.toThrow(/n'a pas retourné d'identifiant pour la voix clonée/);
  });

  it("échantillon vide : erreur FR avant tout appel réseau", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      addElevenLabsVoice({ name: "Ma voix", audioDataUri: "data:audio/webm;base64," }),
    ).rejects.toThrow(/échantillon audio non vide/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clé API absente : erreur de configuration (aucun appel réseau)", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      addElevenLabsVoice({ name: "Ma voix", audioDataUri: sampleDataUri() }),
    ).rejects.toThrow(/ELEVENLABS_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Gardes structurels (convention du dépôt, fs.readFileSync)
// ────────────────────────────────────────────────────────────────────────────

describe("Gardes structurels — clonage branché + persistance audio", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

  it("client.ts : l'endpoint /voices/add est appelé en multipart (FormData + Blob files)", () => {
    const source = read("lib/integrations/elevenlabs/client.ts");
    expect(source).toContain("${API_BASE}/voices/add");
    expect(source).toContain("new FormData()");
    expect(source).toMatch(/form\.append\(\s*"files"/);
    expect(source).toContain("new Blob(");
  });

  it("voice-service.ts : clonage idempotent (voiceId + clonedAtMs persistés dans videoVoices)", () => {
    const source = read("lib/video/voice-service.ts");
    expect(source).toContain("clonedAtMs");
    expect(source).toContain("elevenLabsVoiceId: cloned.voiceId, clonedAtMs: Date.now()");
    expect(source).toContain("addElevenLabsVoice(");
  });

  it("tools.ts : l'audio de voice.speak est persisté sous ai-audio permanent avec repli inline", () => {
    const source = read("lib/integrations/elevenlabs/tools.ts");
    expect(source).toContain("permanent/ai-audio/");
    expect(source).toContain('storage: "r2" | "inline"');
    expect(source).toContain("uploadToR2");
    // Dégradation assumée : aucun throw si le stockage échoue (repli inline).
    expect(source).toContain("JAMAIS de throw si le stockage échoue");
  });
});

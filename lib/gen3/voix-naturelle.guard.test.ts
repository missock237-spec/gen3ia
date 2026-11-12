import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  dureeWavSecondes,
  tenterTranscriptionProfesseur,
  transcriptionViaProfesseurAvec,
  type ConfigurationProfesseur,
} from "@/lib/neural/professeur-media";
import { VOIX_PROFESSEUR, choisirVoixSelonPersonnage } from "@/lib/neural/professeur-media";
import { voiceSpeakTool } from "@/lib/tools/media/voice-speak";
import { analyzeMediaTool } from "@/lib/tools/media/analyze-media";
import { toolLabel } from "@/lib/tools/labels";
import { GEN3IA_TOOLS } from "@/lib/tools/registry";

/**
 * VERROU BIDIRECTIONNEL it.140 (garde) — LA VOIX NATURELLE & L'OREILLE.
 *
 * Demande propriétaire (2026-11-09) : « faire en sorte que gen3 puisse
 * réaliser ce qu'il est actuellement incapable de faire ». Audit réel :
 * le TTS humain (professeur) existait mais le contrat de voice.speak le
 * niait, aucune voix n'était choisissable, et AUCUNE transcription vocale
 * (ASR) n'existait nulle part. it.140 comble les DEUX manques.
 *
 * Ce garde verrouille les DEUX directions :
 *  1. La CAPACITÉ RÉELLE : professeur TTS avec roster de voix documenté +
 *     vitesse, professeur ASR au contrat exact du SDK officiel
 *     (POST /audio/asr, corps { file_base64 } → { text }), durée WAV
 *     mesurée dans l'en-tête RIFF ;
 *  2. L'HONNÊTETÉ : le contrat (descriptions registre + outils + note)
 *     annonce les deux modes (voix humaine réelle / repli local),
 *     l'absence de transcription est déclarée, JAMAIS de texte inventé,
 *     ZÉRO outil fantôme (règle it.58), ZÉRO secret dans le code.
 */

const RACINE = path.join(import.meta.dirname, "..");

function lire(relatif: string): string {
  return readFileSync(path.join(RACINE, relatif), "utf8");
}

const CONFIG_FICTIVE: ConfigurationProfesseur = {
  baseUrl: "https://passerelle.exemple",
  apiKey: "cle-de-test-fictive",
};

/**
 * Module professeur FRAIS (cache de configuration réinitialisé) + env
 * ZAI_CONFIG_JSON fictif : professeurVoix lit la config runtime ; en test
 * seule cette valeur fictive est lue — JAMAIS de clé réelle.
 */
async function professeurFrais() {
  vi.stubEnv("ZAI_CONFIG_JSON", JSON.stringify(CONFIG_FICTIVE));
  vi.resetModules();
  return import("@/lib/neural/professeur-media");
}

/** Fabrique un WAV RIFF canonique valide (PCM 16 bits mono). */
function wavCanonique(dureeSecondes: number, sampleRate = 8000): Buffer {
  const octetsData = Math.round(dureeSecondes * sampleRate) * 2;
  const buffer = Buffer.alloc(44 + octetsData);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + octetsData, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byteRate
  buffer.writeUInt16LE(2, 32); // blockAlign
  buffer.writeUInt16LE(16, 34); // bits
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(octetsData, 40);
  return buffer;
}

describe("it.140 — roster de voix du professeur (capacité réelle)", () => {
  it("propose EXACTEMENT les 7 voix documentées de la passerelle", () => {
    expect([...VOIX_PROFESSEUR]).toEqual([
      "tongtong",
      "chuichui",
      "xiaochen",
      "jam",
      "kazi",
      "douji",
      "luodo",
    ]);
  });

  it("professeurVoix transmet la voix choisie et la vitesse bornée (mock fetch)", async () => {
    const pm = await professeurFrais();
    const appels: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      appels.push({ url: String(url), init });
      return new Response(wavCanonique(2), { status: 200 });
    });
    try {
      const œuvre = await pm.professeurVoix({
        texte: "Bonjour Gen3",
        voix: "chuichui",
        vitesse: 1.4,
      });
      // CASCADE : sonde d'atteignabilité de la passerelle, PUIS le TTS réel.
      const tts = appels.find((a) => a.url === "https://passerelle.exemple/audio/tts");
      expect(tts).toBeTruthy();
      const corps = JSON.parse(String(tts?.init?.body ?? "{}")) as Record<string, unknown>;
      expect(corps).toMatchObject({
        input: "Bonjour Gen3",
        voice: "chuichui",
        speed: 1.4,
        response_format: "wav",
      });
      expect(œuvre.meta.voix).toBe("chuichui");
      expect(œuvre.meta.echafaudage).toBe(true);
      expect(œuvre.meta.loi).toBe("CONTRAINTE-ONDES");
      // Durée réelle mesurée dans l'en-tête WAV (2 s canoniques).
      expect(œuvre.meta.duree).toBe(2);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("professeurVoix borne la vitesse hors bornes et retombe sur la voix par défaut (défense en profondeur)", async () => {
    const pm = await professeurFrais();
    const appels: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      appels.push({ url: String(url), init });
      return new Response(wavCanonique(1), { status: 200 });
    });
    try {
      await pm.professeurVoix({ texte: "Test", voix: "voix-fantome", vitesse: 99 });
      const tts = appels.find((a) => a.url === "https://passerelle.exemple/audio/tts");
      const corps = JSON.parse(String(tts?.init?.body ?? "{}")) as Record<string, unknown>;
      expect(corps.voice).toBe("tongtong");
      expect(corps.speed).toBe(2);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("CASCADE VOIX : passerelle INJOIGNABLE → espace public Edge-TTS avec la voix mappée sur le même genre", async () => {
    const pm = await professeurFrais();
    const appels: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const cible = String(url);
      appels.push({ url: cible, init });
      if (cible === "https://passerelle.exemple") {
        return new Response("réseau privé injoignable", { status: 500 });
      }
      if (cible === "https://innoai-edge-tts-text-to-speech.hf.space/gradio_api/call/tts_interface") {
        return Response.json({ event_id: "ev-1" });
      }
      if (cible.includes("/call/tts_interface/ev-1")) {
        return new Response(
          "event: complete\ndata: [{\"url\":\"https://innoai-edge-tts-text-to-speech.hf.space/gradio_api/file=/tmp/audio.mp3\"}]\n\n",
          { status: 200 },
        );
      }
      if (cible.includes("/gradio_api/file=")) {
        return new Response(Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(2048, 1)]), { status: 200 });
      }
      throw new Error("URL inattendue : " + cible);
    });
    try {
      const œuvre = await pm.professeurVoix({ texte: "Bonjour la voix", voix: "jam" });
      // La voix masculin « jam » est mappée sur la voix masculine Edge (Henri).
      expect(œuvre.meta.moteur).toBe("professeur-voix-espace-edge-tts");
      expect(œuvre.meta.voix).toBe("fr-FR-HenriNeural - fr-FR (Male)");
      expect(œuvre.meta.echafaudage).toBe(true);
      expect(œuvre.mime).toBe("audio/mpeg");
      const lancement = appels.find((a) => a.url.endsWith("/gradio_api/call/tts_interface"));
      const corps = JSON.parse(String(lancement?.init?.body ?? "{}")) as { data?: unknown[] };
      expect(corps.data?.[0]).toBe("Bonjour la voix");
      expect(corps.data?.[1]).toBe("fr-FR-HenriNeural - fr-FR (Male)");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("CASCADE VOIX : voix de l'espace demandée explicitement → espace D'ABORD (la passerelle ne connaît pas ces voix)", async () => {
    const pm = await professeurFrais();
    const appels: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const cible = String(url);
      appels.push({ url: cible, init });
      if (cible === "https://innoai-edge-tts-text-to-speech.hf.space/gradio_api/call/tts_interface") {
        return Response.json({ event_id: "ev-2" });
      }
      if (cible.includes("/call/tts_interface/ev-2")) {
        return new Response(
          "event: complete\ndata: [{\"url\":\"https://innoai-edge-tts-text-to-speech.hf.space/gradio_api/file=/tmp/femme.mp3\"}]\n\n",
          { status: 200 },
        );
      }
      if (cible.includes("/gradio_api/file=")) {
        return new Response(Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(2048, 1)]), { status: 200 });
      }
      throw new Error("URL inattendue : " + cible);
    });
    try {
      const œuvre = await pm.professeurVoix({ texte: "Bonjour", voix: "fr-FR-DeniseNeural - fr-FR (Female)" });
      expect(œuvre.meta.moteur).toBe("professeur-voix-espace-edge-tts");
      // AUCUN appel à la passerelle (ni sonde ni TTS) — la voix Edge est hors roster passerelle.
      expect(appels.some((a) => a.url.startsWith("https://passerelle.exemple"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("choisirVoixSelonPersonnage : genre et accent régionaux DÉTERMINISTES (zéro LLM)", () => {
    const femme = choisirVoixSelonPersonnage("Crée un message vocal d'une femme qui se présente");
    expect(femme.genre).toBe("féminin");
    expect(femme.voixEspace).toBe("fr-FR-DeniseNeural - fr-FR (Female)");
    const homme = choisirVoixSelonPersonnage("un homme qui mange du poulet et dit qu'il veut une eau pétillante");
    expect(homme.genre).toBe("masculin");
    expect(homme.voixEspace).toBe("fr-FR-HenriNeural - fr-FR (Male)");
    const quebec = choisirVoixSelonPersonnage("voix d'un homme avec un accent québécois");
    expect(quebec.voixEspace).toBe("fr-CA-AntoineNeural - fr-CA (Male)");
    const belge = choisirVoixSelonPersonnage("une femme belge présente le produit");
    expect(belge.voixEspace).toBe("fr-BE-CharlineNeural - fr-BE (Female)");
    const neutre = choisirVoixSelonPersonnage("un message vocal de bienvenue");
    expect(neutre.voixEspace).toBe("fr-FR-DeniseNeural - fr-FR (Female)");
  });

  it("genreLabel ACCORDÉ pour les gabarits utilisateur (« voix féminine réelle », pas « voix féminin »)", () => {
    // Sonde production 2026-11-11 : « voix féminin réelle » (accord fautif)
    // dans le fil — l'accord grammatical fait partie du réalisme perçu.
    const femme = choisirVoixSelonPersonnage("message vocal d'une femme");
    expect(femme.genreLabel).toBe("féminine");
    const homme = choisirVoixSelonPersonnage("message vocal d'un homme");
    expect(homme.genreLabel).toBe("masculine");
  });

  it("dureeWavSecondes mesure la durée RÉELLE dans l'en-tête RIFF", () => {
    expect(dureeWavSecondes(wavCanonique(3, 8000))).toBe(3);
    expect(dureeWavSecondes(wavCanonique(1.5, 22050))).toBeCloseTo(1.5, 2);
    // Fail-soft : pas d'en-tête → undefined (jamais de durée inventée).
    expect(dureeWavSecondes(Buffer.alloc(30))).toBeUndefined();
    expect(dureeWavSecondes(Buffer.from("pas un wav"))).toBeUndefined();
  });
});

describe("it.140 — transcription vocale ASR (capacité réelle)", () => {
  it("transcriptionViaProfesseurAvec appelle /audio/asr au contrat SDK officiel", async () => {
    const appels: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      appels.push({ url: String(url), init });
      return Response.json({ text: "Bonjour, ceci est une transcription réelle." });
    });
    try {
      const audio = Buffer.alloc(600, 7); // > 512 octets
      const résultat = await transcriptionViaProfesseurAvec(CONFIG_FICTIVE, audio);
      expect(résultat.texte).toBe("Bonjour, ceci est une transcription réelle.");
      expect(appels[0]?.url).toBe("https://passerelle.exemple/audio/asr");
      const corps = JSON.parse(String(appels[0]?.init?.body ?? "{}")) as { file_base64?: string };
      expect(corps.file_base64).toBe(audio.toString("base64"));
      const enTetes = new Headers(appels[0]?.init?.headers);
      expect(enTetes.get("authorization")).toBe("Bearer cle-de-test-fictive");
      expect(résultat.meta.echafaudage).toBe(true);
      expect(résultat.meta.moteur).toBe("professeur-asr-temporaire");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuse un audio trop court ou trop volumineux AVANT tout appel réseau", async () => {
    let appels = 0;
    vi.stubGlobal("fetch", async () => {
      appels += 1;
      return Response.json({ text: "x" });
    });
    try {
      await expect(transcriptionViaProfesseurAvec(CONFIG_FICTIVE, Buffer.alloc(10))).rejects.toThrow("trop court");
      await expect(
        transcriptionViaProfesseurAvec(CONFIG_FICTIVE, Buffer.alloc(26_000_000)),
      ).rejects.toThrow("trop volumineux");
      expect(appels).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("réponse sans texte → erreur honnête, JAMAIS de texte fabriqué", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ text: "" }));
    try {
      await expect(
        transcriptionViaProfesseurAvec(CONFIG_FICTIVE, Buffer.alloc(600, 3)),
      ).rejects.toThrow("sans texte");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tenterTranscriptionProfesseur : fail-soft total, absence déclarée (mode test sans professeur)", async () => {
    const résultat = await tenterTranscriptionProfesseur(Buffer.alloc(600, 5));
    expect(résultat.disponible).toBe(false);
    expect(résultat.texte).toBeUndefined();
    expect(résultat.raison).toBeTruthy();
    expect(résultat.raison).toContain("reconnaissance vocale");
  });
});

describe("it.140 — le contrat des outils raconte la capacité réelle", () => {
  it("voice.speak : schéma avec voix du roster et vitesse 0.5–2, câblage réel", () => {
    const valide = voiceSpeakTool.inputSchema.safeParse({
      text: "Bonjour",
      voix: "kazi",
      vitesse: 1.7,
    });
    expect(valide.success).toBe(true);
    const codeSource = lire("tools/media/voice-speak.ts");
    // Câblage : l'outil passe voix (résolue selon le personnage) + vitesse au service média réel.
    expect(codeSource).toContain("genererAudioNeuralEtPersister");
    expect(codeSource).toContain("voix: voixRésolue");
    expect(codeSource).toContain("vitesse: input.vitesse");
    expect(codeSource).toContain("choisirVoixSelonPersonnage");
    expect(codeSource).toContain("VOIX_PROFESSEUR");
  });

  it("voice.speak : la note distingue honnêtement les DEUX modes", () => {
    const codeSource = lire("tools/media/voice-speak.ts");
    expect(codeSource).toContain("Voix humaine RÉELLE générée par le professeur média temporaire");
    expect(codeSource).toContain("n'est pas une parole humaine naturelle");
  });

  it("media.analyze : description avec ASR réel + absence honnête", () => {
    const bas = analyzeMediaTool.description.toLowerCase();
    expect(bas).toContain("transcr");
    expect(bas).toContain("professeur");
    expect(bas).toContain("jamais de texte inventé");
  });

  it("registre GEN3IA_TOOLS : les deux descriptions alignées (zéro démenti)", () => {
    const noms = new Set(GEN3IA_TOOLS.map((t) => t.name));
    expect(noms.has("voice.speak")).toBe(true);
    expect(noms.has("media.analyze")).toBe(true);
    const codeSource = lire("tools/registry.ts");
    expect(codeSource).toContain("voix humaine RÉELLE via le professeur média temporaire");
    expect(codeSource).toContain("TRANSCRIRE RÉELLEMENT la parole des pistes audio");
    // L'ancien démenti (la transcription « n'est pas incluse ») est interdit.
    expect(codeSource).not.toContain("La transcription vocale n'est pas incluse");
    expect(codeSource).not.toContain("ce n'est pas de la parole naturelle");
  });

  it("labels : libellé de la capacité réelle (synthèse vocale parlée)", () => {
    expect(toolLabel("voice.speak")).toBe("Synthèse vocale parlée");
  });

  it("analyze.ts : câblage ASR fail-soft + absence déclarée dans le résumé", () => {
    const codeSource = lire("media/analyze.ts");
    expect(codeSource).toContain("tenterTranscriptionProfesseur");
    expect(codeSource).toContain("Transcription vocale RÉELLE");
    expect(codeSource).toContain("n'est PAS transcrit ici");
  });
});

describe("it.140 — hygiène structurelle (zéro fantôme, zéro secret)", () => {
  it("AUCUN secret en clair dans les fichiers touchés (clés uniquement via config runtime)", () => {
    const fichiers = [
      "neural/professeur-media.ts",
      "neural/media-service.ts",
      "tools/media/voice-speak.ts",
      "tools/media/analyze-media.ts",
      "media/analyze.ts",
      "tools/registry.ts",
    ];
    const motifs = [/hf_[A-Za-z0-9]{20,}/, /KGAT_[A-Za-z0-9]{20,}/, /sk-[A-Za-z0-9]{20,}/];
    for (const fichier of fichiers) {
      const contenu = lire(fichier);
      for (const motif of motifs) {
        expect(motif.test(contenu), fichier).toBe(false);
      }
    }
  });

  it("toute œuvre du professeur porte la mention d'échafaudage (loi CONTRAINTE-ONDES)", () => {
    const codeSource = lire("neural/professeur-media.ts");
    expect(codeSource).toContain('moteur: "professeur-asr-temporaire"');
    expect(codeSource).toContain("echafaudage: true");
    expect((codeSource.match(/loi: "CONTRAINTE-ONDES"/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("l'ASR suit le contrat EXACT du SDK officiel (endpoint + corps)", () => {
    const codeSource = lire("neural/professeur-media.ts");
    expect(codeSource).toContain("/audio/asr");
    expect(codeSource).toContain('file_base64: buffer.toString("base64")');
  });
});

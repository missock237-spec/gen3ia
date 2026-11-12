import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOOL musique.creer (Task 2-a AUDIO) — contrat de sortie et honnêteté,
 * avec PERSISTANCE ET SYNTHÈSE MOCKÉES (la composition, elle, est réelle) :
 *  1. identification (media/low) et description honnête ;
 *  2. schéma : demande ≥ 5 caractères, durée 30..300, style connu ;
 *  3. chaîne heureuse R2 : clé permanente déterministe (users/<uid>/
 *     permanent/musique/…), ecouterUrl durable, durée réelle ≈ demandée
 *     (±2 s), taille/nom/style/tempo/accords — jamais de faux succès ;
 *  4. repli inline borné (data URI) quand R2 est indisponible ;
 *  5. échec NOMMÉ quand ni R2 ni inline ne sont possibles ;
 *  6. la demande pilote le résultat (« 30 secondes » → dureeDetectee).
 */

const persistMock = vi.fn();
const syntheseMock = vi.fn();

vi.mock("@/lib/media/persist", () => ({
  persistGeneratedBuffer: (...args: unknown[]) => persistMock(...args),
}));

vi.mock("@/lib/media/url-durable", () => ({
  urlDurableAbsolue: (cle: unknown) =>
    typeof cle === "string" ? `/api/media/durable?path=${encodeURIComponent(cle)}` : null,
}));

vi.mock("@/lib/media/musique/synthese", () => ({
  synthetiserMusique: (...args: unknown[]) => syntheseMock(...args),
}));

import { musiqueCreerTool } from "./musique";

const DEMANDE_FLAGSHIP = "crée une musique de 2 min";

function renduMp3(tailleOctets = 600_000): unknown {
  return {
    buffer: Buffer.alloc(tailleOctets, 0x7f),
    mime: "audio/mpeg",
    extension: "mp3",
    moteur: "ffmpeg-libmp3lame-160k",
    dureeSecondes: 30,
    mp3: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  syntheseMock.mockResolvedValue(renduMp3());
});

describe("musique.creer — identification et honnêteté", () => {
  it("est identifié musique.creer, catégorie media, risque low", () => {
    expect(musiqueCreerTool.id).toBe("musique.creer");
    expect(musiqueCreerTool.name).toBe("musique.creer");
    expect(musiqueCreerTool.category).toBe("media");
    expect(musiqueCreerTool.risk).toBe("low");
  });

  it("annonce honnêtement composition algorithmique, conteneurs et limites", () => {
    const description = musiqueCreerTool.description.toLowerCase();
    expect(description).toContain("composition déterministe");
    expect(description).toContain("mp3");
    expect(description).toContain("wav");
    expect(description).toContain("honnête");
    expect(description).toContain("pas du chant");
  });
});

describe("musique.creer — schéma d'entrée", () => {
  it("refuse une demande trop courte, une durée hors 30..300, un style trop long", () => {
    expect(() => musiqueCreerTool.inputSchema.parse({ demande: "musi" })).toThrow();
    expect(() =>
      musiqueCreerTool.inputSchema.parse({ demande: "crée une musique", dureeSecondes: 29 }),
    ).toThrow();
    expect(() =>
      musiqueCreerTool.inputSchema.parse({ demande: "crée une musique", dureeSecondes: 301 }),
    ).toThrow();
    expect(() =>
      musiqueCreerTool.inputSchema.parse({ demande: "crée une musique", style: "x".repeat(41) }),
    ).toThrow();
  });

  it("accepte la demande du scénario propriétaire avec durée optionnelle", () => {
    const valide = musiqueCreerTool.inputSchema.parse({
      demande: DEMANDE_FLAGSHIP,
      dureeSecondes: 120,
      style: "lofi",
    });
    expect(valide.demande).toBe(DEMANDE_FLAGSHIP);
    expect(valide.dureeSecondes).toBe(120);
    expect(valide.style).toBe("lofi");
  });
});

describe("musique.creer — chaîne heureuse (R2 permanent)", () => {
  beforeEach(() => {
    persistMock.mockImplementation(async (params: { fixedKey?: string; buffer: Buffer }) => ({
      url: "https://r2.exemple.com/signed/musique.mp3",
      storage: "r2",
      storagePath: params.fixedKey,
    }));
  });

  it("livre le contrat complet : clé permanente, lien durable, durée réelle, style", async () => {
    const sortie = await musiqueCreerTool.execute(
      { demande: DEMANDE_FLAGSHIP, dureeSecondes: 30 },
      { userId: "user-1" },
    );

    // Persistance : clé permanente DÉTERMINISTE de contenu.
    expect(persistMock).toHaveBeenCalledTimes(1);
    const appelPersist = persistMock.mock.calls[0]?.[0] as {
      userId: string;
      contentType: string;
      fixedKey: string;
      buffer: Buffer;
    };
    expect(appelPersist.userId).toBe("user-1");
    expect(appelPersist.contentType).toBe("audio/mpeg");
    expect(appelPersist.fixedKey).toMatch(
      /^users\/user-1\/permanent\/musique\/pop-[0-9a-f]{8}-30s-\d+bpm-160k\.mp3$/u,
    );

    // Contrat de sortie.
    expect(sortie.storage).toBe("r2");
    expect(sortie.url).toBe(appelPersist.fixedKey);
    expect(sortie.ecouterUrl).toBe(`/api/media/durable?path=${encodeURIComponent(appelPersist.fixedKey)}`);
    expect(sortie.mimeType).toBe("audio/mpeg");
    expect(Math.abs(sortie.dureeReelle - 30)).toBeLessThanOrEqual(2);
    expect(sortie.dureeDemandee).toBe(30);
    // « 2 min » EST détectée dans le texte — le paramètre explicite a
    // simplement priorité sur la durée analysée (traçable dans la note).
    expect(sortie.dureeDetectee).toBe(true);
    expect(sortie.style).toBe("pop");
    expect(sortie.humeur).toBe("neutre");
    expect(sortie.tempoBpm).toBeGreaterThan(40);
    expect(sortie.accords.length).toBeGreaterThan(0);
    expect(sortie.seed).toMatch(/^[0-9a-f]{8}$/u);
    expect(sortie.tailleOctets).toBe(600_000);
    expect(sortie.nomFichier).toMatch(/^musique-pop-30s\.mp3$/u);
    expect(sortie.moteur).toContain("ffmpeg");
    expect(sortie.note).toContain("ALGORITHMIQUEMENT");
    expect(sortie.note).toContain("pas un modèle type Suno");
    expect(sortie.audioDataUri).toBeUndefined();
  });

  it("la demande pilote le résultat (« une musique de 30 secondes » → durée détectée)", async () => {
    const sortie = await musiqueCreerTool.execute(
      { demande: "compose une musique de 30 secondes" },
      { userId: "user-1" },
    );
    expect(sortie.dureeDemandee).toBe(30);
    expect(sortie.dureeDetectee).toBe(true);
  });

  it("style imposé connu modifie le style ; style inconnu → échec nommé", async () => {
    const sortie = await musiqueCreerTool.execute(
      { demande: DEMANDE_FLAGSHIP, dureeSecondes: 30, style: "jazz" },
      { userId: "user-1" },
    );
    expect(sortie.style).toBe("jazz");
    expect((persistMock.mock.calls[0]?.[0] as { fixedKey: string }).fixedKey).toContain("jazz-");

    await expect(
      musiqueCreerTool.execute(
        { demande: DEMANDE_FLAGSHIP, dureeSecondes: 30, style: "salsa-fantome" },
        { userId: "user-1" },
      ),
    ).rejects.toThrow(/Style « salsa-fantome » inconnu/u);
  });

  it("déterminisme : même demande → même clé de contenu (cache idempotent)", async () => {
    await musiqueCreerTool.execute({ demande: DEMANDE_FLAGSHIP, dureeSecondes: 30 }, { userId: "user-1" });
    await musiqueCreerTool.execute({ demande: DEMANDE_FLAGSHIP, dureeSecondes: 30 }, { userId: "user-1" });
    const cle1 = (persistMock.mock.calls[0]?.[0] as { fixedKey: string }).fixedKey;
    const cle2 = (persistMock.mock.calls[1]?.[0] as { fixedKey: string }).fixedKey;
    expect(cle1).toBe(cle2);
  });
});

describe("musique.creer — honnêteté (jamais de faux succès)", () => {
  it("R2 indisponible + fichier borné → repli inline (data URI jouable)", async () => {
    // Sémantique réelle de persistGeneratedBuffer : échec d'archivage →
    // storage "provider" avec l'URL de repli (ici le data URI) telle quelle.
    persistMock.mockImplementation(async (params: { fallbackUrl?: string }) => ({
      url: params.fallbackUrl ?? "",
      storage: "provider",
    }));
    syntheseMock.mockResolvedValue(renduMp3(500_000)); // ≤ plafond inline

    const sortie = await musiqueCreerTool.execute(
      { demande: DEMANDE_FLAGSHIP, dureeSecondes: 30 },
      { userId: "user-1" },
    );
    expect(sortie.storage).toBe("inline");
    expect(sortie.audioDataUri).toMatch(/^data:audio\/mpeg;base64,/u);
    expect(sortie.ecouterUrl).toBe(sortie.audioDataUri);
    expect(sortie.note).toContain("Livré inline");
  });

  it("R2 indisponible + fichier trop volumineux → ÉCHEC nommé (aucun faux succès)", async () => {
    persistMock.mockResolvedValue({ url: "", storage: "provider" });
    syntheseMock.mockResolvedValue({
      buffer: Buffer.alloc(3_500_000, 0x7f), // > plafond inline (2,8 Mo)
      mime: "audio/wav",
      extension: "wav",
      moteur: "wav-pcm16-native",
      dureeSecondes: 120,
      mp3: false,
      diagnostic: "ffmpeg introuvable",
    });

    await expect(
      musiqueCreerTool.execute({ demande: DEMANDE_FLAGSHIP, dureeSecondes: 120 }, { userId: "user-1" }),
    ).rejects.toThrow(/illivrable/u);
  });

  it("une synthèse qui jette (musique muette) ne devient JAMAIS un succès", async () => {
    syntheseMock.mockRejectedValue(new Error("Composition muette refusée (RMS 0)"));
    await expect(
      musiqueCreerTool.execute({ demande: DEMANDE_FLAGSHIP, dureeSecondes: 30 }, { userId: "user-1" }),
    ).rejects.toThrow(/muette/u);
    expect(persistMock).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";

import { EspaceFiltreResonant } from "../core/resonant-space";
import { SystemeExploitationOutils } from "./tool-os";
import {
  EffecteurMediaBridge,
  type ConfigPontMedia,
} from "./media-bridge";

/**
 * EFFECTEUR PONT MÉDIA — tests du gating honnête :
 *  - résonance < 0.80 → AUCUNE action ;
 *  - pont NON configuré → action ECHEC / PONT_NON_CONFIGURE, AUCUN appel
 *    réseau, jamais PONT_GENERATION_LANCEE ni succès déguisé ;
 *  - pont configuré → requête réellement émise (POST signé Bearer, bornes du
 *    pont), accusé PONT_GENERATION_LANCEE, résultat réel lisible via
 *    attendreResultat(id) — aucune simulation de média.
 */

interface AppelReseau {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

type ReponseTest = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

type Repondeur = (appel: AppelReseau) => ReponseTest | Promise<ReponseTest>;

function reponse(ok: boolean, status: number, corps: unknown) {
  const texte = typeof corps === "string" ? corps : JSON.stringify(corps);
  return { ok, status, text: async () => texte, json: async () => corps };
}

/**
 * Monte un effecteur pont avec un fetch de test injecté (aucun réseau réel).
 * Le répondeur par défaut simule un pont qui RÉPOND (payload média minimal),
 * en enregistrant chaque appel pour vérification.
 */
function monterPont(
  config: Omit<ConfigPontMedia, "fetchImpl"> = {},
  repondeur?: Repondeur,
) {
  const espace = new EspaceFiltreResonant();
  const toolOs = new SystemeExploitationOutils(espace);
  const appels: AppelReseau[] = [];
  const fetchImpl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => {
    const appel: AppelReseau = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    };
    appels.push(appel);
    if (repondeur) return await repondeur(appel);
    return reponse(true, 200, {
      mime: "image/png",
      base64: "QUJDREVGRw==",
      octets: 8,
      gpu_secondes: 1.5,
    });
  };
  const pont = new EffecteurMediaBridge(espace, toolOs, {
    url: "http://pont-test:8787",
    cleApi: "cle-test",
    ...config,
    fetchImpl,
  });
  return { espace, toolOs, pont, appels };
}

describe("EffecteurMediaBridge — enregistrement & gating", () => {
  it("enregistre les 3 pools de sortie et l'outil generer_media_photoreal", () => {
    const { espace, toolOs } = monterPont();

    expect(espace.outputPools.get("GENERER_IMAGE")).toEqual([46, 47]);
    expect(espace.outputPools.get("GENERER_AUDIO")).toEqual([42, 43]);
    expect(espace.outputPools.get("GENERER_VIDEO")).toEqual([44, 45]);

    const outil = toolOs.registreOutils.get("generer_media_photoreal");
    expect(outil).toBeDefined();
    expect(outil?.description).toContain("photoréaliste");
  });

  it("résonance 0.5 (un neurone sur deux) : aucune action", () => {
    const { pont } = monterPont();

    expect(pont.evaluerEtExecuter([46])).toEqual([]);
    expect(pont.evaluerEtExecuter([42])).toEqual([]);
    expect(pont.evaluerEtExecuter([44])).toEqual([]);
  });

  it("aucun spike : aucune action", () => {
    const { pont, appels } = monterPont();

    expect(pont.evaluerEtExecuter([])).toEqual([]);
    expect(appels).toHaveLength(0);
  });
});

describe("EffecteurMediaBridge — pont non configuré (honnêteté stricte)", () => {
  it("résonance 1.0 sans MEDIA_BRIDGE_URL : ECHEC honnête, aucun appel réseau", () => {
    const { pont, appels, toolOs } = monterPont({ url: undefined, cleApi: undefined });

    const actions = pont.evaluerEtExecuter([46, 47], {
      prompt: "aurore boréale au-dessus des fjords",
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("GENERER_IMAGE");
    // AUCUN succès déguisé : l'exécution sandbox a tourné mais le pont est
    // absent — le noyau reçoit ECHEC avec la raison exacte.
    expect(actions[0].status).toBe("ECHEC");
    const resultat = actions[0]["resultat"] as Record<string, unknown>;
    expect(resultat["statut_rendu"]).toBe("PONT_NON_CONFIGURE");
    expect(String(resultat["details"])).toContain("MEDIA_BRIDGE_URL");
    // Aucun faux accusé de lancement, aucun média fabriqué.
    expect(JSON.stringify(actions)).not.toContain("PONT_GENERATION_LANCEE");
    expect(resultat["base64"]).toBeUndefined();
    // Aucune requête émise (le fetch de test n'a jamais été sollicité).
    expect(appels).toHaveLength(0);
    // La mécanique sandbox reste réelle (métriques d'usage).
    expect(toolOs.registreOutils.get("generer_media_photoreal")?.utilisations).toBe(1);
  });

  it("exécution directe de l'outil sans pont : PONT_NON_CONFIGURE (les 3 modes)", () => {
    const { toolOs } = monterPont({ url: undefined, cleApi: undefined });

    for (const mode of ["image", "voix", "video"]) {
      const executions = toolOs.executerEnSandbox("generer_media_photoreal", {
        mode,
        prompt: "test",
        texte: "test",
      });
      const resultat = executions[0]["resultat"] as Record<string, unknown>;
      expect(resultat["statut_rendu"]).toBe("PONT_NON_CONFIGURE");
      expect(resultat["id_promesse"]).toBeUndefined();
    }
  });

  it("proberCapacites sans configuration : sonde honnête PONT_NON_CONFIGURE", async () => {
    const { pont } = monterPont({ url: undefined, cleApi: undefined });

    const capacites = await pont.proberCapacites();
    expect(capacites.joignable).toBe(false);
    expect(capacites.refus).toContain("PONT_NON_CONFIGURE");
  });
});

describe("EffecteurMediaBridge — pont configuré : lancement honnête + résultat réel", () => {
  it("image : résonance 1.0 → PONT_GENERATION_LANCEE, POST /v1/image signé Bearer, valeurs par défaut du pont", async () => {
    const { pont, appels } = monterPont();

    const actions = pont.evaluerEtExecuter([46, 47], {
      prompt: "aurore boréale au-dessus des fjords",
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("GENERER_IMAGE");
    // Le LANCEMENT réel est un succès honnête (id de promesse remis).
    expect(actions[0].status).toBe("SUCCES");
    const lance = actions[0]["resultat"] as Record<string, unknown>;
    expect(lance["statut_rendu"]).toBe("PONT_GENERATION_LANCEE");
    expect(typeof lance["id_promesse"]).toBe("string");
    expect(lance["mode"]).toBe("image");

    // La requête a été émise : POST signé, bons chemin et corps.
    expect(appels).toHaveLength(1);
    const appel = appels[0];
    expect(appel.url).toBe("http://pont-test:8787/v1/image");
    expect(appel.method).toBe("POST");
    expect(appel.headers["Authorization"]).toBe("Bearer cle-test");
    expect(appel.headers["Content-Type"]).toBe("application/json");
    const corps = JSON.parse(appel.body ?? "{}") as Record<string, unknown>;
    expect(corps["prompt"]).toBe("aurore boréale au-dessus des fjords");
    expect(corps["largeur"]).toBe(1024);
    expect(corps["hauteur"]).toBe(1024);
    expect(corps["steps"]).toBe(30);

    // Le résultat réel se lit via attendreResultat(id) — jamais simulé.
    const resultat = await pont.attendreResultat(lance["id_promesse"] as string);
    expect(resultat.statut_rendu).toBe("SUCCES");
    expect(resultat.mime).toBe("image/png");
    expect(resultat.base64).toBe("QUJDREVGRw==");
    expect(resultat.octets).toBe(8);
    expect(resultat.gpuSecondes).toBe(1.5);
  });

  it("voix : POST /v1/tts avec moteur/langue/voix par défaut (F5)", async () => {
    const { pont, appels } = monterPont();

    const actions = pont.evaluerEtExecuter([42, 43], {
      texte: "Bonjour, je suis Gen3.",
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("GENERER_AUDIO");
    expect(appels).toHaveLength(1);
    expect(appels[0].url).toBe("http://pont-test:8787/v1/tts");
    const corps = JSON.parse(appels[0].body ?? "{}") as Record<string, unknown>;
    expect(corps["texte"]).toBe("Bonjour, je suis Gen3.");
    expect(corps["moteur"]).toBe("f5");
    expect(corps["langue"]).toBe("f");
    expect(corps["voix"]).toBe("ff_siwis");
  });

  it("voix : moteur kokoro accepté, graine image propagée au pont", async () => {
    const { pont, appels } = monterPont();

    pont.evaluerEtExecuter([42, 43], { texte: "test", moteur: "kokoro" });
    pont.evaluerEtExecuter([46, 47], { prompt: "graine fixe", graine: 7 });

    expect(appels).toHaveLength(2);
    const corpsVoix = JSON.parse(appels[0].body ?? "{}") as Record<string, unknown>;
    expect(corpsVoix["moteur"]).toBe("kokoro");
    const corpsImage = JSON.parse(appels[1].body ?? "{}") as Record<string, unknown>;
    expect(corpsImage["graine"]).toBe(7);
  });

  it("vidéo : POST /v1/video avec les défauts LTX du pont (480×288, 41 frames, 40 steps)", async () => {
    const { pont, appels } = monterPont();

    const actions = pont.evaluerEtExecuter([44, 45], { prompt: "vague déferlante" });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("GENERER_VIDEO");
    expect(appels).toHaveLength(1);
    expect(appels[0].url).toBe("http://pont-test:8787/v1/video");
    const corps = JSON.parse(appels[0].body ?? "{}") as Record<string, unknown>;
    expect(corps["prompt"]).toBe("vague déferlante");
    expect(corps["largeur"]).toBe(480);
    expect(corps["hauteur"]).toBe(288);
    expect(corps["frames"]).toBe(41);
    expect(corps["steps"]).toBe(40);
  });

  it("attendreResultat : promesse inconnue → ECHEC_GENERATION honnête", async () => {
    const { pont } = monterPont();

    const resultat = await pont.attendreResultat("pont-inexistant-1");
    expect(resultat.statut_rendu).toBe("ECHEC_GENERATION");
    expect(resultat.details).toContain("pont-inexistant-1");
  });

  it("proberCapacites : GET /capabilities sans clé, mapping honnête du profil GPU", async () => {
    const { pont, appels } = monterPont({}, (_appel) =>
      reponse(true, 200, {
        gpu: true,
        profil: "sd",
        vram_go: 24,
        capacites: ["image", "tts", "video"],
        engines: { image: "sdxl", tts: "f5", video: "ltx" },
      }),
    );

    const capacites = await pont.proberCapacites();

    expect(capacites.joignable).toBe(true);
    expect(capacites.gpu).toBe(true);
    expect(capacites.profil).toBe("sd");
    expect(capacites.vramGo).toBe(24);
    expect(capacites.capacites).toEqual(["image", "tts", "video"]);
    expect(appels).toHaveLength(1);
    expect(appels[0].url).toBe("http://pont-test:8787/capabilities");
    expect(appels[0].method).toBe("GET");
    expect(appels[0].headers["Authorization"]).toBeUndefined();
  });
});

describe("EffecteurMediaBridge — bornes du pont & échecs honnêtes", () => {
  it("borne image : prompt > 2000 caractères → ECHEC_GENERATION, aucun appel", async () => {
    const { pont, appels } = monterPont();

    const resultat = await pont.genererImage({ prompt: "x".repeat(2001) });

    expect(resultat.statut_rendu).toBe("ECHEC_GENERATION");
    expect(resultat.details).toContain("2000");
    expect(appels).toHaveLength(0);
  });

  it("borne voix : texte > 4000 caractères → ECHEC_GENERATION, aucun appel", async () => {
    const { pont, appels } = monterPont();

    const resultat = await pont.genererVoix({ texte: "y".repeat(4001) });

    expect(resultat.statut_rendu).toBe("ECHEC_GENERATION");
    expect(resultat.details).toContain("4000");
    expect(appels).toHaveLength(0);
  });

  it("prompt vide / texte vide → ECHEC_GENERATION sans appel", async () => {
    const { pont, appels } = monterPont();

    expect((await pont.genererImage({ prompt: "" })).statut_rendu).toBe("ECHEC_GENERATION");
    expect((await pont.genererVoix({ texte: "   " })).statut_rendu).toBe("ECHEC_GENERATION");
    expect((await pont.genererVideo({ prompt: "" })).statut_rendu).toBe("ECHEC_GENERATION");
    expect(appels).toHaveLength(0);
  });

  it("mode inconnu via le sandbox : ECHEC_GENERATION explicite", () => {
    const { toolOs } = monterPont();

    const executions = toolOs.executerEnSandbox("generer_media_photoreal", {
      mode: "musique",
    });
    const resultat = executions[0]["resultat"] as Record<string, unknown>;
    expect(resultat["statut_rendu"]).toBe("ECHEC_GENERATION");
    expect(String(resultat["details"])).toContain("mode requis");
  });

  it("pont HTTP 500 : ECHEC_GENERATION avec la raison du pont", async () => {
    const { pont, appels } = monterPont({}, () =>
      reponse(false, 500, "CUDA out of memory"),
    );

    const resultat = await pont.genererImage({ prompt: "test" });

    expect(resultat.statut_rendu).toBe("ECHEC_GENERATION");
    expect(resultat.details).toContain("Pont 500");
    expect(resultat.details).toContain("CUDA out of memory");
    expect(appels).toHaveLength(1);
  });

  it("pont injoignable (fetch rejette) : PONT_INACCESSIBLE, jamais de faux média", async () => {
    const { pont } = monterPont({}, () => {
      throw new Error("ECONNREFUSED");
    });

    const resultat = await pont.genererImage({ prompt: "test" });

    expect(resultat.statut_rendu).toBe("PONT_INACCESSIBLE");
    expect(resultat.details).toContain("ECONNREFUSED");
    expect(resultat.base64).toBeUndefined();
  });

  it("pont muet (délai dépassé) : PONT_INACCESSIBLE avec la durée exacte", async () => {
    const { pont } = monterPont(
      { timeoutMs: 10 },
      () => new Promise(() => {}), // ne répond jamais
    );

    const resultat = await pont.genererImage({ prompt: "test" });

    expect(resultat.statut_rendu).toBe("PONT_INACCESSIBLE");
    expect(resultat.details).toContain("Délai dépassé après 10 ms");
  });

  it("réponse 200 sans média : ECHEC_GENERATION (le pont n'a rien rendu)", async () => {
    const { pont } = monterPont({}, () => reponse(true, 200, { mime: "image/png" }));

    const resultat = await pont.genererImage({ prompt: "test" });

    expect(resultat.statut_rendu).toBe("ECHEC_GENERATION");
    expect(resultat.details).toContain("aucun média");
  });

  it("échec du pont via le gating : lancement SUCCES honnête, résultat asynchrone ECHEC_GENERATION", async () => {
    const { pont } = monterPont({}, () => reponse(false, 503, "GPU saturé"));

    const actions = pont.evaluerEtExecuter([46, 47], { prompt: "test" });

    expect(actions).toHaveLength(1);
    // Le lancement a réellement eu lieu (accusé SUCCES honnête, pas un succès de rendu) ;
    // seul le résultat asynchrone porte l'échec réel du pont — jamais simulé.
    expect(actions[0].status).toBe("SUCCES");
    const lance = actions[0]["resultat"] as Record<string, unknown>;
    expect(lance["statut_rendu"]).toBe("PONT_GENERATION_LANCEE");
    // Le résultat asynchrone porte l'échec réel du pont.
    const resultat = await pont.attendreResultat(lance["id_promesse"] as string);
    expect(resultat.statut_rendu).toBe("ECHEC_GENERATION");
    expect(resultat.details).toContain("Pont 503");
  });
});

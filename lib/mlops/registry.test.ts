import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ErreurRegistre,
  RegistreModeles,
  type ManifestModele,
} from "./registry";

/**
 * REGISTRE DE MODÈLES LOCAL — tests du stockage var/neural/registry/ :
 * validation stricte, écritures atomiques (aucun .tmp résiduel),
 * idempotence de register, pointeur production.json (fait foi), rollback
 * par déplacement de pointeur, lignage parentVersion, et règle d'or
 * « aucun binaire copié » (le registre ne contient que des JSON).
 *
 * Chaque test travaille dans un dossier temporaire dédié (jamais var/).
 */

/** Manifeste de référence valide (retouches possibles par champ). */
function manifesteTest(retouches: Partial<ManifestModele> = {}): ManifestModele {
  return {
    modelId: "gen3-cortex-v2",
    version: "1.0.0",
    createdAt: "2026-10-23T10:00:00.000Z",
    gitSha: "cfc052a6",
    auteur: "agent-mlops",
    artefact: {
      chemin: "var/neural/cortex-v2.bin",
      sha256: "a".repeat(64),
      bytes: 12_586_950,
    },
    datasets: [
      { nom: "corpus-llms", reference: "public/llms.txt", echantillons: 120 },
    ],
    hyperparams: { epochs: 4, lrBoost: 0.15 },
    metrics: [{ nom: "accuracy_test", valeur: 0.82, seuilMin: 0.7 }],
    lineage: { source: "pipeline" },
    channel: "experimental",
    ...retouches,
  };
}

const temporaires: string[] = [];

function nouveauRegistre(): { registre: RegistreModeles; racine: string } {
  const racine = mkdtempSync(join(tmpdir(), "gen3-registry-"));
  temporaires.push(racine);
  return { registre: new RegistreModeles(racine), racine };
}

afterEach(() => {
  while (temporaires.length > 0) {
    const racine = temporaires.pop();
    if (racine) rmSync(racine, { recursive: true, force: true });
  }
});

describe("registre de modèles local (lib/mlops/registry)", () => {
  it("register + get : aller-retour exact, fichier JSON lisible sur disque", async () => {
    const { registre, racine } = nouveauRegistre();
    const manifeste = manifesteTest();

    const enregistre = await registre.register(manifeste);
    expect(enregistre).toEqual(manifeste);

    const chemin = join(racine, "gen3-cortex-v2", "1.0.0.json");
    expect(existsSync(chemin)).toBe(true);
    const brut = JSON.parse(readFileSync(chemin, "utf8")) as ManifestModele;
    expect(brut.modelId).toBe("gen3-cortex-v2");
    expect(brut.artefact.sha256).toBe("a".repeat(64));

    const lu = await registre.get("gen3-cortex-v2", "1.0.0");
    expect(lu).not.toBeNull();
    expect(lu).toEqual(manifeste);
  });

  it("get() sur version absente → null sans erreur", async () => {
    const { registre } = nouveauRegistre();
    expect(await registre.get("gen3-cortex-v2", "9.9.9")).toBeNull();
    expect(await registre.list("modelez-inconnu")).toEqual([]);
    expect(await registre.latest("modelez-inconnu", "production")).toBeNull();
  });

  it("validation stricte : manifestes invalides refusés (ErreurRegistre)", async () => {
    const { registre, racine } = nouveauRegistre();
    const cas: Array<[string, Partial<ManifestModele>]> = [
      ["modelId non kebab-case", { modelId: "Gen3 Cortex!" }],
      ["version non semver", { version: "1.0" }],
      ["createdAt non ISO", { createdAt: "hier" }],
      ["gitSha non hexadécimal", { gitSha: "BRANCHE" }],
      ["auteur vide", { auteur: "  " }],
      ["sha256 trop court", { artefact: { chemin: "a.bin", sha256: "abc", bytes: 1 } }],
      ["bytes négatif", { artefact: { chemin: "a.bin", sha256: "a".repeat(64), bytes: -1 } }],
      ["canal inconnu", { channel: "beta" as never }],
      [
        "lineage.source inconnu",
        { lineage: { source: "magique" as never } },
      ],
      ["datasets non tableau", { datasets: "corpus" as never }],
      [
        "métrique non finie",
        { metrics: [{ nom: "accuracy_test", valeur: Number.NaN }] },
      ],
    ];
    for (const [libelle, retouches] of cas) {
      await expect(
        registre.register(manifesteTest(retouches)),
        `cas refusé attendu : ${libelle}`,
      ).rejects.toBeInstanceOf(ErreurRegistre);
    }
    // Aucun fichier ne doit avoir été écrit par les tentatives refusées.
    expect(existsSync(join(racine, "gen3-cortex-v2"))).toBe(false);
  });

  it("écriture atomique : aucun .tmp résiduel après register/promouvoir/rollback", async () => {
    const { registre, racine } = nouveauRegistre();
    const dossier = join(racine, "gen3-cortex-v2");

    await registre.register(manifesteTest());
    await registre.register(manifesteTest({ version: "1.1.0" }));
    await registre.promouvoir("gen3-cortex-v2", "1.0.0");
    await registre.rollback("gen3-cortex-v2", "1.0.0");

    const residus = readdirSync(dossier).filter((f) => f.includes(".tmp"));
    expect(residus).toEqual([]);
  });

  it("idempotence : manifeste identique → no-op ; contenu différent → VERSION_EXISTANTE", async () => {
    const { registre } = nouveauRegistre();
    const manifeste = manifesteTest();

    await registre.register(manifeste);
    await expect(registre.register(manifeste)).resolves.toEqual(manifeste);

    await expect(
      registre.register(
        manifesteTest({ metrics: [{ nom: "accuracy_test", valeur: 0.9 }] }),
      ),
    ).rejects.toMatchObject({ code: "VERSION_EXISTANTE" });
  });

  it("list : tri createdAt desc, isolation par modelId", async () => {
    const { registre } = nouveauRegistre();
    await registre.register(
      manifesteTest({ version: "1.1.0", createdAt: "2026-10-23T11:00:00.000Z" }),
    );
    await registre.register(
      manifesteTest({ version: "1.0.0", createdAt: "2026-10-23T10:00:00.000Z" }),
    );
    await registre.register(
      manifesteTest({ version: "1.2.0", createdAt: "2026-10-23T12:00:00.000Z" }),
    );
    await registre.register(
      manifesteTest({ modelId: "gen3-embeddings", version: "1.0.0" }),
    );

    const versions = (await registre.list("gen3-cortex-v2")).map(
      (m) => m.version,
    );
    expect(versions).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
    expect(await registre.list("gen3-embeddings")).toHaveLength(1);
    expect(await registre.list("inconnu")).toEqual([]);
  });

  it("latest : le POINTEUR production fait foi, même si une expérimentale est plus récente", async () => {
    const { registre } = nouveauRegistre();
    await registre.register(manifesteTest({ version: "1.0.0" }));
    await registre.register(
      manifesteTest({ version: "1.1.0", createdAt: "2026-10-23T11:00:00.000Z" }),
    );

    // Rien en production : latest("production") → null ; expérimental → la plus récente.
    expect(await registre.latest("gen3-cortex-v2", "production")).toBeNull();
    expect(
      (await registre.latest("gen3-cortex-v2", "experimental"))?.version,
    ).toBe("1.1.0");

    // Promotion de l'ancienne : le pointeur prime sur la fraîcheur.
    await registre.promouvoir("gen3-cortex-v2", "1.0.0");
    expect(
      (await registre.latest("gen3-cortex-v2", "production"))?.version,
    ).toBe("1.0.0");

    // Repli sans pointeur : une version enregistrée directement « production ».
    await registre.register(
      manifesteTest({
        modelId: "gen3-embeddings",
        version: "1.0.0",
        channel: "production",
      }),
    );
    expect(
      (await registre.latest("gen3-embeddings", "production"))?.version,
    ).toBe("1.0.0");
  });

  it("promouvoir : production.json écrit atomiquement + canal du manifeste mis à jour", async () => {
    const { registre, racine } = nouveauRegistre();
    await registre.register(manifesteTest({ version: "1.0.0" }));

    const pointeur = await registre.promouvoir("gen3-cortex-v2", "1.0.0");
    expect(pointeur).not.toBeNull();
    expect(pointeur!.version).toBe("1.0.0");
    expect(pointeur!.origine).toBe("promotion");
    expect(typeof pointeur!.promuLe).toBe("string");

    const brut = JSON.parse(
      readFileSync(join(racine, "gen3-cortex-v2", "production.json"), "utf8"),
    ) as { modelId: string; version: string; origine: string };
    expect(brut.modelId).toBe("gen3-cortex-v2");
    expect(brut.origine).toBe("promotion");

    expect(
      (await registre.get("gen3-cortex-v2", "1.0.0"))?.channel,
    ).toBe("production");

    // Version inexistante → INTROUVABLE.
    await expect(
      registre.promouvoir("gen3-cortex-v2", "9.9.9"),
    ).rejects.toMatchObject({ code: "INTROUVABLE" });

    // Démotion explicite vers experimental : pas de pointeur (retour null).
    const demotion = await registre.promouvoir(
      "gen3-cortex-v2",
      "1.0.0",
      "experimental",
    );
    expect(demotion).toBeNull();
    expect(
      (await registre.get("gen3-cortex-v2", "1.0.0"))?.channel,
    ).toBe("experimental");
  });

  it("rollback : déplace le pointeur, origine rollback, historique intact", async () => {
    const { registre, racine } = nouveauRegistre();
    await registre.register(manifesteTest({ version: "1.0.0" }));
    await registre.register(
      manifesteTest({ version: "2.0.0", createdAt: "2026-10-23T11:00:00.000Z" }),
    );
    await registre.promouvoir("gen3-cortex-v2", "2.0.0");
    expect(
      (await registre.latest("gen3-cortex-v2", "production"))?.version,
    ).toBe("2.0.0");

    const pointeur = await registre.rollback("gen3-cortex-v2", "1.0.0");
    expect(pointeur.origine).toBe("rollback");
    expect(
      (await registre.latest("gen3-cortex-v2", "production"))?.version,
    ).toBe("1.0.0");

    // Historique intact : la 2.0.0 existe toujours (canal « production »
    // = « a déjà servi », le pointeur fait foi pour la version servie).
    expect(await registre.get("gen3-cortex-v2", "2.0.0")).not.toBeNull();
    const brut = JSON.parse(
      readFileSync(join(racine, "gen3-cortex-v2", "production.json"), "utf8"),
    ) as { version: string; origine: string };
    expect(brut.version).toBe("1.0.0");
    expect(brut.origine).toBe("rollback");

    // Rollback vers une version absente → refus (jamais de pointeur fantôme).
    await expect(
      registre.rollback("gen3-cortex-v2", "9.9.9"),
    ).rejects.toMatchObject({ code: "INTROUVABLE" });
  });

  it("lineage : remonte la chaîne parentVersion depuis la production", async () => {
    const { registre } = nouveauRegistre();
    await registre.register(
      manifesteTest({
        version: "1.0.0",
        lineage: { source: "pipeline" },
      }),
    );
    await registre.register(
      manifesteTest({
        version: "1.1.0",
        createdAt: "2026-10-23T11:00:00.000Z",
        lineage: { source: "pipeline", parentVersion: "1.0.0" },
      }),
    );
    await registre.register(
      manifesteTest({
        version: "1.2.0",
        createdAt: "2026-10-23T12:00:00.000Z",
        lineage: { source: "training-worker", parentVersion: "1.1.0" },
      }),
    );
    await registre.promouvoir("gen3-cortex-v2", "1.2.0");

    const chaine = (await registre.lineage("gen3-cortex-v2")).map(
      (m) => m.version,
    );
    expect(chaine).toEqual(["1.2.0", "1.1.0", "1.0.0"]);

    // Départ explicite : sous-chaîne.
    const sousChaine = (
      await registre.lineage("gen3-cortex-v2", "1.1.0")
    ).map((m) => m.version);
    expect(sousChaine).toEqual(["1.1.0", "1.0.0"]);

    // Parent absent du registre : arrêt propre (pas d'exception).
    await registre.register(
      manifesteTest({
        version: "2.0.0",
        createdAt: "2026-10-23T13:00:00.000Z",
        lineage: { source: "manuel", parentVersion: "9.9.9" },
      }),
    );
    const orpheline = (
      await registre.lineage("gen3-cortex-v2", "2.0.0")
    ).map((m) => m.version);
    expect(orpheline).toEqual(["2.0.0"]);

    // Modèle inconnu : chaîne vide.
    expect(await registre.lineage("modelez-inconnu")).toEqual([]);
  });

  it("lineage : un cycle parentVersion ne boucle pas à l'infini", async () => {
    const { registre } = nouveauRegistre();
    await registre.register(
      manifesteTest({
        version: "1.0.0",
        lineage: { source: "manuel", parentVersion: "1.1.0" },
      }),
    );
    await registre.register(
      manifesteTest({
        version: "1.1.0",
        createdAt: "2026-10-23T11:00:00.000Z",
        lineage: { source: "manuel", parentVersion: "1.0.0" },
      }),
    );
    const chaine = await registre.lineage("gen3-cortex-v2", "1.1.0");
    expect(chaine).toHaveLength(2);
  });

  it("corruption : un manifeste illisible est ignoré par list/get (avertissement)", async () => {
    const { registre, racine } = nouveauRegistre();
    await registre.register(manifesteTest());
    writeFileSync(
      join(racine, "gen3-cortex-v2", "2.0.0.json"),
      "{ JSON tronqué",
      "utf8",
    );
    expect(await registre.get("gen3-cortex-v2", "2.0.0")).toBeNull();
    const versions = (await registre.list("gen3-cortex-v2")).map(
      (m) => m.version,
    );
    expect(versions).toEqual(["1.0.0"]);
  });

  it("règle d'or : AUCUN binaire copié — le registre ne contient que des JSON", async () => {
    const { registre, racine } = nouveauRegistre();
    // Un « binaire » factice vit HORS du registre ; le manifeste ne le
    // référence que par chemin + empreinte.
    const artefactDir = mkdtempSync(join(tmpdir(), "gen3-artefact-"));
    temporaires.push(artefactDir);
    const cheminBinaire = join(artefactDir, "cortex-v2.bin");
    writeFileSync(cheminBinaire, Buffer.from([0, 1, 2, 3, 255]));

    await registre.register(
      manifesteTest({
        artefact: {
          chemin: cheminBinaire,
          sha256: "b".repeat(64),
          bytes: 5,
        },
      }),
    );
    await registre.promouvoir("gen3-cortex-v2", "1.0.0");

    const fichiers = readdirSync(join(racine, "gen3-cortex-v2"));
    expect(fichiers.every((f) => f.endsWith(".json"))).toBe(true);
    expect(fichiers).toHaveLength(2); // 1.0.0.json + production.json
  });
});

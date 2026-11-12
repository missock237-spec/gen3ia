import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  configurerDepotMemoireUtilisateur,
  consulterMemoireUtilisateur,
  invaliderCacheMemoireUtilisateur,
} from "./memoire-utilisateur";
import { empreintePackSha256 } from "./fichier-final";
import {
  ErreurEntrainementStudio,
  executerEntrainementStudio,
  lireRapportEntrainement,
} from "./pipeline-entrainement";
import type { ContenuFichierFinal } from "./fichier-final";

/* ------------------------------------------------------------------ */
/* PIPELINE BOUT-EN-BOUT DU STUDIO — sur un corpus fixture (3 textes),  */
/* le pipeline doit : extraire les unités, mesurer la baseline (sans    */
/* les unités), ingérer dans la mémoire PERSISTÉE du compte, re-mesurer  */
/* (APRÈS > AVANT sur le domaine, zéro débordement hors domaine) et      */
/* livrer le FICHIER FINAL avec une empreinte SHA-256 cohérente.        */
/* R2 mocké EN MÉMOIRE (même approche que user-data-store.test.ts) —    */
/* la persistance réelle (user-data-store + fichier permanent) est      */
/* exercée de bout en bout.                                             */
/* ------------------------------------------------------------------ */

const r2State = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
}));

function erreurAbsence(): Error {
  const error = new Error("The specified key does not exist.");
  error.name = "NoSuchKey";
  (error as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
  return error;
}

vi.mock("@/lib/storage/r2", () => ({
  putObject: async (options: { key: string; body: Uint8Array | Buffer }) => {
    r2State.store.set(options.key, Buffer.from(options.body));
  },
  downloadFromR2: async (key: string, maxBytes?: number) => {
    const body = r2State.store.get(key);
    if (!body) throw erreurAbsence();
    if (typeof maxBytes === "number" && body.byteLength > maxBytes) {
      throw new Error("R2 object exceeds configured read limit");
    }
    return body;
  },
  deleteObject: async (key: string) => {
    r2State.store.delete(key);
  },
  deleteFromR2: async (key: string) => {
    r2State.store.delete(key);
  },
  listObjectsUnderPrefix: async (prefix: string) => {
    return [...r2State.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((key) => ({
        key,
        sizeBytes: r2State.store.get(key)!.byteLength,
        updatedAt: new Date().toISOString(),
      }));
  },
}));

// ─── CORPUS FIXTURE : trois ressources d'un même domaine (botanique) ─────────

const TEXTE_QA = {
  titre: "Fiche photosynthèse",
  origine: "texte" as const,
  contenu:
    "Q: Qu'est-ce que la photosynthèse ?\n" +
    "A: Le processus biologique par lequel les plantes vertes transforment la lumière du soleil en énergie chimique, en absorbant le dioxyde de carbone et en libérant de l'oxygène.\n" +
    "\n" +
    "Q: Où se déroule la photosynthèse dans la plante ?\n" +
    "A: Dans les chloroplastes, les organites verts contenus dans les cellules du mésophylle des feuilles.\n" +
    "\n" +
    "Q: Quels pigments capturent la lumière ?\n" +
    "A: La chlorophylle a et la chlorophylle b, soutenues par les caroténoïdes qui élargissent le spectre capté.\n",
};

const TEXTE_FAITS = {
  titre: "Notes sur les stomates",
  origine: "texte" as const,
  contenu:
    "Les stomates sont les pores microscopiques des feuilles qui régulent les échanges de gaz entre la plante et l'atmosphère.\n" +
    "La sève brute est la solution aqueuse transportée par le xylème depuis les racines jusqu'aux feuilles.\n",
};

const TEXTE_CODE = {
  titre: "Mesure de lumière",
  origine: "texte" as const,
  contenu:
    "Pour mesurer l'intensité lumineuse utile à la croissance :\n```python\nlumen = photometre.mesure_eclairement()\nif lumen < 8000:\n    activer_eclairage_assiste()\n```\n",
};

const PROJET = { id: "01JTSTUDIO0000000000000000", nom: "Botanique Gen3" };
const DOMAINE = "botanique";

describe("pipeline d'entraînement réel — bout-en-bout", () => {
  beforeEach(() => {
    r2State.store.clear();
    invaliderCacheMemoireUtilisateur();
    configurerDepotMemoireUtilisateur(null); // dépôt R2 (mocké ci-dessus)
  });

  it("extrait, ingère, mesure AVANT < APRÈS et livre le fichier final cohérent", async () => {
    const uid = "entraineur-a";
    const resultat = await executerEntrainementStudio(uid, {
      projet: PROJET,
      domaine: DOMAINE,
      ressources: [TEXTE_QA, TEXTE_FAITS, TEXTE_CODE],
    });
    const { rapport, fichier } = resultat;

    // CORPUS : unités extraites des trois ressources, compteurs honnêtes.
    expect(rapport.ressources).toHaveLength(3);
    expect(rapport.corpus.unites).toBeGreaterThanOrEqual(5);
    expect(rapport.corpus.parType.qa).toBeGreaterThanOrEqual(3);
    expect(rapport.corpus.parType.fait).toBeGreaterThanOrEqual(2);
    expect(rapport.corpus.parType.code).toBe(1);

    // ÉVALUATION : baseline sans la mémoire (score 0) → après ingestion, le
    // score APRÈS sur les questions du domaine est MESURABLEMENT supérieur.
    expect(rapport.evaluation.domaine.questions).toBeGreaterThan(0);
    expect(rapport.evaluation.avant.scoreGlobal).toBe(0);
    expect(rapport.evaluation.apres.scoreGlobal).toBeGreaterThan(0);
    expect(rapport.evaluation.apres.scoreGlobal).toBeGreaterThan(rapport.evaluation.avant.scoreGlobal);
    expect(rapport.evaluation.amelioration).toBeGreaterThan(0);
    // NON-RÉGRESSION : les questions de contrôle hors domaine ne sont JAMAIS servies.
    expect(rapport.evaluation.horsDomaine.regression).toBe(false);
    expect(rapport.evaluation.horsDomaine.serviesApres).toBe(0);

    // MÉMOIRE PERSISTÉE dans l'espace utilisateur (studio/memoire/<domaine>.json).
    expect(rapport.memoire.unitesAjoutees).toBe(rapport.corpus.unites);
    const cleMemoire = `users/${uid}/studio/memoire/${DOMAINE}.json`;
    expect(rapport.memoire.cleStockage).toBe(cleMemoire);
    expect(r2State.store.has(cleMemoire)).toBe(true);

    // FICHIER FINAL : gen3iac-entrainement-<projet>.json dans l'espace PERMANENT.
    expect(fichier.nom).toMatch(/^gen3iac-entrainement-botanique-gen3-.+\.json$/);
    expect(fichier.cle).toContain(`users/${uid}/permanent/studio/`);
    expect(r2State.store.has(fichier.cle)).toBe(true);
    expect(fichier.lienDurable).toBe(`/api/media/durable?path=${encodeURIComponent(fichier.cle)}`);

    const livrable = JSON.parse(r2State.store.get(fichier.cle)!.toString("utf-8")) as ContenuFichierFinal;
    expect(livrable.format).toBe("gen3iac-entrainement");
    expect(livrable.version).toBe(1);
    expect(livrable.projet.id).toBe(PROJET.id);
    expect(livrable.projet.nom).toBe(PROJET.nom);
    expect(livrable.domaine).toBe(DOMAINE);
    expect(livrable.corpus.unites).toBe(rapport.corpus.unites);
    expect(livrable.evaluation.apres.scoreGlobal).toBe(rapport.evaluation.apres.scoreGlobal);
    expect(livrable.genereeLe).toBeTruthy();

    // EMPREINTE SHA-256 COHÉRENTE : recalculée sur les unités RÉELLEMENT
    // persistées dans la mémoire du compte = empreinte annoncée du pack.
    const memoireDoc = JSON.parse(r2State.store.get(cleMemoire)!.toString("utf-8")) as { unites: Parameters<typeof empreintePackSha256>[0] };
    expect(empreintePackSha256(memoireDoc.unites)).toBe(livrable.packSha256);

    // RAPPORT persisté et relisible (GET de la route).
    const relit = await lireRapportEntrainement(uid, PROJET.id);
    expect(relit?.fichierFinal.packSha256).toBe(livrable.packSha256);
  });

  it("l'IA entraînée répond réellement depuis la mémoire persistée du compte", async () => {
    const uid = "entraineur-b";
    await executerEntrainementStudio(uid, {
      projet: PROJET,
      domaine: DOMAINE,
      ressources: [TEXTE_QA],
    });

    // POINT D'INJECTION RÉEL : consulterMemoireUtilisateur est câblée au
    // moteur (lib/neural/runtime.ts → engine.ts) et consulte la mémoire
    // PERSISTÉE du compte (cache process 60 s).
    const reponse = await consulterMemoireUtilisateur("Qu'est-ce que la photosynthèse ?", uid);
    expect(reponse).not.toBeNull();
    expect(reponse?.texte).toContain("lumière du soleil en énergie chimique");
    expect(reponse?.theme).toBe(`studio:${DOMAINE}`);

    // Hors domaine : la même mémoire ne répond PAS (contrôle).
    const horsDomaine = await consulterMemoireUtilisateur("Quelle est la capitale du Pérou ?", uid);
    expect(horsDomaine).toBeNull();

    // Un AUTRE compte n'a pas cette connaissance (isolation multi-tenant).
    expect(await consulterMemoireUtilisateur("Qu'est-ce que la photosynthèse ?", "autre-compte")).toBeNull();
  });

  it("échoue honnêtement (aucun gain mesuré) si le corpus est re-ingéré tel quel", async () => {
    const uid = "entraineur-c";
    await executerEntrainementStudio(uid, {
      projet: PROJET,
      domaine: DOMAINE,
      ressources: [TEXTE_QA],
    });
    // Mêmes ressources : tout est doublon → aucun gain → REFUS, jamais un
    // rapport trompeur.
    await expect(
      executerEntrainementStudio(uid, {
        projet: PROJET,
        domaine: DOMAINE,
        ressources: [TEXTE_QA],
      }),
    ).rejects.toMatchObject({ code: "aucun-gain-mesure" });
  });

  it("échoue honnêtement sans ressources ou sur un corpus sans unité", async () => {
    await expect(
      executerEntrainementStudio("entraineur-d", {
        projet: PROJET,
        domaine: DOMAINE,
        ressources: [],
      }),
    ).rejects.toMatchObject({ code: "ressources-manquantes" });

    await expect(
      executerEntrainementStudio("entraineur-d", {
        projet: PROJET,
        domaine: DOMAINE,
        ressources: [{ titre: "bruit", contenu: "ok ok ok", origine: "texte" }],
      }),
    ).rejects.toBeInstanceOf(ErreurEntrainementStudio);
  });

  it("l'entraînement CUMULE : une deuxième session sur le même domaine enrichit la mémoire", async () => {
    const uid = "entraineur-e";
    await executerEntrainementStudio(uid, {
      projet: PROJET,
      domaine: DOMAINE,
      ressources: [TEXTE_QA],
    });
    const avant = await consulterMemoireUtilisateur("Comment mesurer l'intensité lumineuse ?", uid);
    expect(avant).toBeNull(); // pas encore entraîné sur la mesure de lumière

    const resultat = await executerEntrainementStudio(uid, {
      projet: PROJET,
      domaine: DOMAINE,
      ressources: [TEXTE_CODE],
    });
    expect(resultat.rapport.evaluation.horsDomaine.regression).toBe(false);
    const apres = await consulterMemoireUtilisateur("Comment mesurer l'intensité lumineuse ?", uid);
    expect(apres).not.toBeNull();
    expect(apres?.texte).toContain("photometre.mesure_eclairement");
  });
});

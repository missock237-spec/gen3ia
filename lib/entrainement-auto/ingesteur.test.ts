import { describe, expect, it } from "vitest";

import {
  convertirEchantillon,
  convertirPaire,
  ingesterDataset,
  lignesDepuisContenu,
  nettoyerTexte,
} from "./ingesteur";
import { plafondsAuto } from "./plafonds";
import type { ClientHubAuto, DatasetChoisi } from "./types";

/* ------------------------------------------------------------------ */
/* L'INGESTEUR — conversion des fichiers hubs en matière d'entraînement */
/* ------------------------------------------------------------------ */

describe("nettoyerTexte", () => {
  it("supprime les caractères de contrôle et compresse les espaces", () => {
    expect(nettoyerTexte("  bonjour\u0000\u0008  monde\n\npropre  ", 100)).toBe("bonjour monde propre");
  });

  it("tronque à la longueur demandée", () => {
    expect(nettoyerTexte("a".repeat(300), 10)).toHaveLength(10);
  });

  it("refuse les valeurs non textuelles", () => {
    expect(nettoyerTexte(null, 10)).toBeNull();
    expect(nettoyerTexte(undefined, 10)).toBeNull();
    expect(nettoyerTexte({ objet: true }, 10)).toBeNull();
  });

  it("accepte un nombre fini (converti en texte)", () => {
    expect(nettoyerTexte(42, 10)).toBe("42");
  });
});

describe("convertirPaire", () => {
  it("extrait une paire question/réponse", () => {
    const paire = convertirPaire({ question: "Comment va le réseau ?", response: "312 neurones actifs." }, "theme-test");
    expect(paire).toEqual({ motif: "Comment va le réseau ?", reponse: "312 neurones actifs.", theme: "theme-test" });
  });

  it("reconnaît plusieurs alias de champs (fr, instruction, prompt…)", () => {
    const paire = convertirPaire({ fr: "Quelle heure est-il ?", answer: "Il est midi." }, "t");
    expect(paire?.motif).toBe("Quelle heure est-il ?");
  });

  it("refuse sans réponse, sans motif, trop court ou identique", () => {
    expect(convertirPaire({ question: "Une question sans réponse ?" }, "t")).toBeNull();
    expect(convertirPaire({ response: "une réponse sans question" }, "t")).toBeNull();
    expect(convertirPaire({ question: "court", response: "réponse" }, "t")).toBeNull();
    expect(convertirPaire({ question: "mots identiques ici", response: "mots identiques ici" }, "t")).toBeNull();
  });
});

describe("convertirEchantillon", () => {
  it("utilise le label explicite quand il est reconnu", () => {
    const echantillon = convertirEchantillon({ text: "génère une image de montagne", label: "generer_image" });
    expect(echantillon).toEqual({ text: "génère une image de montagne", label: "GENERER_IMAGE" });
  });

  it("retombe sur l'étiquetage lexical déterministe", () => {
    const echantillon = convertirEchantillon({ text: "crée un son d'orage lointain s'il te plaît" });
    expect(echantillon?.label).toBe("GENERER_AUDIO");
  });

  it("refuse les textes trop courts", () => {
    expect(convertirEchantillon({ text: "trop court" })).toBeNull();
    expect(convertirEchantillon({})).toBeNull();
  });
});

describe("lignesDepuisContenu", () => {
  it("parse un JSONL (lignes corrompues sautées)", () => {
    const contenu = '{"a":1}\n{corrompu}\n{"a":2}\n\n{"a":3}';
    const { lignes, avertissements } = lignesDepuisContenu(contenu, "data.jsonl", 100);
    expect(lignes).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(avertissements).toEqual([]);
  });

  it("parse un JSON tableau ou objet avec clé standard", () => {
    expect(lignesDepuisContenu('[{"x":1},{"x":2}]', "d.json", 100).lignes).toEqual([{ x: 1 }, { x: 2 }]);
    expect(lignesDepuisContenu('{"data":[{"y":1}]}', "d.json", 100).lignes).toEqual([{ y: 1 }]);
  });

  it("JSON illisible → repli JSONL honnête (avertissement)", () => {
    const { lignes, avertissements } = lignesDepuisContenu('{"a":1}\n{"a":2}', "cassee.json", 100);
    expect(lignes).toEqual([{ a: 1 }, { a: 2 }]);
    expect(avertissements).toHaveLength(1);
  });

  it("parse un CSV (délimiteur , ou ;) en lignes-records", () => {
    const csv = "question,reponse\nQui es-tu ? , Gen3ia.\n";
    const { lignes } = lignesDepuisContenu(csv, "d.csv", 100);
    // Les cellules brutes gardent leurs espaces — le nettoyage est fait à la
    // conversion (nettoyerTexte), le parseur reste fidèle au fichier.
    expect(lignes).toEqual([{ question: "Qui es-tu ? ", reponse: " Gen3ia." }]);

    const csvPointVirgule = "question;reponse\nQui es-tu ? ;Gen3ia.\n";
    const autre = lignesDepuisContenu(csvPointVirgule, "d.csv", 100);
    expect(autre.lignes).toEqual([{ question: "Qui es-tu ? ", reponse: "Gen3ia." }]);
  });

  it("parse un TXT (une ligne = un texte)", () => {
    const { lignes } = lignesDepuisContenu("ligne un\nligne deux\n", "d.txt", 100);
    expect(lignes).toEqual([{ texte: "ligne un" }, { texte: "ligne deux" }]);
  });

  it("plafonne le nombre de lignes analysées", () => {
    const contenu = Array.from({ length: 50 }, (_, i) => `{"n":${i}}`).join("\n");
    const { lignes } = lignesDepuisContenu(contenu, "d.jsonl", 10);
    expect(lignes).toHaveLength(10);
  });
});

/* ------------------------------------------------------------------ */
/* Ingestion complète d'un dataset (client factice)                     */
/* ------------------------------------------------------------------ */

const JSONL_LANGAGE = [
  { question: "Comment fonctionne le réseau Gen3 ?", response: "Un SNN à spikes entraîné par résonance." },
  { question: "Que sais-tu faire ?", response: "Générer textes, images, audio et vidéo localement." },
  { question: "Qui t'entraîne ?", response: "Je m'entraîne seule depuis les hubs de datasets." },
].map((l) => JSON.stringify(l)).join("\n");

const CSV_INTENTION = [
  "text,label",
  "génère une image de montagne enneigée,GENERER_IMAGE",
  "crée un son de pluie battante,GENERER_AUDIO",
  "fabrique une vidéo d'océan,GENERER_VIDEO",
  "exécute l'outil calculatrice,EXECUTER_OUTIL_OS",
  "appelle le contact urgence,INITIALISER_APPEL",
].join("\n");

function choixFictif(objectif: "langage" | "intention", ref = "org/jeu-de-donnees"): DatasetChoisi {
  return { provider: "huggingface", ref, titre: ref, objectif };
}

function clientFictif(contenus: Record<string, string>): ClientHubAuto {
  return {
    async inspecter(_provider, ref) {
      const contenu = contenus[ref];
      if (!contenu) throw new Error("dataset indisponible");
      return { files: [{ name: "train.jsonl", sizeBytes: Buffer.byteLength(contenu), downloadable: true }] };
    },
    async telecharger(_provider, ref) {
      const contenu = contenus[ref];
      if (!contenu) throw new Error("fichier indisponible");
      return Buffer.from(contenu, "utf8");
    },
    rechercher: async () => [],
    estConfigure: () => true,
  };
}

describe("ingesterDataset", () => {
  it("ingère un JSONL de dialogues en paires (objectif langage)", async () => {
    const client = clientFictif({ "org/dialogues": JSONL_LANGAGE });
    const apport = await ingesterDataset(
      { ...choixFictif("langage", "org/dialogues"), titre: "Dialogues" },
      { ...client, inspecter: async () => ({ files: [{ name: "train.jsonl", sizeBytes: 100, downloadable: true }] }) },
      plafondsAuto(),
      1_048_576,
    );
    expect(apport.paires).toHaveLength(3);
    expect(apport.echantillons).toHaveLength(0);
    expect(apport.paires[0]?.theme).toBe("hub:huggingface:Dialogues");
    expect(apport.octetsTelecharges).toBeGreaterThan(0);
    expect(apport.erreurs).toEqual([]);
  });

  it("ingère un CSV d'intentions en échantillons étiquetés", async () => {
    const client = clientFictif({ "org/commandes": CSV_INTENTION });
    const apport = await ingesterDataset(choixFictif("intention", "org/commandes"), {
      ...client,
      inspecter: async () => ({ files: [{ name: "train.csv", sizeBytes: 100, downloadable: true }] }),
    }, plafondsAuto(), 1_048_576);
    expect(apport.paires).toHaveLength(0);
    expect(apport.echantillons).toHaveLength(5);
    expect(apport.echantillons.every((e) => e.label !== "INTENTION_GENERALE")).toBe(true);
  });

  it("consigne honnêtement l'échec d'un fichier et continue l'autre", async () => {
    const client = clientFictif({ "org/ok": JSONL_LANGAGE });
    const apport = await ingesterDataset(
      choixFictif("langage", "org/ok"),
      {
        ...client,
        inspecter: async () => ({
          files: [
            { name: "casse.jsonl", sizeBytes: 10, downloadable: true },
            { name: "donnees.jsonl", sizeBytes: 100, downloadable: true },
          ],
        }),
        telecharger: async (_p, _ref, fichier) => {
          if (fichier === "casse.jsonl") throw new Error("téléchargement interrompu");
          return Buffer.from(JSONL_LANGAGE, "utf8");
        },
      },
      plafondsAuto(),
      1_048_576,
    );
    expect(apport.fichiersLus).toBe(1);
    expect(apport.paires).toHaveLength(3);
    expect(apport.erreurs.some((e) => e.includes("casse.jsonl") && e.includes("téléchargement interrompu"))).toBe(true);
  });

  it("refuse poliment quand le budget du cycle est épuisé", async () => {
    const client = clientFictif({ "org/dialogues": JSONL_LANGAGE });
    const apport = await ingesterDataset(choixFictif("langage", "org/dialogues"), client, plafondsAuto(), 0);
    expect(apport.paires).toHaveLength(0);
    expect(apport.erreurs[0]).toContain("Budget");
  });

  it("les plafonds de paires sont réellement appliqués", async () => {
    const lignes = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ question: `Question très différente numéro ${i} ?`, response: `Réponse distincte ${i}.` }),
    ).join("\n");
    const client = clientFictif({ "org/grand": lignes });
    const plafonds = { ...plafondsAuto(), maxPairesParDataset: 20 };
    const apport = await ingesterDataset(choixFictif("langage", "org/grand"), {
      ...client,
      inspecter: async () => ({ files: [{ name: "train.jsonl", sizeBytes: 100, downloadable: true }] }),
    }, plafonds, 1_048_576);
    expect(apport.paires).toHaveLength(20);
  });
});

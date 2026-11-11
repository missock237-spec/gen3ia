import { describe, expect, it } from "vitest";

import { estArchive7z, estArchiveTar, lireTar } from "./tar-text";

// ────────────────────────────────────────────────────────────────────────────
// Lecteur TAR natif — archives construites octet par octet dans le test
// (vérité terrain) : en-têtes 512 o, checksum vérifiée, extraction texte,
// refus corrompu, signature 7z réelle.
// ────────────────────────────────────────────────────────────────────────────

const TAILLE_BLOC = 512;

interface EntreeTarTest {
  chemin: string;
  donnees?: Buffer;
  type?: string;
}

function enteteTar(entree: EntreeTarTest): Buffer {
  const bloc = Buffer.alloc(TAILLE_BLOC);
  const nom = entree.chemin.slice(0, 99);
  bloc.write(nom, 0, "utf8");
  bloc.write("0000644\0", 100, "ascii"); // mode
  bloc.write("0001750\0", 108, "ascii"); // uid
  bloc.write("0001750\0", 116, "ascii"); // gid
  const taille = entree.donnees?.length ?? 0;
  bloc.write(taille.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  bloc.write("00000000000\0", 136, "ascii"); // mtime
  bloc.write("        ", 148, "ascii"); // checksum (espaces pour le calcul)
  bloc.write(entree.type ?? "0", 156, "ascii"); // typeflag
  bloc.write("ustar\0", 257, "ascii"); // magic
  bloc.write("00", 263, "ascii"); // version

  let somme = 0;
  for (const octet of bloc) somme += octet;
  bloc.write(somme.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return bloc;
}

function construireTar(entrees: EntreeTarTest[]): Buffer {
  const morceaux: Buffer[] = [];
  for (const entree of entrees) {
    morceaux.push(enteteTar(entree));
    if (entree.donnees && entree.donnees.length > 0) {
      morceaux.push(entree.donnees);
      const remplissage = (TAILLE_BLOC - (entree.donnees.length % TAILLE_BLOC)) % TAILLE_BLOC;
      if (remplissage > 0) morceaux.push(Buffer.alloc(remplissage));
    }
  }
  morceaux.push(Buffer.alloc(TAILLE_BLOC * 2)); // fin d'archive
  return Buffer.concat(morceaux);
}

describe("lecteur TAR natif (moteur documentaire)", () => {
  it("liste les entrées et extrait le texte des fichiers lisibles", () => {
    const tar = construireTar([
      { chemin: "notes/", type: "5" },
      { chemin: "notes/rapport.txt", donnees: Buffer.from("Bilan annuel complet.\nChiffres vérifiés.", "utf8") },
      { chemin: "bin/data.bin", donnees: Buffer.from([0, 1, 2, 3, 255]) },
    ]);

    const lecture = lireTar(tar);
    expect(lecture.entrees.map((e) => e.chemin)).toEqual([
      "notes/",
      "notes/rapport.txt",
      "bin/data.bin",
    ]);
    expect(lecture.entrees[0].type).toBe("dossier");
    expect(lecture.entrees[1].type).toBe("fichier");

    expect(lecture.fichiersTexte).toHaveLength(1);
    expect(lecture.fichiersTexte[0].chemin).toBe("notes/rapport.txt");
    expect(lecture.fichiersTexte[0].contenu).toContain("Bilan annuel");
    // Le fichier binaire est listé mais PAS servi comme texte.
    expect(lecture.erreurs).toHaveLength(0);
  });

  it("interrompt la lecture sur une checksum corrompue avec une erreur nommée", () => {
    const tar = construireTar([
      { chemin: "sain.txt", donnees: Buffer.from("contenu propre", "utf8") },
      { chemin: "abime.txt", donnees: Buffer.from("contenu abimé", "utf8") },
    ]);
    // Corromps un octet du DEUXIÈME en-tête (à 1024 : après l'en-tête 512 o
    // de l'entrée 1 + ses données paddées à 512 o) sans recalculer la
    // checksum : la première entrée reste lue, la corruption est nommée, la
    // lecture s'arrête proprement (aucune donnée fantôme).
    tar[1024 + 3] = 0x58;
    const lecture = lireTar(tar);
    expect(lecture.entrees.map((e) => e.chemin)).toEqual(["sain.txt"]);
    expect(lecture.erreurs.join(" ")).toContain("checksum");
  });

  it("rejette une archive non alignée", () => {
    expect(() => lireTar(Buffer.alloc(100))).toThrow(/512/);
  });

  it("reconnaît la signature 7z réelle", () => {
    const sept = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]);
    expect(estArchive7z(sept)).toBe(true);
    expect(estArchive7z(Buffer.from("PK\x03\x04blabla", "latin1"))).toBe(false);
  });

  it("reconnaît un TAR par son magic ustar", () => {
    const tar = construireTar([{ chemin: "a.txt", donnees: Buffer.from("x", "utf8") }]);
    expect(estArchiveTar(tar)).toBe(true);
    expect(estArchiveTar(Buffer.from("texte quelconque, pas un tar"))).toBe(false);
  });
});

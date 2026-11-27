/**
 * Tests — OUTIL « database.query » (lecture seule, node:sqlite).
 *
 * On vérifie le contrat RÉEL : lignes réelles renvoyées depuis une base
 * SQLite de test, garde lecture seule (INSERT/multi-statement/mots-clés
 * d'écriture rejetés AVANT ouverture), plafonnement LIMIT honnête, erreurs
 * de chemin explicites. node:sqlite est disponible sur le runtime de test
 * (Node ≥ 22.13) — sinon les tests sont sautés honnêtement.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { databaseQueryTool, plafonnerLimit, validerRequeteLecture } from "./query";

let nodeSqliteDisponible = true;
let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  nodeSqliteDisponible = false;
}

const dirTemp = mkdtempSync(join(tmpdir(), "gen3-db-"));
const cheminBase = join(dirTemp, "test.sqlite");
afterAll(() => rmSync(dirTemp, { recursive: true, force: true }));

if (nodeSqliteDisponible) {
  const db = new DatabaseSync(cheminBase);
  db.exec("CREATE TABLE articles (id INTEGER PRIMARY KEY, titre TEXT, prix REAL);");
  db.exec("INSERT INTO articles (titre, prix) VALUES ('cartable', 42.5), ('stylo', 1.2), ('cahier', 3.0);");
  db.close();
}

describe.skipIf(!nodeSqliteDisponible)("database.query — exécution réelle", () => {
  it("renvoie les lignes réelles d'un SELECT paramétré", async () => {
    const resultat = await databaseQueryTool.execute(
      {
        chemin: cheminBase,
        requete: "SELECT titre, prix FROM articles WHERE prix > ? ORDER BY prix",
        parametres: [2],
      },
      { userId: "test-user" },
    );
    expect(resultat.succes).toBe(true);
    expect(resultat.nbLignes).toBe(2);
    expect(resultat.colonnes).toEqual(["titre", "prix"]);
    expect(resultat.lignes[0]).toMatchObject({ titre: "cahier", prix: 3 });
    expect(resultat.lignes[1]).toMatchObject({ titre: "cartable", prix: 42.5 });
    expect(resultat.limitPlafonne).toBe(true); // LIMIT ajouté (absent de la requête)
  });

  it("respecte un LIMIT déjà plafonné (pas de réécriture)", async () => {
    const resultat = await databaseQueryTool.execute(
      { chemin: cheminBase, requete: "SELECT id FROM articles LIMIT 2" },
      { userId: "test-user" },
    );
    expect(resultat.nbLignes).toBe(2);
    expect(resultat.limitPlafonne).toBe(false);
  });

  it("rejette l'écriture AVANT toute ouverture de base", async () => {
    await expect(
      databaseQueryTool.execute(
        { chemin: cheminBase, requete: "INSERT INTO articles (titre) VALUES ('pirate')" },
        { userId: "test-user" },
      ),
    ).rejects.toThrow(/Lecture seule/);
    await expect(
      databaseQueryTool.execute(
        { chemin: cheminBase, requete: "DELETE FROM articles" },
        { userId: "test-user" },
      ),
    ).rejects.toThrow(/Lecture seule/);
    await expect(
      databaseQueryTool.execute(
        { chemin: cheminBase, requete: "WITH x AS (SELECT 1) SELECT * FROM articles; DROP TABLE articles" },
        { userId: "test-user" },
      ),
    ).rejects.toThrow(/une seule requête/i);
    // La table est intacte (l'écriture n'a jamais eu lieu).
    const verif = await databaseQueryTool.execute(
      { chemin: cheminBase, requete: "SELECT COUNT(*) AS n FROM articles" },
      { userId: "test-user" },
    );
    expect(verif.lignes[0]).toMatchObject({ n: 3 });
  });

  it("signale honnêtement les erreurs de chemin", async () => {
    await expect(
      databaseQueryTool.execute({ chemin: join(dirTemp, "absente.db"), requete: "SELECT 1" }, { userId: "test-user" }),
    ).rejects.toThrow(/introuvable/i);
    await expect(
      databaseQueryTool.execute({ chemin: join(dirTemp, "texte.txt"), requete: "SELECT 1" }, { userId: "test-user" }),
    ).rejects.toThrow(/non SQLite/i);
  });
});

describe("database.query — gardes pures (sans base)", () => {
  it("validerRequeteLecture : SELECT/WITH seuls sont admis", () => {
    expect(validerRequeteLecture("SELECT 1")).toEqual({ ok: true });
    expect(validerRequeteLecture("WITH t AS (SELECT 1) SELECT * FROM t")).toEqual({ ok: true });
    expect(validerRequeteLecture("UPDATE t SET x = 1").ok).toBe(false);
    expect(validerRequeteLecture("select 1; select 2").ok).toBe(false);
    expect(validerRequeteLecture("PRAGMA writable_schema = 1").ok).toBe(false);
    expect(validerRequeteLecture("").ok).toBe(false);
  });

  it("plafonnerLimit : ajoute ou borne honnêtement", () => {
    expect(plafonnerLimit("SELECT 1")).toEqual({ requete: "SELECT 1 LIMIT 200", plafonne: true });
    expect(plafonnerLimit("SELECT 1 LIMIT 50")).toEqual({ requete: "SELECT 1 LIMIT 50", plafonne: false });
    const borne = plafonnerLimit("SELECT 1 LIMIT 10000");
    expect(borne.plafonne).toBe(true);
    expect(borne.requete).toContain("LIMIT 200");
  });

  it("le fichier de test a bien été créé dans un répertoire temporaire", () => {
    expect(cheminBase.startsWith(tmpdir())).toBe(true);
    expect(() => writeFileSync(cheminBase + ".probe", "x")).not.toThrow();
  });
});

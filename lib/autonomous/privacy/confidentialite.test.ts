/**
 * TESTS DE CONFIDENTIALITÉ DÉDIÉS (Lot 5 — RÈGLE 4 de la mission :
 * « Les données privées des utilisateurs ne doivent jamais entrer dans
 * l'entraînement global »).
 *
 * Ces tests vérifient TECHNIQUEMENT le Privacy Firewall :
 *  - liste blanche (refus par défaut de tout chemin non explicitement
 *    autorisé) ;
 *  - isolation des espaces utilisateurs (users/, user/, personal/, private/)
 *    — JAMAIS lisibles par le pipeline d'entraînement global ;
 *  - anti-traversée de répertoires (../, chemins absolus, encodages) ;
 *  - le lecteur de fichiers n'est JAMAIS invoqué pour un chemin refusé ;
 *  - détection de contenus privés détournés dans les sources de lots ;
 *  - garde structurel de cohérence des listes.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PREFIXES_AUTORISES,
  PREFIXES_UTILISATEURS,
  detecterCheminPrive,
  isolationCoherente,
  lireSiAutorise,
  verifierAccesEntrainement,
} from "../privacy/firewall";

let core: string;
beforeEach(() => {
  core = mkdtempSync(join(tmpdir(), "privacy-core-"));
  for (const p of PREFIXES_AUTORISES) {
    mkdirSync(join(core, p.replace(/\/$/u, "")), { recursive: true });
    writeFileSync(join(core, p, "lot-ok.json"), JSON.stringify({ source: "publique" }), "utf8");
  }
  for (const p of PREFIXES_UTILISATEURS) {
    mkdirSync(join(core, p.replace(/\/$/u, "")), { recursive: true });
    writeFileSync(join(core, p, "secret-utilisateur.json"), JSON.stringify({ donnee: "PRIVÉE" }), "utf8");
  }
});
afterEach(() => {
  rmSync(core, { recursive: true, force: true });
});

describe("RÈGLE 4 — les données privées n'entrent JAMAIS dans l'entraînement global", () => {
  it("chaque préfixe utilisateur est REFUSÉ au pipeline d'entraînement (propriété complète)", () => {
    for (const prefixe of PREFIXES_UTILISATEURS) {
      const v = verifierAccesEntrainement(`${prefixe}secret-utilisateur.json`, core);
      expect(v.autorise).toBe(false);
      expect(v.raison).toMatch(/utilisateur|interdit|isolation/u);
    }
  });

  it("tout chemin HORS liste blanche est refusé par défaut (refus par défaut, pas liste noire)", () => {
    for (const chemin of ["conversations/chat.json", "memoire-personnelle/episodes.bin", "export/compte.zip", "brain-v1.json", ""]) {
      expect(verifierAccesEntrainement(chemin, core).autorise).toBe(false);
    }
  });

  it("l'espace autorisé (acquisition/pipeline/connaissances) reste lisible par le pipeline", () => {
    for (const prefixe of PREFIXES_AUTORISES) {
      const v = verifierAccesEntrainement(`${prefixe}lot-ok.json`, core);
      expect(v.autorise).toBe(true);
    }
  });

  it("le lecteur de fichiers n'est JAMAIS invoqué pour un chemin refusé (pas de fuite par effet de bord)", () => {
    let lectures = 0;
    const lecteurEspion = () => {
      lectures += 1;
      return "contenu-sensible";
    };
    const refuse = lireSiAutorise("users/secret-utilisateur.json", core, lecteurEspion);
    expect(refuse.autorise).toBe(false);
    expect(refuse.contenu).toBeUndefined();
    expect(lectures).toBe(0); // le lecteur espion n'a PAS été appelé
  });

  it("lireSiAutorise lit uniquement l'espace autorisé", () => {
    const ok = lireSiAutorise("connaissances/lot-ok.json", core, (p) => require("node:fs").readFileSync(p, "utf8"));
    expect(ok.autorise).toBe(true);
    expect(JSON.parse(ok.contenu ?? "{}")).toEqual({ source: "publique" });
  });
});

describe("RÈGLE 6 — traversées de répertoires toutes refusées", () => {
  it("les traversées hors du core sont refusées", () => {
    for (const chemin of ["../../etc/passwd", "acquisition/../../../etc/shadow", "connaissances/../../users/secret.json"]) {
      const v = verifierAccesEntrainement(chemin, core);
      expect(v.autorise).toBe(false);
    }
  });

  it("les chemins absolus sont refusés (liste blanche relative uniquement)", () => {
    expect(verifierAccesEntrainement("/etc/passwd", core).autorise).toBe(false);
    expect(verifierAccesEntrainement(`${core}/users/secret-utilisateur.json`, core).autorise).toBe(false);
  });

  it("une traversée qui retombe dans l'espace utilisateur est refusée même si le préfixe final semble légal", () => {
    // acquisition/../users/… normalise vers users/… — doit rester refusé.
    const v = verifierAccesEntrainement("acquisition/../users/secret-utilisateur.json", core);
    expect(v.autorise).toBe(false);
    expect(v.raison).toMatch(/utilisateur/u);
  });

  it("erreur inattendue → refus fail-closed (jamais d'accès par exception)", () => {
    const v = verifierAccesEntrainement(null as unknown as string, core);
    expect(v.autorise).toBe(false);
    expect(v.raison).toMatch(/fail-closed/u);
  });
});

describe("RÈGLE 6 — sources de lots : contenus privés détournés détectés", () => {
  it("un contenu prétendant venir d'un espace utilisateur est détecté AVANT traitement", () => {
    for (const source of ["users/journal.txt", "personal/notes.md", "private/photos.zip", "C:\\data\\user\\cv.pdf"]) {
      expect(detecterCheminPrive(source)).toBe(true);
    }
  });

  it("les URL publiques normales passent (la collecte légitime n'est pas brimée)", () => {
    expect(detecterCheminPrive("https://fr.wikipedia.org/wiki/Apprentissage_profond")).toBe(false);
    expect(detecterCheminPrive("acquisition/wikipedia/lot-123.json")).toBe(false);
  });
});

describe("garde structurel du firewall", () => {
  it("les listes blanche/interdite n'ont AUCUN chevauchement (audit de cohérence)", () => {
    expect(isolationCoherente()).toBe(true);
  });

  it("la liste blanche est non vide et les deux listes sont disjointes par construction", () => {
    expect(PREFIXES_AUTORISES.length).toBeGreaterThan(0);
    for (const a of PREFIXES_AUTORISES) {
      for (const b of PREFIXES_UTILISATEURS) {
        expect(a.startsWith(b)).toBe(false);
        expect(b.startsWith(a)).toBe(false);
      }
    }
  });
});

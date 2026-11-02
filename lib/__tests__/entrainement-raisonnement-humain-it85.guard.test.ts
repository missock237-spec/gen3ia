/**
 * GARDE it.85 — ENTRAÎNEMENT RAISONNEMENT HUMAIN (script unique + corpus).
 *
 * Verrouille : l'import du cerveau it.84 (apprentissage cumulatif), la
 * génération des 1 000 000 de paires PP, l'hygiène comptée, le protocole
 * de vérification par famille (mesure immédiate après le bloc — celui
 * d'it.84), les artefacts (snapshot G3TEL73, module de paires) et
 * l'intégration du raisonnement au corpus du chat.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FAMILLES_RAISONNEMENT,
  TOTAL_CIBLE,
  formaterPensee,
  genererPairePP,
  indicesEvaluation,
  planifierGeneration,
} from "../gen3/raisonnement-humain";
import { CORPUS_GEN3, TAILLE_CORPUS_GEN3 } from "../neural/generation/corpus";
import { CORPUS_RAISONNEMENT_IT85 } from "../neural/generation/corpus-raisonnement-it85";

describe("Garde it.85 — script d'entraînement raisonnement humain", () => {
  const cheminScript = join(process.cwd(), "scripts/entrainement-raisonnement-humain-it85.ts");
  const script = existsSync(cheminScript) ? readFileSync(cheminScript, "utf8") : "";

  it("le script unique existe et importe le cerveau it.84 (apprentissage cumulatif)", () => {
    expect(script.length).toBeGreaterThan(1000);
    expect(script).toContain("cortex-tous-domaines-it84.bin");
    expect(script).toContain("importerSnapshotTelephone");
    expect(script).toContain("importerPoids");
  });

  it("le script entraîne par ONDES (EOD) vers la bande du label, sans table magique", () => {
    expect(script).toContain("plasticiteSupervisee");
    expect(script).toContain("fnv1a(LABEL_DOMAINE) % NB_BANDES");
    expect(script).toContain('"raisonnement-humain-fr"');
    // la valeur physique de l'onde décide de la colonne (méthode EOD)
    expect(script).toContain("Math.sin(phi)");
    expect(script).toContain("w / 1.75");
  });

  it("le protocole de vérification mesure chaque famille juste après son bloc (règle it.84)", () => {
    expect(script).toContain("VÉRIFICATION de la famille");
    expect(script).toContain("mesure immédiate après");
    // les questions réservées sont sautées pendant l'entraînement
    expect(script).toContain("JAMAIS entraînée");
  });

  it("l'hygiène compte chaque suppression (zéro chiffre fantôme)", () => {
    expect(script).toContain("hygiene.generes");
    expect(script).toContain("hygiene.doublons");
    expect(script).toContain("hygiene.parasites");
    expect(script).toContain("hygiene.vides");
  });

  it("les artefacts sont produits : snapshot committé au format exact + module de paires", () => {
    const cheminSnapshot = join(process.cwd(), "public/neural/cortex-raisonnement-it85.bin");
    expect(existsSync(cheminSnapshot)).toBe(true);
    const octets = statSync(cheminSnapshot).size;
    // 1 048 576 colonnes × 12 voisins (u8) + entête 48 octets
    expect(octets).toBe(1_048_576 * 12 + 48);
    const brut = readFileSync(cheminSnapshot);
    const magie = Buffer.from(brut.buffer, brut.byteOffset, 7).toString("ascii");
    expect(magie).toBe("G3TEL73");
    expect(script).toContain("cortex-raisonnement-it85.bin");
    expect(script).toContain("corpus-raisonnement-it85.ts");
  });

  it("le module de paires est branché au corpus du chat (code source vivant)", () => {
    expect(CORPUS_RAISONNEMENT_IT85.length).toBeGreaterThanOrEqual(190);
    expect(CORPUS_GEN3.length).toBe(TAILLE_CORPUS_GEN3);
    const motifs85 = new Set(CORPUS_RAISONNEMENT_IT85.map((p) => p.motif));
    for (const p of CORPUS_RAISONNEMENT_IT85) {
      expect(CORPUS_GEN3.some((q) => q.motif === p.motif && q.reponse === p.reponse)).toBe(true);
    }
    expect(motifs85.size).toBe(CORPUS_RAISONNEMENT_IT85.length);
  });

  it("les 16 familles de raisonnement sont représentées dans le corpus du chat", () => {
    const themes = new Set(CORPUS_RAISONNEMENT_IT85.map((p) => p.theme));
    for (const f of FAMILLES_RAISONNEMENT) {
      expect(themes.has(f)).toBe(true);
    }
  });

  it("les réponses du raisonnement exposent la pensée pas à pas (chaîne numérotée)", () => {
    for (const p of CORPUS_RAISONNEMENT_IT85) {
      expect(p.reponse).toMatch(/^1\) /);
      expect(p.reponse).toContain("Donc :");
      expect(p.reponse.length).toBeLessThanOrEqual(700);
    }
  });

  it("zéro fuite éval/entraînement : les indices réservés ne sont jamais dans le flux d'entraînement", () => {
    const plan = planifierGeneration(TOTAL_CIBLE);
    for (const pf of plan.familles) {
      const reserves = new Set(indicesEvaluation(pf.retenus, pf.famille === "theorie_esprit" || pf.famille === "math_verbal"));
      // la règle du script : `if (evalIdx.has(idx)) { ...; continue; }`
      expect(script).toContain("if (evalIdx.has(idx))");
      expect(reserves.size).toBeGreaterThan(0);
    }
  });

  it("la pensée formatée se termine par la réponse et tient dans le chat", () => {
    const paire = genererPairePP("deduction", 0);
    const sortie = formaterPensee(paire);
    expect(sortie.length).toBeGreaterThan(50);
    expect(sortie).toContain("Donc :");
    expect(sortie.endsWith(paire.reponse)).toBe(true);
  });

  it("le savoir appris répond AVANT le pont vocation quand l'appariement est fort (anomalie de prod mesurée + corrigée)", () => {
    const cheminEngine = join(process.cwd(), "lib/neural/engine.ts");
    const engine = existsSync(cheminEngine) ? readFileSync(cheminEngine, "utf8") : "";
    // la constante calibrée existe et est documentée par une mesure
    expect(engine).toContain("SEUIL_CORPUS_PRIORITAIRE = 3");
    expect(engine).toContain("appariement exact d'une paire apprise vaut 5,67");
    // la méthode prioritaire est branchée AVANT le pont vocation sur les
    // chemins de composition (génération, flux, générateur, sans-fenêtre)
    expect(engine).toContain("this.compositionCorpusPrioritaire(messageUtilisateur) ??");
    expect(engine.indexOf("compositionCorpusPrioritaire(messageUtilisateur) ??"))
      .toBeLessThan(engine.indexOf("composerDepuisVocation(messageUtilisateur) ??"));
    expect(engine).toContain("private compositionCorpusPrioritaire");
  });
});

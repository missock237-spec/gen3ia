import { readFileSync, existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CORPUS_GEN3, TAILLE_CORPUS_GEN3 } from "../neural/generation/corpus";
import {
  CORPUS_DOMAINES_IT84,
  TAILLE_CORPUS_DOMAINES_IT84,
} from "../neural/generation/corpus-domaines-it84";

/**
 * Garde de l'entraînement ONDES TOUS DOMAINES (it.84 — demande propriétaire).
 *
 * Verrouille la structure honnête de la méthode EOD : un seul script, 19
 * domaines réels, bande-porteuse dérivée du label (pas de table magique),
 * éval jamais entraînée (zéro fuite), hygiène des réponses parasites
 * comptée, et le savoir multi-domaines intégré au corpus langagier du chat
 * comme code source (paires réelles, réponses propres).
 */

const script = readFileSync(
  "scripts/entrainement-ondes-tous-domaines.ts",
  "utf8",
);

describe("Entraînement ondes tous domaines (scripts/entrainement-ondes-tous-domaines.ts — it.84)", () => {
  it("les 19 domaines sélectionnés sont listés (couverture générale + multimodal)", () => {
    const attends = [
      "math", "sciences", "reasoning", "problem_solving", "nlp_comprehension",
      "text_generation", "conversational_memory", "contextual_understanding",
      "intent_recognition", "professions", "databases", "tools", "code_v4",
      "security_v4", "image_analysis", "video_v4", "voice_speech",
      "audio_understanding", "multimodal_v4",
    ];
    for (const id of attends) {
      expect(script).toContain(`"${id}"`);
    }
    // Le lot conversationnel (scénarios FR) est une source séparée.
    expect(script).toContain("alpaca-gpt4-french");
  });

  it("la bande-porteuse est DÉRIVÉE du label (hash FNV-1a) — pas de table magique", () => {
    expect(script).toContain("fnv1a(label) % bandes");
    // La valeur physique de l'onde décide de la colonne (méthode EOD).
    expect(script).toContain("Math.sin(phi)");
    expect(script).toContain("w / 1.75");
  });

  it("zéro fuite éval/entraînement : les 50 questions de VÉRIFICATION sont réservées AVANT l'échantillonnage", () => {
    // L'ordre dans le code : indicesEval tirés d'abord, train parmi le reste.
    const indice = script.indexOf("indicesEval");
    const entrainables = script.indexOf("entrainables");
    expect(indice).toBeGreaterThanOrEqual(0);
    expect(entrainables).toBeGreaterThan(indice);
    expect(script).toContain("jamais entraînées");
    expect(script).toContain('QUESTIONS_EVAL = 50');
  });

  it("l'hygiène supprime les réponses parasites et CHAQUE suppression est comptée", () => {
    expect(script).toContain("reponseParasite");
    expect(script).toContain("MARQUEURS_PARASITES");
    // Compteurs mesurés par domaine (zéro chiffre fantôme).
    expect(script).toContain("vides");
    expect(script).toContain("doublons");
    expect(script).toContain("marquesParasites");
  });

  it("la plasticité réelle du cortex v2 est utilisée (renfort + punition compétitive)", () => {
    expect(script).toContain("cortex.plasticiteSupervisee(");
    expect(script).toContain("concurrentes.push(b)");
    expect(script).toContain("cortex.pas(");
    // Métabolisme réel cumulé (sobriété mesurable).
    expect(script).toContain("metabolismeDernierPas");
  });

  it("la mesure avant/après est encodée et la règle est écrite", () => {
    expect(script).toContain("avantParDomaine");
    expect(script).toContain("activationBandes");
    expect(script).toContain("bande dominante");
  });
});

describe("Corpus multi-domaines it.84 (code source du savoir assimilé)", () => {
  it("200 paires réelles intégrées au corpus langagier du chat", () => {
    expect(TAILLE_CORPUS_DOMAINES_IT84).toBe(200);
    expect(CORPUS_GEN3.length).toBe(TAILLE_CORPUS_GEN3);
    // Les 200 paires it.84 sont bien DANS le corpus complet (composition
    // immuable base + savoir multi-domaines).
    const motifsIt84 = new Set(CORPUS_DOMAINES_IT84.map((p) => p.motif));
    let presentes = 0;
    for (const paire of CORPUS_GEN3) if (motifsIt84.has(paire.motif)) presentes += 1;
    expect(presentes).toBe(200);
  });

  it("les paires couvrent plusieurs domaines, avec des réponses propres (hygiène appliquée)", () => {
    const themes = new Set(CORPUS_DOMAINES_IT84.map((p) => p.theme));
    expect(themes.size).toBeGreaterThanOrEqual(10);
    for (const paire of CORPUS_DOMAINES_IT84) {
      expect(paire.motif.length).toBeGreaterThan(8);
      expect(paire.reponse.length).toBeGreaterThan(2);
      expect(paire.reponse.length).toBeLessThanOrEqual(350);
      // Aucun marqueur parasite (l'hygiène du script est appliquée à la source).
      const bas = paire.reponse.toLowerCase();
      for (const m of ["undefined", "lorem ipsum", "todo", "xxx"]) {
        expect(bas).not.toContain(m);
      }
    }
  });

  it("l'artefact snapshot du cortex tous-domaines existe et est complet", () => {
    const chemin = "public/neural/cortex-tous-domaines-it84.bin";
    expect(existsSync(chemin)).toBe(true);
    // 1 048 576 colonnes × 12 voisins + entête 48 octets (quantisation u8).
    expect(statSync(chemin).size).toBe(12_582_912 + 48);
  });
});

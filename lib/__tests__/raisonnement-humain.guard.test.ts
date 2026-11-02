/**
 * GARDE it.85 — GÉNÉRATEUR DE RAISONNEMENT HUMAIN.
 *
 * Verrouille la demande propriétaire : « apprendre à gen3 à raisonner
 * comme un humain, 1 million de datasets PP ». Chaque règle encodée ici
 * est une règle réelle du générateur (lib/gen3/raisonnement-humain.ts) :
 * 16 familles, décodage injectif déterministe, plan de 1 000 000 sous
 * plafond de capacité, 50 questions de vérification réservées, hygiène
 * intégrée (aucun marqueur parasite), format de pensée numéroté.
 */

import { describe, expect, it } from "vitest";

import {
  CAPACITES,
  FAMILLES_RAISONNEMENT,
  NOMBRE_EVAL_TOTAL,
  TOTAL_CIBLE,
  evalExtraPour,
  formaterPensee,
  genererPairePP,
  indicesEvaluation,
  planifierGeneration,
} from "../gen3/raisonnement-humain";

function fnv1a(chaine: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < chaine.length; i++) {
    h ^= chaine.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const MARQUEURS_PARASITES = ["undefined", "nan", "lorem ipsum", "todo", "xxx", "###"];

describe("Garde it.85 — générateur de raisonnement humain", () => {
  it("expose exactement les 16 familles de raisonnement humain", () => {
    expect(FAMILLES_RAISONNEMENT).toHaveLength(16);
    for (const f of [
      "deduction", "conditionnel", "induction", "abduction", "analogie",
      "causalite", "sens_commun", "theorie_esprit", "planification",
      "math_verbal", "pragmatique", "ethique_pratique", "spatial",
      "temporel", "metacognition", "resolution_probleme",
    ] as const) {
      expect(FAMILLES_RAISONNEMENT).toContain(f);
    }
  });

  it("la capacité totale dépasse la cible d'un million (marge réelle)", () => {
    const somme = FAMILLES_RAISONNEMENT.reduce((s, f) => s + CAPACITES[f], 0);
    expect(somme).toBeGreaterThanOrEqual(TOTAL_CIBLE);
  });

  it("le plan à 1 000 000 est exact, sous capacité, et nourrit toutes les familles", () => {
    const plan = planifierGeneration(TOTAL_CIBLE);
    expect(plan.verification.somme).toBe(TOTAL_CIBLE);
    expect(plan.verification.sousCapacite).toBe(true);
    for (const f of FAMILLES_RAISONNEMENT) {
      const pf = plan.familles.find((p) => p.famille === f)!;
      expect(pf.retenus).toBeGreaterThan(0);
      expect(pf.retenus).toBeLessThanOrEqual(CAPACITES[f]);
    }
  });

  it("le générateur est déterministe (même index → même paire)", () => {
    for (const f of FAMILLES_RAISONNEMENT) {
      const pas = Math.max(1, Math.floor(CAPACITES[f] / 25));
      for (let i = 0; i < CAPACITES[f]; i += pas) {
        const a = genererPairePP(f, i);
        const b = genererPairePP(f, i);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }
    }
  });

  it("le décodage est injectif : zéro collision de prompt (petites familles exhaustives + échantillon des grosses)", () => {
    const plan = planifierGeneration(TOTAL_CIBLE);
    const vus = new Set<string>();
    for (const pf of plan.familles) {
      const exhaustif = CAPACITES[pf.famille] <= 40_000;
      const pas = exhaustif ? 1 : Math.max(1, Math.floor(CAPACITES[pf.famille] / 5_000));
      for (let i = 0; i < CAPACITES[pf.famille]; i += pas) {
        const cle = genererPairePP(pf.famille, i).prompt.toLowerCase().replace(/\s+/g, " ").trim();
        expect(vus.has(cle)).toBe(false);
        vus.add(cle);
      }
    }
  });

  it("chaque paire porte une pensée pas à pas et une réponse non vide", () => {
    for (const f of FAMILLES_RAISONNEMENT) {
      const p = genererPairePP(f, 0);
      expect(p.pensee.length).toBeGreaterThanOrEqual(2);
      expect(p.reponse.length).toBeGreaterThan(2);
      const texte = formaterPensee(p);
      expect(texte).toMatch(/^1\) /);
      expect(texte).toContain("Donc :");
    }
  });

  it("aucun marqueur parasite dans les paires générées (échantillon large)", () => {
    for (const f of FAMILLES_RAISONNEMENT) {
      const pas = Math.max(1, Math.floor(CAPACITES[f] / 300));
      for (let i = 0; i < CAPACITES[f]; i += pas) {
        const p = genererPairePP(f, i);
        const bas = `${p.prompt} ${p.reponse}`.toLowerCase();
        for (const m of MARQUEURS_PARASITES) {
          // « nan » n'est parasite que comme mot isolé (faux positif de
          // « maintenant » exclu par la règle du mot entier)
          if (m === "nan") {
            expect(bas.includes(" nan ") || bas.startsWith("nan ")).toBe(false);
          } else {
            expect(bas.includes(m)).toBe(false);
          }
        }
      }
    }
  });

  it("50 questions de vérification sont réservées (3 par famille + 2 familles majeures) et jamais en début de série", () => {
    const plan = planifierGeneration(TOTAL_CIBLE);
    let total = 0;
    for (const pf of plan.familles) {
      const idx = indicesEvaluation(pf.retenus, evalExtraPour(pf.famille));
      total += idx.length;
      for (const i of idx) {
        expect(i).toBeGreaterThan(0);
        expect(i).toBeLessThan(pf.retenus);
      }
      if (evalExtraPour(pf.famille)) expect(idx.length).toBe(4);
    }
    expect(total).toBe(NOMBRE_EVAL_TOTAL);
    expect(total).toBe(50);
    expect(evalExtraPour("theorie_esprit")).toBe(true);
    expect(evalExtraPour("math_verbal")).toBe(true);
    expect(evalExtraPour("deduction")).toBe(false);
  });

  it("la bande-porteuse du domaine est dérivée du label (aucune table magique) et libre vis-à-vis d'it.84", () => {
    // Le label du domaine it.85 : hash FNV-1a du label % 32 = bande 0.
    // Bande 0 : libre (aucun des 19 domaines it.84 ni le conversationnel),
    // et structurellement audible (région CSR 0-7 ≈ 1,1 arête/colonne,
    // mesurée — les bandes 8+ sont sourdes ≈ 0,125 arête/colonne).
    const bande = fnv1a("raisonnement-humain-fr") % 32;
    expect(bande).toBe(0);
    const it84: Record<string, number> = {};
    for (const l of ["math", "sciences", "reasoning", "problem_solving", "nlp_comprehension", "text_generation", "conversational_memory", "contextual_understanding", "intent_recognition", "professions", "databases", "tools", "code_v4", "security_v4", "image_analysis", "video_v4", "voice_speech", "audio_understanding", "multimodal_v4", "conversation_scenario"]) {
      it84[l] = fnv1a(l) % 32;
    }
    expect(Object.values(it84)).not.toContain(0);
  });
});

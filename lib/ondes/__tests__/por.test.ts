import { describe, expect, it } from "vitest";

import { MoteurCpu } from "../champ";
import {
  attestationPourPaquet,
  cleConfiguration,
  creerDefi,
  empreinteSpectrale,
  executerDefi,
  hacherEntrees,
  IMPULSIONS_DEFI,
  impulsionsDuDefi,
  PAS_DEFI,
  quantifierAmplitude,
  quantifierPhase,
  SECTEURS_PHASE,
  verifierAttestation,
  verifierReponseDefi,
  VerificateurPor,
} from "../por";
import { CONFIGS_EFFORT } from "../types";

const CFG_ARENE = {
  largeur: 128,
  hauteur: 128,
  pasParImage: 1,
  periodeReadback: 1,
  c2: 0.25,
  amortissement: 0.985,
  couplage: 0.1,
  dt: 0.12,
  gain: 0.016,
};

describe("Proof-of-Resonance — quantification", () => {
  it("quantifie amplitudes et phases de manière déterministe et bornée", () => {
    expect(quantifierAmplitude(0.049)).toBe(1);
    expect(quantifierAmplitude(-0.049)).toBe(-1);
    expect(quantifierPhase(0)).toBe(0);
    // Juste AVANT un tour complet : dernier secteur (jamais 128 → débordement).
    expect(quantifierPhase(Math.PI * 2 - 0.001)).toBe(SECTEURS_PHASE - 1);
    expect(quantifierPhase(Math.PI)).toBe(SECTEURS_PHASE / 2);
    expect(quantifierPhase(-Math.PI / 2)).toBe((3 * SECTEURS_PHASE) / 4);
  });

  it("hache double voie 64 bits — stable et sensible", () => {
    const a = hacherEntrees([1, 2, 3, 4, 5]);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hacherEntrees([1, 2, 3, 4, 5])).toBe(a);
    expect(hacherEntrees([1, 2, 3, 4, 6])).not.toBe(a);
    expect(hacherEntrees(new Int32Array(0))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("clé de configuration stable pour une physique identique", () => {
    expect(cleConfiguration(CONFIGS_EFFORT.faible)).toBe(cleConfiguration({ ...CONFIGS_EFFORT.faible }));
    expect(cleConfiguration(CONFIGS_EFFORT.faible)).not.toBe(cleConfiguration(CONFIGS_EFFORT.eleve));
  });
});

describe("Proof-of-Resonance — empreinte spectrale", () => {
  it("est déterministe : même champ → même empreinte", () => {
    const champ = new MoteurCpu(CFG_ARENE);
    champ.injecter([{ x: 64, y: 64, amplitude: 4, frequence: 0.1, phase: 0.5, rayon: 2.5 }]);
    for (let k = 0; k < 10; k++) champ.avancer();
    const e1 = empreinteSpectrale(champ.amplitudes(), champ.phases(), { config: CFG_ARENE });
    const e2 = empreinteSpectrale(champ.amplitudes(), champ.phases(), { config: CFG_ARENE });
    expect(e1.empreinte).toBe(e2.empreinte);
    expect(e1.spectre).toEqual(e2.spectre);
    expect(e1.spectre).toHaveLength(32);
  });

  it("change dès qu'une cellule bouge hors de la grille de quantification", () => {
    const champ = new MoteurCpu(CFG_ARENE);
    champ.injecter([{ x: 64, y: 64, amplitude: 4, frequence: 0.1, phase: 0.5, rayon: 2.5 }]);
    for (let k = 0; k < 10; k++) champ.avancer();
    const e1 = empreinteSpectrale(champ.amplitudes(), champ.phases(), { config: CFG_ARENE });
    const amp = champ.amplitudes();
    // Perturbation PHISIQUEMENT visible (>> pas de quantification 0.05).
    amp[70 * 128 + 70] += 0.6;
    const e2 = empreinteSpectrale(amp, champ.phases(), { config: CFG_ARENE });
    expect(e2.empreinte).not.toBe(e1.empreinte);
  });

  it("absorbe une dérive flottante infime (dérive GPU/CPU honnête)", () => {
    const champ = new MoteurCpu(CFG_ARENE);
    champ.injecter([{ x: 64, y: 64, amplitude: 4, frequence: 0.1, phase: 0.5, rayon: 2.5 }]);
    for (let k = 0; k < 10; k++) champ.avancer();
    const amp = champ.amplitudes().slice();
    for (let i = 0; i < amp.length; i += 11) amp[i] += 1e-4 * Math.sin(i);
    const e1 = empreinteSpectrale(champ.amplitudes(), champ.phases(), { config: CFG_ARENE });
    const e2 = empreinteSpectrale(amp, champ.phases(), { config: CFG_ARENE });
    const verdict = verifierReponseDefi(e2, e1);
    expect(verdict.valide).toBe(true);
    if (verdict.valide) expect(verdict.coherence).toBeGreaterThan(0.99);
  });

  it("lie l'empreinte au défi et à la configuration", () => {
    const champ = new MoteurCpu(CFG_ARENE);
    champ.injecter([{ x: 64, y: 64, amplitude: 4, frequence: 0.1, phase: 0.5, rayon: 2.5 }]);
    champ.avancer();
    const e1 = empreinteSpectrale(champ.amplitudes(), champ.phases(), { defi: "d1", config: CFG_ARENE });
    const e2 = empreinteSpectrale(champ.amplitudes(), champ.phases(), { defi: "d2", config: CFG_ARENE });
    const e3 = empreinteSpectrale(champ.amplitudes(), champ.phases(), { defi: "d1", config: { ...CFG_ARENE, couplage: 0.11 } });
    expect(e1.empreinte).not.toBe(e2.empreinte);
    expect(e1.empreinte).not.toBe(e3.empreinte);
    expect(e1.defi).toBe("d1");
  });
});

describe("Proof-of-Resonance — protocole défi-réponse", () => {
  it("génère des impulsions déterministes d'un défi", () => {
    const a = impulsionsDuDefi("defi-x", 128);
    const b = impulsionsDuDefi("defi-x", 128);
    const c = impulsionsDuDefi("defi-y", 128);
    expect(a).toHaveLength(IMPULSIONS_DEFI);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const imp of a) {
      expect(imp.x).toBeGreaterThanOrEqual(4);
      expect(imp.x).toBeLessThanOrEqual(124);
      expect(Math.abs(imp.amplitude)).toBeGreaterThan(0);
    }
  });

  it("exécute un défi de façon déterministe — le travail est la preuve", () => {
    const r1 = executerDefi("defi-reproductible");
    const r2 = executerDefi("defi-reproductible");
    expect(r1.empreinte).toBe(r2.empreinte);
    expect(r1.energie).toBeGreaterThan(0);
    expect(r1.ordreR).toBeGreaterThan(0);
    expect(r1.cellules).toBe(128 * 128);
  });

  it("vérifie une réponse honnête (empreinte exacte)", () => {
    const reference = executerDefi("defi-honnete");
    const reponse = executerDefi("defi-honnete");
    const verdict = verifierReponseDefi(reponse, reference);
    expect(verdict).toEqual({ valide: true, mode: "empreinte_exacte", coherence: 1 });
  });

  it("rejette un nœud qui n'exécute que la moitié des pas", () => {
    const defi = "defi-triche";
    const reference = executerDefi(defi);
    const champ = new MoteurCpu(CFG_ARENE);
    champ.injecter(impulsionsDuDefi(defi, 128));
    for (let k = 0; k < PAS_DEFI / 2; k++) champ.avancer();
    const triche = empreinteSpectrale(champ.amplitudes(), champ.phases(), { defi, config: CFG_ARENE });
    champ.detruire();
    const verdict = verifierReponseDefi(triche, reference);
    expect(verdict.valide).toBe(false);
  });

  it("rejette une réponse qui ne porte pas le défi demandé", () => {
    const reference = executerDefi("defi-demande");
    const autre = executerDefi("defi-autre");
    expect(verifierReponseDefi(autre, reference).valide).toBe(false);
    // Une empreinte qui « oublie » son défi est rejetée aussi.
    const sansDefi = { ...autre, defi: undefined };
    expect(verifierReponseDefi(sansDefi as typeof autre, reference).valide).toBe(false);
  });

  it("rejette une grille ou des métriques incompatibles", () => {
    const reference = executerDefi("defi-grille");
    const petite = executerDefi("defi-grille", { dim: 64 });
    expect(verifierReponseDefi(petite, reference)).toEqual({ valide: false, raison: "grille", coherence: 0 });
    const fausse = { ...reference, empreinte: "0000000000000000", energie: reference.energie * 4 };
    expect(verifierReponseDefi(fausse, reference).valide).toBe(false);
  });
});

describe("Proof-of-Resonance — attestations de paquets", () => {
  it("valide une attestation compacte correcte", () => {
    const empreinte = executerDefi("defi-attestation");
    const attestation = attestationPourPaquet(empreinte);
    const verdict = verifierAttestation(attestation);
    expect(verdict.valide).toBe(true);
  });

  it("rejette les formats déformés et les plausibilités physiques impossibles", () => {
    const empreinte = executerDefi("defi-invalide");
    const attestation = attestationPourPaquet(empreinte);
    expect(verifierAttestation({ ...attestation, e: "court" }).valide).toBe(false);
    expect(verifierAttestation({ ...attestation, s: [] }).valide).toBe(false);
    expect(verifierAttestation({ ...attestation, g: -1 }).valide).toBe(false);
    expect(verifierAttestation({ ...attestation, r: 2 }).valide).toBe(false);
    expect(verifierAttestation({ ...attestation, c: 3 }).valide).toBe(false);
    // Plausibilité : un champ vivant a énergie et ordre strictement positifs.
    expect(verifierAttestation({ ...attestation, g: 0 }).valide).toBe(false);
    expect(verifierAttestation({ ...attestation, r: 0 }).valide).toBe(false);
    expect(verifierAttestation(null).valide).toBe(false);
    expect(verifierAttestation("onde").valide).toBe(false);
  });
});

describe("Proof-of-Resonance — VerificateurPor (session)", () => {
  it("cycle complet : émission, réponse, vérification", () => {
    const verificateur = new VerificateurPor();
    const defi = verificateur.emettreDefi("noeud-master", () => 0.42);
    expect(defi.defi).toContain("noeud-ma");
    const reponse = executerDefi(defi.defi);
    const verdict = verificateur.verifier(reponse);
    expect(verdict.valide).toBe(true);
    expect(verificateur.nbDefisActifs).toBe(0); // le défi est consommé
  });

  it("refuse le rejeu d'une même preuve (anti-rejeu)", () => {
    const verificateur = new VerificateurPor();
    const defi = verificateur.emettreDefi("noeud-master", () => 0.1);
    const reponse = executerDefi(defi.defi);
    expect(verificateur.verifier(reponse).valide).toBe(true);
    // Le défi est consommé : toute nouvelle « vérification » est morte.
    const rejeu = verificateur.verifier(reponse);
    expect(rejeu.valide).toBe(false);
    expect(["empreinte", "expire"]).toContain(rejeu.valide ? "" : rejeu.raison);
  });

  it("répond à un défi reçu et refuse les défis expirés", () => {
    const verificateur = new VerificateurPor();
    const defiValide = creerDefi("voisin-1", () => 0.5);
    const reponse = verificateur.recevoirDefi(defiValide);
    expect(reponse).not.toBeNull();
    expect(reponse?.empreinte).toBe(executerDefi(defiValide.defi).empreinte);
    const defiPerime = { ...creerDefi("voisin-2", () => 0.6), echeance: Date.now() - 1 };
    expect(verificateur.recevoirDefi(defiPerime)).toBeNull();
  });

  it("purge les défis expirés", () => {
    const verificateur = new VerificateurPor();
    verificateur.emettreDefi("noeud-master", () => 0.3);
    expect(verificateur.nbDefisActifs).toBe(1);
    verificateur.purger(Date.now() + 10 * 60 * 1000);
    expect(verificateur.nbDefisActifs).toBe(0);
  });
});

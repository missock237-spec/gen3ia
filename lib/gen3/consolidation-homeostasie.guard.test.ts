/**
 * GARDE 37ᵉ (it.68) — LA CONSOLIDATION SOUS HOMÉOSTASIE EST RÉELLE ET
 * L'ARTEFACT NE FAÇONNE RIEN.
 *
 * Demande propriétaire (permanente) : « entraîne gen3 dans tous les
 * domaines... continue jusqu'au niveau requis ». La campagne it.68 prouve
 * par la mesure que le correctif it.67 lève la borne it.65 (25 époques de
 * re-passé SANS explosion — l'anomalie était la cascade, pas la saturation
 * locale) et que l'homéostasie ne coûte RIEN à la croissance (C3 = 13/19,
 * identique à it.66 sans homéostasie — mêmes points de sonde, même graine).
 *
 * Verrous :
 *  1. PHASE A : témoin (homéostasie OFF) et vif (ON), 25 époques,
 *     mématérial identiques, ratio transmissions fin/début < 3 (aucune
 *     explosion), horloges égales (même mécanique), les 3 constats
 *     honnêtes présents (divergence absente, équilibre de saturation,
 *     sur-consolidation) ;
 *  2. PHASE B : 1 900 000 échantillons frais (19 × 100 000, offset 10M+),
 *     C1/C2 19/19, normalisations > 0 (l'homéostasie a réellement tiré) ;
 *  3. ANTI-MQUILLAGE : C3 déclaré = comptage réel des gains > 1 dans
 *     parDomaine ; ordre des domaines = charte ; horloges cohérentes avec
 *     les paramètres (3 cycles/échantillon) ;
 *  4. STRUCTURE : homéostasie activée sur le VIF, jamais sur le TÉMOIN ;
 *     horloge de sonde 90e9 (leçon it.65) ; mécanique EOD inchangée.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { IDS_VOCATION } from "./vocation";

const CHEMIN = join(
  process.cwd(),
  "assets/neural-pretrained/consolidation-homeostasie-it68.json",
);

describe("garde 37ᵉ — consolidation homeostasie it.68", () => {
  const artefact = existsSync(CHEMIN)
    ? (JSON.parse(readFileSync(CHEMIN, "utf8")) as Record<string, unknown>)
    : null;

  it("l'artefact existe et déclare la session it.68", () => {
    expect(artefact).not.toBeNull();
    expect((artefact as { session: string }).session).toBe("consolidation-homeostasie-it68");
  });

  it("phase A — témoin sans homéostasie, vif avec, 25 époques, même matière", () => {
    const pa = (artefact as {
      phaseA: {
        temoin: { homeostasie: boolean; horlogeFinale: number };
        vif: { homeostasie: boolean; horlogeFinale: number; ratioTransmissionsFinDebut: number };
        matiere: { echantillonsTotauxTemoin: number; echantillonsTotauxVif: number };
      };
      parametres: { epoquesPhaseA: number; cyclesParEchantillon: number };
    }).phaseA;
    expect(pa.temoin.homeostasie).toBe(false);
    expect(pa.vif.homeostasie).toBe(true);
    expect((artefact as { parametres: { epoquesPhaseA: number } }).parametres.epoquesPhaseA).toBe(25);
    // Même matière, même mécanique → mêmes échantillons et mêmes horloges.
    expect(pa.matiere.echantillonsTotauxTemoin).toBe(pa.matiere.echantillonsTotauxVif);
    expect(pa.temoin.horlogeFinale).toBe(pa.vif.horlogeFinale);
    // Horloge = époques × cycles × espace (cohérence avec les paramètres).
    const cycles = (artefact as { parametres: { cyclesParEchantillon: number } }).parametres.cyclesParEchantillon;
    expect(pa.vif.horlogeFinale).toBe(25 * cycles * pa.matiere.echantillonsTotauxVif / 25);
  });

  it("phase A — AUCUNE explosion sur 25 époques (la borne it.65 est levée)", () => {
    const vif = (artefact as { phaseA: { vif: { ratioTransmissionsFinDebut: number; transmissionsParEpoque: number[] } } }).phaseA.vif;
    expect(vif.transmissionsParEpoque).toHaveLength(25);
    expect(vif.ratioTransmissionsFinDebut).toBeLessThan(3);
  });

  it("phase A — les 3 constats honnêtes sont écrits dans l'artefact", () => {
    const constats = (artefact as { phaseA: { constatHonnête?: Record<string, string>; constatHonnete?: Record<string, string> } }).phaseA;
    const c = constats.constatHonnête ?? constats.constatHonnete;
    expect(c).toBeDefined();
    expect(Object.keys(c ?? {})).toEqual(
      expect.arrayContaining(["divergenceAbsente", "saturationEquilibre", "surConsolidation"]),
    );
  });

  it("phase B — 1 900 000 échantillons frais, C1/C2 19/19, homéostasie réellement active", () => {
    const pb = (artefact as {
      phaseB: { echantillonsTotaux: number; metabolisme: { normalisations: number } };
    }).phaseB;
    expect(pb.echantillonsTotaux).toBe(1_900_000);
    expect(pb.metabolisme.normalisations).toBeGreaterThan(0);
    const criteres = (artefact as { bilan: { criteres: Record<string, { valeur: number; sur: number; atteint: boolean }> } }).bilan.criteres;
    expect(criteres.c1_donnees_fraises_19_domaines.valeur).toBe(19);
    expect(criteres.c1_donnees_fraises_19_domaines.atteint).toBe(true);
    expect(criteres.c2_renforts_positifs.valeur).toBe(19);
    expect(criteres.c2_renforts_positifs.atteint).toBe(true);
  });

  it("ANTI-MAQUILLAGE : le C3 déclaré est le comptage RÉEL des gains > 1", () => {
    const dossier = artefact as {
      bilan: { criteres: { c3_gain_trace: { valeur: number } } };
      parDomaine: Array<{ id: string; gainTrace: number }>;
    };
    const comptageReel = dossier.parDomaine.filter((d) => d.gainTrace > 1).length;
    expect(dossier.parDomaine).toHaveLength(19);
    expect(dossier.bilan.criteres.c3_gain_trace.valeur).toBe(comptageReel);
    // L'ordre des domaines est celui de la charte (propriétaire, non modifiable).
    expect(dossier.parDomaine.map((d) => d.id)).toEqual([...IDS_VOCATION]);
  });

  it("structure — le script active l'homéostasie sur le VIF seulement et respecte l'horloge sonde", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts/consolidation-homeostasie-it68.ts"),
      "utf8",
    );
    expect(source).toContain('executerSession("temoin", false');
    expect(source).toContain('executerSession("vif", true');
    expect(source).toContain("90_000_000_000");
    // La mécanique EOD est inchangée (it.57/63).
    expect(source).toContain("entrainerDomainesParOndes");
    expect(source).toContain("planInterclasse");
  });
});

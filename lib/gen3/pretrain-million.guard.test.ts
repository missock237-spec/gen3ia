/**
 * GARDE 32ᵉ (it.64) — LA SESSION MILLION À DONNÉES UNIQUES EST LISIBLE
 * ET HONNÊTE (campagne A de l'it.63 branchée sur les surfaces).
 *
 * Demande propriétaire (it.63) : « réalisé encore un preentrainement de
 * gen3 avec plus de 1 million de données et de dataset dans chaque
 * domaine ». La campagne A est celle qui satisfait ce critère (1 005 000
 * textes UNIQUES/domaine) — l'it.64 la rend lisible comme la campagne B.
 * Verrous :
 *  1. L'ARTEFACT committé est réel : chaque domaine dépasse strictement
 *     le million d'échantillons traités, les sources sont cohérentes
 *     (dépôt + HF + procéduraux = total), les 19 ids suivent l'ordre
 *     exact de la charte, le bilan à quatre signaux est rapporté tel quel.
 *  2. LE LECTEUR (lib/gen3/pretrain-million) retourne null sur fichier
 *     absent/corrompu/étranger — aucune métrique fabriquée — et parse un
 *     rapport plausible sans crash, avec cache invalidable.
 *  3. LES SURFACES : l'API /api/neural/domaines expose le résumé dans le
 *     bloc vocation ; la page /vocation affiche le bilan et le tableau
 *     par domaine construits DEPUIS la charte et l'artefact (le total
 *     mesuré n'est jamais collé en dur), avec repli honnête ; la console
 *     /neural affiche la synthèse et lie la preuve publique.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  lireResumeMillion,
  reinitialiserCacheMillion,
  RAPPORT_MILLION_PATH,
} from "./pretrain-million";
import { DOMAINES_VOCATION, NB_DOMAINES_VOCATION } from "./vocation";

const CHEMIN_API = join(process.cwd(), "app/api/neural/domaines/route.ts");
const CHEMIN_PAGE = join(process.cwd(), "app/vocation/page.tsx");
const CHEMIN_CONSOLE = join(process.cwd(), "components/neural/neural-console.tsx");

afterAll(() => {
  reinitialiserCacheMillion();
});

describe("garde 32ᵉ — session million à données uniques lisible (it.64)", () => {
  it("l'artefact committé dépasse réellement le million par domaine (critère propriétaire)", () => {
    expect(existsSync(RAPPORT_MILLION_PATH)).toBe(true);
    const brut = JSON.parse(readFileSync(RAPPORT_MILLION_PATH, "utf8")) as {
      totalEchantillons: number;
      sources: { depot: number; huggingface: number; proceduraux: number; totalSession: number };
      bilan: { donneesParDomaine: { ok: number; total: number } };
      domaines: Array<{ domaine: string; echantillons: number; sources: { genere: number } }>;
    };
    // Cohérence des sources : rien n'est additionné à la main.
    expect(
      brut.sources.depot + brut.sources.huggingface + brut.sources.proceduraux,
    ).toBe(brut.sources.totalSession);
    expect(brut.totalEchantillons).toBe(brut.sources.totalSession);
    // LE CRITÈRE DU PROPRIÉTAIRE : chaque domaine > 1 000 000 réellement traités.
    expect(brut.bilan.donneesParDomaine.ok).toBe(NB_DOMAINES_VOCATION);
    expect(brut.bilan.donneesParDomaine.total).toBe(NB_DOMAINES_VOCATION);
    expect(brut.domaines).toHaveLength(NB_DOMAINES_VOCATION);
    for (const d of brut.domaines) {
      expect(d.echantillons).toBeGreaterThan(1_000_000);
    }
    // La constante de conception « 1 005 000 textes uniques/domaine » est
    // VÉRIFIÉE dans l'artefact (elle n'est pas une libre plume des surfaces).
    for (const d of brut.domaines) {
      expect(d.sources.genere).toBe(1_005_000);
    }
  });

  it("les 19 domaines suivent l'ordre exact de la charte de vocation", () => {
    const brut = JSON.parse(readFileSync(RAPPORT_MILLION_PATH, "utf8")) as {
      domaines: Array<{ domaine: string }>;
    };
    expect(brut.domaines.map((d) => d.domaine)).toEqual(
      DOMAINES_VOCATION.map((d) => d.id),
    );
  });

  it("le bilan à quatre signaux est rapporté tel quel (trace incluse, rien de maquillé)", () => {
    const brut = JSON.parse(readFileSync(RAPPORT_MILLION_PATH, "utf8")) as {
      assimiles: { trace: number; total: number };
      bilan: {
        porteursRenforces: { ok: number; total: number; renfortsTotaux: number };
        stabiliteBandes: { ok: number; total: number };
        traceParDomaine: { ok: number; total: number };
      };
      domaines: Array<{ sondeTrace: { gain: number } }>;
      limitesHonnetes: unknown[];
    };
    // La trace déclarée = exactement le nombre de domaines à gain > 1.
    const gains = brut.domaines.filter((d) => d.sondeTrace.gain > 1).length;
    expect(brut.assimiles.trace).toBe(gains);
    expect(brut.bilan.traceParDomaine.ok).toBe(gains);
    expect(brut.bilan.traceParDomaine.total).toBe(NB_DOMAINES_VOCATION);
    // Porteurs renforcés 19/19, ≈ 505 M renforts/domaine mesurés.
    expect(brut.bilan.porteursRenforces.ok).toBe(NB_DOMAINES_VOCATION);
    expect(brut.bilan.porteursRenforces.renfortsTotaux).toBeGreaterThan(9_000_000_000);
    expect(brut.bilan.stabiliteBandes.ok).toBe(NB_DOMAINES_VOCATION);
    // Les limites honnêtes sont committées (le corpus synthétique est étiqueté).
    expect(brut.limitesHonnetes.length).toBeGreaterThan(0);
  });

  it("le lecteur retourne null sur fichier absent, corrompu ou étranger (honnêteté)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "million-garde-"));
    try {
      const absent = join(tmp, "absent.json");
      expect(lireResumeMillion(absent)).toBeNull();
      const corrompu = join(tmp, "corrompu.json");
      writeFileSync(corrompu, "{ pas du json ]");
      expect(lireResumeMillion(corrompu)).toBeNull();
      const etranger = join(tmp, "etranger.json");
      writeFileSync(etranger, JSON.stringify({ totalEchantillons: 1 }));
      expect(lireResumeMillion(etranger)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("le lecteur parse un rapport plausible sans crash et sans inventer", () => {
    const tmp = mkdtempSync(join(tmpdir(), "million-garde-"));
    try {
      const chemin = join(tmp, "rapport.json");
      writeFileSync(
        chemin,
        JSON.stringify({
          date: "2026-10-31T09:49:57.730Z",
          methode: "EOD (it.57)",
          contexte: "it.63 — campagne A",
          options: { cyclesParEchantillon: 3, tailleLot: 2000, plan: "interclassement round-robin" },
          sources: { depot: 100, huggingface: 5, proceduraux: 2_010_000, totalSession: 2_010_105 },
          totalEchantillons: 2_010_105,
          bilan: {
            donneesParDomaine: { ok: 19, total: 19 },
            porteursRenforces: { ok: 19, total: 19, renfortsTotaux: 9_615_431_899 },
            stabiliteBandes: { ok: 19, total: 19 },
            traceParDomaine: { ok: 12, total: 19 },
          },
          assimiles: { trace: 12, total: 19 },
          sonde: { vocabulaire: { avant: 3.33, apres: 3.56 } },
          metabolisme: { evaluees: 100, reposes: 1000, transmissions: 50, ms: 10 },
          domaines: [
            {
              domaine: "recherche-web",
              label: "Recherche web",
              bande: 1,
              porteurFrequence: 0.4375,
              echantillons: 1_008_400,
              renforts: 505_135_895,
              annulations: 505_136_105,
              sondeTrace: { avant: 3.48, apres: 2.85, gain: 0.818 },
              sondeVocabulaire: { avant: 3.4, apres: 3.4, gain: 1 },
            },
          ],
          limitesHonnetes: ["corpus synthétique étiqueté comme tel"],
        }),
      );
      const resume = lireResumeMillion(chemin);
      expect(resume).not.toBeNull();
      expect(resume!.totalEchantillons).toBe(2_010_105);
      expect(resume!.sources.depot).toBe(100);
      expect(resume!.bilan.donneesParDomaine.ok).toBe(19);
      expect(resume!.bilan.porteursRenforces.renfortsTotaux).toBe(9_615_431_899);
      expect(resume!.assimilesTrace).toBe(12);
      expect(resume!.totalDomaines).toBe(19);
      expect(resume!.parDomaine).toHaveLength(1);
      expect(resume!.parDomaine[0]!.id).toBe("recherche-web");
      expect(resume!.parDomaine[0]!.echantillons).toBe(1_008_400);
      expect(resume!.parDomaine[0]!.gainTrace).toBeCloseTo(0.818);
      expect(resume!.parDomaine[0]!.gainVocabulaire).toBeCloseTo(1);
      expect(resume!.limitesHonnetes).toEqual(["corpus synthétique étiqueté comme tel"]);
      // Champs absents → 0 (jamais inventés).
      expect(resume!.methode).toBe("EOD (it.57)");
      const vide = join(tmp, "vide.json");
      writeFileSync(vide, JSON.stringify({ totalEchantillons: 1, bilan: {}, domaines: [] }));
      const partiel = lireResumeMillion(vide);
      expect(partiel).not.toBeNull();
      expect(partiel!.bilan.donneesParDomaine.ok).toBe(0);
      expect(partiel!.date).toBe("");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("le cache du chemin par défaut est actif et invalidable (réinjection relue à chaque appel)", () => {
    reinitialiserCacheMillion();
    const a = lireResumeMillion();
    const b = lireResumeMillion();
    expect(a).not.toBeNull();
    expect(b).toBe(a); // même référence → cache
    reinitialiserCacheMillion();
    const c = lireResumeMillion();
    expect(c).not.toBe(a); // cache invalidé → relecture
    // Un chemin injecté ne bénéficie JAMAIS du cache.
    const tmp = mkdtempSync(join(tmpdir(), "million-garde-"));
    try {
      const chemin = join(tmp, "rapport.json");
      writeFileSync(chemin, JSON.stringify({ totalEchantillons: 42, bilan: {}, domaines: [] }));
      const injecte1 = lireResumeMillion(chemin);
      writeFileSync(chemin, JSON.stringify({ totalEchantillons: 43, bilan: {}, domaines: [] }));
      const injecte2 = lireResumeMillion(chemin);
      expect(injecte1!.totalEchantillons).toBe(42);
      expect(injecte2!.totalEchantillons).toBe(43);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      reinitialiserCacheMillion();
    }
  });

  it("le rapport réel, lu via le lecteur, porte la campagne intégralement", () => {
    reinitialiserCacheMillion();
    const resume = lireResumeMillion();
    expect(resume).not.toBeNull();
    expect(resume!.totalEchantillons).toBe(19_182_944);
    expect(resume!.parDomaine).toHaveLength(NB_DOMAINES_VOCATION);
    expect(resume!.methode).toContain("EOD");
    expect(resume!.contexte.length).toBeGreaterThan(0);
    expect(resume!.lot).toBe(2000);
    expect(resume!.cyclesParEchantillon).toBe(3);
    expect(resume!.plan.length).toBeGreaterThan(0);
    for (const d of resume!.parDomaine) {
      expect(d.echantillons).toBeGreaterThan(1_000_000);
      expect(d.renforts).toBeGreaterThan(0);
      expect(d.label.length).toBeGreaterThan(0);
    }
  });

  it("l'API /api/neural/domaines expose le résumé de la session million", () => {
    const src = readFileSync(CHEMIN_API, "utf8");
    expect(src).toContain('import { lireResumeMillion } from "@/lib/gen3/pretrain-million"');
    expect(src).toContain("preentrainementMillion: lireResumeMillion()");
  });

  it("la page /vocation affiche le bilan et le tableau depuis la charte — zéro chiffre mesuré en dur", () => {
    const src = readFileSync(CHEMIN_PAGE, "utf8");
    expect(src).toContain('import { lireResumeMillion } from "@/lib/gen3/pretrain-million"');
    // Tableau construit DEPUIS la charte (aucun libellé recopié).
    expect(src).toContain("DOMAINES_VOCATION.map");
    expect(src).toContain("millionParId.get(domaine.id)");
    // Bilan à quatre signaux rendu depuis les données.
    expect(src).toContain("million.bilan.donneesParDomaine");
    expect(src).toContain("million.bilan.porteursRenforces");
    expect(src).toContain("million.bilan.stabiliteBandes");
    expect(src).toContain("million.bilan.traceParDomaine");
    expect(src).toContain("million.totalEchantillons");
    expect(src).toContain("limitesHonnetes");
    // Repli honnête si aucune campagne committée.
    expect(src).toContain("Aucune session million committée");
    // AUCUN chiffre MESURÉ collé en dur (le total vient de l'artefact via le lecteur).
    expect(src).not.toMatch(/19\s*182\s*944/);
    expect(src).not.toMatch(/9\s*615\s*431\s*899/);
    // La page reste publique (aucune donnée utilisateur).
    expect(src).not.toContain("requireUser");
  });

  it("la console /neural affiche la synthèse de la campagne A (contrat étendu)", () => {
    const src = readFileSync(CHEMIN_CONSOLE, "utf8");
    expect(src).toContain("preentrainementMillion?");
    expect(src).toContain("preentrainementMillion.totalEchantillons");
    expect(src).toContain("preentrainementMillion.assimilesTrace");
    // Le lien preuve publique pointe vers la page charte.
    expect(src).toContain('href="/vocation"');
    // Aucun chiffre mesuré en dur dans la console non plus.
    expect(src).not.toMatch(/19\s*182\s*944/);
  });
});

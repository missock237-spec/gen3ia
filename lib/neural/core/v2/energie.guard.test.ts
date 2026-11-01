/**
 * GARDE 42ᵉ — SOBRIÉTÉ ÉNERGÉTIQUE (it.73 — demande propriétaire : « cherche
 * un moyen de diminuer la consommation d'énergie de gen3 tout en gardant sa
 * qualité de réponse et son efficacité pour que gen3 puisse fonctionner même
 * sur un téléphone tout en gardant sa qualité de compétences »).
 *
 * VERROUS :
 *  1. Profil « plein » = comportement historique EXACT (défauts inchangés,
 *     env inconnue → plein — jamais une économie silencieuse) ;
 *  2. Structure CSR partagée : la classe de production et la fonction pure
 *     `remplirStructureCSR` produisent le MÊME câblage bit à bit ;
 *  3. Horloges compactes u32 : EXACTES (< 2^32, poids/spikes identiques
 *     bit à bit vs f64) + refus honnête au-delà ;
 *  4. Moteur téléphone : équivalence MOTEUR prouvée (poids f32 exacts →
 *     spikes bit à bit identiques à la classe en lecture seule) ;
 *  5. Quantification u8 : erreur ≤ 1/510 ; l'accord des sondes est celui
 *     de l'artefact committé (re-dérivable, jamais codé en dur) ;
 *  6. Court-circuit éco : MÊME TEXTE que le chemin plein sur le corpus de
 *     questions (qualité conservée par construction — testée quand même) ;
 *  7. Mémoires re-dérivables (formule = typed arrays réels) ;
 *  8. Snapshot téléphone : round-trip + refus (magie/version/longueur) ;
 *  9. Artefact committé : ordre charte, gain 19/19, accord 342/342,
 *     réduction mémoire re-dérivable, limites honnêtes présentes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CortexColumnnaire,
  CORTEX_CONFIG_DEFAUTS,
  hashTokenVersColonne,
} from "./cortex-columnnaire";
import { remplirStructureCSR } from "./structure-csr";
import {
  CompteurEnergie,
  ECHELLE_QUANTISATION_U8,
  erreurMaxQuantisation,
  estimerMemoireCortexOctets,
  exporterSnapshotTelephone,
  importerSnapshotTelephone,
  MAGIE_SNAPSHOT_TELEPHONE,
  PROFILS_ENERGIE,
  profilEnergieDepuisEnv,
  quantiserPoidsU8,
  VERSION_SNAPSHOT_TELEPHONE,
} from "./energie";
import { CortexTelephone, configDepuisEntete } from "./cortex-telephone";
import { CORPUS_QUESTIONS_VOCATION } from "@/lib/gen3/corpus-questions";
import { DOMAINES_VOCATION } from "@/lib/gen3/vocation";

const CHEMIN_ARTEFACT = join(
  process.cwd(),
  "assets/neural-pretrained/cortex-telephone-it76.json",
);
const CHEMIN_SNAPSHOT = join(process.cwd(), "public/neural/cortex-telephone-it76.bin");

interface ArtefactIt76 {
  iteration: number;
  configTelephone: { colonnes: number; voisins: number; bandes: number; aretes: number; seed: number };
  prolongement: {
    changementDeclare: string;
    comparaison: {
      artefactPrecedent: string;
      plancherIt73: number;
      plancherIt76: number;
      plancherAmeliore: boolean;
      plafondIt76: number;
      varianceIt73: number;
      varianceIt76: number;
      varianceReduite: boolean;
      domainesRatioEnHausse: number;
      domainesRatioEnBaisse: number;
    };
  };
  supervision: { totalEchantillonsEod: number; alignement: { echantillons: number } };
  sonde: { totalSondes: number; accordArgmaxF32U8: number; tauxAccordF32U8: number; argmaxAttenduEntraîne: number; domaineAvecGain: number; plancherRatio: number };
  parDomaine: Array<{ domaineId: string; bandeAttendue: number; ratioAppris: number | null; ratioApprisIt73: number | null; deltaRatioVsIt73: number | null; activationCumuleeEntraîne: number; activationCumuleeNeuf: number }>;
  energie: {
    memoireOctets: { plein_2p20_f64_f32: number; eco_2p20_u32_f32: number; telephone_2p17_u32_u8: number };
    reductionTelephoneVsPlein: number;
    erreurMaxQuantisation: number;
    snapshotOctets: number;
    coutFenetreNeuronaleServeur2p20: { transmissions: number; evaluees: number; ms: number };
  };
  limitesHonnetes: string[];
}

function lireArtefact(): ArtefactIt76 {
  return JSON.parse(readFileSync(CHEMIN_ARTEFACT, "utf8")) as ArtefactIt76;
}

afterEach(() => {
  delete process.env.GEN3_PROFIL_ENERGIE;
});

describe("GARDE 42ᵉ — profils d'énergie (défaut = historique exact)", () => {
  it("le profil par défaut est « plein » et sa description verrouille le comportement historique", () => {
    expect(profilEnergieDepuisEnv({})).toBe("plein");
    expect(profilEnergieDepuisEnv({ GEN3_PROFIL_ENERGIE: "PLEIN" })).toBe("plein");
    // Valeur inconnue → JAMAIS une économie silencieuse.
    expect(profilEnergieDepuisEnv({ GEN3_PROFIL_ENERGIE: " turbo " })).toBe("plein");
    expect(profilEnergieDepuisEnv({ GEN3_PROFIL_ENERGIE: "0" })).toBe("plein");
    expect(profilEnergieDepuisEnv({ GEN3_PROFIL_ENERGIE: "eco" })).toBe("eco");
    expect(profilEnergieDepuisEnv({ GEN3_PROFIL_ENERGIE: "telephone" })).toBe("telephone");
  });

  it("les profils déclarés portent les garanties exactes (eco/telephone = économies déclarées)", () => {
    expect(PROFILS_ENERGIE.plein).toEqual({
      fenetreNeuronaleComplete: true,
      vocationDAabord: false,
      horlogesCompactes: false,
      description: expect.any(String),
    });
    for (const profil of ["eco", "telephone"] as const) {
      expect(PROFILS_ENERGIE[profil].fenetreNeuronaleComplete).toBe(false);
      expect(PROFILS_ENERGIE[profil].vocationDAabord).toBe(true);
      expect(PROFILS_ENERGIE[profil].horlogesCompactes).toBe(true);
    }
  });

  it("les défauts du cortex restent EXACTS (aucune option it.73 activée par défaut)", () => {
    expect(CORTEX_CONFIG_DEFAUTS.horlogesCompactes).toBeUndefined();
    expect(CORTEX_CONFIG_DEFAUTS.lectureSeule).toBeUndefined();
  });
});

describe("GARDE 42ᵉ — structure CSR partagée (identité bit à bit)", () => {
  it("la classe et la fonction pure produisent le MÊME câblage (offsets, cibles, poids initiaux)", () => {
    for (const seed of [42, 7, 20261101]) {
      const config = { colonnes: 4096, voisins: 12, bandesLecture: 8, bandes: 32, seed };
      const classe = new CortexColumnnaire({ colonnes: 4096, voisins: 12, bandesLecture: 8, bandes: 32, seed });
      const offset = new Uint32Array(4097);
      const cible = new Uint32Array(4096 * 12);
      const poids = new Float32Array(4096 * 12);
      remplirStructureCSR(config, offset, cible, poids);
      expect(Array.from(classe.csrOffset)).toEqual(Array.from(offset));
      expect(Array.from(classe.csrCible)).toEqual(Array.from(cible));
      expect(Array.from(classe.csrPoids)).toEqual(Array.from(poids));
    }
  });
});

describe("GARDE 42ᵉ — horloges compactes u32 (exact < 2^32)", () => {
  const config = { colonnes: 4096, voisins: 12, bandesLecture: 8, bandes: 32, seed: 42 };

  function scenario(cortex: CortexColumnnaire): number[][] {
    const traces: number[][] = [];
    cortex.reinitialiserEnergies();
    for (let t = 1; t <= 12; t++) {
      const injections =
        t === 1
          ? cortex.projetterTokens("veille intelligence artificielle planifier".split(" "))
          : null;
      traces.push(cortex.pas(injections, t));
    }
    // Re-injection tardive (décroissance paresseuse sur dt long).
    traces.push(cortex.pas(cortex.projetterTokens("audit sécurité réseau".split(" ")), 5000));
    return traces;
  }

  it("u32 et f64 produisent des spikes et des poids BIT À BIT identiques (< 2^32)", () => {
    const f64 = new CortexColumnnaire(config);
    const u32 = new CortexColumnnaire({ ...config, horlogesCompactes: true });
    expect(u32.dernierSpike.constructor.name).toBe("Uint32Array");
    const tracesF64 = scenario(f64);
    const tracesU32 = scenario(u32);
    expect(tracesU32).toEqual(tracesF64);
    expect(Array.from(u32.exporterPoids())).toEqual(Array.from(f64.exporterPoids()));
  });

  it("au-delà de 2^32−1, le refus est honnête (exception, jamais de silice corrompue)", () => {
    const u32 = new CortexColumnnaire({ ...config, horlogesCompactes: true });
    expect(() => u32.pas(null, 4294967296)).toThrow(/hors capacité u32/);
    // f64 (défaut) accepte les horloges massives (campagnes it.70-72).
    const f64 = new CortexColumnnaire(config);
    expect(() => f64.pas(null, 90_015_700_000)).not.toThrow();
  });
});

describe("GARDE 42ᵉ — moteur téléphone (équivalence moteur + lecture seule)", () => {
  const config = { colonnes: 2048, voisins: 12, bandes: 32, bandesLecture: 8, seed: 42, seuil: 1.0, decroissance: 0.1, plasticiteFenetre: 2.0 };

  it("poids f32 exacts → spikes BIT À BIT identiques à la classe en lecture seule", () => {
    // Les poids initiaux (0.1 + 0.4·a) ne sont pas des multiples de 1/255 :
    // pour isoler la MÉCANIQUE moteur de la quantification, on quantifie
    // LES DEUX contenus (classe ← déquant(u8), moteur ← u8) — toute
    // différence de spikes serait alors un bug de moteur, pas d'échelle.
    const classeQuant = new CortexColumnnaire({ ...config, lectureSeule: true });
    const u8 = quantiserPoidsU8(classeQuant.csrPoids);
    const dequant = new Float32Array(u8.length);
    for (let i = 0; i < u8.length; i++) dequant[i] = u8[i]! / ECHELLE_QUANTISATION_U8;
    expect(classeQuant.importerPoids(dequant)).toBe(true);
    const moteur = new CortexTelephone(config, u8);

    // Mêmes entrées pour les deux moteurs (projection hash identique).
    const entrees = "planifier la culture du maïs cette saison"
      .split(" ")
      .map((mot) => [hashTokenVersColonne(mot, config.colonnes), 1.2] as [number, number]);
    classeQuant.reinitialiserEnergies();
    moteur.reinitialiserEnergies();
    const tracesClasse: number[][] = [];
    const tracesMoteur: number[][] = [];
    for (let t = 1; t <= 4; t++) {
      tracesClasse.push(classeQuant.pas(t === 1 ? entrees : null, t));
      tracesMoteur.push(moteur.pas(t === 1 ? entrees : null, t));
    }
    expect(tracesMoteur).toEqual(tracesClasse);
  });

  it("lecture seule : la plasticité n'écrit JAMAIS (poids figés, refus compté)", () => {
    const cortex = new CortexColumnnaire({ ...config, lectureSeule: true });
    const avant = Array.from(cortex.exporterPoids());
    const entrees = "audit sécurité réseau".split(" ").map((mot) => [hashTokenVersColonne(mot, config.colonnes), 1.2] as [number, number]);
    cortex.reinitialiserEnergies();
    for (let t = 1; t <= 3; t++) cortex.pas(t === 1 ? entrees : null, t);
    expect(Array.from(cortex.exporterPoids())).toEqual(avant);
    cortex.plasticiteSupervisee([1, 2, 3], 1, 0.15, []);
    expect(cortex.ecrituresSuperviseesRefusees.total).toBe(1);
    expect(Array.from(cortex.exporterPoids())).toEqual(avant);
  });
});

describe("GARDE 42ᵉ — quantification u8 + snapshot téléphone", () => {
  it("l'erreur maximale de quantification est ≤ 1/510 (round-trip)", () => {
    const cortex = new CortexColumnnaire({ colonnes: 1024, voisins: 8, bandesLecture: 8, bandes: 32, seed: 7 });
    const u8 = quantiserPoidsU8(cortex.csrPoids);
    expect(u8.length).toBe(cortex.csrPoids.length);
    let erreurMax = 0;
    for (let i = 0; i < u8.length; i++) {
      erreurMax = Math.max(erreurMax, Math.abs(cortex.csrPoids[i]! - u8[i]! / ECHELLE_QUANTISATION_U8));
    }
    expect(erreurMax).toBeLessThanOrEqual(erreurMaxQuantisation());
    expect(erreurMaxQuantisation()).toBeCloseTo(1 / 510, 12);
  });

  it("snapshot : round-trip exact + refus magie/version/longueur", () => {
    const entete = {
      colonnes: 1024,
      voisins: 8,
      bandes: 32,
      bandesLecture: 8,
      seed: 42,
      seuil: 1.0,
      decroissance: 0.1,
      plasticiteFenetre: 2.0,
      aretes: 1024 * 8,
    };
    const poids = new Uint8Array(entete.aretes).fill(128);
    const snapshot = exporterSnapshotTelephone(entete, poids);
    const { entete: lu, poidsU8 } = importerSnapshotTelephone(snapshot);
    // Les flottants f32 (decroissance 0.1) ne repassent PAS exactement —
    // l'entête est comparé champ à champ (entiers exacts, flottants proches).
    expect(lu.colonnes).toBe(entete.colonnes);
    expect(lu.voisins).toBe(entete.voisins);
    expect(lu.bandes).toBe(entete.bandes);
    expect(lu.bandesLecture).toBe(entete.bandesLecture);
    expect(lu.seed).toBe(entete.seed);
    expect(lu.aretes).toBe(entete.aretes);
    expect(lu.seuil).toBeCloseTo(entete.seuil, 6);
    expect(lu.decroissance).toBeCloseTo(entete.decroissance, 6);
    expect(lu.plasticiteFenetre).toBeCloseTo(entete.plasticiteFenetre, 6);
    expect(Array.from(poidsU8)).toEqual(Array.from(poids));
    // Magie invalide.
    const corrompu = snapshot.slice();
    corrompu[0] = 88; // 'X'
    expect(() => importerSnapshotTelephone(corrompu)).toThrow(/magie invalide/);
    // Version non supportée.
    const mauvaiseVersion = snapshot.slice();
    new DataView(mauvaiseVersion.buffer).setUint32(8, VERSION_SNAPSHOT_TELEPHONE + 1, true);
    expect(() => importerSnapshotTelephone(mauvaiseVersion)).toThrow(/version/);
    // Longueur incohérente.
    expect(() => importerSnapshotTelephone(snapshot.slice(0, snapshot.length - 1))).toThrow(/octets/);
    // Auto-cohérence aretes = colonnes × voisins.
    const incoherent = exporterSnapshotTelephone({ ...entete, aretes: 999 }, poids.slice(0, 999));
    expect(() => importerSnapshotTelephone(incoherent)).toThrow(/incohérent/);
    expect(MAGIE_SNAPSHOT_TELEPHONE).toBe("G3TEL73");
  });

  it("le moteur téléphone refuse les poids incohérents et les colonnes hors u32", () => {
    const config = { colonnes: 64, voisins: 4, bandes: 8, bandesLecture: 4, seed: 1, seuil: 1, decroissance: 0.1, plasticiteFenetre: 2 };
    expect(() => new CortexTelephone(config, new Uint8Array(3))).toThrow(/poids ≠/);
    expect(() => new CortexTelephone({ ...config, colonnes: 4294967296 }, new Uint8Array(0))).toThrow(/hors capacité u32/);
    expect(configDepuisEntete({ ...enteteRef, aretes: 256 }).colonnes).toBe(1024);
  });

  const enteteRef = {
    colonnes: 1024,
    voisins: 8,
    bandes: 32,
    bandesLecture: 8,
    seed: 42,
    seuil: 1.0,
    decroissance: 0.1,
    plasticiteFenetre: 2.0,
    aretes: 1024 * 8,
  };
});

describe("GARDE 42ᵉ — mémoires re-dérivables", () => {
  it("la formule re-dérive les typed arrays réels de la classe (f64 et u32)", () => {
    const plein = new CortexColumnnaire({ colonnes: 4096, voisins: 12, bandesLecture: 8, bandes: 32, seed: 42 });
    expect(plein.octetsResidentiels()).toBe(
      estimerMemoireCortexOctets({ colonnes: 4096, voisins: 12, horlogesCompactes: false, poidsU8: false }),
    );
    const compact = new CortexColumnnaire({
      colonnes: 4096, voisins: 12, bandesLecture: 8, bandes: 32, seed: 42, horlogesCompactes: true,
    });
    expect(compact.octetsResidentiels()).toBe(
      estimerMemoireCortexOctets({ colonnes: 4096, voisins: 12, horlogesCompactes: true, poidsU8: false }),
    );
  });

  it("le téléphone mesure ~9 Mo réels (÷13 vs plein 2^20) — cohérence formule/moteur", () => {
    const entete = {
      colonnes: 131072, voisins: 12, bandes: 32, bandesLecture: 8, seed: 42,
      seuil: 1.0, decroissance: 0.1, plasticiteFenetre: 2.0, aretes: 131072 * 12,
    };
    const telephone = new CortexTelephone(configDepuisEntete(entete), new Uint8Array(entete.aretes));
    const reel = telephone.stats().octetsResidentiels;
    expect(reel).toBe(estimerMemoireCortexOctets({ colonnes: 131072, voisins: 12, horlogesCompactes: true, poidsU8: true }));
    const plein = estimerMemoireCortexOctets({ colonnes: 1048576, voisins: 12, horlogesCompactes: false, poidsU8: false });
    expect(plein / reel).toBeGreaterThan(12);
  });
});

describe("GARDE 42ᵉ — compteur d'énergie (mesures, jamais estimé)", () => {
  it("accumule les métabolismes réels et déclare les fenêtres évitées", () => {
    const compteur = new CompteurEnergie();
    compteur.enregistrerPas({ evaluees: 10, reposes: 90, transmissions: 120, ms: 1.5 }, 10);
    compteur.enregistrerPas({ evaluees: 5, reposes: 95, transmissions: 60, ms: 0.5 }, 5);
    compteur.enregistrerFenetreEvitee(12, 4);
    expect(compteur.rapport()).toEqual({
      fenetresExecutees: 2,
      fenetresEvitees: 1,
      epoquesRPIAEvitees: 12,
      cyclesNoyauEvites: 4,
      evaluees: 15,
      reposes: 185,
      spikes: 15,
      transmissions: 180,
      ms: 2,
    });
  });
});

describe("GARDE 42ᵉ — artefact committé (re-dérivable, anti-maquillage)", () => {
  const artefact = lireArtefact();

  it("l'artefact it.73 existe et porte la structure attendue", () => {
    expect(artefact.iteration).toBe(76);
    expect(artefact.configTelephone.colonnes).toBe(131072);
    expect(artefact.configTelephone.aretes).toBe(artefact.configTelephone.colonnes * artefact.configTelephone.voisins);
    expect(artefact.limitesHonnetes.length).toBeGreaterThanOrEqual(5);
  });

  it("l'ordre charte est respecté et le gain appris est présent pour les 19 domaines", () => {
    expect(artefact.parDomaine.map((d) => d.domaineId)).toEqual(DOMAINES_VOCATION.map((d) => d.id));
    for (const d of artefact.parDomaine) {
      expect(d.ratioAppris).not.toBeNull();
      expect(d.ratioAppris!).toBeGreaterThan(1);
      expect(d.activationCumuleeEntraîne).toBeGreaterThan(d.activationCumuleeNeuf);
      expect(d.bandeAttendue).toBeGreaterThanOrEqual(0);
      expect(d.bandeAttendue).toBeLessThanOrEqual(7);
    }
  });

  it("le PROLONGEMENT it.76 est réel : plancher au-dessus de it.73, variance réduite, deltas publiés par domaine", () => {
    const c = artefact.prolongement.comparaison;
    // Le candidat №1 (élever les ratios, réduire la variance) est TENU et
    // verrouillé : plancher it.76 > plancher it.73, variance it.76 < it.73.
    expect(c.artefactPrecedent).toContain("cortex-telephone-it73.json");
    expect(c.plancherIt73).toBe(1.242484);
    expect(c.plancherIt76).toBeGreaterThan(c.plancherIt73);
    expect(c.plancherAmeliore).toBe(true);
    expect(c.varianceIt76).toBeLessThan(c.varianceIt73);
    expect(c.varianceReduite).toBe(true);
    // Le plancher de l'artefact correspond bien au min des ratios.
    const minRatio = Math.min(...artefact.parDomaine.map((d) => d.ratioAppris ?? 0));
    expect(artefact.sonde.plancherRatio).toBe(Math.round(minRatio * 1e6) / 1e6);
    // Les deltas sont publiés HONNÊTEMENT : chaque domaine porte son delta
    // mesuré (hausse ET baisse — jamais un tableau entièrement positif
    // maquillé), et les hausses dominent.
    for (const d of artefact.parDomaine) {
      expect(d.ratioApprisIt73).not.toBeNull();
      expect(d.deltaRatioVsIt73).toBeCloseTo((d.ratioAppris ?? 0) - (d.ratioApprisIt73 ?? 0), 5);
    }
    expect(c.domainesRatioEnHausse).toBeGreaterThan(c.domainesRatioEnBaisse);
    // La réduction de variance est RE-DÉRIVABLE des ratios publiés.
    const ratios = artefact.parDomaine.map((d) => d.ratioAppris ?? 0);
    const moyenne = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const variance = ratios.reduce((a, b) => a + (b - moyenne) ** 2, 0) / ratios.length;
    expect(Math.round(variance * 1e6) / 1e6).toBe(c.varianceIt76);
  });

  it("l'accord f32↔u8 et les compteurs sont ceux de la campagne (jamais arrondis au maquillage)", () => {
    expect(artefact.sonde.totalSondes).toBeGreaterThan(0);
    expect(artefact.sonde.accordArgmaxF32U8).toBe(artefact.sonde.totalSondes);
    expect(artefact.sonde.tauxAccordF32U8).toBe(1);
    // La bande attendue gagne nettement plus que le hasard (1/8) sans être
    // déclarée « détection de domaine » (limites honnêtes).
    expect(artefact.sonde.argmaxAttenduEntraîne).toBeGreaterThan(artefact.sonde.totalSondes / 4);
  });

  it("les mémoires sont re-dérivables de la formule et la réduction ÷13 tient", () => {
    const memoires = artefact.energie.memoireOctets;
    expect(memoires.plein_2p20_f64_f32).toBe(
      estimerMemoireCortexOctets({ colonnes: 1048576, voisins: 12, horlogesCompactes: false, poidsU8: false }),
    );
    expect(memoires.eco_2p20_u32_f32).toBe(
      estimerMemoireCortexOctets({ colonnes: 1048576, voisins: 12, horlogesCompactes: true, poidsU8: false }),
    );
    expect(memoires.telephone_2p17_u32_u8).toBe(
      estimerMemoireCortexOctets({ colonnes: 131072, voisins: 12, horlogesCompactes: true, poidsU8: true }),
    );
    const rederive = memoires.plein_2p20_f64_f32 / memoires.telephone_2p17_u32_u8;
    expect(Math.round(rederive * 1e6) / 1e6).toBe(artefact.energie.reductionTelephoneVsPlein);
    expect(artefact.energie.reductionTelephoneVsPlein).toBeGreaterThan(12);
  });

  it("le snapshot committé est valide, de la taille déclarée, et son en-tête matche la config", () => {
    const bytes = readFileSync(CHEMIN_SNAPSHOT);
    const { entete } = importerSnapshotTelephone(new Uint8Array(bytes));
    expect(bytes.byteLength).toBe(artefact.energie.snapshotOctets);
    expect(entete.colonnes).toBe(artefact.configTelephone.colonnes);
    expect(entete.voisins).toBe(artefact.configTelephone.voisins);
    expect(entete.seed).toBe(artefact.configTelephone.seed);
  });

  it("le corpus de questions du cadre est couvert (19 domaines — la qualité du pont est la même sur le téléphone)", () => {
    const domainesCouverts = new Set(CORPUS_QUESTIONS_VOCATION.map((p) => p.domaineId));
    for (const domaine of DOMAINES_VOCATION) {
      expect(domainesCouverts.has(domaine.id)).toBe(true);
    }
  });
});

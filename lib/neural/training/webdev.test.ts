import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import {
  chargerWebdev,
  couvertureLexicaleWebdev,
  repartitionWebdev,
  versEchantillonsSNN,
  versPairesCortex,
  LABEL_WEBDEV,
  type EchantillonWebdev,
} from "./webdev";
import { entrainerDeveloppementWeb, lireRapportWebdev } from "./entrainement-webdev";
import { construireSignaturesDomaines } from "./domaines";

/**
 * COUCHE WEB-DEV DU TRAINER — le pack gen3-webdev-pack (des millions de
 * lignes bilingues au service d'un objectif : que Gen3ia sache concevoir et
 * développer des SaaS, des sites web et des projets de développement).
 *
 * Les tests exécutent la CHAÎNE RÉELLE sur l'échantillon commis au dépôt :
 * chargement streaming plafonné, conversions SNN / cortex, entraînement
 * supervisé réel (plasticité sur les pools de domaine) et rapport honnête.
 * Le dataset complet (hors git) est utilisé automatiquement quand il est
 * présent, mais les tests restent bornés par les plafonds passés aux options.
 */

const RAPPORT_TEST = "var/neural/webdev/rapport.json";

beforeEach(async () => {
  await rm(RAPPORT_TEST, { force: true });
});

afterAll(async () => {
  await rm(RAPPORT_TEST, { force: true });
});

describe("chargerWebdev — chargement streaming plafonné", () => {
  it("charge l'échantillon commis avec une répartition honnête", async () => {
    const charge = await chargerWebdev({ plafond: 500 });
    expect(charge.totalLu).toBeGreaterThan(0);
    expect(charge.source).toMatch(/developpement_web\.jsonl/);
    expect(charge.echantillons.length).toBeGreaterThan(0);
    expect(charge.echantillons.length).toBeLessThanOrEqual(500);
    // Toute ligne chargée est un exemple web-dev valide.
    const premier = charge.echantillons[0] as EchantillonWebdev;
    expect(premier.domain).toBe("developpement_web");
    expect(premier.instruction.length).toBeGreaterThan(20);
    expect(premier.output.length).toBeGreaterThan(200);
    const { parTache, parLangue } = repartitionWebdev(charge.echantillons);
    // Les 10 types de tâches du pack sont présents sur l'échantillon commis.
    expect(Object.keys(parTache).length).toBe(10);
    expect(parLangue.fr).toBeGreaterThan(0);
    expect(parLangue.en).toBeGreaterThan(0);
  });

  it("arrêt précoce : deux chargements identiques (ordre du générateur, déterministe)", async () => {
    // Le générateur écrit les lignes dans un ordre aléatoire uniforme :
    // prendre les premières lignes EST un échantillon représentatif, et la
    // lecture s'arrête au plafond (jamais les millions de lignes).
    const a = await chargerWebdev({ plafond: 50 });
    const b = await chargerWebdev({ plafond: 50 });
    expect(a.echantillons.length).toBe(50);
    expect(b.echantillons.map((e) => e.id)).toEqual(a.echantillons.map((e) => e.id));
    // Lecture bornée dans LES DEUX environnements : dataset complet présent
    // → arrêt précoce (totalLu ≈ plafond, jamais des millions) ; dataset
    // absent (bac à sable, CI) → repli garanti sur l'échantillon commis
    // (totalLu = 500, sa taille exacte). Jamais de lecture hors bornes.
    if (a.source.includes("complet")) {
      expect(a.totalLu).toBeLessThan(500);
    } else {
      expect(a.source).toMatch(/echantillons\/developpement_web\.jsonl$/);
      expect(a.totalLu).toBe(500);
    }
  });

  it("filtre par langue quand demandé", async () => {
    const charge = await chargerWebdev({ plafond: 200, langue: "fr" });
    expect(charge.echantillons.every((e) => e.language === "fr")).toBe(true);
  });
});

describe("conversions SNN et cortex", () => {
  it("étiquette les échantillons web-dev avec leurs tokens signatures", async () => {
    const charge = await chargerWebdev({ plafond: 40 });
    const signatures = await construireSignaturesDomaines({ complet: false });
    const snn = versEchantillonsSNN(charge.echantillons, signatures);
    // Au moins une partie des échantillons porte un token signature (les
    // autres sont sautés honnêtement : rien à apprendre sans vocabulaire).
    expect(snn.length).toBeGreaterThan(0);
    expect(snn.every((s) => s.label === LABEL_WEBDEV)).toBe(true);
    expect(snn.every((s) => s.text.split(" ").length <= 6)).toBe(true);
  });

  it("produit des paires conversationnelles compactes et thémées", async () => {
    const charge = await chargerWebdev({ plafond: 40 });
    const paires = versPairesCortex(charge.echantillons, 900);
    expect(paires.length).toBe(charge.echantillons.length);
    for (const paire of paires) {
      expect(paire.motif.length).toBeGreaterThan(20);
      expect(paire.reponse.length).toBeLessThanOrEqual(902);
      expect(paire.theme.startsWith("dev-web:")).toBe(true);
    }
    // La couverture lexicale est non triviale (signatures SNN).
    expect(couvertureLexicaleWebdev(charge.echantillons)).toBeGreaterThan(100);
  });
});

describe("entrainerDeveloppementWeb — chaîne réelle", () => {
  it("entraîne le SNN (plasticité réelle) et nourrit le cortex, puis écrit un rapport honnête", async () => {
    // Runtime réel (même singleton que la production — pattern engine-domaines).
    const rapport = await entrainerDeveloppementWeb({
      plafondSnn: 60,
      plafondCortex: 80,
      epoques: 2,
    });

    // Le message du rapport porte le diagnostic en cas d'échec (honnêteté).
    expect(rapport.statut, `statut=${rapport.statut} message=${rapport.message}`).toBe("termine");
    expect(rapport.source).toMatch(/developpement_web\.jsonl/);
    expect(rapport.snn).not.toBeNull();
    expect(rapport.snn?.echantillons).toBeGreaterThan(0);
    expect(rapport.snn?.accuracyTrain).toBeGreaterThanOrEqual(0);
    expect(rapport.snn?.accuracyTest).toBeGreaterThanOrEqual(0);
    expect(rapport.cortex?.pairesAjoutees).toBeGreaterThan(0);
    expect(rapport.message).toMatch(/échantillons web-dev/);
    // Rapport persisté lisible (jamais inventé).
    const lu = await lireRapportWebdev();
    expect(lu).not.toBeNull();
    expect(lu?.statut).toBe("termine");
  }, 120_000);
});

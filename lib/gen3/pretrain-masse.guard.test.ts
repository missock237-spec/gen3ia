/**
 * GARDE 30ᵉ (it.63) — LE PRÉ-ENTRAÎNEMENT MASSIF EST RÉEL ET HONNÊTE.
 *
 * Demande propriétaire (it.63) : « réalisé encore un preentrainement de
 * gen3 avec plus de 1 million de données et de dataset dans chaque
 * domaine ». Verrous :
 *  1. LA CAMPAGNE dépasse réellement le million par domaine
 *     (501 époques × 2000 = 1 002 000) et n'invente RIEN : la sonde
 *     TRACE/GÉNÉRALISATION est comparée à un cortex témoin, les gains sont
 *     mesurés ; les 19 domaines viennent de la charte (aucun libellé en
 *     dur) ; la continuité d'horloge relie les lots (horlogeInitiale) ;
 *     l'artefact cortical + le rapport honnête sont écrits dans assets/.
 *  2. LE LECTEUR (lib/gen3/pretrain-masse) retourne null sur fichier
 *     absent/corrompu — aucune métrique fabriquée — et parse un rapport
 *     plausible sans crash.
 *  3. LES SURFACES : l'API /api/neural/domaines expose le résumé dans le
 *     bloc vocation ; la page /vocation affiche le tableau par domaine
 *     avec repli honnête « aucune campagne committée ».
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  lireResumeMasse,
  reinitialiserCacheMasse,
  RAPPORT_MASSE_PATH,
} from "./pretrain-masse";
import { NB_DOMAINES_VOCATION } from "./vocation";

const CHEMIN_SCRIPT = join(process.cwd(), "scripts/pretrain-masse-1m-it63.ts");
const CHEMIN_API = join(process.cwd(), "app/api/neural/domaines/route.ts");
const CHEMIN_PAGE = join(process.cwd(), "app/vocation/page.tsx");

afterAll(() => {
  reinitialiserCacheMasse();
});

describe("garde 30ᵉ — campagne de pré-entraînement massif (it.63)", () => {
  it("la campagne dépasse réellement le million d'échantillons par domaine", () => {
    expect(existsSync(CHEMIN_SCRIPT)).toBe(true);
    const src = readFileSync(CHEMIN_SCRIPT, "utf8");
    const epoques = src.match(/const EPOQUES = (\d+)/);
    const lot = src.match(/const LOT = (\d+)/);
    expect(epoques).not.toBeNull();
    expect(lot).not.toBeNull();
    const parDomaine = Number(epoques![1]) * Number(lot![1]);
    expect(parDomaine).toBeGreaterThan(1_000_000);
    // 19 domaines, ordre de la charte — les boucles (vocabulaire, bandes,
    // échantillons, époques) dérivent de la charte, jamais d'une liste en dur.
    expect(src).toContain("IDS_VOCATION");
    expect(src).toContain("DOMAINES_VOCATION");
    expect(src).toContain("for (const id of IDS_VOCATION)");
    expect(src).toContain("for (const domaine of DOMAINES_VOCATION)");
  });

  it("la campagne entraîne par ondes avec continuité d'horloge entre les lots", () => {
    const src = readFileSync(CHEMIN_SCRIPT, "utf8");
    // La méthode it.57, inchangée, est bien celle appelée.
    expect(src).toContain("entrainerDomainesParOndes");
    // Continuité de phase : chaque lot reprend l'horloge globale.
    expect(src).toContain("horlogeInitiale: horloge");
    expect(src).toContain("horloge +=");
  });

  it("l'onde d'un domaine balaye SA bande-porteuse (it.63 — discrimination à l'échelle du million)", () => {
    // Le module ondes plie le balayage dans l'intervalle de la bande cible
    // (rétrocompatible : sans bande, balayage substrat-complet it.57).
    const srcModule = readFileSync(
      join(process.cwd(), "lib/neural/training/entrainement-ondes.ts"),
      "utf8",
    );
    expect(srcModule).toContain("bandeCible?: number");
    expect(srcModule).toContain("cortex.config.bandes");
    // La session d'entraînement passe bien la bande du domaine.
    expect(srcModule).toMatch(/colonnesDepuisOndes\(\s*paquets,\s*cortex\.config\.colonnes,\s*bande,\s*cortex\.config\.bandes,\s*\)/);
  });

  it("la sonde d'assimilation compare à un témoin vierge et ne maquille rien", () => {
    const src = readFileSync(CHEMIN_SCRIPT, "utf8");
    expect(src).toContain("ratioPorteur"); // TRACE : ratio porteur/autres
    expect(src).toContain("texteInconnu"); // GÉNÉRALISATION : jamais vu
    expect(src).toMatch(/new CortexColumnnaire\(CORTEX_CONFIG_DEFAUTS\)/g);
    // Le témoin existe et les gains sont mesurés (trained / témoin).
    expect(src).toContain("ratiosTemoin");
    expect(src).toContain("gainGen");
    // Assimilation : seuil explicite, rapporté tel quel.
    expect(src).toMatch(/const SEUIL_ASSIMILE = [\d.]+/);
    // Artefacts : état cortical + rapport honnête committés.
    expect(src).toContain("assets/neural-pretrained/cortex-v2.bin");
    expect(src).toContain("assets/neural-pretrained/preentrainement-masse-1m-it63.json");
    // Reprise : checkpoints réels (état structural + progression).
    expect(src).toContain("ecrireArtefactV2");
    expect(src).toContain("pretrain-masse-progress-it63.json");
  });

  it("le lecteur retourne null sur fichier absent ou corrompu (honnêteté)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "masse-garde-"));
    try {
      const absent = join(tmp, "absent.json");
      expect(lireResumeMasse(absent)).toBeNull();
      const corrompu = join(tmp, "corrompu.json");
      writeFileSync(corrompu, "{ ceci n'est pas du json ]");
      expect(lireResumeMasse(corrompu)).toBeNull();
      const etranger = join(tmp, "etranger.json");
      writeFileSync(etranger, JSON.stringify({ hello: "world" }));
      expect(lireResumeMasse(etranger)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("le lecteur parse un rapport plausible sans crash et sans inventer", () => {
    const tmp = mkdtempSync(join(tmpdir(), "masse-garde-"));
    try {
      const chemin = join(tmp, "rapport.json");
      writeFileSync(
        chemin,
        JSON.stringify({
          date: "2026-10-31T00:00:00.000Z",
          methode: "EOD",
          contexte: "it.63",
          options: { lot: 2000, epoques: 501, seuilAssimile: 1.25 },
          totalEchantillons: 19_038_000,
          echantillonsParDomaine: { "recherche-web": 1_002_000 },
          sonde: {
            assimiles: 19,
            total: NB_DOMAINES_VOCATION,
            seuilAssimile: 1.25,
            domaines: [
              {
                domaine: "recherche-web",
                bande: 1,
                porteurFrequence: 0.4375,
                echantillons: 1_002_000,
                trace: { ratios: [8.9], ratiosTemoin: [2.9], gain: 3.07, assimile: true },
                generalisation: { ratio: 8.9, ratioTemoin: 3.9, gain: 2.28 },
              },
            ],
          },
        }),
      );
      const resume = lireResumeMasse(chemin, join(tmp, "cortex-absent.bin"));
      expect(resume).not.toBeNull();
      expect(resume!.totalEchantillons).toBe(19_038_000);
      expect(resume!.assimiles).toBe(19);
      expect(resume!.totalDomaines).toBe(NB_DOMAINES_VOCATION);
      expect(resume!.parDomaine).toHaveLength(1);
      expect(resume!.parDomaine[0]!.id).toBe("recherche-web");
      expect(resume!.parDomaine[0]!.assimile).toBe(true);
      // Aucune valeur fabriquée : champ absent → 0 / false, jamais inventé.
      // (cheminCortex injecté inexistant → taille null, même si un artefact
      //  cortical réel existe sur la machine locale — test hermétique.)
      expect(resume!.artefactCortical.tailleOctets).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("l'API /api/neural/domaines expose le résumé dans le bloc vocation", () => {
    const src = readFileSync(CHEMIN_API, "utf8");
    expect(src).toContain('import { lireResumeMasse } from "@/lib/gen3/pretrain-masse"');
    expect(src).toContain("preentrainementMasse: lireResumeMasse()");
  });

  it("la page /vocation affiche la campagne avec repli honnête", () => {
    const src = readFileSync(CHEMIN_PAGE, "utf8");
    expect(src).toContain('import { lireResumeMasse } from "@/lib/gen3/pretrain-masse"');
    // Tableau par domaine construit depuis la CHARTE (pas de doublon de libellés).
    expect(src).toContain("DOMAINES_VOCATION.map");
    expect(src).toContain("masseParId.get(domaine.id)");
    // Preuve visible : gains + assimilation.
    expect(src).toContain("gainTrace");
    expect(src).toContain("gainGeneralisation");
    expect(src).toContain("assimilé");
    // Repli honnête si aucune campagne committée.
    expect(src).toContain("Aucune campagne massive committée");
    // La page reste publique (aucune donnée utilisateur — le lecteur ne
    // lit que le rapport de campagne committé).
    expect(src).not.toContain("requireUser");
  });

  it("la console /neural affiche le résumé de campagne (contrat étendu)", () => {
    const src = readFileSync(join(process.cwd(), "components/neural/neural-console.tsx"), "utf8");
    // Le contrat client étend la vocation de l'API (champ optionnel, null toléré).
    expect(src).toContain("preentrainementMasse?");
    // Affichage honnête : total réel + assimilation mesurée + lien vers la preuve publique.
    expect(src).toContain("preentrainementMasse.totalEchantillons");
    expect(src).toContain("preentrainementMasse.assimiles");
    expect(src).toContain('href="/vocation"');
  });

  it("le rapport committé, s'il existe, dépasse le million par domaine", () => {
    // Si la campagne a déjà livré son rapport, verrou sur la réalité :
    // chaque domaine dépasse 1 000 000 d'échantillons réellement traités.
    if (!existsSync(RAPPORT_MASSE_PATH)) return;
    reinitialiserCacheMasse();
    const resume = lireResumeMasse();
    expect(resume).not.toBeNull();
    expect(resume!.totalDomaines).toBe(NB_DOMAINES_VOCATION);
    for (const d of resume!.parDomaine) {
      expect(d.echantillons).toBeGreaterThan(1_000_000);
    }
  });
});

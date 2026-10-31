import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DOMAINES_VOCATION,
  IDS_VOCATION,
  MISSION_GEN3,
  NB_DOMAINES_VOCATION,
} from "./vocation";

/**
 * VERROU BIDIRECTIONNEL it.62 (29ᵉ test garde) — LA VOCATION DEVIENNE
 * PILOTABLE ET LISIBLE DEPUIS L'APPLICATION.
 *
 * Chaîne d'honnêteté continue (it.57 → it.61 → it.62) :
 *  1. La méthode d'entraînement par ondes (EOD, it.57) est RÉELLE ;
 *  2. Le pré-entraînement des 19 domaines (it.61, script + notebook Colab)
 *     a été exécuté et mesuré (19/19 assimilés à la sonde de trace) ;
 *  3. it.62 : le PRÉ-ENTRAÎNEMENT PAR ONDES devient un BOUTON de la
 *     console neuronale (/neural, onglet Entraînement) — POST
 *     { source: "ondes", domainesOndes: [les 19 ids de la vocation] } —
 *     et la charte devient une PAGE LISIBLE (/vocation) pour tous les
 *     utilisateurs.
 *
 * Ce garde verrouille les trois câblages : console (bouton + rapport
 * affiché), page /vocation (charte rendue depuis le module source, zéro
 * duplication), et cohérence des ids (ceux du bouton = ceux de la charte).
 */

const LIBELLES_PROPRIETAIRE = [
  "Recherche web",
  "Contrôle de données",
  "Rédaction de texte",
  "Analyse de documents",
  "Génération de code",
  "Analyse de données",
  "Cybersécurité",
  "Médecine et santé",
  "Commerce et économie",
  "Langue et communication",
  "Ingénierie et industrie",
  "Art et création multimédia",
  "Agriculture et environnement",
  "Droit et administration",
  "Éducation et recherche",
  "Transport et immobilier",
  "Sciences humaines et sociales",
  "Domaines spécialisés et émergents en IA",
  "Apprentissage autonome avec d'autres IA",
];

describe("it.62 — la console neuronale pilote le pré-entraînement par ondes de la vocation", () => {
  const lireConsole = () =>
    readFileSync(
      path.join(import.meta.dirname, "../../components/neural/neural-console.tsx"),
      "utf8",
    );

  it("le bouton de la console POSTe la source « ondes » avec les ids DE LA CHARTE (pas une liste codée en dur)", () => {
    const src = lireConsole();
    expect(src).toContain('source: "ondes", domainesOndes: domaines?.vocation.domaines.map((d) => d.id) ?? []');
  });

  it("la console étend le contrat du train (domainesOndes) et du job (rapportOndes)", () => {
    const src = lireConsole();
    expect(src).toContain('{ source: "ondes"; domainesOndes: string[] }');
    expect(src).toContain("rapportOndes?: {");
    expect(src).toContain("resonanceMoyenne: number;");
    expect(src).toContain("paquetsEmis: number;");
  });

  it("la console affiche le rapport honnête de la session d'ondes (métier + métabolisme)", () => {
    const src = lireConsole();
    expect(src).toContain("job?.rapportOndes");
    expect(src).toContain("Ondes · métabolisme");
    expect(src).toContain("Renforts / annulations");
  });

  it("la console lie la charte lisible /vocation", () => {
    const src = lireConsole();
    expect(src).toContain('href="/vocation"');
  });

  it("le bouton est réservé aux opérateurs (même règle que les autres actions à privilège)", () => {
    const src = lireConsole();
    const positionBouton = src.indexOf("Pré-entraîner les 19 domaines (ondes)");
    const positionGarde = src.indexOf("estOperateur ?", positionBouton - 600);
    expect(positionBouton).toBeGreaterThan(-1);
    expect(positionGarde).toBeGreaterThan(-1);
    expect(positionGarde).toBeLessThan(positionBouton);
  });
});

describe("it.62 — la page /vocation rend la charte depuis la source unique", () => {
  const lirePage = () =>
    readFileSync(
      path.join(import.meta.dirname, "../../app/vocation/page.tsx"),
      "utf8",
    );

  it("la page importe le module charte (zéro duplication des libellés)", () => {
    const src = lirePage();
    expect(src).toContain('from "@/lib/gen3/vocation"');
    expect(src).toContain("DOMAINES_VOCATION");
    expect(src).toContain("MISSION_GEN3");
    expect(src).toContain("NB_DOMAINES_VOCATION");
    // ZÉRO libellé codé en dur : les 19 libellés du propriétaire ne
    // doivent PAS être recopiés dans la page (sinon dérive à la marge).
    for (const libelle of LIBELLES_PROPRIETAIRE) {
      expect(src).not.toContain(libelle);
    }
  });

  it("la page expose les 19 domaines avec tâches et outils réels", () => {
    const src = lirePage();
    expect(src).toContain("domaine.taches");
    expect(src).toContain("domaine.outils");
    expect(src).toContain("domaine.mission");
  });

  it("la charte source reste EXACTEMENT les 19 domaines du propriétaire (ordre intact)", () => {
    expect(NB_DOMAINES_VOCATION).toBe(19);
    expect(DOMAINES_VOCATION.map((d) => d.label)).toEqual(LIBELLES_PROPRIETAIRE);
    expect(IDS_VOCATION.length).toBe(19);
    expect(MISSION_GEN3).toContain("CRÉÉ POUR EXÉCUTER DES TÂCHES");
  });
});

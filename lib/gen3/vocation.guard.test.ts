import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DOMAINES_VOCATION,
  IDS_VOCATION,
  MISSION_GEN3,
  NB_DOMAINES_VOCATION,
  predireDomaineVocation,
  sectionVocationGen3,
} from "./vocation";
import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import { bandeDuDomaine, porteurBande } from "@/lib/neural/training/entrainement-ondes";

/**
 * VERROU BIDIRECTIONNEL it.59 (27ᵉ test garde) — LA VOCATION DE GEN3.
 *
 * Demande propriétaire : « implémente ces domaines dans gen3 pour qu'il
 * sache qu'il a été créé pour réaliser [les 19 domaines] ; il doit savoir
 * qu'il a été créé pour exécuter des tâches dans chaque domaine ».
 *
 * Ce garde verrouille les DEUX directions :
 *  1. La charte (vocation.ts) : EXACTEMENT les 19 domaines énoncés, chacun
 *     avec mission « créé pour », tâches, mots-clés et des outils RÉELS
 *     (zéro fantôme — règle it.58) ;
 *  2. Le CÂBLAGE : gen3 SAIT — la section de vocation est injectée dans le
 *     prompt système du moteur de conversation (engine-chat.ts) ET dans le
 *     prompt système de qualité (response-quality.ts), et la charte est
 *     exposée par GET /api/neural/domaines.
 */

const NOMS_OUTILS_REELS = new Set(GEN3IA_TOOLS.map((outil) => outil.name));

/** Les 19 libellés, dans l'ordre énoncé par le propriétaire. */
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

describe("it.59 — la charte de vocation de gen3 (source de vérité)", () => {
  it("déclare EXACTEMENT les 19 domaines énoncés, dans l'ordre du propriétaire", () => {
    expect(NB_DOMAINES_VOCATION).toBe(19);
    expect(DOMAINES_VOCATION).toHaveLength(19);
    expect(DOMAINES_VOCATION.map((domaine) => domaine.label)).toEqual(LIBELLES_PROPRIETAIRE);
  });

  it("utilise des identifiants canoniques uniques (kebab-case, prêts pour domainesOndes)", () => {
    const ids = DOMAINES_VOCATION.map((domaine) => domaine.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(IDS_VOCATION);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("chaque domaine porte une mission « créé pour » des tâches et des mots-clés", () => {
    for (const domaine of DOMAINES_VOCATION) {
      expect(domaine.mission.length).toBeGreaterThanOrEqual(60);
      expect(domaine.mission).toContain("créé pour");
      expect(domaine.taches.length).toBeGreaterThanOrEqual(4);
      expect(domaine.outils.length).toBeGreaterThanOrEqual(3);
      expect(domaine.motsCles.length).toBeGreaterThanOrEqual(5);
      for (const tache of domaine.taches) expect(tache.trim().length).toBeGreaterThan(3);
    }
  });

  it("ZÉRO OUTIL FANTÔME : chaque outil référencé existe au registre GEN3IA_TOOLS", () => {
    expect(NOMS_OUTILS_REELS.size).toBeGreaterThan(40);
    for (const domaine of DOMAINES_VOCATION) {
      for (const outil of domaine.outils) {
        expect(NOMS_OUTILS_REELS.has(outil)).toBe(true);
      }
    }
  });

  it("la mission maîtresse déclare la vocation complète (créé pour exécuter des tâches, 19 domaines)", () => {
    expect(MISSION_GEN3).toContain("CRÉÉ POUR EXÉCUTER DES TÂCHES");
    expect(MISSION_GEN3).toContain("19 domaines");
    expect(MISSION_GEN3).toContain("zéro service IA externe");
  });
});

describe("it.59 — gen3 SAIT : la section de vocation injectée à gen3", () => {
  const section = sectionVocationGen3();

  it("affirme l'identité impérative « créé pour exécuter des tâches »", () => {
    expect(section).toContain("TA VOCATION — GEN3");
    expect(section).toContain("CRÉÉ POUR EXÉCUTER DES TÂCHES");
    expect(section).toContain("19 domaines");
  });

  it("cite les 19 domaines, numérotés 1 à 19, avec leur mission", () => {
    LIBELLES_PROPRIETAIRE.forEach((libelle, index) => {
      expect(section).toContain(`${index + 1}. ${libelle.toUpperCase()}`);
    });
    expect(section).not.toContain("20.");
  });

  it("exige l'honnêteté (outils réels, jamais de capacité fantôme)", () => {
    expect(section).toContain("outils RÉELS de la plateforme");
    expect(section).toContain("ne promets jamais une capacité qui n'existe pas");
  });
});

describe("it.59 — détection lexicale du domaine de vocation (déterministe)", () => {
  it("route des demandes réelles vers le bon domaine", () => {
    const cas: Array<[string, string]> = [
      ["Peux-tu faire une recherche web sur les panneaux solaires et me faire une synthèse des sources ?", "recherche-web"],
      ["Voici un fichier : contrôle de données — doublons, valeurs manquantes, anomalies", "controle-donnees"],
      ["Rédige un texte : un courrier de relance client poli et ferme", "redaction-texte"],
      ["Analyse ce document PDF et extrais les informations structurées", "analyse-documents"],
      ["Écris le code d'une fonction python qui trie une liste, avec tests", "generation-code"],
      ["Fais une analyse de données de mes ventes : moyenne, tendance, graphique", "analyse-donnees"],
      ["Audite la sécurité de mon serveur : vulnérabilités et plan de remédiation", "cybersecurite"],
      ["Explique les symptômes et traitements de l'hypertension, vulgarisation médicale", "medecine-sante"],
      ["Étude de marché et pricing pour mon commerce : marge et chiffre d'affaires", "commerce-economie"],
      ["Traduis cette lettre en anglais et corrige la grammaire", "langue-communication"],
      ["Calcule le dimensionnement d'une poutre et le processus de maintenance de l'usine", "ingenierie-industrie"],
      ["Génère une image et une vidéo pour mon artwork musical", "art-creation-multimedia"],
      ["Conseil agricole : calendrier de culture, sol et climat pour le maïs", "agriculture-environnement"],
      ["Prépare mes documents administratifs et vérifie la réglementation juridique", "droit-administration"],
      ["Crée un cours avec exercices et quiz pour mes étudiants", "education-recherche"],
      ["Analyse le marché immobilier de ce logement : loyer et estimation", "transport-immobilier"],
      ["Fais une analyse sociologique et historique de cette société", "sciences-humaines-sociales"],
      ["Explique les agents IA et le machine learning moderne", "ia-specialisee-emergente"],
      ["Configure l'apprentissage autonome via MCP et webhooks avec d'autres IA", "apprentissage-entre-ia"],
    ];
    for (const [demande, attendu] of cas) {
      const detection = predireDomaineVocation(demande);
      expect(detection, `demande : ${demande}`).not.toBeNull();
      expect(detection?.id, `demande : ${demande}`).toBe(attendu);
      expect(detection?.matched.length).toBeGreaterThan(0);
    }
  });

  it("retourne null plutôt que d'inventer un domaine (honnêteté)", () => {
    expect(predireDomaineVocation("")).toBeNull();
    expect(predireDomaineVocation("   ")).toBeNull();
    expect(predireDomaineVocation("xyzzy plugh qwerty")).toBeNull();
  });

  it("est déterministe (deux appels identiques → même détection)", () => {
    const a = predireDomaineVocation("Recherche web et synthèse de sources");
    const b = predireDomaineVocation("Recherche web et synthèse de sources");
    expect(a).toEqual(b);
  });
});

describe("it.59 — compatibilité entraînement par ondes de domaine (it.57)", () => {
  it("chaque identifiant de vocation obtient une bande-porteuse valide du vocabulaire", () => {
    for (const id of IDS_VOCATION) {
      const bande = bandeDuDomaine(id);
      expect(bande).toBeGreaterThanOrEqual(0);
      expect(bande).toBeLessThan(8);
      const porteur = porteurBande(bande);
      expect(porteur).toBeGreaterThanOrEqual(0.25);
      expect(porteur).toBeLessThanOrEqual(1.75);
    }
  });

  it("les 19 identifiants couvrent le vocabulaire sans collision totale (répartition)", () => {
    const bandes = new Set(IDS_VOCATION.map((id) => bandeDuDomaine(id)));
    // 19 domaines → au moins 5 bandes distinctes occupées sur 8 (répartition réelle).
    expect(bandes.size).toBeGreaterThanOrEqual(5);
  });
});

describe("it.59 — VERROU bidirectionnel : le câblage réel des prompts et de l'API", () => {
  const lire = (relatif: string): string =>
    readFileSync(path.join(import.meta.dirname, relatif), "utf8");

  it("le moteur de conversation injecte la vocation dans ses prompts système", () => {
    const src = lire("../domain/conversations/engine-chat.ts");
    expect(src).toContain('from "@/lib/gen3/vocation"');
    expect(src).toContain("sectionVocationGen3()");
    // Injecté DANS systemParts (pas seulement importé) : l'appel précède
    // languageDirective dans l'assemblage du prompt système du tour chat.
    const positionSystemParts = src.indexOf("const systemParts = [");
    const positionAppel = src.indexOf("sectionVocationGen3(),");
    expect(positionSystemParts).toBeGreaterThan(-1);
    expect(positionAppel).toBeGreaterThan(positionSystemParts);
  });

  it("le prompt système de qualité inclut la vocation (surfaces génériques)", () => {
    const src = lire("../ai/response-quality.ts");
    expect(src).toContain('from "@/lib/gen3/vocation"');
    expect(src).toContain("sectionVocationGen3(),");
  });

  it("l'API d'inventaire expose la charte de vocation", () => {
    const src = lire("../../app/api/neural/domaines/route.ts");
    expect(src).toContain('from "@/lib/gen3/vocation"');
    expect(src).toContain("MISSION_GEN3");
    expect(src).toContain("DOMAINES_VOCATION.map");
    expect(src).toContain("vocation:");
  });
});

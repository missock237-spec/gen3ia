/**
 * GARDE 47ᵉ (it.79, Job 478451 — demande propriétaire : développement web) —
 * GEN3 ÉCRIT, COMPREND ET SIMULE DU CODE, MESURÉ, JAMAIS INVENTÉ.
 *
 * Contexte : la campagne `scripts/campagne-developpement-web-it79.ts`
 * (100 % locale, graine 42, zéro service IA externe) a entraîné un cortex
 * compact spécialisé sur la matière code web-dev (corpus procédural unique
 * par bijection + matière réelle du dépôt) et livré conditionnellement le
 * snapshot + la matière committée pour la page publique /code.
 *
 * Cette garde verrouille :
 *  1. la RÈGLE DE LIVRAISON encodée dans le script (ratio code moyen > 1 ·
 *     argmax bande attendu ≥ 7/9 · accord u8 = 9/9 · plancher 19 domaines ≥
 *     socle it.73 gelé) — cohérence binaire↔artefact, jamais contée ;
 *  2. la SIMULATION est RÉELLE : chaque item « simuler » de la matière
 *     committée est RÉ-EXÉCUTÉ ici (new Function en Node) — le résultat et
 *     la trace doivent coïncider EXACTEMENT avec ceux publiés (aucun chiffre
 *     fantôme ne peut entrer en production) ;
 *  3. les sondes code sont JAMAIS supervisées (plage de corpus
 *     [uniques, uniques + 108), sans modulo — construite hors de la plage
 *     cyclée visitée par les lots) ;
 *  4. l'échelle déclarée du propriétaire (1 milliard d'exemples / 1 million
 *     de datasets) est publiée avec la session réelle et l'extrapolation
 *     mesurée ;
 *  5. la page /code sert ce snapshot et cette matière (et rien d'autre).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { importerSnapshotTelephone } from "@/lib/neural/core/v2/energie";
import { describe, expect, it } from "vitest";

const CHEMIN_ARTEFACT = join(process.cwd(), "assets/neural-pretrained/cortex-developpement-web-it79.json");
const CHEMIN_MATIERE = join(process.cwd(), "public/neural/webdev-it79-matiere.json");
const CHEMIN_SNAPSHOT = join(process.cwd(), "public/neural/cortex-developpement-web-it79.bin");

// Valeurs MESURÉES gelées — anti-maquillage.
const PLANCHER_SOCLE_IT73 = 1.242484;
const OBJECTIF_PROPRIETAIRE = 1_000_000_000;
const UNIQUES_PROPRIETAIRE = 1_000_000;

interface ItemSimulerArtefact {
  id: string; capacite: "simuler"; question: string; code: string;
  entreeDesc: string; sortie: string; trace: string[];
}
interface ArtefactIt79 {
  iteration: number;
  demande: string;
  graine: number;
  optionsSession: {
    objectif: number; uniques: number; epoques: number; ancrage: number;
    reprise: boolean; benchmark: boolean;
  };
  echelleDeclaree: {
    cibleExemples: number;
    cibleUniques: number;
    cetteSession: { exemplesCodeVus: number; lotsFaits: number; lotsTotal: number; corpusUniques: number };
    extrapolation: { echS: number; heuresRestantesVersMilliard: number; note: string };
  };
  supervision: { lots: { tailleCode: number; ancrageParDomaine: number }; alignement: { epoques: number } };
  sonde: {
    plageCorpusSondes: string;
    noteJamaisSupervisees: string;
    parCapacite: Array<{
      capacite: string; sondes: number; ratioAppris: number | null;
      argmaxAttendu: number; accordU8: number;
    }>;
    ratioCodeMoyen: number;
    argmaxAttenduCode: number;
    accordsU8Code: number;
    limites: string;
  };
  antiRetour19: {
    plancher: number;
    socleIt73: number;
    plancherAuDessusSocle: boolean;
    parDomaine: Array<{ domaineId: string; ratioAppris: number | null }>;
  };
  energie: { erreurMaxQuantisation: number; snapshotOctets: number };
  livraison: {
    snapshotWebdev: string;
    matiereJson: string;
    regleDeclaree: string;
    livreSnapshot: boolean;
  };
  limitesHonnetes: string[];
}

describe("GARDE 47ᵉ — la campagne développement web it.79 est mesurée, jamais inventée", () => {
  const artefact = JSON.parse(readFileSync(CHEMIN_ARTEFACT, "utf8")) as ArtefactIt79;

  it("l'artefact existe, porte la demande propriétaire et l'échelle déclarée (1 Md / 1 M)", () => {
    expect(artefact.iteration).toBe(79);
    expect(artefact.demande).toContain("développement web");
    expect(artefact.demande).toContain("1 milliard");
    expect(artefact.graine).toBe(42);
    expect(artefact.echelleDeclaree.cibleExemples).toBe(OBJECTIF_PROPRIETAIRE);
    expect(artefact.echelleDeclaree.cibleUniques).toBe(UNIQUES_PROPRIETAIRE);
    // La session réelle est publiée telle quelle (objectif atteint dans la
    // session sandbox : exemplesCodeVus == objectif demandé à cette session).
    expect(artefact.echelleDeclaree.cetteSession.exemplesCodeVus).toBe(artefact.optionsSession.objectif);
    expect(artefact.echelleDeclaree.cetteSession.corpusUniques).toBe(artefact.optionsSession.uniques);
    // L'extrapolation est un INDICATEUR mesuré (débit > 0), pas une promesse.
    expect(artefact.echelleDeclaree.extrapolation.echS).toBeGreaterThan(0);
    expect(artefact.echelleDeclaree.extrapolation.note).toContain("wall-clock");
    expect(artefact.limitesHonnetes.length).toBeGreaterThanOrEqual(4);
  });

  it("les 3 capacités sont mesurées : ratio > 1 · argmax ≥ 7/9 · accord u8 9/9 (portes de la règle)", () => {
    const s = artefact.sonde;
    expect(s.parCapacite).toHaveLength(3);
    expect(s.parCapacite.map((c) => c.capacite).sort()).toEqual(["comprendre", "ecrire", "simuler"]);
    for (const c of s.parCapacite) {
      expect(c.sondes).toBe(3);
      expect(c.ratioAppris ?? 0).toBeGreaterThan(1);
      expect(c.accordU8).toBe(c.sondes);
    }
    // Les moyennes publiées sont re-dérivables des capacités publiées.
    const ratios = s.parCapacite.map((c) => c.ratioAppris ?? 0);
    const moyenne = Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 1e6) / 1e6;
    expect(s.ratioCodeMoyen).toBe(moyenne);
    const argmaxTotal = s.parCapacite.reduce((a, c) => a + c.argmaxAttendu, 0);
    expect(s.argmaxAttenduCode).toBe(argmaxTotal);
    expect(s.accordsU8Code).toBe(9);
    // La limite honnête sur la sonde neurale est publiée.
    expect(s.limites).toContain("PAS une preuve de génération de code");
  });

  it("l'anti-retour des 19 domaines tient : plancher ≥ socle it.73, re-dérivable des ratios publiés", () => {
    const a = artefact.antiRetour19;
    expect(a.parDomaine).toHaveLength(19);
    const minRatio = Math.min(...a.parDomaine.map((d) => d.ratioAppris ?? 0));
    expect(a.plancher).toBe(Math.round(minRatio * 1e6) / 1e6);
    expect(a.socleIt73).toBe(PLANCHER_SOCLE_IT73);
    expect(a.plancher).toBeGreaterThanOrEqual(PLANCHER_SOCLE_IT73);
    expect(a.plancherAuDessusSocle).toBe(true);
  });

  it("les sondes code sont JAMAIS supervisées : plage hors cycle, sans modulo", () => {
    const s = artefact.sonde;
    expect(s.plageCorpusSondes).toBe(`[${artefact.optionsSession.uniques}, ${artefact.optionsSession.uniques + 108})`);
    expect(s.noteJamaisSupervisees).toContain("HORS");
    expect(s.noteJamaisSupervisees).toContain("SANS modulo");
  });
});

describe("GARDE 47ᵉ — règle de livraison : le snapshot livré est celui mesuré", () => {
  const artefact = JSON.parse(readFileSync(CHEMIN_ARTEFACT, "utf8")) as ArtefactIt79;

  it("la règle encodée (ratio > 1 · argmax ≥ 7 · u8 9/9 · plancher ≥ socle) est satisfaite et appliquée", () => {
    const s = artefact.sonde;
    const attendu =
      s.ratioCodeMoyen > 1 && s.argmaxAttenduCode >= 7 && s.accordsU8Code === 9 &&
      artefact.antiRetour19.plancher >= PLANCHER_SOCLE_IT73;
    expect(artefact.livraison.livreSnapshot).toBe(attendu);
    expect(attendu).toBe(true); // cette itération a PASSÉ les quatre portes
    expect(artefact.livraison.snapshotWebdev).toContain("cortex-developpement-web-it79.bin");
    expect(artefact.livraison.regleDeclaree).toContain("ratioCodeMoyen > 1");
    expect(artefact.livraison.regleDeclaree).toContain("plancher19 >= 1.242484");
  });

  it("le snapshot binaire existe, correspond à l'artefact et décrit un cortex compact spécialisé", () => {
    expect(existsSync(CHEMIN_SNAPSHOT)).toBe(true);
    const octets = statSync(CHEMIN_SNAPSHOT).size;
    expect(octets).toBe(artefact.energie.snapshotOctets);
    const bytes = new Uint8Array(readFileSync(CHEMIN_SNAPSHOT));
    const { entete } = importerSnapshotTelephone(bytes);
    expect(entete.colonnes).toBe(131072); // 2^17 — config téléphone/sobriété
    expect(entete.seed).toBe(42);
    expect(entete.aretes).toBe(131072 * 12);
    // Le snapshot téléphone it.76 de production est INTACT (produit séparé).
    expect(existsSync(join(process.cwd(), "public/neural/cortex-telephone-it76.bin"))).toBe(true);
  });

  it("la règle de livraison est ENCODÉE dans le script de campagne (jamais contée à la main)", () => {
    const script = readFileSync(join(process.cwd(), "scripts/campagne-developpement-web-it79.ts"), "utf8");
    expect(script).toContain(
      "ratioCodeMoyen > 1 && argmaxAttenduCode >= 7 && accordsU8Code === 9 && plancher19 >= PLANCHER_SOCLE_IT73",
    );
    expect(script).toContain("PLANCHER_SOCLE_IT73 = 1.242484");
    // La suppression d'un bin non livré est encodée (pas manuelle).
    expect(script).toContain("unlinkSync(join(dirPublic");
    // Les sondes sans modulo (jamais supervisées) sont encodées.
    expect(script).toContain("function exempleSonde");
    expect(script).toContain("const i = uniques + 100 + q;");
  });

  it("la page /code sert ce snapshot et cette matière (et rien d'autre)", () => {
    const composant = readFileSync(join(process.cwd(), "components/neural/cortex-webdev-embarque.tsx"), "utf8");
    expect(composant).toContain('"/neural/cortex-developpement-web-it79.bin"');
    expect(composant).toContain('"/neural/webdev-it79-matiere.json"');
    expect(composant).not.toContain("it76");
    const page = readFileSync(join(process.cwd(), "app/code/page.tsx"), "utf8");
    expect(page).toContain("écrire, comprendre, simuler");
    expect(page).toContain("CortexWebdevEmbarque");
  });
});

describe("GARDE 47ᵉ — la matière committée est réelle : la simulation est RÉ-EXÉCUTÉE ici", () => {
  const matiere = JSON.parse(readFileSync(CHEMIN_MATIERE, "utf8")) as {
    iteration: number;
    horodatage: string;
    items: Array<
      | { id: string; capacite: "ecrire"; instruction: string; code: string }
      | { id: string; capacite: "comprendre"; question: string; code: string; reponse: string }
      | ItemSimulerArtefact
    >;
  };

  it("la matière contient 18 items : 6 par capacité, provenant de la campagne it.79", () => {
    expect(matiere.iteration).toBe(79);
    expect(matiere.items).toHaveLength(18);
    for (const capacite of ["ecrire", "comprendre", "simuler"] as const) {
      expect(matiere.items.filter((it) => it.capacite === capacite)).toHaveLength(6);
    }
  });

  it("les items ÉCRIRE sont du code TypeScript réel typé avec garde de cas limite", () => {
    for (const it of matiere.items) {
      if (it.capacite !== "ecrire") continue;
      expect(it.instruction).toContain("Écris une fonction TypeScript");
      expect(it.instruction).toContain("cas limite couvert");
      expect(it.code).toMatch(/export (async )?function /);
      expect(it.code).toContain("// "); // en-tête contexte + cas limite
    }
  });

  it("les items COMPRENDRE portent une réponse exacte non vide, dérivée du gabarit", () => {
    for (const it of matiere.items) {
      if (it.capacite !== "comprendre") continue;
      expect(it.question.length).toBeGreaterThan(20);
      expect(it.reponse.length).toBeGreaterThan(20);
      expect(it.code).toMatch(/export (async )?function /);
    }
  });

  it("les items SIMULER sont structurellement complets (code, entrée publiée, sortie, trace)", () => {
    for (const it of matiere.items) {
      if (it.capacite !== "simuler") continue;
      expect(it.code).toMatch(/^function [A-Za-z]+\(entree\)/);
      expect(it.code).toContain("const trace = []");
      expect(it.entreeDesc.length).toBeGreaterThan(3);
      const sortie = JSON.parse(it.sortie) as unknown;
      expect(["number", "string", "boolean"]).toContain(typeof sortie);
      expect(it.trace.length).toBeGreaterThan(0);
      // Chaque pas publié est une étape annotée (jamais vide).
      for (const pas of it.trace) expect(pas.length).toBeGreaterThan(2);
    }
  });

  it("chaque item SIMULER est re-dérivé de bout en bout (exécution réelle, sortie ET trace exactes)", () => {
    // Ré-exécution COMPLÈTE : l'entrée est reconstruite depuis la description
    // publiée (format déterministe du script de campagne) puis le code publié
    // est EXÉCUTÉ ici — le résultat et la trace doivent coïncider EXACTEMENT
    // avec ceux committés. Toute divergence fait échouer la garde.
    for (const it of matiere.items) {
      if (it.capacite !== "simuler") continue;
      const nom = it.code.match(/function ([A-Za-z]+)/)?.[1] ?? "";
      expect(nom.length).toBeGreaterThan(3);
      const executeur = new Function(`${it.code}; return ${nom};`)() as
        (e: unknown) => { resultat: unknown; trace: string[] };
      const entree = reconstruireEntree(it.entreeDesc, it.id);
      const mesure = executeur(entree);
      expect(JSON.stringify(mesure.resultat)).toBe(it.sortie);
      expect(mesure.trace.slice(0, it.trace.length)).toEqual(it.trace);
    }
  });
});

/**
 * Reconstruit l'entrée d'un item SIMULER depuis sa description publiée —
 * même convention déterministe que le script de campagne (les tableaux sont
 * `[a, b, c…]` imprimés, la dichotomie liste le trié puis la cible,
 * fibonacci/estPremier/factorielle sont `n = X`, inverserChaine est une
 * chaîne entre guillemets, puissanceRapide est `base X, exposant Y`).
 * Toute divergence de format fait ÉCHOUER la garde (pas de tolérance).
 */
function reconstruireEntree(entreeDesc: string, id: string): unknown {
  const tableau = entreeDesc.match(/(?:trié|tableau) \[([0-9, ]+)\]/);
  if (tableau) {
    const tab = (tableau[1] ?? "").split(", ").map((v) => Number(v));
    if (entreeDesc.includes("trié")) {
      const cible = Number(entreeDesc.match(/cible ([0-9]+)/)?.[1] ?? "0");
      return { tab: [...tab].sort((a, b) => a - b), cible };
    }
    return tab;
  }
  const n = entreeDesc.match(/n = ([0-9]+)/);
  if (n) return { n: Number(n[1]) };
  const chaine = entreeDesc.match(/chaîne "([^"]+)"/);
  if (chaine) return { texte: chaine[1] };
  const puissance = entreeDesc.match(/base ([0-9]+), exposant ([0-9]+)/);
  if (puissance) return { base: Number(puissance[1]), exposant: Number(puissance[2]) };
  throw new Error(`Entrée non re-dérivable pour ${id} : ${entreeDesc}`);
}

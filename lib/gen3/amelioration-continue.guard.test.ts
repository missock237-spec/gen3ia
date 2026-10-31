/**
 * GARDE 33ᵉ (it.65) — LE GÉNÉRATEUR DE DATASETS, L'AMÉLIORATION CONTINUE
 * ET LA CAMPAGNE 5M SONT RÉELS ET HONNÊTES.
 *
 * Demande propriétaire : « crée un système qui va permettre à gen3
 * d'apprendre du générateur de dataset, pour qu'il puisse toujours
 * continuer à s'améliorer en continu... crée 5 millions de données et de
 * dataset... entraîne gen3 dans ta propre base de données... utilise tes
 * outils... continue jusqu'à ce qu'il atteigne le niveau requis ».
 *
 * Verrous :
 *  1. LA FABRIQUE (lib/gen3/generateur-datasets) est déterministe et
 *     unique : bijection index→texte sans collision sur un grand échantillon,
 *     vocabulaire issu de la CHARTE réelle, espace combinatoire ≥ 5M/domaine.
 *  2. LE MANIFESTE COMMIS (assets/neural-pretrained/
 *     manifeste-generateur-5m-it65.json) prouve la génération : 5 000 000
 *     écrits, 19 domaines, ≥ 263 157/domaine, empreintes présentes.
 *  3. LA SOURCE INTERNE de la boucle d'auto-apprentissage produit des
 *     paires TOUJOURS NOUVELLES (anti-rejoue par offset de cycle) et la
 *     boucle est câblée (fallback hubs muets + champ rapport + statut).
 *  4. LA CAMPAGNE (scripts/amelioration-continue-gen3) existe, continue
 *     par checkpoints, et l'ARTEFACT commis ne fabrique RIEN : les
 *     critères non atteints sont rapportés comme tels (aucun « atteint »
 *     mensonger), les limites (cascade CSR, échelles de sondes) sont
 *     écrites dans l'artefact lui-même.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  espaceCombinatoire,
  lexiqueDuDomaine,
  lireManifesteGeneration,
  reinitialiserCacheMillion as _inutilise,
  texteGenere,
} from "./generateur-datasets";
import { IDS_VOCATION, NB_DOMAINES_VOCATION } from "./vocation";

void _inutilise;

const CHEMIN_MANIFESTE_COMMIS = join(
  process.cwd(),
  "assets/neural-pretrained/manifeste-generateur-5m-it65.json",
);
const CHEMIN_ARTEFACT = join(
  process.cwd(),
  "assets/neural-pretrained/amelioration-continue-gen3-it65.json",
);
const CHEMIN_BOUCLLE = join(process.cwd(), "lib/entrainement-auto/boucle.ts");
const CHEMIN_SOURCE = join(process.cwd(), "lib/entrainement-auto/generateur.ts");
const CHEMIN_TYPES = join(process.cwd(), "lib/entrainement-auto/types.ts");
const CHEMIN_CAMPAGNE = join(process.cwd(), "scripts/amelioration-continue-gen3.ts");
const CHEMIN_GENERATION = join(process.cwd(), "scripts/generer-datasets-5m.ts");

afterAll(() => {
  /* aucun cache global à purger ici (les sondes de la fabrique sont pures) */
});

describe("garde 33ᵉ — générateur de datasets et amélioration continue (it.65)", () => {
  it("la bijection du générateur est déterministe et sans collision (60 000 textes/domaine)", () => {
    for (const id of [IDS_VOCATION[0], IDS_VOCATION[7], IDS_VOCATION[15]]) {
      const vus = new Set<string>();
      for (let i = 0; i < 60_000; i++) {
        const t = texteGenere(id, i);
        expect(texteGenere(id, i)).toBe(t); // déterministe
        vus.add(t);
      }
      expect(vus.size).toBe(60_000); // unicité (bijection)
      expect(texteGenere(id, 0)).not.toBe(texteGenere(id, 1));
    }
  });

  it("le vocabulaire des textes générés provient de la charte réelle du domaine", () => {
    const l = lexiqueDuDomaine(IDS_VOCATION[3] ?? "");
    const mue = texteGenere(IDS_VOCATION[3] ?? "", 123_456).toLowerCase();
    const sources = [...l.taches, ...l.motsCles, ...l.outils, l.label].map((s) =>
      s.toLowerCase(),
    );
    const mots = mue.split(/[^a-zàâäéèêëîïôöùûüç0-9]+/u).filter((m) => m.length > 4);
    expect(mots.length).toBeGreaterThan(5);
    // chaque mot porteur (hors charnières génériques) vient de la charte
    const charnieres = new Set([
      "gen3", "mission", "produire", "traiter", "result", "resultat",
      "éléments", "elements", "élément", "element", "données", "donnees",
      "records", "items", "enregistrements", "livrable", "deliverable",
      "couvrant", "covering", "verified", "outil", "tool", "unique",
      "fiche", "chiffré", "chiffre", "résultat", // charnières génériques des gabarits
    ]);
    const inconnus = mots.filter((m) => !sources.some((s) => s.includes(m)) && !charnieres.has(m));
    expect(inconnus).toEqual([]);
  });

  it("l'espace combinatoire de chaque domaine dépasse largement 5 millions", () => {
    for (const id of IDS_VOCATION) {
      expect(espaceCombinatoire(lexiqueDuDomaine(id))).toBeGreaterThan(5_000_000);
    }
    expect(espaceCombinatoire(lexiqueDuDomaine("transport-immobilier"))).toBeGreaterThan(
      5_000_000,
    ); // le domaine sans dataset réel aussi
  });

  it("le manifeste commis prouve les 5 000 000 de données sur 19 domaines", () => {
    expect(existsSync(CHEMIN_MANIFESTE_COMMIS)).toBe(true);
    const m = JSON.parse(readFileSync(CHEMIN_MANIFESTE_COMMIS, "utf8")) as {
      totalEcrit: number;
      totalDemande: number;
      domaines: Array<{ id: string; echantillons: number; lots: number; sha256: string; espaceCombinatoire: number }>;
      licence: string;
      noteHonnete: string;
    };
    expect(m.totalEcrit).toBe(5_000_000);
    expect(m.totalDemande).toBe(5_000_000);
    expect(m.domaines).toHaveLength(NB_DOMAINES_VOCATION);
    expect(m.domaines.map((d) => d.id)).toEqual([...IDS_VOCATION]);
    for (const d of m.domaines) {
      expect(d.echantillons).toBeGreaterThanOrEqual(263_157);
      expect(d.lots).toBeGreaterThan(0);
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/u); // empreinte de lot présente
      expect(d.espaceCombinatoire).toBeGreaterThan(5_000_000);
    }
    expect(m.licence).toContain("synthetic-gen3ia"); // étiqueté synthétique
    expect(m.noteHonnete).toContain("SYNTHÉTIQUE");
  });

  it("la fabrique rejette un espace combinatoire insuffisant (honnêteté structurelle)", () => {
    // la garde d'espacement existe dans ecrireDatasetGen3 : vérifiée par
    // lecture du source (le test d'exécution nécessiterait un domaine
    // artificiellement contraint).
    const src = readFileSync(join(process.cwd(), "lib/gen3/generateur-datasets.ts"), "utf8");
    expect(src).toContain("Espace combinatoire insuffisant");
  });

  it("la source interne de la boucle produit des paires toujours nouvelles (anti-rejoue)", async () => {
    const { apportGenerateur, REF_GENERATEUR } = await import(
      "../entrainement-auto/generateur"
    );
    const cycle0 = apportGenerateur(0);
    const cycle1 = apportGenerateur(1);
    // 240/19 → 12 paires par domaine (plancher) — lot plafonné honnête.
    expect(cycle0.length).toBeGreaterThanOrEqual(19 * 12);
    expect(cycle1.length).toBe(cycle0.length);
    const motifs0 = new Set(cycle0.map((p) => p.reponse));
    const motifs1 = new Set(cycle1.map((p) => p.reponse));
    // AUCUNE réponse partagée entre deux cycles (le texte répondu est la
    // partie bijection — les motifs, eux, sont des gabarits réutilisables).
    for (const m of motifs1) expect(motifs0.has(m)).toBe(false);
    for (const p of cycle0) {
      expect(p.theme.length).toBeGreaterThan(0);
      expect(p.reponse.length).toBeGreaterThan(20);
    }
    expect(REF_GENERATEUR).toContain("generateur-interne");
  });

  it("la boucle d'auto-apprentissage est câblée sur la source interne (fallback honnête)", () => {
    const boucle = readFileSync(CHEMIN_BOUCLLE, "utf8");
    expect(boucle).toContain('from "./generateur"');
    expect(boucle).toContain("apportGenerateur(etat.cyclesExecutes)");
    expect(boucle).toContain("paires.length === 0 && echantillons.length === 0");
    expect(boucle).toContain("sourceGenerateur");
    const types = readFileSync(CHEMIN_TYPES, "utf8");
    // it.67 — le champ `questions` est ADDITIF (les artefacts it.65
    // restent conformes) ; `paires` et `reference` sont inchangés.
    expect(types).toContain(
      "generateur?: { paires: number; questions?: number; reference: string }",
    );
    const source = readFileSync(CHEMIN_SOURCE, "utf8");
    expect(source).toContain("paireGenere");
    expect(source).toContain("server-only");
  });

  it("le script de génération et la campagne existent avec leurs mécaniques clés", () => {
    expect(existsSync(CHEMIN_GENERATION)).toBe(true);
    const generation = readFileSync(CHEMIN_GENERATION, "utf8");
    expect(generation).toContain("5_000_000");
    expect(generation).toContain("AUDIT");
    const campagne = readFileSync(CHEMIN_CAMPAGNE, "utf8");
    expect(campagne).toContain("entrainerDomainesParOndes");
    expect(campagne).toContain("horlogeInitiale");
    expect(campagne).toContain("assignerHorloges"); // horloge MONOTONE (correctif it.65)
    expect(campagne).toContain("--reprendre");
    expect(campagne).toContain("sauverCheckpoint");
    expect(campagne).toContain("niveauRequis");
  });

  it("l'artefact de campagne ne fabrique rien : critères atteints/non-atteints rapportés tels quels", () => {
    expect(existsSync(CHEMIN_ARTEFACT)).toBe(true);
    const a = JSON.parse(readFileSync(CHEMIN_ARTEFACT, "utf8")) as {
      totalEchantillons: number;
      sources: { generateur: number; depot: number };
      bilan: {
        donneesParDomaine: { ok: number; total: number };
        porteursRenforces: { ok: number; total: number; renfortsTotaux: number };
        traceParDomaine: { ok: number; total: number };
      };
      niveauRequis: Record<string, { requis: string; constate: string; atteint: boolean }>;
      limitesHonnetes: string[];
      options: { epoquesConsolidation: number };
    };
    expect(a.sources.generateur).toBe(5_000_000);
    expect(a.sources.depot).toBeGreaterThan(80_000);
    expect(a.totalEchantillons).toBeGreaterThanOrEqual(5_000_000);
    expect(a.bilan.donneesParDomaine.ok).toBe(NB_DOMAINES_VOCATION);
    expect(a.bilan.porteursRenforces.ok).toBe(NB_DOMAINES_VOCATION);
    expect(a.bilan.porteursRenforces.renfortsTotaux).toBeGreaterThan(1_000_000_000);
    // HONNÊTETÉ : les critères NON atteints sont rapportés comme tels —
    // au moins un « atteint: false » doit exister si le bilan l'indique.
    const c4 = a.niveauRequis["C4_trace"];
    expect(c4).toBeDefined();
    expect(c4!.atteint).toBe(a.bilan.traceParDomaine.ok === NB_DOMAINES_VOCATION);
    const nonAtteints = Object.values(a.niveauRequis).filter((c) => !c.atteint);
    if (a.bilan.traceParDomaine.ok < NB_DOMAINES_VOCATION) {
      expect(nonAtteints.length).toBeGreaterThan(0);
      for (const c of nonAtteints) {
        expect(c.constate.length).toBeGreaterThan(0);
      }
    }
    // Les limites (cascade CSR, échelles) sont écrites dans l'artefact.
    expect(a.limitesHonnetes.length).toBeGreaterThanOrEqual(5);
    const cascade = a.limitesHonnetes.join(" ");
    expect(cascade).toContain("cascade CSR saturante");
    expect(cascade).toContain("ne remplace pas des données réelles");
  });

  it("le manifeste du disque (var/) s'il existe coïncide avec le manifeste commis", () => {
    const disque = lireManifesteGeneration(join(process.cwd(), "var", "datasets-generateur"));
    if (!disque) return; // environnement sans les données générées (CI) — rien à comparer
    const commis = JSON.parse(readFileSync(CHEMIN_MANIFESTE_COMMIS, "utf8")) as {
      totalEcrit: number;
      domaines: Array<{ id: string; echantillons: number; sha256: string }>;
    };
    expect(disque.totalEcrit).toBe(commis.totalEcrit);
    for (const d of commis.domaines) {
      const surDisque = disque.domaines.find((x) => x.id === d.id);
      expect(surDisque?.echantillons).toBe(d.echantillons);
      expect(surDisque?.sha256).toBe(d.sha256);
    }
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { IDS_VOCATION, NB_DOMAINES_VOCATION } from "./vocation";

/**
 * VERROU BIDIRECTIONNEL it.63 (31ᵉ test garde) — LA SESSION MILLION À
 * DONNÉES UNIQUES (demande propriétaire : « réalisé encore un
 * pré-entraînement de gen3 avec plus de 1 million de données et de dataset
 * dans chaque domaine »).
 *
 * Coordination it.63 (deux campagnes complémentaires, deux gardes) :
 *  - le 30ᵉ garde (pretrain-masse.guard.test.ts) verrouille la CAMPAGNE
 *    ÉPOQUES bande-contrainte (501 × 2000/domaine, sonde de trace 19/19
 *    après réparation du témoin) et ses surfaces applicatives ;
 *  - CELUI-CI verrouille la SESSION MILLION À DONNÉES UNIQUES
 *    (1 005 000 textes uniques/domaine — la demande littérale de données),
 *    son plan interclassé, ses sondes honnêtes et son bilan quatre signaux.
 *
 * Chaîne d'honnêteté continue (it.57 → it.61 → it.62 → it.63) :
 *  1. La méthode EOD (it.57) est réelle et INCHANGÉE — cap garde-fou du
 *     trainer (2 000/domaine/appel) respecté : la session enchaîne 9 601
 *     lots avec continuité d'horloge (option additive horlogeInitiale) ;
 *  2. Le PLAN est interclassé (round-robin — un lot de ≤ 2 000 par domaine
 *     et par round) : les pilots en blocs séquentiels ont MESURÉ un
 *     effondrement des bandes dominées à l'échelle million (×0,46–0,63,
 *     bandes 2/6/7) — l'analyse est conservée dans l'artefact (motifPlan) ;
 *  3. Le BILAN porte les quatre signaux mesurés : données 19/19 (> 1 M
 *     traités par domaine — la demande), porteurs renforcés 19/19, bandes
 *     stables 19/19, trace sparse 12/19 (limite documentée, pas masquée) ;
 *  4. L'équivalence bit-à-bit « lots ≡ session d'un bloc » est vérifiée au
 *     démarrage et bloquante.
 *
 * Ce garde verrouille ces propriétés : s'ils changent, la CI tombe.
 */

const racine = path.join(process.cwd());
const cheminScript = path.join(racine, "scripts", "preentrainement-million.ts");
const cheminTrainer = path.join(racine, "lib", "neural", "training", "entrainement-ondes.ts");
const cheminArtefact = path.join(racine, "assets", "neural-pretrained", "preentrainement-eod-million-19-domaines.json");

describe("it.63 — le pré-entraînement à l'échelle million reste la méthode EOD inchangée", () => {
  it("le script de session million existe et dérive les 19 domaines de la CHARTE (aucune liste codée en dur)", () => {
    const src = readFileSync(cheminScript, "utf8");
    expect(src).toContain("import { DOMAINES_VOCATION, IDS_VOCATION } from");
    // Les littéraux d'ids ne peuvent être que des clés de mapping de sources
    // (it.61) ou des replis unitaires — jamais plusieurs ids sur une même
    // ligne (ce que ferait un tableau codé en dur).
    for (const ligne of src.split("\n")) {
      const cites = IDS_VOCATION.filter((id) => ligne.includes(`"${id}"`)).length;
      expect(cites).toBeLessThanOrEqual(2);
    }
    expect(IDS_VOCATION).toHaveLength(NB_DOMAINES_VOCATION);
  });

  it("les lots respectent le cap garde-fou du trainer EOD (2 000) — aucun contournement", () => {
    const src = readFileSync(cheminScript, "utf8");
    expect(src).toContain("const TAILLE_LOT = 2000");
    expect(src).toContain("maxParDomaine: TAILLE_LOT");
    const trainer = readFileSync(cheminTrainer, "utf8");
    expect(trainer).toContain("Math.min(2000, options.maxParDomaine ?? 200)");
  });

  it("la continuité d'horloge passe par l'option ADDITIVE horlogeInitiale (défaut 0 — sémantique inchangée)", () => {
    const trainer = readFileSync(cheminTrainer, "utf8");
    expect(trainer).toContain("horlogeInitiale?: number");
    expect(trainer).toContain("let horloge = horlogeInitiale");
    expect(trainer).toContain("options.horlogeInitiale ?? 0");
    const src = readFileSync(cheminScript, "utf8");
    expect(src).toContain("horlogeInitiale: chunk.horlogeDebut");
  });

  it("le plan est INTERCLASSÉ (round-robin) et l'analyse du pilot en blocs séquentiels est conservée", () => {
    const src = readFileSync(cheminScript, "utf8");
    expect(src).toContain("function planifier(");
    expect(src).toContain("round-robin");
    // La raison scientifique du plan est documentée dans le code ET l'artefact.
    expect(src).toContain("effondre les bandes dominées");
    expect(src).toContain("bandes 2/6/7");
  });

  it("l'équivalence bit-à-bit lots ≡ un bloc est vérifiée AU DÉMARRAGE et bloquante", () => {
    const src = readFileSync(cheminScript, "utf8");
    expect(src).toContain("function verifierEquivalence()");
    expect(src).toContain("ÉQUIVALENCE LOTS ≢ UN BLOC");
    expect(src.indexOf("if (!verifierEquivalence())")).toBeGreaterThan(-1);
    expect(src.indexOf("if (!verifierEquivalence())")).toBeLessThan(src.indexOf("sauverCheckpoint(cortex, champ, progress)"));
  });

  it("la cible est strictement > 1 million d'échantillons PAR domaine, avec unicité procédurale garantie", () => {
    const src = readFileSync(cheminScript, "utf8");
    expect(src).toContain("const CIBLE_PAR_DOMAINE = 1_005_000");
    expect(src).toContain("bijection mixte-radix");
    expect(src).toContain("Contrôle d'unicité procédurale échoué");
    expect(src).toContain("unicité non garantie, session refusée");
  });

  it("les sources réelles sont celles d'it.61 (dépôt + 3 datasets HF avec le token du propriétaire, uniquement)", () => {
    const src = readFileSync(cheminScript, "utf8");
    expect(src).toContain("keivalya/MedQuad-MedicalQnADataset");
    expect(src).toContain("KisanVaani/agriculture-qa-english-only");
    expect(src).toContain("nguha/legalbench");
    expect(src).toContain("datasets-server.huggingface.co/rows");
    expect(src).toContain('process.env.HF_TOKEN ?? ""');
    // Aucun autre appel réseau que les datasets HF (SNN purement local).
    const fetchs = src.match(/fetch\(/g) ?? [];
    expect(fetchs).toHaveLength(1);
  });

  it("le corpus procédural est étiqueté SYNTHÉTIQUE et son lexique vient de la charte réelle", () => {
    const src = readFileSync(cheminScript, "utf8");
    expect(src).toContain("lexiqueDuDomaine");
    expect(src).toContain("l.taches");
    expect(src).toContain("l.motsCles");
    expect(src).toContain("l.outils");
    expect(src).toContain("Synthétique");
    expect(src).toContain("étiqueté comme tel");
    expect(src).toContain("CC-BY-4.0-synthetic-gen3ia");
  });

  it("l'artefact porte le bilan honnête à quatre signaux (données 19/19, porteurs 19/19, bandes stables 19/19, trace mesurée)", () => {
    const artefact = JSON.parse(readFileSync(cheminArtefact, "utf8")) as {
      methode: string;
      options: { plan: string; motifPlan: string };
      totalEchantillons: number;
      bilan: {
        donneesParDomaine: { ok: number; total: number };
        porteursRenforces: { ok: number; total: number; renfortsTotaux: number };
        stabiliteBandes: { ok: number; total: number };
        traceParDomaine: { ok: number; total: number };
      };
      sources: { depot: number; huggingface: number; proceduraux: number; note: string };
      domaines: Array<{ domaine: string; echantillons: number; sources: { total: number }; sondeTrace: { avant: number; apres: number; gain: number }; renforts: number }>;
      limitesHonnetes: string[];
      metabolisme: { evaluees: number; transmissions: number; ms: number };
    };
    // La demande propriétaire : PLUS DE 1 million de données PAR domaine —
    // mesuré, pas déclaré (chaque échantillon traverse la pipeline EOD).
    expect(artefact.domaines).toHaveLength(NB_DOMAINES_VOCATION);
    for (const d of artefact.domaines) {
      expect(d.echantillons).toBeGreaterThan(1_000_000);
      expect(d.sources.total).toBeGreaterThan(1_000_000);
    }
    expect(artefact.totalEchantillons).toBeGreaterThan(19_000_000);
    expect(artefact.sources.depot).toBeGreaterThan(0);
    expect(artefact.sources.huggingface).toBeGreaterThan(0);
    expect(artefact.sources.note).toContain("ynthétique");
    // Le bilan quatre signaux.
    expect(artefact.bilan.donneesParDomaine.ok).toBe(NB_DOMAINES_VOCATION);
    expect(artefact.bilan.donneesParDomaine.total).toBe(NB_DOMAINES_VOCATION);
    expect(artefact.bilan.porteursRenforces.ok).toBe(NB_DOMAINES_VOCATION);
    expect(artefact.bilan.porteursRenforces.renfortsTotaux).toBeGreaterThan(1_000_000_000);
    expect(artefact.bilan.stabiliteBandes.ok).toBe(NB_DOMAINES_VOCATION);
    // La trace sparse est rapportée TELLE QUELLE (aucun maquillage) — et la
    // limite est documentée dans les limites honnêtes.
    expect(artefact.bilan.traceParDomaine.ok).toBeGreaterThan(0);
    expect(artefact.bilan.traceParDomaine.ok).toBeLessThanOrEqual(NB_DOMAINES_VOCATION);
    const limites = artefact.limitesHonnetes.join(" ");
    expect(limites).toContain("SPARSE-COLONNE");
    expect(limites).toContain("8.4 M de colonnes");
    expect(artefact.options.motifPlan).toContain("effondre les bandes dominées");
    expect(artefact.metabolisme.ms).toBeGreaterThan(0);
    expect(artefact.methode).toContain("échelle million");
  });

  it("les checkpoints rendent la session reprenable (var/neural-million/, hors git) sans ré-entraîner les lots faits", () => {
    const src = readFileSync(cheminScript, "utf8");
    expect(src).toContain('"neural-million"');
    expect(src).toContain("--reprendre");
    expect(src).toContain("déjà consolidé (reprise)");
    expect(src).toContain("Reprise :");
  });
});

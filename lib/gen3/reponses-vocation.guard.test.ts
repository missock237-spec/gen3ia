/**
 * GARDE 34ᵉ (it.66) — GEN3 RÉPOND AUX QUESTIONS DE SON CADRE
 * D'APPRENTISSAGE, ET LA RÉPONSE EST ANCRÉE, HONNÊTE, CÂBLÉE.
 *
 * Demande propriétaire : « entraîne gen3 depuis tes propres serveurs
 * locaux… 1 million de données par domaine (atteint it.63, campagne A)…
 * fais en sorte qu'il soit capable de répondre à des questions qui
 * rentrent dans son cadre d'apprentissage ». Verrous :
 *  1. LE CORPUS DE QUESTIONS (lib/gen3/corpus-questions) couvre les 19
 *     domaines de la charte dans l'ordre du propriétaire, en FR et EN ;
 *     chaque réponse est composée DEPUIS LA CHARTE uniquement (label,
 *     tâches, outils réels) — aucune statistique inventée, aucun fait
 *     externe ; déterministe.
 *  2. LE PONT (lib/neural/vocation-pont) compose la réponse depuis le
 *     cadre : meta-questions → les 19 domaines ; question de domaine →
 *     mission + tâches + outils + score ; HORS CADRE → null (jamais de
 *     domaine ni de capacité inventés).
 *  3. LE CÂBLAGE EST RÉEL : les trois chemins du moteur (generate,
 *     generateStream, générateur) appellent composerDepuisVocation ;
 *     l'union SourceLangage et le cache reconnaissent « vocation » ; le
 *     runtime apprend les paires QA au démarrage ; l'endpoint PUBLIC
 *     /api/neural/questions existe (réponse réelle, « connu: false »
 *     honnête hors cadre) et est enregistré dans la liste publique ; la
 *     page /vocation embarque le testeur qui l'appelle.
 *  4. L'ARTEFACT DE CAMPAGNE (entrainement-questions-it66.json) est
 *     mesuré, anti-rejoué (offset ≥ 10 M), cohérent (somme = total) et
 *     rapporte son bilan tel quel (aucun critère maquillé).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CORPUS_QUESTIONS_VOCATION,
  motsInformatifsQuestion,
  rechercherPaireVocation,
  SEUIL_APPARIEMENT_QUESTION,
  statsCorpusQuestions,
} from "./corpus-questions";
import { DOMAINES_VOCATION, IDS_VOCATION, NB_DOMAINES_VOCATION } from "./vocation";
import { composerDepuisVocation, statsPontVocation } from "../neural/vocation-pont";

const CHEMIN_MOTEUR = join(process.cwd(), "lib/neural/engine.ts");
const CHEMIN_CACHE = join(process.cwd(), "lib/neural/generation/cache-reponses.ts");
const CHEMIN_RUNTIME = join(process.cwd(), "lib/neural/runtime.ts");
const CHEMIN_ROUTE = join(process.cwd(), "app/api/neural/questions/route.ts");
const CHEMIN_ACCES = join(process.cwd(), "lib/security/user-access.ts");
const CHEMIN_PAGE = join(process.cwd(), "app/vocation/page.tsx");
const CHEMIN_TESTEUR = join(process.cwd(), "components/neural/testeur-questions.tsx");
const CHEMIN_ARTEFACT = join(process.cwd(), "assets/neural-pretrained/entrainement-questions-it66.json");

describe("garde 34ᵉ — le corpus de questions du cadre (19 domaines, charte-source)", () => {
  it("couvre les 19 domaines dans l'ordre exact de la charte, FR et EN", () => {
    const stats = statsCorpusQuestions();
    expect(NB_DOMAINES_VOCATION).toBe(19);
    expect(stats.domainesCouverts).toBe(19);
    // Ordre : la première occurrence de chaque domaine suit l'ordre de la charte.
    const ordreRencontre: string[] = [];
    for (const paire of CORPUS_QUESTIONS_VOCATION) {
      if (!ordreRencontre.includes(paire.domaineId)) ordreRencontre.push(paire.domaineId);
    }
    expect(ordreRencontre).toEqual([...IDS_VOCATION]);
    // Bilingue : chaque domaine a au moins une paire FR et une paire EN.
    for (const id of IDS_VOCATION) {
      const duDomaine = CORPUS_QUESTIONS_VOCATION.filter((p) => p.domaineId === id);
      expect(duDomaine.length).toBeGreaterThanOrEqual(6);
      expect(duDomaine.some((p) => p.langue === "fr")).toBe(true);
      expect(duDomaine.some((p) => p.langue === "en")).toBe(true);
    }
  });

  it("chaque réponse est composée depuis la charte uniquement (label, tâches, outils) — zéro invention", () => {
    for (const paire of CORPUS_QUESTIONS_VOCATION) {
      const domaine = DOMAINES_VOCATION.find((d) => d.id === paire.domaineId);
      expect(domaine).toBeDefined();
      const normalise = (s: string) => s.toLowerCase();
      const dansCharte =
        normalise(paire.reponse).includes(normalise(domaine!.label)) ||
        domaine!.taches.some((t) => normalise(paire.reponse).includes(normalise(t))) ||
        domaine!.outils.some((o) => paire.reponse.includes(o));
      expect(dansCharte).toBe(true);
      // Zéro statistique fabriquée : aucun pourcentage ni total "mesuré" dans la réponse.
      expect(paire.reponse).not.toMatch(/\d+\s*%/);
      expect(paire.reponse).not.toMatch(/\b\d{1,3}(\s\d{3})+\b/);
      // Aucune promesse hors registre : la réponse cite des outils réels du domaine.
      for (const outilCite of paire.reponse.match(/(?:web|file|code|artifact|browser|knowledge|email|notion|schema|zip|data|db|ml|image|video|audio|search|open)\.[a-z_]+/g) ?? []) {
        expect(domaine!.outils).toContain(outilCite);
      }
    }
  });

  it("déterministe : même question → même paire ; hors cadre → null (jamais imposée)", () => {
    const q = "que sais-tu faire en recherche web ?";
    const a = rechercherPaireVocation(q);
    const b = rechercherPaireVocation(q);
    expect(a).toEqual(b);
    expect(a?.domaineId).toBe("recherche-web");
    // Hors cadre apparent : null, seuil respecté.
    expect(rechercherPaireVocation("")).toBeNull();
    expect(rechercherPaireVocation("xyzzy qwerty asdf")).toBeNull();
    expect(SEUIL_APPARIEMENT_QUESTION).toBeGreaterThan(0);
    expect(SEUIL_APPARIEMENT_QUESTION).toBeLessThanOrEqual(1);
  });

  it("l'anti-rejoue it.66 : les textes de campagne partent d'un offset ≥ 10 M (matière nouvelle)", () => {
    // Le corpus de questions (cortex/pont) est INDEPENDANT de la bijection
    // de campagne : sa vérification anti-rejoue porte sur l'artefact (plus bas).
    expect(CORPUS_QUESTIONS_VOCATION.length).toBeGreaterThan(300);
  });
});

describe("garde 34ᵉ — le pont vocation répond depuis le cadre, honnêtement", () => {
  it("meta-question → les 19 domaines de la charte, dans l'ordre du propriétaire", () => {
    const meta = composerDepuisVocation("quels sont tes domaines ?");
    expect(meta).not.toBeNull();
    expect(meta!.source).toBe("vocation");
    const texte = meta!.texte;
    for (const domaine of DOMAINES_VOCATION) {
      expect(texte).toContain(domaine.label);
    }
    expect((texte.match(/^\d+\./gm) ?? []).length).toBe(19);
  });

  it("question de domaine → réponse ancrée (mission, tâches, outils réels, score)", () => {
    const reponse = composerDepuisVocation("que sais-tu faire en cybersécurité ?");
    expect(reponse).not.toBeNull();
    expect(reponse!.source).toBe("vocation");
    expect(reponse!.theme).toBe("vocation:cybersecurite");
    expect(reponse!.texte).toContain("Cybersécurité");
    // Outils réels du domaine cités depuis la charte.
    const domaine = DOMAINES_VOCATION.find((d) => d.id === "cybersecurite")!;
    for (const outil of domaine.outils) {
      expect(reponse!.texte).toContain(outil);
    }
    expect(typeof reponse!.scoreAppariement).toBe("number");
  });

  it("couverture : chaque domaine des 19 répond à une question directe de son cadre", () => {
    for (const domaine of DOMAINES_VOCATION) {
      // Question construite DEPUIS LA CHARTE (mot-clé réel du domaine) —
      // le test ne fabrique jamais un libellé hors charte.
      const motCle = domaine.motsCles[0] ?? domaine.label.toLowerCase();
      const question = `peux-tu m'aider pour ${motCle} ?`;
      const reponse = composerDepuisVocation(question);
      expect(reponse, `domaine ${domaine.id} (mot-clé « ${motCle} »)`).not.toBeNull();
      expect(reponse!.source).toBe("vocation");
      expect(reponse!.theme).toBe(`vocation:${domaine.id}`);
    }
  });

  it("hors cadre apparent → null (refus honnête, la chaîne classique prend le relais)", () => {
    expect(composerDepuisVocation("")).toBeNull();
    expect(composerDepuisVocation("   ")).toBeNull();
    expect(composerDepuisVocation("quelle heure est-il à Tokyo ce matin ?")).toBeNull();
    expect(composerDepuisVocation("recette de gâteau au chocolat sans gluten")).toBeNull();
  });

  it("les statistiques du pont sont mesurées et bornées", () => {
    const stats = statsPontVocation();
    expect(stats.domainesCharte).toBe(19);
    expect(stats.pairesCorpus).toBe(CORPUS_QUESTIONS_VOCATION.length);
    expect(stats.seuilScore).toBeGreaterThanOrEqual(1);
    expect(stats.seuilPaire).toBeGreaterThan(0);
  });

  it("les mots informatifs écartent les mots outils (bilingue)", () => {
    expect(motsInformatifsQuestion("que peux-tu faire pour moi dans ce domaine ?")).not.toContain("pour");
    expect(motsInformatifsQuestion("what can you do for me ?")).not.toContain("what");
    expect(motsInformatifsQuestion("vérification factuelle multi-sources").length).toBeGreaterThan(0);
  });
});

describe("garde 34ᵉ — le câblage est réel (moteur, runtime, API publique, surface)", () => {
  const moteur = existsSync(CHEMIN_MOTEUR) ? readFileSync(CHEMIN_MOTEUR, "utf8") : "";

  it("les TROIS chemins du moteur appellent le pont vocation (generate, flux, générateur)", () => {
    expect(existsSync(CHEMIN_MOTEUR)).toBe(true);
    const occurrences = moteur.match(/composerDepuisVocation\(messageUtilisateur\)/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
    // Le pont vient AVANT le repli cortex (this.composer) dans la chaîne.
    expect(moteur).toContain('composerDepuisVocation(messageUtilisateur) ??');
    expect(moteur).toContain('import { composerDepuisVocation } from "./vocation-pont"');
  });

  it("l'union SourceLangage et le cache reconnaissent « vocation »", () => {
    expect(moteur).toContain('| "vocation"');
    const cache = readFileSync(CHEMIN_CACHE, "utf8");
    expect(cache).toContain('| "vocation"');
  });

  it("le runtime apprend les paires question→réponse de la vocation au démarrage", () => {
    const runtime = readFileSync(CHEMIN_RUNTIME, "utf8");
    expect(runtime).toContain("CORPUS_QUESTIONS_VOCATION");
    expect(runtime).toMatch(/cortex\.apprendre\(\s*CORPUS_QUESTIONS_VOCATION/);
    expect(runtime).toContain("vocation:");
  });

  it("l'endpoint PUBLIC /api/neural/questions existe, est honnête et enregistré", () => {
    expect(existsSync(CHEMIN_ROUTE)).toBe(true);
    const route = readFileSync(CHEMIN_ROUTE, "utf8");
    expect(route).toContain("composerDepuisVocation");
    expect(route).toContain("connu: false");
    const acces = readFileSync(CHEMIN_ACCES, "utf8");
    expect(acces).toContain('"/api/neural/questions": "public"');
  });

  it("la page /vocation embarque le testeur qui appelle l'endpoint", () => {
    const page = readFileSync(CHEMIN_PAGE, "utf8");
    expect(page).toContain("TesteurQuestionsVocation");
    const testeur = readFileSync(CHEMIN_TESTEUR, "utf8");
    expect(testeur).toContain('"/api/neural/questions"');
    expect(testeur).toContain("use client");
  });
});

describe("garde 34ᵉ — l'artefact de campagne QA est mesuré et sans maquillage", () => {
  it("l'artefact committé est cohérent, anti-rejoué et rapporte son bilan tel quel", () => {
    expect(existsSync(CHEMIN_ARTEFACT)).toBe(true);
    const artefact = JSON.parse(readFileSync(CHEMIN_ARTEFACT, "utf8")) as {
      totalEchantillons: number;
      lots: number;
      horlogeFinale: number;
      parametres: { cibleParDomaine: number; offsetBijection: number; formatTexte: string };
      sources: { generateur: string; charte: string; antiRejoue: string };
      bilan: {
        criteres: Record<string, { valeur: number; sur: number; atteint: boolean }>;
        limitesHonnetes: string[];
      };
      parDomaine: {
        id: string;
        echantillons: number;
        renforts: number;
        traceAvant: number;
        traceApres: number;
        gainTrace: number;
      }[];
    };

    // Ordre charte + cible atteinte partout.
    expect(artefact.parDomaine.map((d) => d.id)).toEqual([...IDS_VOCATION]);
    for (const d of artefact.parDomaine) {
      expect(d.echantillons).toBeGreaterThanOrEqual(artefact.parametres.cibleParDomaine);
      expect(d.renforts).toBeGreaterThan(0);
    }
    // Somme = total (aucun échantillon fantôme).
    const somme = artefact.parDomaine.reduce((acc, d) => acc + d.echantillons, 0);
    expect(somme).toBe(artefact.totalEchantillons);
    // Anti-rejoue : offset ≥ 10 M — matière jamais vue par it.63/it.65.
    expect(artefact.parametres.offsetBijection).toBeGreaterThanOrEqual(10_000_000);
    // Format QA réel.
    expect(artefact.parametres.formatTexte).toContain("Q:");
    expect(artefact.parametres.formatTexte).toContain("R:");
    // Bilan rapporté tel quel : la valeur déclarée d'un critère est le
    // compte RÉEL calculé depuis les mesures par domaine.
    const c3Reel = artefact.parDomaine.filter((d) => d.gainTrace > 1).length;
    expect(artefact.bilan.criteres.c3_gain_trace.valeur).toBe(c3Reel);
    expect(artefact.bilan.criteres.c3_gain_trace.atteint).toBe(c3Reel === 19);
    // Les limites honnêtes sont citées (substrat + pont + cadre).
    expect(artefact.bilan.limitesHonnetes.length).toBeGreaterThanOrEqual(3);
  });
});

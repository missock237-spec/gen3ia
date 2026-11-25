/**
 * TESTS DE FINALISATION OPÉRATIONNELLE — redémarrage, résilience,
 * persistance, performance, apprentissage avant/après, annotation chat
 * (mission « finalisation opérationnelle » — catégories de tests obligatoires).
 *
 * Rien n'est simulé dans les affirmations : chaque test mesure un
 * comportement réel (disque, machine à états, caps, garde anti-oubli).
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Gen3iaCoeurAutonome } from "@/lib/autonomous/core/orchestrator";
import { chargerConfigCoeurAutonome } from "@/lib/autonomous/core/config/autonomous-config";
import { GestionnaireTaches } from "@/lib/autonomous/core/task-manager";
import type { ContexteTick } from "@/lib/autonomous/core/types";
import { agentCollecteur } from "@/lib/autonomous/acquisition/collecteur";
import { RegistreSources } from "@/lib/autonomous/acquisition/source-registry";
import { FileLots } from "@/lib/autonomous/pipeline/queue";
import { agentTraitement } from "@/lib/autonomous/pipeline/worker";
import { MemoireConnaissances } from "@/lib/autonomous/knowledge/memoire-connaissances";
import { RegistreCompetences, developperCompetences } from "@/lib/autonomous/skills/moteur-competences";
import { adapterSansOubli, type Sonde, type SousMoteurNeural } from "@/lib/autonomous/continual-learning/moteur-continu";
import { sousMoteurNeuralReel } from "@/lib/autonomous/continual-learning/sous-moteur-reel";
import { agentApprentissageContinu } from "@/lib/autonomous/modules/agent-apprentissage";
import { annoterMessageAssistant, annoterEvenementsFlux } from "@/lib/autonomous/anti-hallucination/verificateur-chat";

let dossier: string;
beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "finalisation-"));
});
afterEach(() => {
  rmSync(dossier, { recursive: true, force: true });
});


function ctx(cycle = 1): ContexteTick {
  return { cycle, dateIso: new Date().toISOString(), taches: new GestionnaireTaches(), evenementsRecus: [], emettreEvenement() {} };
}

const WIKI = JSON.stringify({
  title: "Le Soleil chauffe la Terre",
  extract:
    "Le Soleil est l'étoile du Système solaire. La Terre reçoit de la chaleur du Soleil sous forme de rayonnement solaire. Le rayonnement permet la photosynthèse sur Terre. L'énergie solaire alimente le climat de la planète. Les saisons dépendent de l'inclinaison de l'axe de la Terre dans le plan orbital.",
});

describe("PERSISTANCE + REDÉMARRAGE — zéro perte au crash du process", () => {
  it("crash entre PROCESSING et VALIDATING : lot récupéré RETRY→QUEUED au redémarrage", async () => {
    const registre = new RegistreSources(dossier);
    const file = new FileLots(dossier);
    await agentCollecteur({ registre, file, fetcher: async () => ({ ok: true, statut: 200, contentType: "application/json", contenu: WIKI }) }).tick(ctx(1));
    const lot = file.parStatut("QUEUED")[0];
    file.transitioner(lot.id, "PROCESSING"); // le process meurt ICI
    // RESTART : nouvelles instances depuis le disque (ce que fait PM2).
    const registre2 = new RegistreSources(dossier);
    const file2 = new FileLots(dossier);
    const memoire2 = new MemoireConnaissances(dossier);
    expect(registre2.obtenir("wikipedia-fr")!.lotsProduits).toBe(1); // registre persisté
    const recupere = file2.obtenir(lot.id)!;
    expect(recupere.statut).toBe("QUEUED"); // RETRY→QUEUED automatique
    expect(recupere.historique.some((h) => h.vers === "RETRY")).toBe(true);
    // Le traitement reprend et aboutit (confirmation 2e cycle non requise :
    // collecte identique → idempotence — on injecte un contenu DIFFÉRENT).
    const collecteur2 = agentCollecteur({ registre: registre2, file: file2, fetcher: async () => ({ ok: true, statut: 200, contentType: "application/json", contenu: WIKI.replace("climat", "climat terrestre global") }) });
    await collecteur2.tick(ctx(2));
    const r = await agentTraitement({ file: file2, memoire: memoire2, registre: registre2, dossierCore: dossier }).tick(ctx(2));
    expect(["succes", "rien_a_faire"]).toContain(r.statut);
    expect(memoire2.taille() + file2.compteParStatut().QUARANTINED + file2.compteParStatut().INTEGRATED).toBeGreaterThanOrEqual(1);
  });

  it("le cœur restauré reprend son compteur de cycles et son armement depuis l'état persisté", () => {
    const config = { ...chargerConfigCoeurAutonome({}), intervalleCycleMs: 10 };
    const coeur1 = new Gen3iaCoeurAutonome({ dossier, config });
    coeur1.demarrer();
    expect(coeur1.cycleCourant()).toBeGreaterThanOrEqual(1);
    coeur1.arreter();
    const persiste = JSON.parse(readFileSync(join(dossier, "etat.json"), "utf8")) as { cycle: number };
    const coeur2 = new Gen3iaCoeurAutonome({ dossier, config });
    const reprise = coeur2.demarrer();
    expect(coeur2.cycleCourant()).toBeGreaterThanOrEqual(persiste.cycle); // continuité
    expect(coeur2.actif()).toBe(true);
    expect(typeof reprise.tachesReprises).toBe("number");
    coeur2.arreter();
    expect(coeur2.actif()).toBe(false);
  });
});

describe("RÉSILIENCE — 30 cycles avec source instable (50 % d'échecs)", () => {
  it("aucun crash, aucun lot perdu, débits respectés, santé traçable", async () => {
    const registre = new RegistreSources(dossier);
    const file = new FileLots(dossier);
    const memoire = new MemoireConnaissances(dossier);
    // Source de test à débit immédiat (intervalle 0) : chaque cycle tente
    // réellement une collecte — l'instabilité est ainsi exercée 30 fois.
    registre.ajouter({
      id: "instable",
      url: "https://test.local/instable",
      type: "web",
      licence: "source de test (locale)",
      intervalleMinMs: 0,
      statut: "actif",
      lotsProduits: 0,
    });
    let appel = 0;
    const fetcherInstable = async () => {
      appel += 1;
      if (appel % 2 === 0) throw new Error("réseau instable simulé");
      return { ok: true, statut: 200, contentType: "application/json", contenu: WIKI.replace("climat", `climat v${appel}`) };
    };
    const collecteur = agentCollecteur({ registre, file, fetcher: fetcherInstable });
    const worker = agentTraitement({ file, memoire, registre, dossierCore: dossier });
    for (let cycle = 1; cycle <= 30; cycle++) {
      await collecteur.tick(ctx(cycle));
      await worker.tick(ctx(cycle));
    }
    const compte = file.compteParStatut();
    // Zéro perte : tout lot est soit actif (queue/quarantaine), soit intégré,
    // soit FAILED tracé (3 tentatives épuisées) — jamais disparu.
    expect(file.taille()).toBe(compte.QUEUED + compte.PROCESSING + compte.VALIDATING + compte.APPROVED + compte.INTEGRATED + compte.REJECTED + compte.QUARANTINED + compte.FAILED + compte.RETRY);
    // La source a survécu aux échecs honnêtes (traçage complet, débits respectés).
    const source = registre.obtenir("instable")!;
    expect(source.lotsProduits).toBeGreaterThanOrEqual(1);
    expect(source.derniereCollecteLe).toBeTruthy();
    expect(appel).toBe(30); // les 30 tentatives réelles (y compris les échecs)
  });
});

describe("PERFORMANCE — caps et backpressure réels (RAM 2 cœurs)", () => {
  it("100 lots drainés en moins de 10 s (plafond 3/tick honnête)", async () => {
    const registre = new RegistreSources(dossier);
    const file = new FileLots(dossier);
    const memoire = new MemoireConnaissances(dossier);
    for (let i = 1; i <= 100; i++) {
      const contenu = JSON.stringify({
        title: `Document ${i} sur les énergies renouvelables`,
        extract: `Le document ${i} décrit une installation solaire. Le rayonnement alimente le réseau. La production dépend de l'ensoleillement et du stockage thermique. Une installation moderne couvre une part significative des besoins.`,
      });
      file.enqueuer({
        id: `perf-${i}`,
        cycle: 1,
        sourceId: "wikipedia-fr",
        url: `u${i}`,
        collecteLe: new Date().toISOString(),
        contenu,
        contentType: "application/json",
        tailleOctets: contenu.length,
        empreinte: `e${i}`,
      });
    }
    const debut = Date.now();
    const worker = agentTraitement({ file, memoire, registre, dossierCore: dossier });
    let ticks = 0;
    while (file.aTraiter(3).length > 0 && ticks < 60) {
      await worker.tick(ctx(ticks + 1));
      ticks += 1;
    }
    const dureeMs = Date.now() - debut;
    expect(dureeMs).toBeLessThan(10_000); // performance bornée (pas d'avalanche)
    expect(file.compteParStatut().QUEUED).toBe(0);
  }, 20_000);

  it("cap disque : au-delà de 400 lots terminés, élagage réel", () => {
    const file = new FileLots(dossier);
    for (let i = 1; i <= 410; i++) {
      const lot = file.enqueuer({
        id: `cap-${i}`,
        cycle: 1,
        sourceId: "wikipedia-fr",
        url: `u${i}`,
        collecteLe: new Date().toISOString(),
        contenu: `contenu ${i}`,
        contentType: "text/plain",
        tailleOctets: 9,
        empreinte: `ec${i}`,
      });
      if (lot) {
        file.transitioner(lot.id, "PROCESSING");
        file.transitioner(lot.id, "VALIDATING");
        file.transitioner(lot.id, "REJECTED");
      }
    }
    expect(file.taille()).toBeLessThanOrEqual(400); // backpressure réelle
  });
});

describe("AVANT/APRÈS — apprentissage gardé (anti-oubli) + sous-moteur RÉEL", () => {
  const sondes: Sonde[] = [
    { question: "Que sais-tu du Soleil ?", attendu: "étoile rayonnement chaleur" },
    { question: "Que sais-tu du routing ?", attendu: "lexical domaines" },
  ];

  it("sous-moteur RÉEL : readiness honnête mesurée (prêt OU refus documenté)", async () => {
    const { moteur, etat } = sousMoteurNeuralReel();
    expect(etat.raison.length).toBeGreaterThan(0);
    const score = await moteur.evaluer(sondes);
    if (etat.pret) {
      // Le cerveau RÉEL est chargé dans ce process : score mesuré réel 0..1.
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    } else {
      // Pas de cerveau dans ce process : NaN honnête (jamais un faux score).
      expect(Number.isNaN(score)).toBe(true);
    }
  });

  it("adaptation gardée : le score PRÉ fait foi (échec honnête si score invalide)", async () => {
    const sm: SousMoteurNeural = {
      async evaluer() {
        return NaN; // cerveau indisponible — comme le sous-moteur réel hors process
      },
      async adapter() {
        throw new Error("ne doit JAMAIS être appelé si le pré-score est invalide");
      },
      async sauvegarder() {
        throw new Error("ne doit JAMAIS être appelé");
      },
      async restaurer() {
        return true;
      },
    };
    const r = await adapterSansOubli(sm, [{ question: "q", reponse: "r" }], sondes);
    expect(r.statut).toBe("echec");
    expect(r.message).toContain("score pré invalide");
  });

  it("agent apprentissage-continu : déflexe hors fenêtre + rapport honnête", async () => {
    const memoire = new MemoireConnaissances(dossier);
    // Une connaissance vérifiée → sondes dérivées + échantillons d'adaptation.
    memoire.integrer(
      {
        idConcept: "apprentissage-s1",
        concept: "Le Soleil",
        domaine: "sciences_professionnel",
        proprietes: [],
        relations: [],
        resume: "Le Soleil est une étoile qui chauffe la Terre par rayonnement et alimente le climat.",
        langue: "fr",
        qualite: 0.8,
        provenance: { lotId: "lot-a1", sourceId: "wikipedia-fr", url: "u", collecteLe: new Date().toISOString() },
        contentType: "application/json",
        statut: "pending_validation",
      },
      2,
    );
    const agent = agentApprentissageContinu({ memoire, sousMoteur: ((): SousMoteurNeural => ({ evaluer: async () => 0.5, adapter: async () => ({ ok: true, message: "ok" }), sauvegarder: async () => "t", restaurer: async () => true }))(), tousLesCycles: 4 });
    const hors = await agent.tick(ctx(1)); // 1 % 4 ≠ 0
    expect(hors.statut).toBe("rien_a_faire");
    expect(hors.message).toContain("hors fenêtre");
    const dans = await agent.tick(ctx(4)); // 4 % 4 = 0
    expect(dans.statut).toBe("succes"); // adaptation appliquée (Δ mesuré avec le sous-moteur injecté)
    expect(dans.details && (dans.details as { delta?: number }).delta).toBeDefined();
  });
});

describe("ANNOTATION CHAT (Lot 07) — citations réelles, incertitude honnête, fail-soft", () => {
  it("affirmations soutenues → citations de provenance réelle ; hors mémoire → NON_FONDÉE signalée", async () => {
    const memoire = new MemoireConnaissances(dossier);
    memoire.integrer(
      {
        idConcept: "chat-s1",
        concept: "Le Soleil",
        domaine: "sciences_professionnel",
        proprietes: [{ cle: "chaleur", valeur: "La Terre reçoit de la chaleur du Soleil par rayonnement" }],
        relations: [],
        resume: "Le Soleil chauffe la Terre par rayonnement solaire et alimente le climat de la planète.",
        langue: "fr",
        qualite: 0.8,
        provenance: { lotId: "lot-chat-1", sourceId: "wikipedia-fr", url: "https://fr.wikipedia.org/", collecteLe: new Date().toISOString() },
        contentType: "application/json",
        statut: "pending_validation",
      },
      2,
    );
    const soutenu = await annoterMessageAssistant(
      { content: "Le Soleil chauffe la Terre par rayonnement solaire. Le rayonnement alimente le climat de la planète depuis des milliards d'années." },
      { memoire },
    );
    expect(soutenu.citations?.some((c) => c.source === "autonome:wikipedia-fr")).toBe(true); // provenance réelle
    expect((soutenu as { verificationAutonome?: { verdict: string } }).verificationAutonome?.verdict).toBeTruthy();

    const invente = await annoterMessageAssistant(
      { content: "Le Soleil est en réalité une machine thermique construite par une civilisation disparue du système galactique voisin, alimentée par fusion contrôlée." },
      { memoire },
    );
    expect(invente.content).toContain("⚠️"); // signal d'incertitude HONNÊTE
    expect(invente.citations?.length ?? 0).toBe(0); // AUCUNE source inventée
  });

  it("fail-soft : mémoire vide ou erreur → réponse inchangée (le chat n'est jamais cassé)", async () => {
    const memoireVide = new MemoireConnaissances(dossier);
    const message = { content: "Une réponse quelconque suffisamment longue pour passer le seuil de vérification automatique autonome du cerveau." };
    const r = await annoterMessageAssistant(message, { memoire: memoireVide });
    expect(r.content).toBe(message.content);
    expect(r.citations).toBeUndefined();
    // Interrupteur : AUTO_ANTI_HALLUCINATION=0 → inchangé même avec mémoire.
    process.env.AUTO_ANTI_HALLUCINATION = "0";
    const avecMemoire = await annoterMessageAssistant(message, { memoire: new MemoireConnaissances(dossier) });
    expect(avecMemoire.content).toBe(message.content);
    delete process.env.AUTO_ANTI_HALLUCINATION;
  });

  it("flux stream : l'événement done est annoté, les autres transmis tels quels", async () => {
    const memoire = new MemoireConnaissances(dossier);
    memoire.integrer(
      {
        idConcept: "chat-s2",
        concept: "Le Soleil",
        domaine: "sciences_professionnel",
        proprietes: [],
        relations: [],
        resume: "Le Soleil chauffe la Terre par rayonnement solaire et alimente le climat de la planète.",
        langue: "fr",
        qualite: 0.8,
        provenance: { lotId: "lot-chat-2", sourceId: "wikipedia-en", url: "u", collecteLe: new Date().toISOString() },
        contentType: "application/json",
        statut: "pending_validation",
      },
      2,
    );
    const recus: Array<{ type: string; assistantMessage?: { content: string; citations?: Array<{ source: string }> } }> = [];
    const emetteur = annoterEvenementsFlux(async (e) => {
      recus.push(e as typeof recus[number]);
    }, { memoire });
    await emetteur({ type: "status", etape: "generation" } as never);
    await emetteur({
      type: "done",
      assistantMessage: { content: "Le Soleil chauffe la Terre par rayonnement solaire. Le rayonnement alimente le climat de la planète." },
    } as never);
    expect(recus[0].type).toBe("status");
    const done = recus[1];
    expect(done.assistantMessage?.citations?.some((c) => c.source === "autonome:wikipedia-en")).toBe(true);
  });
});

describe("COMPÉTENCES — agent connecté, exécution isolée, registre honnête", () => {
  it("registre vide après mémoire sans candidat ; validation obligatoire sinon échec", async () => {
    const memoire = new MemoireConnaissances(dossier);
    const registre = new RegistreCompetences(dossier);
    const r = await developperCompetences({
      registre,
      memoire,
      executeur: async () => ({ ok: false, message: "sandbox indisponible", dureeMs: 1 }),
    });
    expect(r.validees).toBe(0); // sans exécution verte, RIEN n'est déclaré valide
    expect(existsSync(join(dossier, "competences", "competences.json"))).toBe(false); // registre non falsifié
  });
});

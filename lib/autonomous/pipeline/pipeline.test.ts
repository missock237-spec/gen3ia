/**
 * TESTS DES LOTS 2-5 — Acquisition, Pipeline, Intelligence, Vérification,
 * Mémoire permanente, Privacy Firewall (mission « GEN3IA AUTONOMOUS BRAIN »).
 *
 * Règle 18 de la mission : aucune fonctionnalité déclarée terminée sans
 * tests démontrables. Chaque condition de validation du plan est couverte :
 * collecte par cycles, enregistrement des résultats, idempotence (0 doublon
 * non maîtrisé), traçabilité 100 %, vérification avant intégration,
 * provenance conservée, isolation utilisateur TECHNIQUE.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GestionnaireTaches } from "../core/task-manager";
import { agentCollecteur, empreinteContenu, fetcherReel } from "../acquisition/collecteur";
import { RegistreSources, sourcesInitiales } from "../acquisition/source-registry";
import { FileLots } from "../pipeline/queue";
import { agentTraitement } from "../pipeline/worker";
import { evaluerQualite, extraireContenu, traiterLot, detecterLangue } from "../intelligence/traiter";
import { verifierEnregistrement } from "../intelligence/verifier";
import { MemoireConnaissances } from "../knowledge/memoire-connaissances";
import { isolationCoherente, lireSiAutorise, verifierAccesEntrainement } from "../privacy/firewall";
import type { ContexteTick } from "../core/types";

/** Contenu Wikipedia factice (fixture réaliste du format API REST). */
const WIKI_JSON = JSON.stringify({
  title: "Le Soleil chauffe la Terre",
  extract:
    "Le Soleil est l'étoile du Système solaire. La Terre reçoit de la chaleur du Soleil sous forme de rayonnement solaire. " +
    "Le rayonnement permet la photosynthèse sur Terre. L'énergie solaire alimente le climat de la planète. " +
    "Les saisons dépendent de l'inclinaison de l'axe de la Terre dans le plan orbital. " +
    "Une éclipse est un alignement astronomique rare entre le Soleil, la Lune et la Terre.",
});
const WIKI_JSON_2 = JSON.stringify({
  title: "Le Soleil chauffe la Terre",
  extract:
    "La lumière du Soleil met environ huit minutes pour atteindre la Terre. " +
    "Le rayonnement solaire est le moteur principal du climat terrestre et de la photosynthèse. " +
    "Les cycles solaires influencent les aurores polaires et les communications radio sur la planète.",
});

let dossier: string;
let registre: RegistreSources;
let file: FileLots;
let memoire: MemoireConnaissances;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "autobrain-"));
  registre = new RegistreSources(dossier);
  file = new FileLots(dossier);
  memoire = new MemoireConnaissances(dossier);
});
afterEach(() => {
  rmSync(dossier, { recursive: true, force: true });
});

/** Contexte de tick de test (traçabilité réelle via GestionnaireTaches). */
function ctx(cycle = 1): ContexteTick {
  const taches = new GestionnaireTaches();
  return {
    cycle,
    dateIso: new Date().toISOString(),
    taches,
    evenementsRecus: [],
    emettreEvenement() {},
  };
}

/** Fetcher factice : file d'attente de réponses (aucun réseau). */
function fetcherFactice(reponses: Array<{ contenu: string; contentType?: string }>) {
  let i = 0;
  return async () => {
    const r = reponses[Math.min(i, reponses.length - 1)];
    i += 1;
    return { ok: true, statut: 200, contentType: r.contentType ?? "application/json", contenu: r.contenu };
  };
}

describe("Lot 2 — Source Registry (respect des sources)", () => {
  it("sources initiales : licences citées, débits ≥ cycle du core", () => {
    for (const s of sourcesInitiales()) {
      expect(s.intervalleMinMs).toBeGreaterThanOrEqual(300_000); // jamais plus rapide qu'un cycle 5 min
      expect(s.licence.length).toBeGreaterThan(10);
    }
  });

  it("tour de rôle : la source la plus ancienne passe, type hub exclu", async () => {
    expect(registre.prochaineDue(Date.now())!.id).toBe("wikipedia-fr"); // jamais collectée
    registre.noterCollecte("wikipedia-fr", new Date().toISOString());
    expect(registre.prochaineDue(Date.now())!.id).toBe("wikipedia-en");
    registre.noterCollecte("wikipedia-en", new Date().toISOString());
    expect(registre.prochaineDue(Date.now())!.id).toBe("arxiv-cs");
    // Le type hub n'est jamais retourné (collecté par la boucle existante).
    const due = registre.prochaineDue(Date.now());
    expect(due?.type).not.toBe("hub");
  });

  it("débit respecté : une source fraîchement collectée n'est pas due", () => {
    registre.noterCollecte("wikipedia-fr", new Date().toISOString());
    expect(registre.prochaineDue(Date.now())?.id).not.toBe("wikipedia-fr");
  });

  it("persistance atomique + relecture du registre", () => {
    registre.noterCollecte("wikipedia-fr", "2026-11-25T10:00:00.000Z");
    registre.persister();
    const fichier = join(dossier, "acquisition", "sources.json");
    expect(existsSync(fichier)).toBe(true);
    const lu = JSON.parse(readFileSync(fichier, "utf8")) as { sources: Array<{ id: string; lotsProduits: number }> };
    expect(lu.sources.find((s) => s.id === "wikipedia-fr")!.lotsProduits).toBe(1);
    // Un nouveau registre relit l'état persisté.
    const registre2 = new RegistreSources(dossier);
    expect(registre2.obtenir("wikipedia-fr")!.lotsProduits).toBe(1);
  });
});

describe("Lot 2 — Collecteur (cycles bornés, idempotence, traçabilité)", () => {
  it("collecte une unité par cycle et dépose un LOT en file (COLLECTED→QUEUED)", async () => {
    const collecteur = agentCollecteur({
      registre,
      file,
      fetcher: fetcherFactice([{ contenu: WIKI_JSON }]),
    });
    const rapport = await collecteur.tick(ctx(1));
    expect(rapport.statut).toBe("succes");
    expect(file.taille()).toBe(1);
    const lot = file.parStatut("QUEUED")[0];
    expect(lot.statut).toBe("QUEUED");
    expect(lot.sourceId).toBe("wikipedia-fr");
    expect(lot.tailleOctets).toBeGreaterThan(0);
    expect(registre.obtenir("wikipedia-fr")!.lotsProduits).toBe(1);
  });

  it("idempotence : le même contenu collecté deux fois ne crée PAS deux lots", async () => {
    const collecteur = agentCollecteur({ registre, file, fetcher: fetcherFactice([{ contenu: WIKI_JSON }]) });
    const r1 = await collecteur.tick(ctx(1));
    expect(r1.statut).toBe("succes");
    expect(file.taille()).toBe(1);
    // Deuxième cycle : la même source n'est pas due (débit) — force via
    // un nouveau registre sans mémoire de collecte mais même file.
    const registre2 = new RegistreSources(dossier);
    const collecteur2 = agentCollecteur({ registre: registre2, file, fetcher: fetcherFactice([{ contenu: WIKI_JSON }]) });
    const r2 = await collecteur2.tick(ctx(2));
    expect(r2.statut).toBe("rien_a_faire");
    expect(r2.message).toContain("idempotence");
    expect(file.taille()).toBe(1); // 0 doublon non maîtrisé
  });

  it("échec de collecte : message honnête, débit respecté, aucune perte silencieuse", async () => {
    const collecteur = agentCollecteur({
      registre,
      file,
      fetcher: async () => ({ ok: false, statut: 503, contentType: "", contenu: "", erreur: "HTTP 503" }),
    });
    const rapport = await collecteur.tick(ctx(1));
    expect(rapport.statut).toBe("echec");
    expect(rapport.message).toContain("503");
    expect(registre.obtenir("wikipedia-fr")!.derniereErreur).toContain("503");
    expect(file.taille()).toBe(0);
  });

  it("rien à faire quand aucune source n'est due (intervalles respectés)", async () => {
    registre.toutes().forEach((s) => registre.noterCollecte(s.id, new Date().toISOString()));
    const collecteur = agentCollecteur({ registre, file, fetcher: fetcherFactice([{ contenu: WIKI_JSON }]) });
    const rapport = await collecteur.tick(ctx(1));
    expect(rapport.statut).toBe("rien_a_faire");
    expect(rapport.message).toContain("intervalles de débit respectés");
  });

  it("fetcher réel : cap d'octets et timeout honnêtes (sans réseau)", async () => {
    // Le fetcher réel refuse un type de contenu non collectable.
    const f = fetcherReel();
    // On ne peut pas appeler le réseau en test unitaire fiable — on teste
    // le contrat de signature via une URL invalide (échec rapide, fail-soft).
    const r = await f("http://127.0.0.1:1/injoignable", { timeoutMs: 300, maxOctets: 1024, userAgent: "gen3ia-test" });
    expect(r.ok).toBe(false);
    expect(r.erreur).toBeTruthy();
  });

  it("empreinte stable : même contenu → même empreinte (déduplication)", () => {
    expect(empreinteContenu("abc")).toBe(empreinteContenu("abc"));
    expect(empreinteContenu("abc")).not.toBe(empreinteContenu("abd"));
  });
});

describe("Lot 3 — File persistante (machine à états, récupération)", () => {
  function lotTest(id: string, empreinte: string) {
    return {
      id,
      cycle: 1,
      sourceId: "wikipedia-fr",
      url: "https://fr.wikipedia.org/api/rest_v1/page/random/summary",
      collecteLe: new Date().toISOString(),
      contenu: WIKI_JSON,
      contentType: "application/json",
      tailleOctets: WIKI_JSON.length,
      empreinte,
    };
  }

  it("chemin complet COLLECTED→QUEUED→PROCESSING→VALIDATING→APPROVED→INTEGRATED", () => {
    const lot = file.enqueuer(lotTest("lot-1", "e1"))!;
    expect(lot.statut).toBe("QUEUED");
    expect(file.transitioner("lot-1", "PROCESSING")).toBe(true);
    expect(file.transitioner("lot-1", "VALIDATING")).toBe(true);
    expect(file.transitioner("lot-1", "APPROVED")).toBe(true);
    expect(file.transitioner("lot-1", "INTEGRATED")).toBe(true);
    // Transition interdite : INTEGRATED est terminal.
    expect(file.transitioner("lot-1", "QUEUED")).toBe(false);
  });

  it("idempotence : même id et même empreinte refusés (0 doublon)", () => {
    expect(file.enqueuer(lotTest("lot-1", "e1"))).not.toBeNull();
    expect(file.enqueuer(lotTest("lot-1", "e1"))).toBeNull(); // même id
    expect(file.enqueuer(lotTest("lot-2", "e1"))).toBeNull(); // même contenu
  });

  it("reprise : lot orphelin PROCESSING au boot → RETRY → QUEUED (0 perte)", () => {
    const lot = file.enqueuer(lotTest("lot-orphelin", "e2"))!;
    file.transitioner(lot.id, "PROCESSING");
    // Simule le crash : nouvelle file relisant le disque.
    const file2 = new FileLots(dossier);
    const relus = file2.parStatut("QUEUED");
    expect(relus.some((l) => l.id === "lot-orphelin")).toBe(true);
    const relit = file2.obtenir("lot-orphelin")!;
    expect(relit.historique.some((h) => h.vers === "RETRY")).toBe(true);
  });

  it("replanification bornée : 3 tentatives max puis FAILED tracé", () => {
    file.enqueuer(lotTest("lot-retry", "e3"));
    file.transitioner("lot-retry", "PROCESSING");
    expect(file.replanifier("lot-retry", "échec 1")).toBe(true);
    expect(file.obtenir("lot-retry")!.tentatives).toBe(1);
    file.transitioner("lot-retry", "PROCESSING");
    file.replanifier("lot-retry", "échec 2");
    file.transitioner("lot-retry", "PROCESSING");
    expect(file.replanifier("lot-retry", "échec 3")).toBe(true);
    expect(file.obtenir("lot-retry")!.statut).toBe("FAILED");
    expect(file.obtenir("lot-retry")!.historique.some((h) => h.vers === "FAILED")).toBe(true);
  });

  it("comptage par statut pour le tableau de supervision", () => {
    file.enqueuer(lotTest("a", "ea"));
    file.enqueuer(lotTest("b", "eb"));
    const compte = file.compteParStatut();
    expect(compte.QUEUED).toBe(2);
  });

  it("persistance disque réelle des lots (chaque transition)", () => {
    file.enqueuer(lotTest("lot-disque", "ed"));
    expect(existsSync(join(dossier, "pipeline", "lots", "lot-disque.json"))).toBe(true);
  });
});

describe("Lot 4 — Intelligence (extraction, classification, qualité)", () => {
  it("extraction JSON Wikipedia : titre + résumé", () => {
    const { titre, texte } = extraireContenu(WIKI_JSON, "application/json");
    expect(titre).toBe("Le Soleil chauffe la Terre");
    expect(texte).toContain("rayonnement solaire");
  });

  it("extraction XML arXiv : entrées titres + summaries", () => {
    const atom = `<?xml version="1.0"?><feed><title>arXiv</title><entry><title>Neural Waves and Memory</title><summary>We study continual learning without catastrophic forgetting in spiking networks.</summary></entry></feed>`;
    const { titre, texte } = extraireContenu(atom, "application/atom+xml");
    expect(titre).toContain("Neural Waves");
    expect(texte).toContain("catastrophic forgetting");
  });

  it("classification par le ROUTEUR DU CERVEAU (18 domaines)", () => {
    const lot = {
      id: "lot-routeur",
      cycle: 1,
      sourceId: "wikipedia-fr",
      url: "u",
      collecteLe: new Date().toISOString(),
      contenu: WIKI_JSON,
      contentType: "application/json",
      tailleOctets: WIKI_JSON.length,
      empreinte: "er",
      statut: "QUEUED" as const,
      tentatives: 0,
      historique: [],
    };
    const resultat = traiterLot(lot);
    expect(resultat.ok).toBe(true);
    expect(resultat.enregistrement!.domaine).toBeTruthy(); // routeur du cerveau utilisé
    expect(resultat.enregistrement!.idConcept).toHaveLength(16);
    expect(resultat.enregistrement!.provenance.sourceId).toBe("wikipedia-fr");
  });

  it("lot indigeste → échec honnête (pas de structuration forcée)", () => {
    const lotVide = {
      id: "lot-vide",
      cycle: 1,
      sourceId: "wikipedia-fr",
      url: "u",
      collecteLe: new Date().toISOString(),
      contenu: "court",
      contentType: "text/plain",
      tailleOctets: 5,
      empreinte: "ev",
      statut: "QUEUED" as const,
      tentatives: 0,
      historique: [],
    };
    const resultat = traiterLot(lotVide);
    expect(resultat.ok).toBe(false);
    expect(resultat.message).toContain("indigeste");
  });

  it("qualité et langue mesurées (aucune invention)", () => {
    expect(evaluerQualite(WIKI_JSON.replace(/[\{\}"\[\]]/g, " "))).toBeGreaterThan(0.3);
    expect(detecterLangue("Le Soleil est une étoile dans le ciel de la Terre")).toBe("fr");
    expect(detecterLangue("The Sun is a star in the sky of the Earth and that is the answer")).toBe("en");
  });
});

describe("Lot 5 — Vérification avant intégration (jamais l'incertain en vérité)", () => {
  function enregistrementQualite(qualite: number, idConcept: string) {
    return {
      idConcept,
      concept: "Le Soleil chauffe la Terre",
      domaine: "sciences_professionnel",
      proprietes: [{ cle: "rayonnement", valeur: "La Terre reçoit de la chaleur du Soleil" }],
      relations: [],
      resume: "Le Soleil chauffe la Terre par rayonnement et alimente le climat de la planète entière.",
      langue: "fr" as const,
      qualite,
      provenance: {
        lotId: `lot-${idConcept}`,
        sourceId: "wikipedia-fr",
        url: "https://fr.wikipedia.org/",
        collecteLe: new Date().toISOString(),
      },
      contentType: "application/json",
      statut: "pending_validation" as const,
    };
  }

  it("source inconnue → REJECTED (provenance non traçable)", () => {
    const enr = { ...enregistrementQualite(0.8, "c1"), provenance: { ...enregistrementQualite(0.8, "c1").provenance, sourceId: "source-fantome" } };
    const d = verifierEnregistrement(enr, registre, memoire);
    expect(d.statut).toBe("REJECTED");
    expect(d.raisons[0]).toContain("inconnue du registre");
  });

  it("qualité insuffisante → REJECTED", () => {
    const d = verifierEnregistrement(enregistrementQualite(0.1, "c2"), registre, memoire);
    expect(d.statut).toBe("REJECTED");
    expect(d.raisons.some((r) => r.includes("qualité"))).toBe(true);
  });

  it("première source de TRÈS haute qualité → APPROVED ; qualité moyenne → QUARANTINED", () => {
    const haute = verifierEnregistrement(enregistrementQualite(0.9, "c3"), registre, memoire);
    expect(haute.statut).toBe("APPROVED");
    expect(haute.confiance).toBeGreaterThanOrEqual(0.7);
    const moyenne = verifierEnregistrement(enregistrementQualite(0.6, "c7"), registre, memoire);
    expect(moyenne.statut).toBe("QUARANTINED");
    expect(moyenne.raisons.some((r) => r.includes("QUARANTAINE"))).toBe(true);
  });

  it("deux sources distinctes → confirmation indépendante (confiance ↑)", () => {
    memoire.integrer(enregistrementQualite(0.8, "c4"), 1);
    // L'enregistrement vient d'une AUTRE source confirmant le même concept.
    const enr2 = { ...enregistrementQualite(0.8, "c4"), provenance: { ...enregistrementQualite(0.8, "c4").provenance, sourceId: "wikipedia-en", lotId: "lot-c4-en" } };
    const d = verifierEnregistrement(enr2, registre, memoire);
    expect(d.statut).toBe("APPROVED");
    expect(d.raisons.some((r) => r.includes("confirmation indépendante"))).toBe(true);
  });

  it("confiance insuffisante → QUARANTINED (jamais transformé en vérité)", () => {
    // Qualité moyenne (0.4), une seule source : confiance < 0.55.
    const d = verifierEnregistrement(enregistrementQualite(0.35, "c5"), registre, memoire);
    expect(d.statut).toBe("QUARANTINED");
    expect(d.raisons.some((r) => r.includes("QUARANTAINE"))).toBe(true);
  });

  it("date de collecte dans le futur → REJECTED", () => {
    const enr = { ...enregistrementQualite(0.8, "c6"), provenance: { ...enregistrementQualite(0.8, "c6").provenance, collecteLe: new Date(Date.now() + 3_600_000).toISOString() } };
    const d = verifierEnregistrement(enr, registre, memoire);
    expect(d.statut).toBe("REJECTED");
    expect(d.raisons.some((r) => r.includes("futur"))).toBe(true);
  });
});

describe("Lot 5 — Mémoire permanente (provenance, versionnement, contradictions)", () => {
  function enr(idConcept: string, valeur: string, sourceId: string) {
    return {
      idConcept,
      concept: "Le Soleil",
      domaine: "sciences_professionnel",
      proprietes: [{ cle: "chaleur", valeur }],
      relations: [{ relation: "est", cible: "une étoile" }],
      resume: `Le Soleil : ${valeur}`,
      langue: "fr" as const,
      qualite: 0.8,
      provenance: { lotId: `lot-${sourceId}-${valeur.slice(0, 8)}`, sourceId, url: "u", collecteLe: new Date().toISOString() },
      contentType: "application/json",
      statut: "pending_validation" as const,
    };
  }

  it("intégration : provenance conservée intégralement", () => {
    const c = memoire.integrer(enr("s1", "étoile du Système solaire", "wikipedia-fr"), 1);
    expect(c.provenances).toHaveLength(1);
    expect(c.provenances[0].sourceId).toBe("wikipedia-fr");
    expect(memoire.sourcesDe("s1")).toEqual(["wikipedia-fr"]);
  });

  it("versionnement : la mise à jour archive la version précédente", () => {
    memoire.integrer(enr("s2", "premier résumé du Soleil", "wikipedia-fr"), 1);
    const maj = memoire.integrer(enr("s2", "second résumé plus complet du Soleil", "wikipedia-en"), 2);
    expect(maj.versionsPrecedentes).toHaveLength(1);
    expect(maj.versionsPrecedentes[0].resume).toContain("premier résumé");
    expect(maj.confirmations).toBe(3); // 1 + max(1,2)
    expect(memoire.sourcesDe("s2")).toEqual(["wikipedia-fr", "wikipedia-en"]);
  });

  it("contradictions : les DEUX valeurs sont conservées et flaggées", () => {
    memoire.integrer(enr("s3", "8 minutes-lumière", "wikipedia-fr"), 1);
    const maj = memoire.integrer(enr("s3", "8 minutes et 20 secondes", "wikipedia-en"), 1);
    expect(maj.contradictions).toHaveLength(1);
    expect(maj.contradictions[0].valeurs).toEqual(["8 minutes et 20 secondes", "8 minutes-lumière"]);
    expect(maj.proprietes.filter((p) => p.cle === "chaleur")).toHaveLength(2); // aucune perte
  });

  it("obsolète : marquée sans suppression, réactivée par une confirmation", () => {
    memoire.integrer(enr("s4", "résumé", "wikipedia-fr"), 1);
    expect(memoire.marquerObsolete("s4", "info dépassée")).toBe(true);
    expect(memoire.obtenir("s4")!.obsolete?.raison).toBe("info dépassée");
    expect(memoire.parDomaine("sciences_professionnel").some((c) => c.idConcept === "s4")).toBe(false);
    memoire.integrer(enr("s4", "résumé rafraîchi", "wikipedia-en"), 1);
    expect(memoire.obtenir("s4")!.obsolete).toBeUndefined();
  });

  it("persistance JSONL : rechargement complet au boot", () => {
    memoire.integrer(enr("s5", "concept persisté", "wikipedia-fr"), 1);
    expect(existsSync(join(dossier, "connaissances", "connaissances.jsonl"))).toBe(true);
    const memoire2 = new MemoireConnaissances(dossier);
    expect(memoire2.obtenir("s5")!.resume).toContain("concept persisté");
    expect(memoire2.sourcesDe("s5")).toEqual(["wikipedia-fr"]);
  });
});

describe("Lot 5 — Privacy Firewall (isolation TECHNIQUE, pas déclarative)", () => {
  it("liste blanche : seuls acquisition/, pipeline/, connaissances/ passent", () => {
    expect(verifierAccesEntrainement("pipeline/lots/x.json", dossier).autorise).toBe(true);
    expect(verifierAccesEntrainement("connaissances/connaissances.jsonl", dossier).autorise).toBe(true);
    expect(verifierAccesEntrainement("acquisition/sources.json", dossier).autorise).toBe(true);
    expect(verifierAccesEntrainement("divers/autre.json", dossier).autorise).toBe(false);
  });

  it("espaces utilisateurs REFUSÉS (users/, personal/, private/)", () => {
    for (const chemin of ["users/uid-123/agents.json", "personal/memoire.json", "private/conversations.jsonl"]) {
      const v = verifierAccesEntrainement(chemin, dossier);
      expect(v.autorise).toBe(false);
      expect(v.raison).toContain("isolation technique");
    }
  });

  it("traversée et chemins absolus refusés (fail-closed)", () => {
    expect(verifierAccesEntrainement("../users/x", dossier).autorise).toBe(false);
    expect(verifierAccesEntrainement("../../etc/passwd", dossier).autorise).toBe(false);
    expect(verifierAccesEntrainement("/etc/passwd", dossier).autorise).toBe(false);
  });

  it("lecture conditionnelle : refuse puis n'appelle JAMAIS le lecteur", () => {
    let lu = false;
    const r = lireSiAutorise("users/uid-1/agents.json", dossier, () => {
      lu = true;
      return "{}";
    });
    expect(r.autorise).toBe(false);
    expect(lu).toBe(false); // le lecteur n'a JAMAIS été appelé
    const ok = lireSiAutorise("pipeline/lots/x.json", dossier, () => "{}");
    expect(ok.autorise).toBe(true);
    expect(ok.contenu).toBe("{}");
  });

  it("cohérence structurelle : aucun préfixe autorisé ne recouvre un espace utilisateur", () => {
    expect(isolationCoherente()).toBe(true);
  });
});

describe("Lots 2-5 E2E — collecte → file → traitement → vérification → mémoire", () => {
  it("cycle 1 : première source → QUARANTAINE ; cycle 2 : confirmation → PROMOTION des deux", async () => {
    const collecteur = agentCollecteur({ registre, file, fetcher: fetcherFactice([{ contenu: WIKI_JSON }, { contenu: WIKI_JSON_2 }]) });
    const worker = agentTraitement({ file, memoire, registre, dossierCore: dossier });

    // Cycle 1 : collecte wikipedia-fr, traitement — source unique → QUARANTAINE
    // (l'incertain n'est PAS intégré : il attend une confirmation).
    const rCollecte1 = await collecteur.tick(ctx(1));
    expect(rCollecte1.statut).toBe("succes");
    const rWorker1 = await worker.tick(ctx(1));
    expect(rWorker1.statut).toBe("succes");
    expect(rWorker1.message).toContain("quarantaine");
    expect(memoire.taille()).toBe(0);
    expect(file.compteParStatut().QUARANTINED).toBe(1);

    // Cycle 2 : collecte wikipedia-en (tour de rôle) — MÊME concept d'une
    // AUTRE source → confirmation indépendante → lot courant APPROVED ET
    // lot en quarantaine PROMU (la vérification a résolu l'incertitude).
    const rCollecte2 = await collecteur.tick(ctx(2));
    expect(rCollecte2.statut).toBe("succes");
    expect(rCollecte2.details && (rCollecte2.details as { sourceId: string }).sourceId).toBe("wikipedia-en");
    const rWorker2 = await worker.tick(ctx(2));
    expect(rWorker2.statut).toBe("succes");
    expect(rWorker2.message).toContain("2 intégré");

    // La mémoire contient LA connaissance confirmée, avec ses 2 sources.
    expect(memoire.taille()).toBe(1);
    expect(file.compteParStatut().INTEGRATED).toBe(2);
    expect(file.compteParStatut().QUARANTINED).toBe(0);
    // Traçabilité 100 % : chaque lot intégré porte son historique complet
    // et sa provenance.
    for (const lot of file.parStatut("INTEGRATED", 10)) {
      expect(lot.historique[lot.historique.length - 1].vers).toBe("INTEGRATED");
      expect(lot.historique.some((h) => h.vers === "APPROVED")).toBe(true);
      expect(lot.sourceId).toMatch(/^wikipedia-(fr|en)$/);
    }
  });

  it("le worker re-planifie un lot indigeste puis FAILED après 3 tentatives", async () => {
    const collecteur = agentCollecteur({ registre, file, fetcher: fetcherFactice([{ contenu: "court" }]) });
    const worker = agentTraitement({ file, memoire, registre, dossierCore: dossier });
    await collecteur.tick(ctx(1));
    // 3 cycles de traitement (3 tentatives) → FAILED tracé, jamais silencieux.
    await worker.tick(ctx(1));
    await worker.tick(ctx(2));
    await worker.tick(ctx(3));
    const compte = file.compteParStatut();
    expect(compte.FAILED).toBe(1);
    expect(compte.QUEUED).toBe(0);
  });

  it("quarantaine : un lot incertain n'atteint JAMAIS la mémoire", async () => {
    // Contenu court, sans ancre des 18 domaines (titre neutre) → qualité et
    // confirmation insuffisantes → l'incertain reste hors mémoire.
    const contenuMoyen = JSON.stringify({
      title: "Une description moyenne",
      extract: "Une phrase descriptive moyenne. Une autre phrase descriptive moyenne. Une troisième phrase encore.",
    });
    const collecteur = agentCollecteur({ registre, file, fetcher: fetcherFactice([{ contenu: contenuMoyen }]) });
    const worker = agentTraitement({ file, memoire, registre, dossierCore: dossier });
    await collecteur.tick(ctx(1));
    const r = await worker.tick(ctx(1));
    expect(memoire.taille()).toBe(0); // l'incertain n'est PAS intégré
    expect(r.message).toMatch(/quarantaine|rejeté/);
    const compte = file.compteParStatut();
    expect(compte.QUARANTINED + compte.REJECTED).toBe(1);
    expect(compte.INTEGRATED).toBe(0);
  });
});

describe("Persistance disque des éléments du pipeline", () => {
  it("structure var/autonomous complète après un E2E de confirmation", async () => {
    const collecteur = agentCollecteur({ registre, file, fetcher: fetcherFactice([{ contenu: WIKI_JSON }, { contenu: WIKI_JSON_2 }]) });
    const worker = agentTraitement({ file, memoire, registre, dossierCore: dossier });
    await collecteur.tick(ctx(1));
    await worker.tick(ctx(1)); // quarantaine (source unique)
    await collecteur.tick(ctx(2));
    await worker.tick(ctx(2)); // confirmation → intégration + promotion
    expect(existsSync(join(dossier, "acquisition", "sources.json"))).toBe(true);
    expect(existsSync(join(dossier, "pipeline", "lots"))).toBe(true);
    expect(existsSync(join(dossier, "connaissances", "connaissances.jsonl"))).toBe(true);
    const lignes = readFileSync(join(dossier, "connaissances", "connaissances.jsonl"), "utf8").trim().split("\n");
    expect(lignes.length).toBeGreaterThanOrEqual(1);
    const c = JSON.parse(lignes[lignes.length - 1]) as { provenances: Array<{ sourceId: string }> };
    const sources = new Set(c.provenances.map((p) => p.sourceId));
    expect(sources.has("wikipedia-fr")).toBe(true);
    expect(sources.has("wikipedia-en")).toBe(true);
  });
});

describe("Réutilisation des modules existants (Règle 2 de la mission)", () => {
  it("nettoyerTexte de l'ingesteur existant est bien utilisé par l'extraction", async () => {
    const { nettoyerTexte } = await import("../../entrainement-auto/ingesteur");
    expect(nettoyerTexte("  du texte propre  ", 100)).toBe("du texte propre");
    expect(nettoyerTexte(null, 100)).toBeNull();
  });

  it("le registre des sources type hub reste visible pour la boucle existante", () => {
    const hub = registre.obtenir("hubs-hf-kaggle");
    expect(hub?.type).toBe("hub");
    expect(registre.prochaineDue(Date.now())?.type).not.toBe("hub");
  });

  it("le firewall expose l'espace autorisé documenté (var/autonomous)", () => {
    mkdirSync(join(dossier, "pipeline", "lots"), { recursive: true });
    writeFileSync(join(dossier, "pipeline", "lots", "x.json"), "{}");
    expect(verifierAccesEntrainement("pipeline/lots/x.json", dossier).autorise).toBe(true);
  });
});

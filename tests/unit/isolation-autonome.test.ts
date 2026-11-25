/**
 * TESTS AUTOMATIQUES D'ISOLATION (Lot 04 — mission « finalisation
 * opérationnelle ») : par ARCHITECTURE, les workers d'apprentissage global
 * ne peuvent JAMAIS lire les mémoires privées des utilisateurs.
 *
 * Trois niveaux de preuve :
 *  1. GARDE STRUCTUREL — aucun module du cerveau autonome ne référence les
 *     espaces utilisateurs (scan réel du code source au test) ;
 *  2. MATRICE FIREWALL — users/, traversées, absolus : REFUSÉS fail-closed ;
 *  3. INTÉGRATION WORKER — un lot pointant vers un chemin utilisateur est
 *     refusé par le worker AVANT toute lecture.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isolationCoherente, lireSiAutorise, PREFIXES_AUTORISES, PREFIXES_UTILISATEURS, verifierAccesEntrainement } from "@/lib/autonomous/privacy/firewall";
import { FileLots } from "@/lib/autonomous/pipeline/queue";
import { agentTraitement } from "@/lib/autonomous/pipeline/worker";
import { RegistreSources } from "@/lib/autonomous/acquisition/source-registry";
import { MemoireConnaissances } from "@/lib/autonomous/knowledge/memoire-connaissances";
import { GestionnaireTaches } from "@/lib/autonomous/core/task-manager";
import type { ContexteTick } from "@/lib/autonomous/core/types";

let dossier: string;
beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "isolation-"));
});
afterEach(() => {
  rmSync(dossier, { recursive: true, force: true });
});

describe("Niveau 1 — garde STRUCTUREL du code source (scan réel)", () => {
  it("aucun module de lib/autonomous ne référence un espace utilisateur", () => {
    const racine = join(process.cwd(), "lib", "autonomous");
    const violations: string[] = [];
    const visites = new Set<string>();
    const parcourir = (d: string): void => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const chemin = join(d, f.name);
        if (f.isDirectory()) {
          if (!visites.has(chemin)) {
            visites.add(chemin);
            parcourir(chemin);
          }
          continue;
        }
        if (!f.name.endsWith(".ts") || f.name.endsWith(".test.ts")) continue;
        const contenu = readFileSync(chemin, "utf8");
        // Le firewall lui-même DOIT mentionner « users/ » (c'est le garde) :
        // il est exclu du scan ; tout AUTRE module ne doit pas le connaître.
        if (chemin.includes("privacy") && f.name.startsWith("firewall")) continue;
        for (const motif of ["user-data-store", "users/", "lib/storage", "personal/", "getUserMemory", "memoireUtilisateur"]) {
          if (contenu.includes(motif)) violations.push(`${f.name} contient « ${motif} »`);
        }
      }
    };
    parcourir(racine);
    expect(violations).toEqual([]); // le cerveau autonome ne connaît PAS les données privées
  });

  it("le firewall et les workers d'entraînement global : liste blanche cohérente", () => {
    expect(isolationCoherente()).toBe(true);
    expect(PREFIXES_AUTORISES.every((p) => p.endsWith("/") || p.includes("/"))).toBe(true);
    expect(PREFIXES_UTILISATEURS).toContain("users/");
  });
});

describe("Niveau 2 — matrice firewall (fail-closed)", () => {
  const refus = ["users/uid-1/agents.json", "user/memoire.json", "personal/conversations.jsonl", "private/fichiers.json", "../users/x", "../../etc/passwd", "/etc/passwd", "memory-personnelle.json", "divers/notes.json"];
  it("refuse chaque chemin privé, utilisateur, traversée ou hors liste blanche", () => {
    for (const chemin of refus) {
      const verdict = verifierAccesEntrainement(chemin, dossier);
      expect(verdict.autorise, `« ${chemin} » doit être refusé`).toBe(false);
    }
  });

  it("autorise UNIQUEMENT les espaces de connaissances publiques du cerveau", () => {
    expect(verifierAccesEntrainement("acquisition/sources.json", dossier).autorise).toBe(true);
    expect(verifierAccesEntrainement("pipeline/lots/x.json", dossier).autorise).toBe(true);
    expect(verifierAccesEntrainement("connaissances/connaissances.jsonl", dossier).autorise).toBe(true);
  });

  it("le lecteur n'est JAMAIS appelé sur un chemin refusé (preuve fonctionnelle)", () => {
    let appels = 0;
    lireSiAutorise("users/uid-9/conversations.json", dossier, () => {
      appels += 1;
      return "SECRET";
    });
    expect(appels).toBe(0); // zéro accès réel au fichier privé
  });
});

describe("Niveau 3 — le worker d'apprentissage global REFUSE un lot utilisateur", () => {
  it("un lot injecté vers un chemin utilisateur est REJETÉ sans lecture", async () => {
    const registre = new RegistreSources(dossier);
    const file = new FileLots(dossier);
    const memoire = new MemoireConnaissances(dossier);
    const secret = "CONTENU PRIVE UTILISATEUR";
    // Le « lot » prétend vivre dans l'espace utilisateur (attaque simulée :
    // un lot détourné vers une mémoire privée).
    file.enqueuer({
      id: "lot-detourne-users",
      cycle: 1,
      sourceId: "wikipedia-fr",
      url: "users/uid-42/conversations.jsonl",
      collecteLe: new Date().toISOString(),
      contenu: secret,
      contentType: "text/plain",
      tailleOctets: secret.length,
      empreinte: "attaque",
    });
    // Un fichier privé existe réellement sur disque à cet endroit.
    const cheminPrive = join(dossier, "users", "uid-42");
    mkdirSync(cheminPrive, { recursive: true });
    writeFileSync(join(cheminPrive, "conversations.jsonl"), secret, "utf8");

    const worker = agentTraitement({ file, memoire, registre, dossierCore: dossier });
    const r = await worker.tick(ctxTest(1));

    const journal = (r.details as { journal?: string[] } | undefined)?.journal ?? [];
    expect(journal.some((ligne) => ligne.includes("REFUSÉ firewall"))).toBe(true); // refus tracé
    const lot = file.obtenir("lot-detourne-users")!;
    expect(lot.statut).toBe("REJECTED");
    expect(memoire.taille()).toBe(0); // rien n'a atteint la mémoire du cerveau
    // Le contenu privé n'est PAS entré dans la pipeline de connaissances :
    const dossierConnaissances = join(dossier, "connaissances");
    if (existsSync(join(dossierConnaissances, "connaissances.jsonl"))) {
      const brut = readFileSync(join(dossierConnaissances, "connaissances.jsonl"), "utf8");
      expect(brut).not.toContain("CONTENU PRIVE");
    }
  });

  it("les connaissances publiques passent normalement (pas de faux refus)", async () => {
    const registre = new RegistreSources(dossier);
    const file = new FileLots(dossier);
    const memoire = new MemoireConnaissances(dossier);
    const contenu = JSON.stringify({
      title: "Le Soleil chauffe la Terre",
      extract: "Le Soleil chauffe la Terre par rayonnement solaire. La chaleur alimente le climat et la photosynthèse de la planète. Les saisons dépendent de l'inclinaison de l'axe de la Terre.",
    });
    const collecte = { ok: true, statut: 200, contentType: "application/json", contenu };
    const { agentCollecteur } = await import("@/lib/autonomous/acquisition/collecteur");
    await agentCollecteur({ registre, file, fetcher: async () => collecte }).tick(ctxTest(1));
    const r = await agentTraitement({ file, memoire, registre, dossierCore: dossier }).tick(ctxTest(1));
    // Source unique de qualité moyenne → QUARANTAINE (jamais mémoire) ou
    // REJECT — mais JAMAIS un refus firewall (le chemin est légitime).
    expect(r.message).not.toContain("REFUSÉ firewall");
  });
});

/* utilitaires locaux */
function ctxTest(cycle = 1): ContexteTick {
  return {
    cycle,
    dateIso: new Date().toISOString(),
    taches: new GestionnaireTaches(),
    evenementsRecus: [],
    emettreEvenement() {},
  };
}

import { describe, expect, it } from "vitest";

import { executerCompetence, validerCode } from "../competences/bac-a-sable";
import {
  DiffuseurCompetences,
  RegistreCompetences,
} from "../competences/diffuseur";
import {
  ErreurModule,
  creerModule,
  fragmenterModule,
  reassemblerModule,
  verifierIntegrite,
} from "../competences/module-competence";
import type { MessageAgent } from "../types";
import type { NoeudAgents } from "../noeud-agents";

const CODE_VALIDE = `function executer(entree, memoire, journal) {
  memoire.appels = (memoire.appels ?? 0) + 1;
  journal("appel " + memoire.appels);
  return { double: (entree?.valeur ?? 0) * 2, appels: memoire.appels };
}`;

async function moduleValide(): Promise<Awaited<ReturnType<typeof creerModule>>> {
  return creerModule({
    id: "doubleur",
    nom: "Doubleur",
    description: "double une valeur",
    code: CODE_VALIDE,
    emetteur: "n-test",
  });
}

describe("creerModule — validation et empreinte", () => {
  it("accepte un module sain et calcule son empreinte SHA-256", async () => {
    const mod = await moduleValide();
    expect(mod.id).toBe("doubleur");
    expect(mod.empreinte).toMatch(/^[0-9a-f]{64}$/);
    expect(mod.code).toBe(CODE_VALIDE);
  });

  it("refuse les motifs dangereux AVANT compilation", async () => {
    for (const code of [
      "function executer(e) { return fetch('/x'); }",
      "function executer(e) { return eval('1'); }",
      "function executer(e) { return globalThis; }",
      "function executer(e) { return document.title; }",
      "function executer(e) { return import('/x'); }",
    ]) {
      await expect(
        creerModule({ id: "x", nom: "X", description: "", code, emetteur: "n" }),
      ).rejects.toThrow(ErreurModule);
    }
  });

  it("refuse un module sans executer ou trop lourd", async () => {
    await expect(
      creerModule({ id: "xx", nom: "X", description: "", code: "const a = 1;", emetteur: "n" }),
    ).rejects.toThrow(/executer/);
    await expect(
      creerModule({
        id: "xx",
        nom: "X",
        description: "",
        code: "function executer(){ return 1; } //" + "y".repeat(33 * 1024),
        emetteur: "n",
      }),
    ).rejects.toThrow(/trop lourd/);
  });
});

describe("fragmentation et intégrité", () => {
  it("fragmente et réassemble sans perte", async () => {
    const mod = await moduleValide();
    const { morceaux, total } = fragmenterModule(mod.code, 64);
    expect(total).toBe(morceaux.length);

    const carte = new Map(morceaux.map((m, i) => [i, m]));
    const code = reassemblerModule(carte, total);
    expect(code).toBe(mod.code);
  });

  it("un fragment manquant invalide TOUT le module", async () => {
    const mod = await moduleValide();
    const { morceaux, total } = fragmenterModule(mod.code, 32);
    const carte = new Map(morceaux.map((m, i) => [i, m]));
    carte.delete(Math.min(1, total - 1));
    expect(() => reassemblerModule(carte, total)).toThrow(ErreurModule);
  });

  it("verifierIntegrite détecte une altération d'un octet", async () => {
    const mod = await moduleValide();
    await expect(verifierIntegrite(mod.code, {
      id: mod.id,
      nom: mod.nom,
      description: mod.description,
      total: 1,
      empreinte: mod.empreinte,
      taille: mod.code.length,
      emetteur: "n",
      ts: mod.ts,
    })).resolves.toBeUndefined();

    const altere = mod.code.replace("double", "doubll");
    await expect(verifierIntegrite(altere, {
      id: mod.id,
      nom: mod.nom,
      description: mod.description,
      total: 1,
      empreinte: mod.empreinte,
      taille: mod.code.length,
      emetteur: "n",
      ts: mod.ts,
    })).rejects.toThrow(/Empreinte/);
  });
});

describe("bac à sable — la seule porte d'exécution", () => {
  it("exécute un module sain avec mémoire persistée et journal borné", () => {
    const mod = {
      id: "doubleur",
      nom: "Doubleur",
      description: "",
      version: 1,
      code: CODE_VALIDE,
      empreinte: "x",
      emetteur: "n",
      ts: 0,
    };
    const premier = executerCompetence(mod, { valeur: 21 });
    expect(premier.ok).toBe(true);
    expect(premier.valeur).toEqual({ double: 42, appels: 1 });
    expect(premier.journal[0]).toContain("appel 1");
    expect(premier.memoire.appels).toBe(1);

    const second = executerCompetence(mod, { valeur: 5 }, { memoire: premier.memoire });
    expect(second.valeur).toEqual({ double: 10, appels: 2 });
  });

  it("refuse au vol un code interdit passé au travers", () => {
    const mod = {
      id: "x",
      nom: "X",
      description: "",
      version: 1,
      code: "function executer(e) { return window.location; }",
      empreinte: "x",
      emetteur: "n",
      ts: 0,
    };
    const r = executerCompetence(mod, null);
    expect(r.ok).toBe(false);
    expect(r.erreur).toContain("interdit");
  });

  it("attrape les exceptions du module sans casser le nœud", () => {
    const mod = {
      id: "x",
      nom: "X",
      description: "",
      version: 1,
      code: "function executer(e) { throw new Error('boom'); }",
      empreinte: "x",
      emetteur: "n",
      ts: 0,
    };
    const r = executerCompetence(mod, null);
    expect(r.ok).toBe(false);
    expect(r.erreur).toContain("boom");
  });

  it("borne la valeur de retour (pas de fuite mémoire)", () => {
    const mod = {
      id: "x",
      nom: "X",
      description: "",
      version: 1,
      code: "function executer(e) { return 'z'.repeat(64 * 1024); }",
      empreinte: "x",
      emetteur: "n",
      ts: 0,
    };
    const r = executerCompetence(mod, null);
    expect(r.ok).toBe(false);
    expect(r.erreur).toContain("trop lourde");
  });

  it("refuse les boucles non bornées évidentes", () => {
    const v = validerCode("function executer(e) { while (true) { } }");
    expect(v.ok).toBe(false);
    expect(v.motifs).toContain("boucle non bornée");
  });
});

describe("DiffuseurCompetences — injection par ondes", () => {
  function noeudFactice(id: string) {
    const emis: MessageAgent[] = [];
    const noeud = {
      id,
      emettre: (message: { type: string; charge: unknown; vers?: string }) => {
        emis.push({
          v: 1,
          mid: `m-${emis.length}`,
          de: id,
          vers: message.vers,
          type: message.type as MessageAgent["type"],
          charge: message.charge,
          ttl: 2,
          ts: Date.now(),
        });
      },
      demarrer: () => undefined,
      arreter: () => undefined,
    } as unknown as NoeudAgents;
    return { noeud, emis };
  }

  it("diffuse en fragments, l'autre nœud rassemble et installe", async () => {
    const a = noeudFactice("n-a");
    const b = noeudFactice("n-b");
    const registreB = new RegistreCompetences();
    const diffuseurB = new DiffuseurCompetences({ noeud: b.noeud, registre: registreB });
    const diffuseurA = new DiffuseurCompetences({ noeud: a.noeud, registre: new RegistreCompetences() });

    const mod = await moduleValide();
    diffuseurA.diffuser(mod);

    // B reçoit chaque fragment d'onde…
    const fragments = a.emis.filter((m) => m.type === "competence");
    expect(fragments.length).toBeGreaterThan(0);
    for (const f of fragments) {
      diffuseurB.traiterMessage({ ...f, de: "n-a" });
    }

    // L'installation est asynchrone (vérification d'empreinte) : on attend
    // borné (poll) qu'elle aboutisse — un simple tick peut être trop court
    // sur un runner chargé (flake CI observé).
    let installee = registreB.get("doubleur");
    for (let i = 0; i < 40 && !installee; i += 1) {
      await new Promise((resoudre) => setTimeout(resoudre, 5));
      installee = registreB.get("doubleur");
    }

    // …et installe la compétence vérifiée.
    expect(installee).toBeDefined();
    expect(installee!.module.code).toBe(mod.code);

    // Elle est immédiatement exécutable dans le bac à sable.
    const r = registreB.executer("doubleur", { valeur: 3 });
    expect(r.ok).toBe(true);
    expect(r.valeur).toEqual({ double: 6, appels: 1 });
  });

  it("un module incomplet n'est PAS installé", async () => {
    const a = noeudFactice("n-a");
    const b = noeudFactice("n-b");
    const registreB = new RegistreCompetences();
    const diffuseurB = new DiffuseurCompetences({ noeud: b.noeud, registre: registreB });
    const diffuseurA = new DiffuseurCompetences({ noeud: a.noeud, registre: new RegistreCompetences() });

    // Un module assez gros pour être découpé en PLUSIEURS fragments
    // (taille d'onde : 4096 o de base64).
    const grosCode = CODE_VALIDE + "\n// " + "pad ".repeat(1600);
    const mod = await creerModule({
      id: "gros-module",
      nom: "Gros Module",
      description: "",
      code: grosCode,
      emetteur: "n-a",
    });
    diffuseurA.diffuser(mod);
    const fragments = a.emis.filter((m) => m.type === "competence");
    expect(fragments.length).toBeGreaterThan(1);

    // On n'en livre qu'une partie.
    for (const f of fragments.slice(0, Math.floor(fragments.length / 2))) {
      diffuseurB.traiterMessage({ ...f, de: "n-a" });
    }
    expect(registreB.get("gros-module")).toBeUndefined();
    expect(diffuseurB.enReception[0]?.fragments).toBeGreaterThan(0);
  });

  it("le registre refuse d'exécuter une compétence absente", () => {
    const registre = new RegistreCompetences();
    const r = registre.executer("inconnue", null);
    expect(r.ok).toBe(false);
    expect(r.erreur).toContain("non installée");
  });
});

/**
 * GARDE DES 12 MODULES GEN3 (demande propriétaire : architecture 12 modules
 * orchestrés par Gen3 Core). Le garde verrouille les règles d'honnêteté du
 * dépôt (zéro fantôme, cf. it.58) :
 *  - exactement 12 modules, identifiants canoniques uniques ;
 *  - chaque organe déclaré existe RÉELLEMENT sur disque (fs.existsSync) ;
 *  - chaque outil déclaré est RÉELLEMENT enregistré (GEN3IA_TOOLS ou
 *    brain.train — les seuls noms réels de la plateforme) ;
 *  - les niveaux N1/N2/N3 sont valides et Core reste l'orchestrateur ;
 *  - le routage est DÉTERMINISTE (même entrée → même sortie) et honnête
 *    (sous le seuil, retombe sur Core avec decide=false).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GEN3IA_TOOLS } from "@/lib/tools/registry";

import {
  inventaireModulesGen3,
  routerVersModules,
  SEUIL_DECISION_MODULE,
} from "./orchestrateur-modules";
import {
  MISSION_MODULES_GEN3,
  MODULES_GEN3,
  MODULES_PAR_ID,
  NB_MODULES_GEN3,
  NIVEAUX_VALIDES,
  OUTILS_HORS_REGISTRE_AUTORISES,
} from "./modules-gen3";

const RACINE_DEPOT = process.cwd();

/** Les noms d'outils RÉELS de la plateforme : GEN3IA_TOOLS (registre
 *  déclaratif) + les outils hors registre autorisés (brain.train, réel —
 *  lib/tools/brain-train.ts, enregistré dans default-registry.ts). */
const NOMS_OUTILS_REELS = new Set<string>([
  ...GEN3IA_TOOLS.map((t) => t.name),
  ...OUTILS_HORS_REGISTRE_AUTORISES,
]);

describe("garde-modules : structure des 12 modules", () => {
  it("déclare exactement 12 modules", () => {
    expect(MODULES_GEN3).toHaveLength(NB_MODULES_GEN3);
    expect(NB_MODULES_GEN3).toBe(12);
  });

  it("identifiants canoniques uniques et index par id complet", () => {
    const ids = MODULES_GEN3.map((m) => m.id);
    expect(new Set(ids).size).toBe(12);
    expect(Object.keys(MODULES_PAR_ID)).toHaveLength(12);
    for (const id of ids) {
      expect(MODULES_PAR_ID[id]).toBeDefined();
      expect(MODULES_PAR_ID[id].id).toBe(id);
    }
  });

  it("chaque module a une mission, des signaux et des niveaux valides", () => {
    for (const m of MODULES_GEN3) {
      expect(m.mission.length).toBeGreaterThan(40);
      expect(m.signaux.length).toBeGreaterThan(2);
      expect(NIVEAUX_VALIDES).toContain(m.niveau);
      expect(m.label).toMatch(/^Gen3 /);
    }
  });

  it("Gen3 Core est l'orchestrateur déclaré en premier", () => {
    expect(MODULES_GEN3[0].id).toBe("core");
    expect(MODULES_GEN3[0].label).toBe("Gen3 Core");
  });

  it("MISSION_MODULES_GEN3 nomme les 12 modules", () => {
    // La mission est rédigée en français : certains ids ont un libellé
    // accentué (« vidéo », « mémoire ») — mapping exact, aucun contournement.
    const motDeLaMission: Record<string, string> = {
      video: "vidéo",
      memoire: "mémoire",
    };
    const mission = MISSION_MODULES_GEN3.toLowerCase();
    for (const m of MODULES_GEN3) {
      const mot = motDeLaMission[m.id] ?? m.id;
      expect(mission).toContain(mot);
    }
  });
});

describe("garde-modules : zéro fantôme (organes et outils réels)", () => {
  it("chaque organe déclaré existe réellement sur disque", () => {
    const absents: string[] = [];
    for (const m of MODULES_GEN3) {
      for (const chemin of m.organes) {
        if (!existsSync(join(RACINE_DEPOT, chemin))) absents.push(`${m.id}: ${chemin}`);
      }
    }
    expect(absents).toEqual([]);
  });

  it("chaque outil déclaré est réellement enregistré dans la plateforme", () => {
    const fantomes: string[] = [];
    for (const m of MODULES_GEN3) {
      for (const outil of m.outils) {
        if (!NOMS_OUTILS_REELS.has(outil)) fantomes.push(`${m.id}: ${outil}`);
      }
    }
    expect(fantomes).toEqual([]);
  });

  it("les 12 modules couvrent au total tous les canaux propriétaires", () => {
    const ids = new Set(MODULES_GEN3.map((m) => m.id));
    for (const attendu of [
      "core",
      "texte",
      "vision",
      "audio",
      "video",
      "code",
      "spatial",
      "memoire",
      "apprentissage",
      "agents",
      "raisonnement",
      "recherche",
    ]) {
      expect(ids.has(attendu)).toBe(true);
    }
  });
});

describe("garde-modules : routage déterministe et honnête", () => {
  it("une demande vidéo active Gen3 Vidéo en module principal", () => {
    const r = routerVersModules("Crée-moi une vidéo courte avec sous-titres pour mon produit");
    expect(r.modulePrincipal).toBe("video");
    expect(r.decide).toBe(true);
    expect(r.scores).toHaveLength(12);
  });

  it("une demande de calcul/recherche web active Gen3 Recherche", () => {
    const r = routerVersModules("Cherche sur internet les dernières actualités sur Mars");
    expect(r.modulePrincipal).toBe("recherche");
  });

  it("une demande de code active Gen3 Code", () => {
    const r = routerVersModules("Écris un script TypeScript qui corrige ce bug dans mon site");
    expect(r.modulePrincipal).toBe("code");
  });

  it("une demande d'entraînement active Gen3 Apprentissage", () => {
    const r = routerVersModules("Entraîne-toi sur ce nouveau dataset de corpus");
    expect(r.modulePrincipal).toBe("apprentissage");
  });

  it("déterminisme strict : même demande → même routage (hors latence)", () => {
    const a = routerVersModules("Analyse cette image et décris les objets et les couleurs");
    const b = routerVersModules("Analyse cette image et décris les objets et les couleurs");
    expect(a.modulePrincipal).toBe("vision");
    expect(b.modulePrincipal).toBe(a.modulePrincipal);
    expect(b.modulesSecondaires).toEqual(a.modulesSecondaires);
    expect(b.scores.map((s) => s.score)).toEqual(a.scores.map((s) => s.score));
  });

  it("honnêteté : sous le seuil, retombe sur Core avec decide=false", () => {
    const r = routerVersModules("bonjour");
    expect(r.decide).toBe(false);
    expect(r.modulePrincipal).toBe("core");
    expect(r.demande).toBe("bonjour");
  });

  it("le seuil de décision est strictement positif", () => {
    expect(SEUIL_DECISION_MODULE).toBeGreaterThan(0);
  });

  it("les scores portent le label et le niveau du module", () => {
    const r = routerVersModules("Génère une image d'une scène avec des formes colorées");
    for (const s of r.scores) {
      expect(s.label).toMatch(/^Gen3 /);
      expect(NIVEAUX_VALIDES).toContain(s.niveau);
    }
  });
});

describe("garde-modules : inventaire pour l'API", () => {
  it("enrichit chaque module d'un état d'organes calculé par l'appelant", () => {
    const inventaire = inventaireModulesGen3(["lib/monde"]);
    const spatial = inventaire.find((m) => m.id === "spatial");
    expect(spatial).toBeDefined();
    expect(spatial?.organesAbsents).toEqual(["lib/monde"]);
    expect(spatial?.organesVerifies).toBe(spatial!.organes.length - 1);
    const texte = inventaire.find((m) => m.id === "texte");
    expect(texte?.organesAbsents).toEqual([]);
    expect(texte?.organesVerifies).toBe(texte!.organes.length);
  });
});

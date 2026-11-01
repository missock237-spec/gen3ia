/**
 * GARDE 43ᵉ — ACTIVATION VERSIONNÉE DU PROFIL ÉCO EN PRODUCTION (it.74,
 * candidat №1 déclaré it.73 §7.1 : « activer GEN3_PROFIL_ENERGIE=eco sur
 * le VPS et mesurer la réduction réelle de la charge serveur »).
 *
 * VERROUS :
 *  1. PRIORITÉ : variable d'environnement valide > fichier versionné >
 *     « plein » — l'opérateur local reste maître ;
 *  2. HONNÊTETÉ : une valeur d'environnement EXPLICITE INCONNUE retombe
 *     sur « plein » (comportement historique bit à bit) — JAMAIS sur une
 *     économie non demandée (même si le fichier dit « eco ») ;
 *  3. FICHIER VERSIONNÉ : absent / corrompu / non-objet / profil inconnu
 *     → repli honnête « plein » (jamais un profil déduit d'un fichier
 *     illisible) ;
 *  4. PROTECTION TESTS : sous NODE_ENV=test le fichier versionné est
 *     ignoré — la suite complète exerce toujours le comportement
 *     historique bit à bit, indépendamment du choix de production ;
 *  5. FICHIER COMMITTÉ RÉEL : profil « eco », declare=true, it ≥ 74,
 *     motif et qualité décrits, retour arrière documenté — l'activation
 *     est une DÉCLARATION reviewée par git, jamais un détour silencieux ;
 *  6. COMPTEUR D'ÉNERGIE : sommes d'entiers mesurés (fenêtres exécutées /
 *     évitées, époques RPIA et cycles évités), horodatage ISO, reset
 *     réservé aux tests ;
 *  7. BRANCHEMENT MOTEUR (garde structurelle) : engine.ts lit bien
 *     profilEnergieActif (canal versionné) et instrumentation compteur
 *     présente aux 3 chemins de fenêtres + court-circuit éco ;
 *     runtime.ts branche les horloges compactes sur le canal versionné ;
 *  8. SURFACE PUBLIQUE : /api/energie existe (no-store, profil + source +
 *     compteur + honnêteté), est dans la liste blanche publique, et la
 *     sonde production vérifie la nouvelle surface ;
 *  9. CONTINUITÉ it.73 : PROFILS_ENERGIE inchangé (les 3 profils et leurs
 *     descriptions) et profilEnergieDepuisEnv intact (garde 42ᵉ).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  enregistrerFenetreEvitee,
  enregistrerFenetreExecutee,
  lireCompteurEnergieProcess,
  reinitialiserCompteurEnergieProcess,
} from "./compteur-energie-process";
import {
  CHEMIN_PROFIL_PRODUCTION,
  lireFichierProfilProduction,
  profilEnergieActif,
} from "./profil-production";
import { PROFILS_ENERGIE, profilEnergieDepuisEnv } from "./energie";

const RACINE = process.cwd();
const CHEMIN_ENGINE = join(RACINE, "lib/neural/engine.ts");
const CHEMIN_RUNTIME = join(RACINE, "lib/neural/runtime.ts");
const CHEMIN_ROUTE = join(RACINE, "app/api/energie/route.ts");
const CHEMIN_LISTE_BLANCHE = join(RACINE, "lib/security/user-access.ts");
const CHEMIN_SONDE = join(RACINE, "scripts/sonde_regression_prod.mjs");
const CHEMIN_FICHIER_REEL = join(RACINE, CHEMIN_PROFIL_PRODUCTION);

const ENV_VIDE: Record<string, string | undefined> = {};

describe("GARDE 43ᵉ — priorité du canal versionné", () => {
  afterEach(() => reinitialiserCompteurEnergieProcess());

  it("1. env valide GAGNE sur le fichier versionné (l'opérateur local reste maître)", () => {
    const actif = profilEnergieActif(
      { GEN3_PROFIL_ENERGIE: "telephone" },
      {
        ignorerFichierVersionne: false,
        cheminFichier: CHEMIN_FICHIER_REEL,
      },
    );
    expect(actif.profil).toBe("telephone");
    expect(actif.source).toBe("env");
  });

  it("2. valeur d'environnement EXPLICITE INCONNUE → plein, JAMAIS l'économie du fichier", () => {
    const actif = profilEnergieActif(
      { GEN3_PROFIL_ENERGIE: "experimental" },
      {
        ignorerFichierVersionne: false,
        cheminFichier: CHEMIN_FICHIER_REEL, // ce fichier dit « eco »
      },
    );
    expect(actif.profil).toBe("plein");
    expect(actif.source).toBe("defaut-honnete");
  });

  it("3. env absente + fichier versionné valide → profil du fichier, source déclarée", () => {
    const actif = profilEnergieActif(ENV_VIDE, {
      ignorerFichierVersionne: false,
      cheminFichier: CHEMIN_FICHIER_REEL,
    });
    expect(actif.profil).toBe("eco");
    expect(actif.source).toBe("fichier-versionne");
  });

  it("4. PROTECTION TESTS : NODE_ENV=test ignore le fichier versionné (historique bit à bit)", () => {
    // Sans option explicite, le lecteur honore process.env.NODE_ENV — la
    // suite vitest tourne sous NODE_ENV=test → « plein » même si le fichier
    // committé dit « eco ».
    expect(process.env["NODE_ENV"]).toBe("test");
    const actif = profilEnergieActif(ENV_VIDE);
    expect(actif.profil).toBe("plein");
    expect(actif.source).toBe("defaut-honnete");
  });

  it("5. fichier absent / corrompu / non-objet / profil inconnu → repli honnête « plein »", () => {
    const lire = (c: string): string => {
      if (c === "inexistant.json") throw new Error("ENOENT");
      if (c === "corrompu.json") return "{ pas du JSON";
      if (c === "tableau.json") return '["eco"]';
      return "{}";
    };
    for (const chemin of [
      "inexistant.json",
      "corrompu.json",
      "tableau.json",
      "vide.json",
    ]) {
      const actif = profilEnergieActif(ENV_VIDE, {
        ignorerFichierVersionne: false,
        cheminFichier: chemin,
        lire,
      });
      expect(actif.profil).toBe("plein");
      expect(actif.source).toBe("defaut-honnete");
    }
    // Profil inconnu dans un fichier lisible → plein (jamais deviné).
    const actif = profilEnergieActif(ENV_VIDE, {
      ignorerFichierVersionne: false,
      cheminFichier: "inconnu.json",
      lire: () => JSON.stringify({ profil: "turbo" }),
    });
    expect(actif.profil).toBe("plein");
  });

  it("6. fichier versionné à « plein » : légal — le repli reste le défaut honnête", () => {
    const actif = profilEnergieActif(ENV_VIDE, {
      ignorerFichierVersionne: false,
      cheminFichier: "plein.json",
      lire: () => JSON.stringify({ profil: "plein", declare: true }),
    });
    expect(actif.profil).toBe("plein");
    expect(actif.source).toBe("defaut-honnete");
  });
});

describe("GARDE 43ᵉ — fichier versionné committé (activation déclarée)", () => {
  it("7. le fichier committé active « eco » avec les déclarations requises", () => {
    const contenu = lireFichierProfilProduction(CHEMIN_FICHIER_REEL);
    expect(contenu).not.toBeNull();
    expect(contenu?.["profil"]).toBe("eco");
    expect(contenu?.["declare"]).toBe(true);
    expect(typeof contenu?.["it"]).toBe("number");
    expect(contenu?.["it"]).toBeGreaterThanOrEqual(74);
    expect(String(contenu?.["motif"]).length).toBeGreaterThan(30);
    expect(String(contenu?.["date"])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const qualite = contenu?.["qualite"] as Record<string, unknown> | undefined;
    expect(String(qualite?.["texte"])).toContain("identique");
    expect(String(qualite?.["hors-cadre"])).toContain("inchangé");
    expect(String(contenu?.["retourArriere"]).length).toBeGreaterThan(10);
  });

  it("8. le fichier versionné est re-dérivable du module (même chemin constant)", () => {
    expect(CHEMIN_PROFIL_PRODUCTION).toBe(
      "assets/config/profil-energie-production.json",
    );
    // Lecture directe disque = même contenu que le lecteur injecté.
    const brut = readFileSync(CHEMIN_FICHIER_REEL, "utf8");
    expect(JSON.parse(brut)).toEqual(
      lireFichierProfilProduction(CHEMIN_FICHIER_REEL),
    );
  });
});

describe("GARDE 43ᵉ — compteur d'énergie du processus (mesures réelles)", () => {
  afterEach(() => reinitialiserCompteurEnergieProcess());

  it("9. les champs sont des sommes d'entiers exactes (évitées = 3 champs)", () => {
    reinitialiserCompteurEnergieProcess();
    enregistrerFenetreEvitee(12, 4);
    enregistrerFenetreEvitee(12, 4);
    enregistrerFenetreEvitee(12, 4);
    const c = lireCompteurEnergieProcess();
    expect(c.fenetresEvitees).toBe(3);
    expect(c.epoquesRPIAEvitees).toBe(36);
    expect(c.cyclesNoyauEvites).toBe(12);
    expect(c.fenetresExecutees).toBe(0);
  });

  it("10. fenêtre exécutée : incrémente UNIQUEMENT fenetresExecutees", () => {
    reinitialiserCompteurEnergieProcess();
    enregistrerFenetreExecutee();
    enregistrerFenetreExecutee();
    const c = lireCompteurEnergieProcess();
    expect(c.fenetresExecutees).toBe(2);
    expect(c.fenetresEvitees).toBe(0);
    expect(c.epoquesRPIAEvitees).toBe(0);
    expect(c.cyclesNoyauEvites).toBe(0);
    expect(c.demarrageIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("11. le compteur survit aux recharges de module (globalThis) et se réinitialise", () => {
    reinitialiserCompteurEnergieProcess();
    enregistrerFenetreExecutee();
    const avant = lireCompteurEnergieProcess();
    expect(avant.fenetresExecutees).toBe(1);
    reinitialiserCompteurEnergieProcess();
    const apres = lireCompteurEnergieProcess();
    expect(apres.fenetresExecutees).toBe(0);
    expect(apres.demarrageIso).toBeTruthy();
  });
});

describe("GARDE 43ᵉ — branchements (garde structurelle des sources)", () => {
  it("12. engine.ts lit le canal versionné et instrumente les 4 points d'énergie", () => {
    const source = readFileSync(CHEMIN_ENGINE, "utf8");
    // Canal versionné (plus l'ancien lecteur env seul au constructor).
    expect(source).toContain("profilEnergieActif().profil");
    // Compteur : court-circuit éco (fenêtre évitée) + 3 chemins de fenêtres
    // (génération, flux, générateur).
    expect(source).toContain("enregistrerFenetreEvitee(EPOQUES_RPIA_CHAT");
    expect(source.match(/enregistrerFenetreExecutee\(\)/g)?.length).toBe(3);
  });

  it("13. runtime.ts branche les horloges compactes sur le canal versionné", () => {
    const source = readFileSync(CHEMIN_RUNTIME, "utf8");
    expect(source).toContain("horlogesCompactes: profilEnergieActif().profil");
    expect(source).not.toContain(
      "horlogesCompactes: profilEnergieDepuisEnv()",
    );
  });

  it("14. continuité it.73 : PROFILS_ENERGIE et profilEnergieDepuisEnv inchangés", () => {
    expect(Object.keys(PROFILS_ENERGIE).sort()).toEqual([
      "eco",
      "plein",
      "telephone",
    ]);
    // Env inconnue → plein (la garde 42ᵉ verrouille déjà ce contrat —
    // re-vérifié ici contre toute régression du canal versionné).
    expect(profilEnergieDepuisEnv({ GEN3_PROFIL_ENERGIE: "?" })).toBe("plein");
    expect(profilEnergieDepuisEnv(ENV_VIDE)).toBe("plein");
  });
});

describe("GARDE 43ᵉ — surface publique /api/energie", () => {
  it("15. la route existe : profil + source + compteur + honnêteté, no-store", () => {
    expect(CHEMIN_ROUTE).toContain(join("app/api/energie", "route.ts"));
    const source = readFileSync(CHEMIN_ROUTE, "utf8");
    expect(source).toContain("profilEnergieActif()");
    expect(source).toContain("lireCompteurEnergieProcess()");
    expect(source).toContain("PROFILS_ENERGIE[actif.profil].description");
    expect(source).toContain('"no-store"');
    expect(source).toContain("aucune économie silencieuse");
  });

  it("16. /api/energie est dans la liste blanche publique", () => {
    const source = readFileSync(CHEMIN_LISTE_BLANCHE, "utf8");
    expect(source).toContain('"/api/energie": "systeme"');
  });

  it("17. la sonde production vérifie la nouvelle surface (mobile, énergie, snapshot)", () => {
    const source = readFileSync(CHEMIN_SONDE, "utf8");
    expect(source).toContain("'/mobile'");
    expect(source).toContain("'/api/energie'");
    expect(source).toContain("'/neural/cortex-telephone-it76.bin'");
  });
});

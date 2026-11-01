import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  enregistrerReponsePont,
  enregistrerRefusPont,
  lireCompteurPontVocation,
  reinitialiserCompteurPontVocation,
} from "@/lib/neural/compteur-pont-vocation";

/**
 * GARDE 44ᵉ — VUE UTILISATEUR DE LA SOBRIÉTÉ ÉNERGÉTIQUE (it.75, candidat
 * №2 déclaré it.74 §7 : « intégrer le compteur (profil actif + fenêtres
 * évitées) à la page /vocation ou /status — la mesure devient visible sans
 * curl »). Conventions du dépôt : vitest tourne en Node SANS jsdom ni
 * @testing-library/react — le câblage est verrouillé structurellement :
 *
 *  1. LE COMPOSANT CONSOMME LA MESURE RÉELLE : GET /api/energie (endpoint
 *     public it.74, no-store) — profil actif ET SA SOURCE, compteur de
 *     fenêtres exécutées vs évitées, époques RPIA et cycles évités,
 *     horodatage du démarrage, règle d'honnêteté. Aucun chiffre fabriqué
 *     côté client : les nombres affichés viennent du JSON du serveur.
 *  2. L'HONNÊTETÉ EST AFFICHÉE : erreur réseau/HTTP déclarée comme telle,
 *     état de lecture déclaré, persistance déclarée (mode fichier/mémoire,
 *     it.78) — jamais de succès inventé ni de jauge fictive.
 *  3. LE WIDGET EST LUI-MÊME SOBRE : rafraîchissement périodique 30 s GATÉ
 *     PAR LA VISIBILITÉ (useVisiblePolling) — zéro requête en arrière-plan ;
 *     un indicateur de sobriété qui pollerait en fond serait une
 *     contradiction.
 *  4. LA PAGE /vocation INTÈGRE LE WIDGET : import + rendu après le
 *     testeur public — la sobriété est lisible sur la page de la charte.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const COMPOSANT = "components/neural/vue-sobriete-energie.tsx";
const PAGE = "app/vocation/page.tsx";
const ROUTE = "app/api/energie/route.ts";
const ROUTE_QUESTIONS = "app/api/neural/questions/route.ts";
const COMPTEUR_PONT = "lib/neural/compteur-pont-vocation.ts";

describe("GARDE 44ᵉ — le widget consomme la mesure réelle du serveur", () => {
  const source = read(COMPOSANT);

  it("1. le composant est client et consomme GET /api/energie (mesure réelle, pas d'invention)", () => {
    expect(source).toContain('"use client"');
    expect(source).toContain('fetch("/api/energie", { cache: "no-store" })');
    // Les champs affichés sont CEUX du JSON du serveur (contrat it.74) —
    // aucun compteur parallèle calculé côté client.
    expect(source).toContain("profil.actif ??");
    expect(source).toContain("profil.source ??");
    expect(source).toContain("compteur?.fenetresEvitees");
    expect(source).toContain("compteur?.fenetresExecutees");
    expect(source).toContain("compteur.epoquesRPIAEvitees");
    expect(source).toContain("compteur.cyclesNoyauEvites");
    expect(source).toContain("compteur.demarrageIso");
    // it.75 — le second périmètre (pont public) est consommé tel quel.
    expect(source).toContain("pont?.reponsesServies");
    expect(source).toContain("pont?.refusHonnêtes");
    expect(source).toContain("energie?.honnetete?.regle");
    expect(source).toContain("energie?.honnetete?.qualite");
  });

  it("2. l'honnêteté est affichée : erreur déclarée, lecture déclarée, persistance déclarée", () => {
    expect(source).toContain("Endpoint énergie indisponible");
    expect(source).toContain("Réseau indisponible — réessayez.");
    expect(source).toContain("Lecture du compteur d&apos;énergie…");
    // it.78 — la persistance est AFFICHÉE : mode constaté (fichier/mémoire)
    // et continuité à travers les redéploiements expliquée — au lieu de la
    // vieille limite « remise à zéro » aujourd'hui levée.
    expect(source).toContain("Compteurs persistés sur disque (it.78)");
    expect(source).toContain("Persistance : ");
    expect(source).toContain("persistance?.mode ??");
    // La part évitée est mesurée depuis les deux compteurs — jamais une
    // estimation fixe.
    expect(source).toContain("Math.round((evitees / total) * 100)");
  });

  it("3. le widget est lui-même sobre : polling 30 s gaté par la visibilité", () => {
    expect(source).toContain("useVisiblePolling");
    expect(source).toContain("30_000");
    // Le hook gaté par la visibilité est bien celui du dépôt (audit perf
    // 2-a) — pas une boucle setInterval brute.
    expect(source).toContain('@/components/hooks/use-visible-polling');
  });

  it("4. la passerelle /mobile est proposée (le téléphone répond sans serveur)", () => {
    expect(source).toContain('href="/mobile"');
    expect(source).toContain("zéro requête serveur par question");
  });
});

describe("GARDE 44ᵉ — /vocation intègre la vue de sobriété", () => {
  const page = read(PAGE);

  it("5. la page importe et rend VueSobrieteEnergie après le testeur public", () => {
    expect(page).toContain('import VueSobrieteEnergie from "@/components/neural/vue-sobriete-energie"');
    expect(page).toContain("<VueSobrieteEnergie />");
    // Ordre : le testeur (it.66) PUIS la sobriété (it.75) — la question
    // fait bouger le compteur affiché juste en dessous.
    const indexTesteur = page.indexOf("<TesteurQuestionsVocation />");
    const indexSobriete = page.indexOf("<VueSobrieteEnergie />");
    expect(indexTesteur).toBeGreaterThan(-1);
    expect(indexSobriete).toBeGreaterThan(indexTesteur);
  });

  it("6. le commentaire de la page déclare le lien avec la demande propriétaire", () => {
    expect(page).toContain("it.75 — SOBRIÉTÉ ÉNERGÉTIQUE lisible par les utilisateurs");
    expect(page).toContain("devient visible sans curl");
  });
});

describe("GARDE 44ᵉ — continuité du contrat /api/energie (it.74)", () => {
  it("7. la route sert toujours profil + source + compteur + honnêteté en no-store", () => {
    const source = read(ROUTE);
    expect(source).toContain("profilEnergieActif()");
    expect(source).toContain("lireCompteurEnergieProcess()");
    expect(source).toContain('"no-store"');
    expect(source).toContain("aucune économie silencieuse");
  });

  it("8. aucun chiffre d'énergie n'est codé en dur dans le widget (12 époques / 4 cycles restent côté moteur)", () => {
    const source = read(COMPOSANT);
    // Les constantes du moteur (12 époques RPIA + 4 cycles par fenêtre)
    // appartiennent au serveur qui compte — le widget n'affiche QUE les
    // sommes déjà comptées. Interdiction d'écrire « 12 » ou « 4 » comme
    // multiplicateur d'énergie dans le client.
    expect(source).not.toMatch(/\b12\s*[×x*]\s*(époques|RPIA)/);
    expect(source).not.toMatch(/=\s*12\s*\*\s*fenetres/);
    expect(source).not.toMatch(/=\s*4\s*\*\s*fenetres/);
  });
});

describe("GARDE 44ᵉ — compteur du pont vocation (second périmètre réel, it.75)", () => {
  afterEach(() => {
    reinitialiserCompteurPontVocation();
  });

  it("9. les champs sont des sommes d'entiers exactes (réponses et refus comptés séparément)", () => {
    reinitialiserCompteurPontVocation();
    enregistrerReponsePont();
    enregistrerReponsePont();
    enregistrerReponsePont();
    enregistrerRefusPont();
    const c = lireCompteurPontVocation();
    expect(c.reponsesServies).toBe(3);
    expect(c.refusHonnêtes).toBe(1);
    expect(Number.isInteger(c.reponsesServies)).toBe(true);
    expect(Number.isInteger(c.refusHonnêtes)).toBe(true);
    expect(new Date(c.demarrageIso).toString()).not.toBe("Invalid Date");
  });

  it("10. le compteur survit aux recharges de module (globalThis) et se réinitialise", () => {
    reinitialiserCompteurPontVocation();
    enregistrerReponsePont();
    enregistrerReponsePont();
    // Re-lecture sans re-import : même conteneur globalThis.
    expect(lireCompteurPontVocation().reponsesServies).toBe(2);
    reinitialiserCompteurPontVocation();
    const neuf = lireCompteurPontVocation();
    expect(neuf.reponsesServies).toBe(0);
    expect(neuf.refusHonnêtes).toBe(0);
  });

  it("11. la route questions compte les réponses ET les refus honnêtes", () => {
    const source = read(ROUTE_QUESTIONS);
    expect(source).toContain('from "@/lib/neural/compteur-pont-vocation"');
    expect(source).toContain("enregistrerReponsePont()");
    expect(source).toContain("enregistrerRefusPont()");
    // Le comptage est placé sur les DEUX branches honnêtes (connu true / false).
    const brancheConnue = source.indexOf("enregistrerReponsePont()");
    const brancheRefus = source.indexOf("enregistrerRefusPont()");
    expect(brancheConnue).toBeGreaterThan(-1);
    expect(brancheRefus).toBeGreaterThan(-1);
    expect(brancheRefus).toBeLessThan(brancheConnue);
  });

  it("12. /api/energie expose le compteur du pont avec son périmètre déclaré", () => {
    const source = read(ROUTE);
    expect(source).toContain("lireCompteurPontVocation()");
    expect(source).toContain("pontVocation");
    expect(source).toContain("SANS fenêtre moteur");
    expect(source).toContain("disjoint du compteur du moteur");
  });

  it("13. le module compteur du pont est un module pur honnête (sommes mesurées, jamais estimées)", () => {
    const source = read(COMPTEUR_PONT);
    expect(source).toContain("SOMME D'ENTIERS MESURÉS");
    expect(source).toContain("jamais une estimation ni");
    expect(source).toContain("on compte ce qui est arrivé");
    expect(source).toContain("__gen3CompteurPontVocationIt75");
  });
});

describe("GARDE 44ᵉ — it.78 : la mesure devient durable et visible partout", () => {
  it("14. /status intègre le widget (candidat №2 reporté it.74 §7 / it.76 §8 / it.77 §9)", () => {
    const page = read("app/status/page.tsx");
    expect(page).toContain('import VueSobrieteEnergie from "@/components/neural/vue-sobriete-energie"');
    expect(page).toContain("<VueSobrieteEnergie />");
    expect(page).toContain("candidat №2 reporté trois fois");
  });

  it("15. /api/energie déclare la persistance (mode constaté, repli jamais silencieux)", () => {
    const source = read(ROUTE);
    expect(source).toContain("persistanceCompteurs");
    expect(source).toContain("lireModePersistanceCompteurs()");
    expect(source).toContain("repli mémoire DÉCLARÉ");
  });

  it("16. les deux compteurs s'amorcent depuis le disque et persistent à chaque incrément", () => {
    const pont = read(COMPTEUR_PONT);
    const moteur = read("lib/neural/core/v2/compteur-energie-process.ts");
    for (const source of [pont, moteur]) {
      expect(source).toContain("lireEtatCompteurs()");
      expect(source).toContain("persisterBlocCompteur(");
      expect(source).toContain("effacerEtatCompteurs()");
      expect(source).toContain("AMORÇAGE depuis le disque");
    }
  });
});

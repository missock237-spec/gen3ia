import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
 *     état de lecture déclaré, compteur à zéro expliqué (redéploiement) —
 *     jamais de succès inventé ni de jauge fictive.
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
    expect(source).toContain("energie?.honnetete?.regle");
    expect(source).toContain("energie?.honnetete?.qualite");
  });

  it("2. l'honnêteté est affichée : erreur déclarée, lecture déclarée, zéro expliqué", () => {
    expect(source).toContain("Endpoint énergie indisponible");
    expect(source).toContain("Réseau indisponible — réessayez.");
    expect(source).toContain("Lecture du compteur d&apos;énergie…");
    // Le compteur à zéro est EXPLIQUÉ (redéploiement) au lieu d'être maquillé.
    expect(source).toContain("Le compteur démarre à zéro à chaque redéploiement");
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

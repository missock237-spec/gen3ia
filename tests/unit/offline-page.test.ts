import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Task 99-d — garde structurel de la page hors-ligne (public/offline.html).
 *
 * offline.html est la page servie par le service worker quand une navigation
 * échoue (network-first). Elle doit rester 100 % hors-ligne (zéro requête
 * réseau, zéro asset externe), coller aux tokens réels du design system
 * GEN3IA (app/globals.css) et refléter l'état réel de la file hors-ligne :
 * auto-retry au retour du réseau + compteur de missions en attente lues
 * dans la base IndexedDB du service worker (lecture seule, jamais créée).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("Page hors-ligne — offline.html alignée sur le design system GEN3IA", () => {
  const page = read("public/offline.html");
  const pageMin = page.toLowerCase();

  // Tokens réels extraits de globals.css : le garde échouera si l'un des
  // deux fichiers diverge — l'alignement reste vérifié, pas copié-collé.
  const bg = /--g3-bg:\s*(#[0-9A-Fa-f]{6})/.exec(read("app/globals.css"))?.[1] ?? "";
  const surface = /--g3-surface:\s*(#[0-9A-Fa-f]{6})/.exec(read("app/globals.css"))?.[1] ?? "";
  const primary = /--g3-primary:\s*(#[0-9A-Fa-f]{6})/.exec(read("app/globals.css"))?.[1] ?? "";

  it("page française, mobile-ready (lang=fr + viewport conservés)", () => {
    expect(page).toContain('lang="fr"');
    expect(page).toContain('name="viewport"');
  });

  it("couleurs strictement alignées sur les tokens (--g3-bg, --g3-surface, --g3-primary)", () => {
    // Sanity check des tokens attendus (thème sombre « Nebula »).
    expect(bg.toLowerCase()).toBe("#05060c");
    expect(surface.toLowerCase()).toBe("#0b0d17");
    expect(primary.toLowerCase()).toBe("#7c5cff");
    // La page porte bien les valeurs réelles, pas des approximations.
    expect(pageMin).toContain(bg.toLowerCase());
    expect(pageMin).toContain(surface.toLowerCase());
    expect(pageMin).toContain(primary.toLowerCase());
    // Anciennes valeurs non alignées bannies (bg, surface, accent violets).
    expect(pageMin).not.toContain("#070a12");
    expect(pageMin).not.toContain("#0d1220");
    expect(pageMin).not.toContain("#7c3aed");
  });

  it("auto-retry : le retour du réseau déclenche un rechargement avec état « Reconnexion… » affiché", () => {
    expect(page).toContain('addEventListener("online"');
    expect(page).toContain("location.reload()");
    // Feedback visuel AVANT le reload (réseau qui revient puis recoupe).
    expect(page).toContain("Reconnexion…");
    expect(page).toContain("passerEnReconnexion");
    // Le réseau peut recouper : l'état « Hors ligne » est rétabli.
    expect(page).toContain('addEventListener("offline"');
  });

  it("bouton manuel « Réessayer » conservé", () => {
    expect(page).toContain(">Réessayer</button>");
  });

  it("compteur de missions en attente : lecture STRICTEMENT en lecture seule de la file du SW", () => {
    // Base et store exacts du service worker (public/sw.js).
    expect(page).toContain('"gen3ia-outbox"');
    expect(page).toContain('"requests"');
    // Ouverture SANS version : jamais d'upgrade ni de création — la base
    // reste la propriété exclusive du SW (une base vide ici casserait la
    // file : le SW n'upgraderait plus jamais son store).
    expect(page).toMatch(/indexedDB\.open\("gen3ia-outbox"\)/);
    expect(page).not.toContain('indexedDB.open("gen3ia-outbox", 1)');
    // Lecture readonly via getAll (même pattern que listQueued du SW).
    expect(page).toContain('"readonly"');
    expect(page).toContain('getAll()');
    // Gardes défensifs : la base doit exister avant ouverture, et toute
    // erreur masque le bloc silencieusement.
    expect(page).toContain("indexedDB.databases()");
    expect(page).toContain("hidden = true");
  });

  it("compteur rafraîchi aux messages du service worker (gen3ia-outbox-*)", () => {
    expect(page).toContain('navigator.serviceWorker.addEventListener("message"');
    expect(page).toContain('"gen3ia-outbox-flushed"');
    expect(page).toContain('"gen3ia-outbox-failed"');
    expect(page).toContain('"gen3ia-outbox-pending"');
  });

  it("message singulier/pluriel correct pour les missions en attente", () => {
    expect(page).toContain("mission en attente");
    expect(page).toContain("missions en attente");
    expect(page).toContain("envoi automatique dès le retour du réseau");
  });

  it("100 % hors-ligne : aucun fetch, aucune URL externe, aucun asset distant", () => {
    expect(page).not.toMatch(/\bfetch\s*\(/);
    expect(page).not.toMatch(/https?:\/\//);
    // Aucune dépendance externe (script src, link href distants).
    expect(page).not.toMatch(/<script[^>]+src=/i);
    expect(page).not.toMatch(/<link[^>]+href=/i);
  });

  it("hygiène UI : pas d'alert/prompt, état réseau annoncé aux lecteurs d'écran", () => {
    expect(page).not.toMatch(/\b(alert|prompt)\s*\(/);
    expect(page).toContain('role="status"');
    expect(page).toContain('aria-live="polite"');
  });
});

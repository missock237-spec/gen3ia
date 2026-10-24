import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Task 100-C — écrans de démarrage iOS (apple-touch-startup-image).
 *
 * En mode standalone, iOS n'a pas d'équivalent du splash Android (généré
 * depuis le manifest) : sans ces link dans le <head> SSR, l'app installée
 * affiche un écran BLANC au lancement. Garde-fous structurels :
 * le root layout référence bien les splashes (≥ 8 appareils, portrait),
 * chaque PNG référencé existe réellement sur disque et le dépôt reste
 * léger (aucune image au-delà de 200 Ko).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const layout = read("app/layout.tsx");

/** Balises <link rel="apple-touch-startup-image" ...> déclarées dans le layout. */
const splashLinks = layout.match(
  /<link\s+rel="apple-touch-startup-image"[^>]*>/g,
) ?? [];

/** hrefs des splashes référencés (attributs rel puis href sur la même balise). */
const splashHrefs = splashLinks
  .map((link) => link.match(/href="([^"]+)"/)?.[1])
  .filter((href): href is string => Boolean(href));

describe("Splash iOS — câblage dans le root layout", () => {
  it("le layout déclare les apple-touch-startup-image (≥ 8 appareils couverts)", () => {
    // Neuf appareils visés (5 iPhone + 1 iPhone @2x + 3 iPad) : chaque
    // balise porte une media-query distincte — une seule est retenue par iOS.
    expect(layout.match(/apple-touch-startup-image/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
    expect(splashLinks.length).toBeGreaterThanOrEqual(8);
    expect(splashHrefs.length).toBe(splashLinks.length);
  });

  it("les media-queries ciblent les dimensions CSS réelles (pixel-ratio + portrait)", () => {
    // iOS appaire l'image via device-width/device-height en POINTS ×
    // -webkit-device-pixel-ratio ; sans le ratio, plusieurs appareils
    // entreraient en collision (ex. 375pt @2x vs @3x). Couverture
    // PORTRAIT assumée — le paysage retombe sur l'écran uni.
    for (const link of splashLinks) {
      expect(link).toContain("(device-width:");
      expect(link).toContain("(device-height:");
      expect(link).toContain("-webkit-device-pixel-ratio");
      expect(link).toContain("orientation: portrait");
      expect(link).toContain('href="/images/splash/');
    }
  });

  it("chaque href référencé pointe vers un PNG réellement présent sur disque", () => {
    // Garde anti-lien-mort : un href fantôme serait silencieusement
    // ignoré par iOS (retour à l'écran blanc d'origine).
    expect(splashHrefs.length).toBeGreaterThanOrEqual(8);
    const unique = new Set(splashHrefs);
    expect(unique.size).toBe(splashHrefs.length); // pas de doublon d'appareil
    for (const href of splashHrefs) {
      const file = path.join(process.cwd(), "public", href.replace(/^\//, ""));
      expect(existsSync(file), `PNG manquant : ${href}`).toBe(true);
    }
  });

  it("dépôt léger : aucune image de splash ne dépasse 200 Ko", () => {
    // Fond uni #05060C + logo : le PNG compresse très bien — au-delà de
    // 200 Ko c'est le signe d'un fond texturé ou d'une compression perdue.
    for (const href of splashHrefs) {
      const file = path.join(process.cwd(), "public", href.replace(/^\//, ""));
      expect(statSync(file).size, `trop lourd : ${href}`).toBeLessThanOrEqual(200 * 1024);
    }
  });

  it("les balises sont rendues dans le <head> explicite du root layout", () => {
    // Le layout embarque un <head> JSX explicite (preconnects, bootstrap
    // thème) : les splashes doivent y vivre AUSSI — hors <head>, iOS ne
    // les lirait pas au lancement (et React ne hoiste pas rétroactivement
    // un splash déjà manqué).
    const headMatch = layout.match(/<head>([\s\S]*?)<\/head>/);
    expect(headMatch).not.toBeNull();
    const linksInHead = headMatch?.[1].match(
      /<link\s+rel="apple-touch-startup-image"/g,
    ).length ?? 0;
    expect(linksInHead).toBe(splashLinks.length);
  });
});

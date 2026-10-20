import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHARIOW_PLAN_WIDGETS,
  CHARIOW_STORE_DOMAIN,
  WIDGET_SCRIPT_SRC,
  WIDGET_STYLE_HREF,
} from "./chariow-widgets-config";

/**
 * WIDGET DE PAIEMENT DIRECT CHARIOW — conventions du dépôt : vitest tourne en
 * Node SANS jsdom ni @testing-library/react (cf. components/media/). Les
 * données exportées (boutique, 3 produits payants, URLs loader) sont testées
 * par import direct depuis le module PUR chariow-widgets-config.ts ; le
 * mécanisme d'injection (scan one-shot du script Chariow, re-scan au
 * remontage React, dédoublonnage micro-tâche, CSP requise) et l'intégration
 * /billing sont verrouillés structurellement sur les sources.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const WIDGET = "components/billing/chariow-widget.tsx";
const CONFIG = "components/billing/chariow-widgets-config.ts";
const MIDDLEWARE = "middleware.ts";
const BILLING_PAGE = "app/billing/page.tsx";

describe("produits de paiement direct (données pures exportées)", () => {
  it("pointe sur la boutique Chariow officielle Gen3ia", () => {
    expect(CHARIOW_STORE_DOMAIN).toBe("xdaagetk.mychariow.shop");
  });

  it("expose exactement les 3 produits payants publiés (Pro / Entreprise / Sur-Mesure)", () => {
    expect(CHARIOW_PLAN_WIDGETS.map((w) => w.productId)).toEqual([
      "prd_svqonju7",
      "prd_v76f5kjl",
      "prd_646qpmge",
    ]);
    expect(CHARIOW_PLAN_WIDGETS).toHaveLength(3);
    for (const widget of CHARIOW_PLAN_WIDGETS) {
      expect(widget.label.length).toBeGreaterThan(0);
      expect(widget.note.length).toBeGreaterThan(0);
    }
  });

  it("charge le loader officiel depuis js.chariowcdn.com (script + style)", () => {
    expect(WIDGET_SCRIPT_SRC).toBe("https://js.chariowcdn.com/v1/widget.min.js");
    expect(WIDGET_STYLE_HREF).toBe("https://js.chariowcdn.com/v1/widget.min.css");
  });

  it("cohérence avec la grille serveur (lib/billing/plans.ts = source de vérité)", async () => {
    const plans = await import("@/lib/billing/plans");
    delete process.env.CHARIOW_PLAN_PRO_PRODUCT_ID;
    delete process.env.CHARIOW_PLAN_ENTREPRISE_PRODUCT_ID;
    delete process.env.CHARIOW_PLAN_SUR_MESURE_PRODUCT_ID;
    expect(plans.resolvePlanProductId("pro")).toBe("prd_svqonju7");
    expect(plans.resolvePlanProductId("entreprise")).toBe("prd_v76f5kjl");
    expect(plans.resolvePlanProductId("modele-sur-mesure")).toBe("prd_646qpmge");
  });
});

describe("mécanisme d'injection (verrouillage structurel du composant)", () => {
  const source = read(WIDGET);

  it("rend la div officielle #chariow-widget avec les attributs du code d'embed", () => {
    expect(source).toContain('id="chariow-widget"');
    expect(source).toContain("data-product-id={productId}");
    expect(source).toContain("data-store-domain={storeDomain}");
    expect(source).toContain('data-style="tap"');
    expect(source).toContain('data-locale="fr"');
    expect(source).toContain('data-primary-color="#ffcc00"');
    expect(source).toContain('data-cta-animation="shine"');
  });

  it("injecte le loader après le rendu (useEffect) et délègue l'injection", () => {
    expect(source).toContain("useEffect(() => {");
    expect(source).toContain("programmerInjection()");
    expect(source).toContain("appendChild(script)");
    expect(source).toContain("appendChild(link)");
  });

  it("force le re-scan au remontage (retire le script existant avant réinjection)", () => {
    // Le script Chariow ne scanne qu'une fois : sans ce remove, un remontage
    // React laisserait les nouvelles divs vides.
    expect(source).toContain("getElementById(WIDGET_SCRIPT_ID)?.remove()");
    expect(source).toContain("script.id = WIDGET_SCRIPT_ID");
  });

  it("déduplique les injections par micro-tâche (N widgets → un seul scan)", () => {
    expect(source).toContain("injectionProgrammee");
    expect(source).toContain("setTimeout");
    expect(source).toContain("clearTimeout");
  });

  it("l'injection vit dans le composant client, pas dans le module de données", () => {
    // chariow-widgets-config.ts reste pur (importable en tests Node sans DOM).
    expect(read(CONFIG)).not.toContain("document.createElement");
    expect(read(CONFIG)).not.toContain("useEffect");
  });
});

describe("intégration page /billing + CSP forteresse", () => {
  it("la page billing rend les 3 widgets de paiement direct", () => {
    const page = read(BILLING_PAGE);
    expect(page).toContain("chariow-widget");
    expect(page).toContain("CHARIOW_PLAN_WIDGETS");
    expect(page).toContain("Paiement direct sur la boutique Chariow");
  });

  it("la CSP autorise le CDN widget (script + style) sans ouvrir le reste", () => {
    const csp = read(MIDDLEWARE);
    const scriptSrc = csp.match(/"script-src[^"]+"/)?.[0] ?? "";
    const styleSrc = csp.match(/"style-src[^"]+"/)?.[0] ?? "";
    const frameSrc = csp.match(/"frame-src[^"]+"/)?.[0] ?? "";
    const connectSrc = csp.match(/"connect-src[^"]+"/)?.[0] ?? "";
    expect(scriptSrc).toContain("https://js.chariowcdn.com");
    expect(styleSrc).toContain("https://js.chariowcdn.com");
    expect(frameSrc).toContain("js.chariowcdn.com");
    expect(frameSrc).toContain("*.mychariow.shop");
    expect(connectSrc).toContain("js.chariowcdn.com");
    expect(connectSrc).toContain("*.mychariow.shop");
  });
});

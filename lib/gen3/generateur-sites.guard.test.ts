/**
 * GARDE 48ᵉ (it.80 — demande propriétaire, trace 1a198553ec1dce61 : « via le
 * navigateur, si un utilisateur demande de créer un site ou une app, gen3
 * doit lui générer du code ») — LE GÉNÉRATEUR SUR DEMANDE EST DÉTERMINISTE,
 * SÛR ET HONNÊTE.
 *
 * Cette garde verrouille :
 *  1. la DÉTERMINISME : même demande → code octet-pour-octet identique ;
 *  2. la COUVERTURE : les 6 familles annoncées produisent toutes un module
 *     exporté complet (et l'index des familles affiché à l'utilisateur y
 *     correspond exactement) ;
 *  3. la SÉCURITÉ : aucun identifieur/texte utilisateur ne peut casser la
 *     structure du code généré (sanitisation mesurée : accents, injection
 *     de guillemets/balises, repli « App ») ;
 *  4. les OPTIONS : accessibilité (aria/labels) et sauvegarde locale
 *     (localStorage) n'apparaissent QUE si demandées, et localStorage n'est
 *     proposé QUE pour les familles à état persistable ;
 *  5. l'HONNÊTETÉ : le code généré ne contient NI eval NI new Function
 *     (CSP sans unsafe-eval), les notes déclarent le cadre appri et le
 *     repli explicite quand le nom n'est pas exploitable.
 */

import { describe, expect, it } from "vitest";

import {
  TYPES_PROJET,
  famillesCouvertes,
  genererCodeSite,
  identifieurNom,
  nomAffiche,
  type OptionsProjet,
  type TypeProjet,
} from "./generateur-sites";

const LES_SIX = Object.keys(TYPES_PROJET) as TypeProjet[];

function options(type: TypeProjet, partiel: Partial<OptionsProjet> = {}): OptionsProjet {
  return { type, nom: "Café Goma", contexte: "next", accessibilite: true, stockageLocal: true, ...partiel };
}

describe("GARDE 48ᵉ — déterminisme et couverture des 6 familles", () => {
  it("la même demande produit un code OCTET-POUR-OCTET identique (déterminisme)", () => {
    for (const type of LES_SIX) {
      const a = genererCodeSite(options(type, { nom: "Clinique Nkolo" }));
      const b = genererCodeSite(options(type, { nom: "Clinique Nkolo" }));
      expect(b.code).toBe(a.code);
      expect(b.instruction).toBe(a.instruction);
    }
  });

  it("chaque famille produit un module exporté complet et cohérent avec son contexte", () => {
    for (const type of LES_SIX) {
      const next = genererCodeSite(options(type, { contexte: "next" }));
      const react = genererCodeSite(options(type, { contexte: "react" }));
      expect(next.code).toContain("export default function");
      expect(react.code).toContain("export default function");
      expect(next.code.length).toBeGreaterThan(600);
      expect(next.fichier.startsWith("app/")).toBe(true);
      expect(react.fichier.startsWith("components/")).toBe(true);
      // l'identifieur du composant est dérivé du nom (PascalCase, accents retirés)
      expect(next.code).toContain("CafeGoma");
    }
  });

  it("l'index des familles affiché à l'utilisateur correspond EXACTEMENT aux types couverts", () => {
    expect(famillesCouvertes()).toEqual(LES_SIX.map((t) => TYPES_PROJET[t].label));
    expect(LES_SIX).toHaveLength(6);
  });
});

describe("GARDE 48ᵉ — sécurité : aucune entrée utilisateur ne casse le code généré", () => {
  it("les accents et signes sont retirés de l'identifieur (mesuré)", () => {
    expect(identifieurNom("Café Goma")).toBe("CafeGoma");
    expect(identifieurNom("clinique nkolo")).toBe("CliniqueNkolo");
    expect(identifieurNom("!!!")).toBe("App"); // repli honnête
    expect(identifieurNom("")).toBe("App");
    expect(identifieurNom("3 ateliers")).toBe("Ateliers"); // chiffres en tête retirés
  });

  it("les guillemets, antislashs, chevrons et esperluettes sont NEUTRALISÉS dans le nom affiché", () => {
    const nom = nomAffiche('Cafe" \\ ` Goma</h1><script>alert(1)</script>&co\'');
    expect(nom).not.toContain('"');
    expect(nom).not.toContain("\\");
    expect(nom).not.toContain("`");
    expect(nom).not.toContain("<");
    expect(nom).not.toContain(">");
    expect(nom).not.toContain("&");
    expect(nom).not.toContain("'");
    const resultat = genererCodeSite(options("site-vitrine", { nom: 'x"y`z<w>&\'' }));
    // le code généré ne contient aucun guillemet double parasite issu du nom
    expect(resultat.code).not.toContain('x"y');
  });

  it("le nom affiché est borné (48 caractères) et le repli « Mon site » s'applique", () => {
    expect(nomAffiche("A".repeat(200)).length).toBeLessThanOrEqual(48);
    expect(nomAffiche("   ")).toBe("Mon site");
  });

  it("le code généré ne contient NI eval NI new Function (CSP sans unsafe-eval)", () => {
    for (const type of LES_SIX) {
      const r = genererCodeSite(options(type));
      expect(r.code).not.toContain("eval(");
      expect(r.code).not.toContain("new Function");
      expect(r.code).not.toContain("${"); // aucun gabarit évalué dans le code livré
    }
  });
});

describe("GARDE 48ᵉ — options : accessibilité et sauvegarde locale mesurées", () => {
  it("l'option accessibilité ajoute aria/labels — et leur absence les retire", () => {
    const avec = genererCodeSite(options("formulaire-contact", { accessibilite: true }));
    const sans = genererCodeSite(options("formulaire-contact", { accessibilite: false }));
    expect(avec.code).toContain("aria-describedby");
    expect(sans.code).not.toContain("aria-describedby");
    expect(avec.instruction).not.toBe(sans.instruction);
  });

  it("localStorage n'apparaît QUE si demandé ET pour une famille à état persistable", () => {
    for (const type of LES_SIX) {
      const fiche = TYPES_PROJET[type];
      const avec = genererCodeSite(options(type, { stockageLocal: true }));
      const sans = genererCodeSite(options(type, { stockageLocal: false }));
      if (fiche.avecEtatPersistable) {
        expect(avec.code).toContain("localStorage");
        expect(sans.code).not.toContain("localStorage");
      } else {
        // famille sans état : l'option n'introduit JAMAIS de localStorage
        expect(avec.code).not.toContain("localStorage");
        expect(sans.code).not.toContain("localStorage");
      }
    }
  });

  it("les notes déclarent honnêtement le cadre appri et le repli « App »", () => {
    const r = genererCodeSite(options("site-vitrine", { nom: "!!!", contexte: "next" }));
    const jointes = r.notes.join("\n");
    expect(jointes).toContain("cadre appri");
    expect(jointes).toContain("App");
    // et le code utilise bien le repli
    expect(r.code).toContain("App");
  });
});

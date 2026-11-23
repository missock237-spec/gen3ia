import { describe, expect, it } from "vitest";

import { deriveStatutApplication, libelleDerniereVerification } from "./statut-app";

/**
 * STATUT DE L'APPLICATION (logique pure) — la garantie visible de la
 * demande : l'app installée est CONNECTÉE au site (même version) et les
 * mises à jour s'appliquent automatiquement. Mêmes règles que le
 * DeployWatcher : sondes divergentes = indéterminé (jamais de décision
 * contradictoire), hors-ligne = indéterminé avec démarche.
 */
describe("deriveStatutApplication — app installée vs version servie", () => {
  it("versions identiques (api = manifest = locale) → À JOUR, mise à jour auto affirmée", () => {
    const statut = deriveStatutApplication({
      apiId: "build-42",
      manifestVersion: "build-42",
      versionLocale: "build-42",
    });
    expect(statut.etat).toBe("a-jour");
    expect(statut.versionActive).toBe("build-42");
    expect(statut.libelle).toMatch(/À jour ✓/);
    expect(statut.detail).toMatch(/même version que le site web/);
    expect(statut.detail).toMatch(/automatiquement/);
  });

  it("locale périmée (cache de l'app d'avant) → nouvelle version EN APPLICATION AUTOMATIQUE", () => {
    const statut = deriveStatutApplication({
      apiId: "build-43",
      manifestVersion: "build-43",
      versionLocale: "build-42",
    });
    expect(statut.etat).toBe("nouvelle-version");
    expect(statut.libelle).toMatch(/application automatique/);
    expect(statut.detail).toMatch(/Aucune réinstallation nécessaire/);
  });

  it("service worker avec une version EN ATTENTE (reg.waiting) → application automatique même si locale inconnue", () => {
    const statut = deriveStatutApplication({
      apiId: "build-44",
      manifestVersion: "build-44",
      versionLocale: null,
      nouvelleVersionEnAttente: true,
    });
    expect(statut.etat).toBe("nouvelle-version");
    expect(statut.detail).toMatch(/rechargement transparent/);
  });

  it("sondes divergentes (bascule/rollback) → INDÉTERMINÉ, jamais de décision contradictoire", () => {
    const statut = deriveStatutApplication({
      apiId: "build-44",
      manifestVersion: "build-45",
      versionLocale: "build-43",
    });
    expect(statut.etat).toBe("indetermine");
    expect(statut.versionActive).toBeNull();
    expect(statut.detail).toMatch(/divergent/);
  });

  it("serveur injoignable (hors-ligne) → indéterminé avec démarche (retour du réseau)", () => {
    const statut = deriveStatutApplication({
      apiId: null,
      manifestVersion: null,
      versionLocale: "build-42",
    });
    expect(statut.etat).toBe("indetermine");
    expect(statut.detail).toMatch(/retour du réseau/);
  });

  it("manifeste statique seul (incident API) → décision prise quand même (sonde de secours)", () => {
    const statut = deriveStatutApplication({
      apiId: null,
      manifestVersion: "build-45",
      versionLocale: "build-45",
    });
    expect(statut.etat).toBe("a-jour");
    expect(statut.versionActive).toBe("build-45");
  });
});

describe("libelleDerniereVerification — horodatage lisible", () => {
  const maintenant = 1_800_000_000_000;
  it("jamais si aucune vérification ; sinon minutes/heures/jours", () => {
    expect(libelleDerniereVerification(null, maintenant)).toBe("jamais");
    expect(libelleDerniereVerification(maintenant - 20_000, maintenant)).toBe("il y a moins d'une minute");
    expect(libelleDerniereVerification(maintenant - 5 * 60_000, maintenant)).toBe("il y a 5 min");
    expect(libelleDerniereVerification(maintenant - 3 * 3_600_000, maintenant)).toBe("il y a 3 h");
    expect(libelleDerniereVerification(maintenant - 2 * 86_400_000, maintenant)).toBe("il y a 2 j");
  });
});

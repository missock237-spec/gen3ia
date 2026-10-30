import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * HISTORIQUE COMPLET DES ÉVALUATIONS (it.47) — conventions du dépôt :
 * vitest tourne en Node SANS jsdom ni @testing-library/react (cf.
 * components/developer/tabs/secrets-panel.test.tsx). Le câblage de la
 * porte /api/ia/auto-apprentissage/rapport dans la carte
 * auto-apprentissage du chat (components/chat/auto-apprentissage-carte.tsx)
 * est verrouillé structurellement :
 *
 *  1. LA PORTE RAPPORT EST CONSOMMÉE À LA DEMANDE : chargement au
 *     dépliage du bloc (onToggle) — pas de requête au montage de la
 *     carte, le rate-limit 60/min de la porte reste disponible.
 *  2. L'HONNÊTETÉ STATISTIQUE EST AFFICHÉE : le protocole du serveur est
 *     restitué tel quel, les évaluations sous-seuil restent listées avec
 *     la mention « non comptable » (jamais maquillées), résumés par
 *     domaine (consignées/valides, dernière, meilleure, tendance).
 *  3. L'ÉTAT EST HONNÊTE : 401 → « Connectez-vous », 429 → patientez,
 *     échec réseau affiché — jamais de succès inventé.
 *  4. ZÉRO DÉPENDANCE EXTERNE : la porte consommée est uniquement la
 *     porte maison (session cookie same-origin, convention du fichier).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const CARTE = "components/chat/auto-apprentissage-carte.tsx";

describe("Historique complet des évaluations (câblage /api/ia/auto-apprentissage/rapport, it.47)", () => {
  const carte = read(CARTE);

  it("la porte rapport est consommée À LA DEMANDE (dépliage), pas au montage", () => {
    expect(carte).toContain('fetch("/api/ia/auto-apprentissage/rapport", { cache: "no-store" })');
    expect(carte).toContain("chargerRapport");
    // Chargement conditionné au dépliage du bloc — zéro requête au montage.
    expect(carte).toContain("onToggle={ouvrirRapport}");
    expect(carte).toContain("e.currentTarget.open && !rapport && !rapportEnCours");
    // Garde anti double-chargement pendant la requête en cours.
    expect(carte).toContain("if (rapportEnCours) return;");
  });

  it("l'honnêteté statistique est restituée : protocole, sous-seuil signalés, résumés complets", () => {
    // Le protocole du serveur est affiché tel quel (texte de la route).
    expect(carte).toContain("rapport.rapport.protocole");
    // Une évaluation sous-seuil reste visible ET signalée — jamais
    // maquillée (honnêteté de la porte, restituée côté carte).
    expect(carte).toContain("non comptable (sous-seuil)");
    // Résumés par domaine : consignées / valides / dernière / meilleure /
    // tendance — aucune métrique fabriquée côté client.
    expect(carte).toContain("domaine.resume.evaluationsConsignees");
    expect(carte).toContain("domaine.resume.evaluationsValides");
    expect(carte).toContain("domaine.resume.derniereAccuracy");
    expect(carte).toContain("domaine.resume.meilleureAccuracy");
    expect(carte).toContain("domaine.resume.tendance");
    // Cas honnête : un domaine sans évaluation le dit.
    expect(carte).toContain("Aucune évaluation consignée pour ce domaine.");
    // L'instantané est daté (pas de données présentées comme vivantes).
    expect(carte).toContain("Rapport généré le");
  });

  it("l'état est honnête : 401 → connexion, 429 → patientez, échec affiché", () => {
    expect(carte).toContain('res.status === 401');
    expect(carte).toContain("Connectez-vous pour consulter l'historique des évaluations.");
    expect(carte).toContain('res.status === 429');
    expect(carte).toContain("Trop de consultations : patientez un instant.");
    expect(carte).toContain("Historique indisponible (réseau).");
    // Le message d'erreur est rendu (classe erreur existante) — jamais
    // avalé.
    expect(carte).toContain("auto-carte-erreur");
  });

  it("zéro dépendance externe : la porte consommée est uniquement la porte maison", () => {
    const sectionRapport = carte.slice(
      carte.indexOf("historique complet — GET /api/ia/auto-apprentissage/rapport"),
      carte.indexOf("const autonomie = phase === \"autonomie\";"),
    );
    expect(sectionRapport).toContain("/api/ia/auto-apprentissage/rapport");
    expect(sectionRapport).not.toMatch(/https?:\/\//);
    expect(sectionRapport).not.toContain("axios");
  });
});

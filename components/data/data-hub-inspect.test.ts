import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * INSPECTION RÉELLE DES JEUX DU HUB (it.48) — conventions du dépôt :
 * vitest tourne en Node SANS jsdom ni @testing-library/react (cf.
 * components/chat/auto-apprentissage-rapport.test.ts). Le câblage de la
 * porte /api/training/hub/inspect dans la console Data
 * (components/data/data-console.tsx) est verrouillé structurellement :
 *
 *  1. LA PORTE INSPECT EST CONSOMMÉE À LA DEMANDE : bouton « Inspecter »
 *     sur chaque résultat de la recherche hub (provider + ref) — pas de
 *     requête au montage, garde anti double-clic pendant la requête, le
 *     rate-limit 30/min de la porte reste disponible.
 *  2. L'INSPECTION RESTITUE LE CONTRAT RÉEL : licence, taille,
 *     téléchargements, splits déclarés, fichiers (avec le statut
 *     importable / format non géré), colonnes, échantillon de lignes
 *     réelles et limites remontées par le connecteur — tout ce que le
 *     hub n'expose pas est affiché « non exposé » (jamais maquillé) et
 *     l'instantané est daté.
 *  3. L'ÉTAT EST HONNÊTE : 401 → « Connectez-vous », 429 → patientez,
 *     échec réseau affiché (role=alert) — jamais de succès inventé.
 *  4. ZÉRO DÉPENDANCE EXTERNE : la porte consommée est uniquement la
 *     porte maison (authFetch same-origin, convention du fichier).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const CONSOLE = "components/data/data-console.tsx";

describe("Inspection des jeux du hub (câblage /api/training/hub/inspect, it.48)", () => {
  const consoleData = read(CONSOLE);

  it("la porte inspect est consommée À LA DEMANDE (provider + ref), pas au montage", () => {
    expect(consoleData).toContain("`/api/training/hub/inspect?${params.toString()}`");
    expect(consoleData).toContain("inspecterDuHub");
    expect(consoleData).toContain("new URLSearchParams({ provider, ref })");
    // Garde anti double-clic pendant la requête en cours.
    expect(consoleData).toContain("if (!ref.trim() || inspectBusy) return;");
    // Le bouton d'inspection est un bouton réel du JSX.
    expect(consoleData).toContain("? \"Inspection…\" : \"Inspecter\"");
  });

  it("l'inspection restitue le contrat réel : splits, fichiers, échantillon, limites, datation", () => {
    // Contrat de la porte restitué tel quel — aucune métrique fabriquée.
    expect(consoleData).toContain("inspect.splits");
    expect(consoleData).toContain("inspect.files");
    expect(consoleData).toContain("inspect.columns");
    expect(consoleData).toContain("inspect.previewRows");
    expect(consoleData).toContain("inspect.notes");
    expect(consoleData).toContain("inspect.license");
    // Un champ non exposé reste signalé comme tel — jamais maquillé.
    expect(consoleData).toContain("non exposé par le hub");
    // L'échantillon est présenté comme RÉEL (lignes du hub).
    expect(consoleData).toContain("Échantillon réel");
    // Les limites honnêtes du connecteur sont listées.
    expect(consoleData).toContain("voir limites ci-dessous");
    // L'instantané est daté (pas de données présentées comme vivantes).
    expect(consoleData).toContain("Inspection générée le");
  });

  it("l'état est honnête : 401 → connexion, 429 → patientez, échec affiché", () => {
    expect(consoleData).toContain("response.status === 401");
    expect(consoleData).toContain("Connectez-vous pour inspecter un jeu du hub.");
    expect(consoleData).toContain("response.status === 429");
    expect(consoleData).toContain("Trop d'inspections : patientez un instant.");
    expect(consoleData).toContain("Inspection indisponible (réseau).");
    // Le message d'erreur est rendu avec role=alert — jamais avalé.
    expect(consoleData).toContain('role="alert"');
    // Le panneau d'inspection est annoncé (role=status).
    expect(consoleData).toContain('role="status"');
  });

  it("zéro dépendance externe : la porte consommée est uniquement la porte maison", () => {
    const sectionInspect = consoleData.slice(
      consoleData.indexOf("Inspection réelle du jeu — GET /api/training/hub/inspect"),
      consoleData.indexOf("/* Liste des datasets */"),
    );
    expect(sectionInspect).toContain("/api/training/hub/inspect");
    expect(sectionInspect).not.toMatch(/https?:\/\//);
    expect(sectionInspect).not.toContain("axios");
  });
});

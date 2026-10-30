import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * KNOWLEDGE SPACES — ESPACE DOCUMENTS (it.49) — conventions du dépôt :
 * vitest tourne en Node SANS jsdom ni @testing-library/react (cf.
 * components/chat/auto-apprentissage-rapport.test.ts). Le câblage de la
 * porte /api/knowledge dans l'espace Connaissances
 * (components/knowledge/knowledge-console.tsx + app/knowledge/page.tsx)
 * est verrouillé structurellement :
 *
 *  1. LA PORTE KNOWLEDGE EST CONSOMMÉE DANS SES TROIS MODES : GET liste
 *     (scopée par projet), POST ingestion (multipart fichiers + JSON
 *     URL — garde SSRF serveur) et DELETE retrait (fragments + miroir
 *     vectoriel côté serveur).
 *  2. L'HONNÊTETÉ DE L'INGESTION EST RESTITUÉE : les résultats par
 *     fichier sont affichés tels quels — indexé (fragments), vide (aucun
 *     texte extrait), échec (message du serveur) — jamais de succès
 *     inventé ; les métadonnées réelles du document (mime, caractères,
 *     fragments) sont affichées.
 *  3. L'ÉTAT EST HONNÊTE : 401 → « Connectez-vous », 429 → message de
 *     la porte (rate-limit 30/h), échec réseau affiché (role=alert) —
 *     jamais avalé.
 *  4. ZÉRO DÉPENDANCE EXTERNE : les portes consommées sont uniquement
 *     les portes maison (authFetch same-origin, convention du fichier).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const CONSOLE = "components/knowledge/knowledge-console.tsx";
const PAGE = "app/knowledge/page.tsx";

describe("Knowledge Spaces — espace documents (câblage /api/knowledge, it.49)", () => {
  const consoleData = read(CONSOLE);

  it("la porte knowledge est consommée dans ses trois modes (liste, ingestion, suppression)", () => {
    // GET — liste scopée par projet.
    expect(consoleData).toContain("`/api/knowledge?projectId=${projectId}`");
    // POST multipart — ingestion fichiers (≤ 10 par lot, côté porte).
    expect(consoleData).toContain('authFetch("/api/knowledge", { method: "POST", body: form }');
    // POST JSON — ingestion par URL (garde SSRF côté serveur).
    expect(consoleData).toContain('body: JSON.stringify({ url: url.trim(), projectId: selectedProject })');
    // DELETE — retrait document + fragments + miroir.
    expect(consoleData).toContain('`/api/knowledge?id=${id}`');
    expect(consoleData).toContain('{ method: "DELETE" }');
    // La page est réelle et rend la console.
    const page = read(PAGE);
    expect(page).toContain('import { KnowledgeConsole } from "@/components/knowledge/knowledge-console";');
    expect(page).toContain("<KnowledgeConsole />");
  });

  it("l'honnêteté de l'ingestion est restituée : résultats par fichier, métadonnées réelles", () => {
    // Résultats par fichier restitués tels quels — trois états possibles.
    expect(consoleData).toContain("indexé ·");
    expect(consoleData).toContain("vide (aucun texte extrait)");
    expect(consoleData).toContain("échec :");
    // Cas honnête : un projet sans document le dit.
    expect(consoleData).toContain("Aucun document pour ce projet");
    // Métadonnées réelles du document (rien de fabriqué côté client).
    expect(consoleData).toContain("doc.mimeType");
    expect(consoleData).toContain("doc.charCount");
    expect(consoleData).toContain("doc.chunkCount");
  });

  it("l'état est honnête : 401 → connexion, 429 → patientez, échec affiché", () => {
    expect(consoleData).toContain("response.status === 401");
    expect(consoleData).toContain("Connectez-vous pour gérer vos connaissances.");
    expect(consoleData).toContain("response.status === 429");
    expect(consoleData).toContain("Trop de téléversements. Réessayez dans un instant.");
    expect(consoleData).toContain("Connexion au serveur impossible. Réessayez.");
    // Les messages sont rendus (role alert + status) — jamais avalés.
    expect(consoleData).toContain('role="alert"');
    expect(consoleData).toContain('role="status"');
  });

  it("zéro dépendance externe : les portes consommées sont uniquement les portes maison", () => {
    const sectionIngestion = consoleData.slice(
      consoleData.indexOf("Ingestion RAG réelle — POST /api/knowledge"),
      consoleData.indexOf("const projetActif"),
    );
    expect(sectionIngestion).toContain("/api/knowledge");
    expect(sectionIngestion).not.toMatch(/https?:\/\//);
    expect(sectionIngestion).not.toContain("axios");
  });
});

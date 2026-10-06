import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  cleModelePourChamp,
  idDocUsageDaily,
  jourIsoUtc,
} from "@/lib/ai/usage";

/**
 * Task 102-a — garde structurel de l'agrégation « usageDaily » (quota Firestore).
 *
 * AVANT : recordAIUsage créait UN document Firestore par appel IA (collection
 * "usage", ID auto) → stockage illimité, et le lecteur admin devait lire
 * 200 documents d'appels pour un simple total.
 *
 * APRÈS : mêmes écritures (1 par appel IA) mais stockage ÷N — un seul
 * document par utilisateur et par jour UTC (collection "usageDaily",
 * ID déterministe `${userId}_${YYYYMMDD}`) mis à jour par incréments
 * atomiques en set merge. Le lecteur admin lit ces agrégats et somme les
 * compteurs "calls".
 *
 * Ces tests lisent le CONTENU SOURCE (convention « gardes structurels » du
 * dépôt) : toute régression qui réintroduirait un document par appel ou
 * casserait le contrat du lecteur admin échoue ici, même si la suite
 * comportementale ne couvre pas ce chemin.
 */

// Résolution depuis le dossier du test (import.meta.dirname = équivalent
// ESM de __dirname sous Node ≥ 20.11).
const dossierTest =
  import.meta.dirname;

const lireSource = (
  fichier: string,
) =>
  readFileSync(
    path.join(
      dossierTest,
      fichier,
    ),
    "utf8",
  );

describe("Garde structurel — lib/ai/usage.ts (agrégation usageDaily)", () => {
  const sourceUsage =
    lireSource("usage.ts");

  it("écrit dans la collection agrégée « usageDaily » et plus dans « usage » par appel", () => {
    expect(sourceUsage).toContain("usageDaily");
    // L'ancien motif créait un document à ID auto PAR APPEL IA (stockage
    // illimité) : il ne doit plus exister.
    expect(sourceUsage).not.toContain('.collection("usage")');
  });

  it("incrémente atomiquement en set merge (1 écriture par appel, 0 lecture préalable)", () => {
    // FieldValue.increment + merge: true = incrément serveur atomique :
    // sans eux, deux appels simultanés s'écraseraient (dernier gagnant)
    // ou nécessiteraient une lecture (coût quota).
    expect(sourceUsage).toContain("FieldValue.increment");
    expect(sourceUsage).toContain("merge: true");
  });

  it("construit l'ID déterministe par utilisateur+jour (${userId}_YYYYMMDD)", () => {
    // L'ID déterministe est ce qui COMPRESSE le stockage : N appels → 1 doc.
    expect(sourceUsage).toContain("${userId}_");
  });

  it("horodate le document côté serveur (updatedAt, fraîcheur de l'agrégat)", () => {
    expect(sourceUsage).toContain("serverTimestamp()");
  });
});

describe("Garde structurel — lecteur admin app/api/admin/observability/route.ts", () => {
  const sourceRoute =
    lireSource(
      path.join(
        "..",
        "..",
        "app",
        "api",
        "admin",
        "observability",
        "route.ts",
      ),
    );

  it("lit la collection agrégée « usageDaily »", () => {
    expect(sourceRoute).toContain("usageDaily");
  });

  it("somme les compteurs « calls » agrégés (Σ, pas un comptage de documents)", () => {
    // POURQUOI : chaque doc usageDaily couvre N appels — le total doit être
    // la somme des compteurs, avec repli 1 par doc si « calls » est absent.
    expect(sourceRoute).toContain("calls");
  });

  it("conserve le contrat de réponse (usageTotal + statusCounts + executions + generatedAt)", () => {
    // Contrat inchangé pour le tableau de bord admin : { executions,
    // usage: {requests, costMinor}, statusCounts, generatedAt } + no-store.
    expect(sourceRoute).toContain("usageTotal");
    expect(sourceRoute).toContain("statusCounts");
    expect(sourceRoute).toContain("executions");
    expect(sourceRoute).toContain("generatedAt");
  });
});

describe("Logique pure — clé modèle assainie et ID quotidien", () => {
  it("assainit la clé modèle pour les chemins de champ pointés (provider openai, model gpt-4.1-mini)", () => {
    // Points et tirets des noms de modèles deviennent « _ » : la clé est
    // injectée dans models.<clé>.calls — un point parasite créerait une
    // imbrication involontaire.
    expect(cleModelePourChamp("openai", "gpt-4.1-mini")).toBe("openai_gpt_4_1_mini");
  });

  it("neutralise TOUT caractère hors [A-Za-z0-9] (tiret, slash, deux-points)", () => {
    expect(cleModelePourChamp("google-vertex", "gemini/2.0:flash")).toBe("google_vertex_gemini_2_0_flash");
  });

  it("dérive l'ID quotidien déterministe de l'UTC (${userId}_${YYYYMMDD})", () => {
    expect(idDocUsageDaily("abc123DEF", new Date("2025-02-03T23:59:59.000Z"))).toBe("abc123DEF_20250203");
  });

  it("bascule sur le jour suivant après minuit UTC (frontière de réinitialisation du quota)", () => {
    expect(idDocUsageDaily("abc123DEF", new Date("2025-02-04T00:00:01.000Z"))).toBe("abc123DEF_20250204");
  });

  it("jourIsoUtc renvoie le jour au format YYYY-MM-DD UTC", () => {
    expect(jourIsoUtc(new Date("2025-12-31T23:30:00.000Z"))).toBe("2025-12-31");
  });
});

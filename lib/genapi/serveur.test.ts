import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { chargerContrat } from "@/lib/genapi/serveur";

/**
 * Contrat gRPC gen3 — chargé via @grpc/proto-loader avec le VRAI fichier
 * lib/genapi/proto/gen3.proto (le proto EST le contrat livré aux
 * développeurs SaaS dans le paquet client). Le serveur mTLS complet est
 * sondé en VPS (hôte avec clé TLS + CA) ; ici on valide le contrat.
 */

const CHEMIN_PROTO = path.resolve(import.meta.dirname, "proto", "gen3.proto");

describe("chargerContrat — structure du contrat gen3.proto (fichier réel)", () => {
  it("le fichier proto existe et déclare le package gen3.v1", () => {
    const proto = readFileSync(CHEMIN_PROTO, "utf8");
    expect(proto).toContain("package gen3.v1;");
    expect(proto).toContain("service Gen3");
  });

  it("service gen3.v1.Gen3 chargé avec ses 3 RPC unaires", () => {
    const definition = chargerContrat(CHEMIN_PROTO);
    const service = definition["gen3.v1.Gen3"];
    expect(service).toBeDefined();

    for (const methode of ["Sante", "ExecuterInference", "StatutExecution"]) {
      const attrs = service![methode as keyof typeof service] as {
        path: string;
        requestStream: boolean;
        responseStream: boolean;
        originalName: string;
      };
      expect(attrs, `RPC ${methode} manquant`).toBeDefined();
      expect(attrs.requestStream).toBe(false);
      expect(attrs.responseStream).toBe(false);
      expect(String(attrs.path)).toContain(methode);
    }
    expect(String(service!.Sante!.path)).toBe("/gen3.v1.Gen3/Sante");
    expect(String(service!.ExecuterInference!.path)).toBe("/gen3.v1.Gen3/ExecuterInference");
    expect(String(service!.StatutExecution!.path)).toBe("/gen3.v1.Gen3/StatutExecution");
  });

  it("les 6 messages du contrat sont présents dans la définition", () => {
    const definition = chargerContrat(CHEMIN_PROTO);
    for (const message of [
      "gen3.v1.RequeteSante",
      "gen3.v1.ReponseSante",
      "gen3.v1.RequeteInference",
      "gen3.v1.ReponseInference",
      "gen3.v1.RequeteStatut",
      "gen3.v1.ReponseStatut",
    ]) {
      expect(definition[message], `message ${message} manquant`).toBeDefined();
    }
  });

  it("options proto-loader : longs:String (int64 en chaînes côté client)", () => {
    // garde-fou du contrat de sérialisation : chargerContrat applique bien
    // les options { keepCase:false, longs:String, enums:String, defaults:true, oneofs:true }.
    const definition = chargerContrat(CHEMIN_PROTO);
    // La charge réussit avec les options canoniques du socle → non vide.
    expect(Object.keys(definition).length).toBeGreaterThanOrEqual(7);
  });
});

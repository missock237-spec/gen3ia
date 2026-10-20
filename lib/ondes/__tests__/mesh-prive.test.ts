import { describe, expect, it } from "vitest";

import {
  autoriserSalleMesh,
  creerTicketMesh,
  salleMeshPour,
  TICKET_MESH_TTL_MS,
  verifierTicketMesh,
} from "@/lib/ondes/mesh-prive";

/* ------------------------------------------------------------------ */
/* MESH PRIVÉ — tickets d'admission signés : sans ticket valide, aucune  */
/* salle privée ne peut être rejointe ni lue (plan Entreprise).          */
/* ------------------------------------------------------------------ */

describe("creerTicketMesh / verifierTicketMesh", () => {
  it("le ticket délivré est valide et porte la salle du compte", () => {
    const { ticket, salle, expireDansMs } = creerTicketMesh("u1");
    expect(expireDansMs).toBe(TICKET_MESH_TTL_MS);
    expect(salle).toMatch(/^mesh-[0-9a-f]{24}$/);

    const verdict = verifierTicketMesh(ticket);
    expect(verdict.valide).toBe(true);
    if (verdict.valide) {
      expect(verdict.salle).toBe(salle);
      expect(verdict.uid).toBe("u1");
    }
  });

  it("la salle privée est déterministe par compte et distincte entre comptes", () => {
    expect(salleMeshPour("u1")).toBe(salleMeshPour("u1"));
    expect(salleMeshPour("u1")).not.toBe(salleMeshPour("u2"));
  });

  it("un ticket falsifié (corps modifié) est refusé", () => {
    const { ticket } = creerTicketMesh("u1");
    const morceaux = ticket.split(".");
    const corps = Buffer.from(morceaux[1], "base64url").toString("utf-8");
    const falsifie = corps.replace("mesh-", "MESH-");
    morceaux[1] = Buffer.from(falsifie, "utf-8").toString("base64url");
    const verdict = verifierTicketMesh(morceaux.join("."));
    expect(verdict).toEqual({ valide: false, raison: "signature" });
  });

  it("un ticket d'un autre compte est refusé (signature invalide pour ce corps)", () => {
    const { ticket } = creerTicketMesh("u1");
    // Un attaquant remplace le corps par celui d'une salle qu'il possède :
    // le HMAC ne correspond plus (il ne possède pas la clé).
    const corpsFalsifie = Buffer.from(
      JSON.stringify({ salle: "mesh-attaque", uid: "u1", exp: Date.now() + 60_000 }),
      "utf-8",
    ).toString("base64url");
    const faux = `v1.${corpsFalsifie}.${ticket.split(".")[2]}`;
    expect(verifierTicketMesh(faux)).toEqual({ valide: false, raison: "signature" });
  });

  it("un ticket expiré est refusé (raison explicite)", () => {
    const { ticket } = creerTicketMesh("u1", Date.now() - TICKET_MESH_TTL_MS - 1000);
    expect(verifierTicketMesh(ticket)).toEqual({ valide: false, raison: "expire" });
  });

  it("une entrée non-textuelle est refusée sans exception", () => {
    expect(verifierTicketMesh(undefined)).toEqual({ valide: false, raison: "format" });
    expect(verifierTicketMesh(null)).toEqual({ valide: false, raison: "format" });
    expect(verifierTicketMesh(42)).toEqual({ valide: false, raison: "format" });
    expect(verifierTicketMesh("n'importe quoi")).toEqual({ valide: false, raison: "format" });
  });
});

describe("autoriserSalleMesh — le ticket doit porter la salle EXACTE", () => {
  it("admet le bon couple (salle, ticket)", () => {
    const { ticket, salle } = creerTicketMesh("u1");
    const verdict = autoriserSalleMesh(salle, ticket);
    expect(verdict.valide).toBe(true);
  });

  it("refuse le REJOU d'un ticket valide vers une AUTRE salle", () => {
    const { ticket, salle } = creerTicketMesh("u1");
    const verdict = autoriserSalleMesh(`${salle}-autre`, ticket);
    expect(verdict).toEqual({ valide: false, raison: "signature" });
  });

  it("refuse sans ticket (même sur une salle privée valide)", () => {
    const { salle } = creerTicketMesh("u1");
    expect(autoriserSalleMesh(salle, undefined)).toEqual({ valide: false, raison: "format" });
    expect(autoriserSalleMesh(salle, null)).toEqual({ valide: false, raison: "format" });
  });
});

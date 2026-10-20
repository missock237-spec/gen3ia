import { describe, expect, it } from "vitest";

import {
  chiffrerPourUtilisateur,
  dechiffrerPourUtilisateur,
  empreinteIp,
  scellerArtefact,
  verifierSceau,
} from "@/lib/security/forteresse";

/* ------------------------------------------------------------------ */
/* FORTERESSE — chiffrement au repos, scellement, confidentialité des    */
/* journaux. Toutes les primitives sont cryptographiquement réelles.     */
/* ------------------------------------------------------------------ */

describe("chiffrement au repos (AES-256-GCM par utilisateur)", () => {
  it("l'aller-retour restitue le texte exact", () => {
    const secret = '{"format":"gen3-language-model","modele":{"paires":[1,2,3]}}';
    const enveloppe = chiffrerPourUtilisateur(secret, "u1");
    expect(enveloppe).toContain("gen3ia-chiffre-v1");
    expect(enveloppe).not.toContain("gen3-language-model");
    const dechiffre = dechiffrerPourUtilisateur(enveloppe, "u1");
    expect(dechiffre).toEqual({ ok: true, texte: secret });
  });

  it("un autre compte ne peut PAS déchiffrer (clé dérivée par utilisateur)", () => {
    const enveloppe = chiffrerPourUtilisateur("données confidentielles", "u1");
    expect(dechiffrerPourUtilisateur(enveloppe, "voleur")).toEqual({ ok: false, raison: "invalide" });
  });

  it("toute altération du blob est détectée (tag GCM)", () => {
    const enveloppe = chiffrerPourUtilisateur("données confidentielles", "u1");
    const objet = JSON.parse(enveloppe) as { data: string };
    // Un octet du texte chiffré est modifié.
    const data = Buffer.from(objet.data, "base64");
    data[0] ^= 0xff;
    objet.data = data.toString("base64");
    expect(dechiffrerPourUtilisateur(JSON.stringify(objet), "u1")).toEqual({ ok: false, raison: "invalide" });
  });

  it("deux chiffrages du même texte diffèrent (IV aléatoire) — pas de corrélation", () => {
    const a = chiffrerPourUtilisateur("même texte", "u1");
    const b = chiffrerPourUtilisateur("même texte", "u1");
    expect(a).not.toBe(b);
  });

  it("un texte non enveloppé est signalé 'format' (jamais d'exception)", () => {
    expect(dechiffrerPourUtilisateur("artefact nu historique", "u1")).toEqual({ ok: false, raison: "format" });
    expect(dechiffrerPourUtilisateur("", "u1")).toEqual({ ok: false, raison: "format" });
  });
});

describe("scellement d'artefacts (anti-falsification)", () => {
  const corps = '{"format":"gen3-language-model","poids":{"a":0.35}}';

  it("un artefact scellé est vérifié valide", () => {
    const enveloppe = scellerArtefact(corps, "artefact-modele");
    expect(verifierSceau(enveloppe, "artefact-modele")).toEqual({ valide: true });
  });

  it("un octet modifié casse le sceau : refus explicite", () => {
    const enveloppe = scellerArtefact(corps, "artefact-modele");
    const objet = JSON.parse(enveloppe) as { corps: string };
    objet.corps = objet.corps.replace("0.35", "0.99"); // attaque réaliste : changer un poids
    expect(verifierSceau(JSON.stringify(objet), "artefact-modele")).toEqual({ valide: false, raison: "falsifie" });
  });

  it("un sceau lié à un AUTRE contexte est refusé (anti-détournement de type)", () => {
    const enveloppe = scellerArtefact(corps, "artefact-modele");
    expect(verifierSceau(enveloppe, "autre-contexte")).toEqual({ valide: false, raison: "format" });
  });

  it("un texte non scellé est signalé 'format' (rétrocompatibilité)", () => {
    expect(verifierSceau(corps, "artefact-modele")).toEqual({ valide: false, raison: "format" });
  });
});

describe("confidentialité des journaux (empreinte IP)", () => {
  it("l'IP brute n'apparaît JAMAIS dans l'empreinte", () => {
    const empreinte = empreinteIp("209.74.86.62");
    expect(empreinte).toBeDefined();
    expect(empreinte).not.toContain("209.74.86.62");
    expect(empreinte!.length).toBe(16);
  });

  it("l'empreinte est stable dans la journée, tournante d'un jour à l'autre", () => {
    const matin = Date.UTC(2026, 0, 10, 8, 0, 0);
    const soir = Date.UTC(2026, 0, 10, 22, 0, 0);
    const lendemain = Date.UTC(2026, 0, 11, 8, 0, 0);
    expect(empreinteIp("1.2.3.4", matin)).toBe(empreinteIp("1.2.3.4", soir));
    expect(empreinteIp("1.2.3.4", matin)).not.toBe(empreinteIp("1.2.3.4", lendemain));
  });

  it("absence d'IP → absence d'empreinte (pas de valeur fantôme)", () => {
    expect(empreinteIp(undefined)).toBeUndefined();
  });
});

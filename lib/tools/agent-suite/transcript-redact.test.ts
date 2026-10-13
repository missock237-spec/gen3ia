import { describe, expect, it } from "vitest";

/**
 * Tool « transcript.redact » (Task 140) — masquage déterministe des données
 * sensibles d'une transcription d'appel.
 *
 * Verrous :
 *  1. ORDRE d'application : cartes AVANT téléphones (un PAN à 16 chiffres
 *     n'est jamais traité comme un numéro de téléphone) ;
 *  2. PAN : validation Luhn stricte — une séquence à 16 chiffres invalide
 *     reste intacte ;
 *  3. mise en page préservée + 4 derniers chiffres visibles (cartes, IBAN,
 *     téléphones), NIR intégralement masqué ;
 *  4. idempotence : une seconde application ne rajoute AUCUN masque ;
 *  5. métadonnées { type, index, length } — jamais le secret capturé ;
 *  6. motifs personnalisés : invalides → signalés et ignorés, jamais crash ;
 *  7. schéma d'entrée zod strict (bornes, défauts d'options).
 */

import { passesLuhn, transcriptRedactTool } from "./transcript-redact";

const CONTEXT = { userId: "user-1", executionId: "exec-redact-1" };

async function redact(transcript: string, options?: Record<string, unknown>) {
  const parsed = transcriptRedactTool.inputSchema.parse(
    options ? { transcript, options } : { transcript },
  );
  return transcriptRedactTool.execute(parsed, CONTEXT);
}

/* ──────────────────────────────────────────────────────────────────── */
/* Schéma d'entrée                                                     */
/* ──────────────────────────────────────────────────────────────────── */

describe("transcript.redact — schéma d'entrée", () => {
  it("applique les défauts d'options (tout activé) via prefault", () => {
    const parsed = transcriptRedactTool.inputSchema.parse({ transcript: "coucou" });
    expect(parsed.options.cardNumbers).toBe(true);
    expect(parsed.options.credentials).toBe(true);
    expect(parsed.options.personalData).toBe(true);
  });

  it("refuse une transcription vide ou trop longue", () => {
    expect(() => transcriptRedactTool.inputSchema.parse({ transcript: "" })).toThrow();
    expect(() =>
      transcriptRedactTool.inputSchema.parse({ transcript: "a".repeat(200_001) }),
    ).toThrow();
  });

  it("refuse plus de 10 motifs personnalisés", () => {
    const customPatterns = Array.from({ length: 11 }, (_, i) => ({
      name: `motif-${i}`,
      pattern: `X${i}+`,
    }));
    expect(() =>
      transcriptRedactTool.inputSchema.parse({
        transcript: "coucou",
        options: { customPatterns },
      }),
    ).toThrow();
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* Luhn                                                                */
/* ──────────────────────────────────────────────────────────────────── */

describe("transcript.redact — validation Luhn", () => {
  it("accepte les numéros de test canoniques et refuse les invalides", () => {
    expect(passesLuhn("4111111111111111")).toBe(true); // Visa
    expect(passesLuhn("378282246310005")).toBe(true); // Amex
    expect(passesLuhn("1234567890123456")).toBe(false);
    expect(passesLuhn("4111111111111112")).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* Cartes bancaires                                                    */
/* ──────────────────────────────────────────────────────────────────── */

describe("transcript.redact — cartes bancaires", () => {
  it("(a) masque le Visa de test 4111111111111111 dans plusieurs mises en page, 4 derniers chiffres visibles", async () => {
    const layouts = [
      { in: "Carte 4111111111111111", out: "Carte ••••••••••••1111" },
      { in: "Carte 4111 1111 1111 1111", out: "Carte •••• •••• •••• 1111" },
      { in: "Carte 4111-1111-1111-1111", out: "Carte ••••-••••-••••-1111" },
    ];
    for (const layout of layouts) {
      const result = await redact(layout.in);
      expect(result.redacted).toBe(layout.out);
      expect(result.redacted).toContain("1111");
      expect(result.redacted).not.toContain("4111111111111111");
      expect(result.byType.cartes).toBe(1);
    }
  });

  it("(a-bis) masque un Amex 378282246310005 (15 chiffres) en gardant 4 chiffres", async () => {
    const result = await redact("Amex 378282246310005");
    expect(result.redacted).toBe("Amex •••••••••••0005");
    expect(result.byType.cartes).toBe(1);
  });

  it("(b) laisse intacte une séquence à 16 chiffres INVALIDE au Luhn", async () => {
    const result = await redact("Commande 1234567890123456 enregistrée");
    expect(result.redacted).toBe("Commande 1234567890123456 enregistrée");
    expect(result.totalRedactions).toBe(0);
    expect(result.byType.cartes).toBeUndefined();
  });

  it("(c) ordre cartes avant téléphones : le PAN ET le téléphone sont masqués chacun pour ce qu'ils sont", async () => {
    const result = await redact(
      "Mon numéro de carte est 4111 1111 1111 1111, appelez le 06 12 34 56 78",
    );
    expect(result.redacted).toBe(
      "Mon numéro de carte est •••• •••• •••• 1111, appelez le •• •• •• 56 78",
    );
    expect(result.byType).toEqual({ cartes: 1, telephones: 1 });
    expect(result.totalRedactions).toBe(2);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* IBAN / CVV / NIR                                                    */
/* ──────────────────────────────────────────────────────────────────── */

describe("transcript.redact — IBAN, CVV contextuel et NIR", () => {
  it("(e) masque un IBAN français en conservant la mise en page et 4 caractères", async () => {
    const result = await redact("Virement sur FR76 3000 6000 0112 3456 7890 123 svp");
    expect(result.redacted).not.toContain("FR76");
    expect(result.redacted).not.toContain("3000 6000");
    expect(result.redacted).toContain("123");
    // La longueur du segment (layout espaces compris) est préservée.
    expect(result.redacted).toMatch(/•••• •••• •••• •••• •••0 123/);
    expect(result.byType.iban).toBe(1);
  });

  it("(e-bis) ignore un faux IBAN français de longueur incompatible", async () => {
    // FR + 20 caractères = 22 ≠ 27 : pas un IBAN FR valide.
    const result = await redact("IBAN FR76 3000 6000 0112 3456 7890");
    expect(result.byType.iban).toBeUndefined();
    expect(result.redacted).toContain("FR76 3000 6000 0112 3456 7890");
  });

  it("(f) masque le CVV contextuel (FR et EN) sans toucher aux mots du contexte", async () => {
    const fr = await redact("Le cryptogramme visuel est 789 au dos");
    expect(fr.redacted).toBe("Le cryptogramme visuel est ••• au dos");
    expect(fr.byType.cvv).toBe(1);

    const en = await redact("My cvv code: 4567 please");
    expect(en.redacted).toBe("My cvv code: •••• please");
    expect(en.byType.cvv).toBe(1);
  });

  it("masque un NIR français intégralement (aucun chiffre conservé)", async () => {
    const result = await redact("NIR 2 69 05 49 387 157 33");
    expect(result.redacted).toBe("NIR • •• •• •• ••• ••• ••");
    expect(result.byType.nir).toBe(1);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* Identifiants / emails / motifs personnalisés                        */
/* ──────────────────────────────────────────────────────────────────── */

describe("transcript.redact — identifiants, emails et motifs personnalisés", () => {
  it("(d) masque le secret énoncé après « mot de passe est », mots du contexte intacts", async () => {
    const result = await redact("mon mot de passe est Secret123");
    expect(result.redacted).toBe("mon mot de passe est ••••••••");
    expect(result.byType.identifiants).toBe(1);
  });

  it("(d-bis) masque les variantes mdp / identifiant / password", async () => {
    const mdp = await redact("mdp: hunter2");
    expect(mdp.redacted).toBe("mdp: ••••••••");
    const ident = await redact("mon identifiant = User_2024!");
    expect(ident.redacted).toBe("mon identifiant = ••••••••");
  });

  it("(i) remplace les emails par [email protégé]", async () => {
    const result = await redact("Écrivez à marie.dupont@exemple.fr merci");
    expect(result.redacted).toBe("Écrivez à [email protégé] merci");
    expect(result.byType.emails).toBe(1);
  });

  it("(g) applique un motif personnalisé valide et signale un motif invalide sans crasher", async () => {
    const result = await redact("Le dossier DOS-123456 est validé.", {
      customPatterns: [
        { name: "Numéro de dossier", pattern: "DOS-[0-9]{4,6}" },
        { name: "Cassé", pattern: "([" },
      ],
    });
    expect(result.redacted).toBe("Le dossier [Numéro de dossier retiré] est validé.");
    expect(result.byType["Numéro de dossier"]).toBe(1);
    expect(result.skippedPatterns).toHaveLength(1);
    expect(result.skippedPatterns[0]?.name).toBe("Cassé");
    expect(result.skippedPatterns[0]?.reason).toMatch(/invalide/i);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* Métadonnées + options + idempotence                                 */
/* ──────────────────────────────────────────────────────────────────── */

describe("transcript.redact — métadonnées, options et idempotence", () => {
  it("produit des métadonnées { type, index, length } sans jamais exposer le secret", async () => {
    const result = await redact("CB 4111111111111111 fin");
    expect(result.matches).toEqual([{ type: "cartes", index: 3, length: 16 }]);
    expect(JSON.stringify(result.matches)).not.toContain("4111111111111111");
    expect(JSON.stringify(result.byType)).not.toContain("4111111111111111");
    expect(result.totalRedactions).toBe(1);
  });

  it("désactive chaque famille d'options indépendamment", async () => {
    const sansCartes = await redact("Carte 4111 1111 1111 1111", { cardNumbers: false });
    expect(sansCartes.redacted).toContain("4111 1111 1111 1111");
    expect(sansCartes.totalRedactions).toBe(0);

    const sansIdentifiants = await redact("mon mot de passe est Secret123", { credentials: false });
    expect(sansIdentifiants.redacted).toContain("Secret123");

    const sansPerso = await redact("Appelez le 06 12 34 56 78", { personalData: false });
    expect(sansPerso.redacted).toContain("06 12 34 56 78");
  });

  it("(h) idempotence : une seconde application n'ajoute aucun masque", async () => {
    const initial =
      "Carte 4111 1111 1111 1111, IBAN FR76 3000 6000 0112 3456 7890 123, " +
      "email marie.dupont@exemple.fr, mot de passe est Secret123, " +
      "téléphone 06 12 34 56 78, cvv 451";
    const first = await redact(initial);
    expect(first.totalRedactions).toBeGreaterThan(0);

    const second = await redact(first.redacted);
    expect(second.totalRedactions).toBe(0);
    expect(second.redacted).toBe(first.redacted);
  });
});

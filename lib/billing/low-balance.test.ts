import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cooldownElapsed,
  fireLowBalanceAlert,
  formatMinorAsFcfa,
  isLowBalance,
  isSystemEmailConfigured,
  lowBalanceCooldownMs,
  lowBalanceThresholdMinor,
  markLowBalanceNotified,
} from "./low-balance";

/**
 * Audit de production — facturation D : alerte automatique quand le solde du
 * wallet passe sous le seuil critique (500 FCFA par défaut) en cours de
 * mission. Logique pure + gardes structurels sur le câblage du wallet.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Seuil critique et cooldown (configuration)", () => {
  it("seuil par défaut : 50 000 unités mineures = 500 FCFA (audit)", () => {
    expect(lowBalanceThresholdMinor()).toBe(50_000);
  });

  it("seuil surchargeable par GEN3IA_WALLET_LOW_THRESHOLD_MINOR", () => {
    vi.stubEnv("GEN3IA_WALLET_LOW_THRESHOLD_MINOR", "120000");
    expect(lowBalanceThresholdMinor()).toBe(120_000);
  });

  it("seuil invalide ou non positif → repli sur le défaut (jamais 0 = alerte permanente)", () => {
    vi.stubEnv("GEN3IA_WALLET_LOW_THRESHOLD_MINOR", "not-a-number");
    expect(lowBalanceThresholdMinor()).toBe(50_000);
    vi.stubEnv("GEN3IA_WALLET_LOW_THRESHOLD_MINOR", "-5");
    expect(lowBalanceThresholdMinor()).toBe(50_000);
  });

  it("cooldown par défaut : 24 h, surchargeable, invalide → défaut", () => {
    expect(lowBalanceCooldownMs()).toBe(24 * 60 * 60 * 1000);
    vi.stubEnv("GEN3IA_WALLET_LOW_COOLDOWN_MS", "3600000");
    expect(lowBalanceCooldownMs()).toBe(3_600_000);
    vi.stubEnv("GEN3IA_WALLET_LOW_COOLDOWN_MS", "abc");
    expect(lowBalanceCooldownMs()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("Décision d'alerte (pure)", () => {
  it("isLowBalance : strictement sous le seuil (égalité = pas encore critique)", () => {
    expect(isLowBalance(49_999)).toBe(true);
    expect(isLowBalance(50_000)).toBe(false);
    expect(isLowBalance(200_000)).toBe(false);
  });

  it("isLowBalance : solde 0 ou négatif est critique ; NaN/Infinity jamais", () => {
    expect(isLowBalance(0)).toBe(true);
    expect(isLowBalance(-1)).toBe(true);
    expect(isLowBalance(Number.NaN)).toBe(false);
    expect(isLowBalance(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("cooldownElapsed : jamais notifié → alerte due", () => {
    expect(cooldownElapsed(undefined, Date.now())).toBe(true);
    expect(cooldownElapsed(0, Date.now())).toBe(true);
  });

  it("cooldownElapsed : notifié récemment → pas d'alerte (anti-spam)", () => {
    const now = 1_800_000_000_000;
    expect(cooldownElapsed(now - 60_000, now)).toBe(false);
  });

  it("cooldownElapsed : cooldown écoulé → alerte due ; Timestamp Firestore (toMillis) accepté", () => {
    const now = 1_800_000_000_000;
    expect(cooldownElapsed(now - 25 * 60 * 60 * 1000, now)).toBe(true);
    expect(cooldownElapsed({ toMillis: () => now - 60_000 }, now)).toBe(false);
    expect(cooldownElapsed({ toMillis: () => now - 25 * 60 * 60 * 1000 }, now)).toBe(true);
  });
});

describe("Formatage honnête XAF", () => {
  it("unités mineures → FCFA arrondi au PLANCHER (jamais plus que le solde réel)", () => {
    expect(formatMinorAsFcfa(50_000, "XAF")).toMatch(/500\s*FCFA/);
    expect(formatMinorAsFcfa(12_345, "XAF")).toMatch(/123\s*FCFA/);
    expect(formatMinorAsFcfa(0, "XAF")).toMatch(/0\s*FCFA/);
    expect(formatMinorAsFcfa(300_000, "XAF")).toMatch(/3\s?000\s*FCFA/);
  });

  it("devise non-XAF affichée telle quelle (jamais un FCFA mensonger)", () => {
    expect(formatMinorAsFcfa(50_000, "EUR")).toMatch(/500\s*EUR/);
  });
});

describe("Configuration e-mail système", () => {
  it("inactif sans RESEND_API_KEY ou EMAIL_FROM_ADDRESS", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "");
    expect(isSystemEmailConfigured()).toBe(false);
  });

  it("actif avec les deux variables (même configuration Resend que l'email agentique)", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "alertes@gen3ia.online");
    expect(isSystemEmailConfigured()).toBe(true);
  });
});

describe("Câblage wallet (structurel — le dédup atomique est non négociable)", () => {
  const wallet = read("lib/billing/wallet.ts");

  it("reserveFunds : décision + drapeau écrits dans la MÊME transaction (dédup atomique)", () => {
    expect(wallet).toContain("lowBalanceNotifiedAtMs: FieldValue.serverTimestamp()");
    expect(wallet).toContain("cooldownElapsed(walletSnap.get(\"lowBalanceNotifiedAtMs\")");
  });

  it("reserveFunds : messages d'erreur historiques PRÉSERVÉS (compatibilité UI/tests)", () => {
    expect(wallet).toContain("AI agents are stopped because the wallet balance is 0. Recharge your Gen3ia wallet to resume all agents.");
    expect(wallet).toContain("Insufficient wallet balance for this execution.");
  });

  it("hard-stop solde épuisé : l'alerte part du catch, drapeau best-effort, erreur repropagée", () => {
    expect(wallet).toContain("class InsufficientFundsError");
    expect(wallet).toContain("markLowBalanceNotified(params.userId)");
    // L'erreur d'origine doit TOUJOURS repropager (sémantique d'arrêt inchangée).
    expect(wallet).toContain("throw error;");
  });

  it("settleReservation : alerte après règlement (descente sous seuil en cours de mission)", () => {
    expect(wallet).toContain("const availableAfter = balance - params.actualChargeMinor");
    expect(wallet).toContain("...(alert ? { lowBalanceNotifiedAtMs: FieldValue.serverTimestamp() } : {})");
  });

  it("applyTopup : toute recharge réelle RÉARME le cycle d'alerte", () => {
    expect(wallet).toContain("lowBalanceNotifiedAtMs: FieldValue.delete()");
  });

  it("dispatch fire-and-forget : jamais de blocage d'une mission facturée", () => {
    expect(wallet).toContain("void fireLowBalanceAlert(");
    expect(wallet).toContain(".catch(() => undefined)");
  });
});

describe("Câblage module d'alerte (structurel)", () => {
  const alertModule = read("lib/billing/low-balance.ts");

  it("notification in-app type info, en français, avec solde et recharge", () => {
    expect(alertModule).toContain('type: "info"');
    expect(alertModule).toContain('"Solde Gen3ia critique"');
    expect(alertModule).toContain("Rechargez votre wallet");
  });

  it("e-mail système via Resend : URL API + timeout 5 s + lien de recharge", () => {
    expect(alertModule).toContain("https://api.resend.com/emails");
    expect(alertModule).toContain("AbortSignal.timeout(5_000)");
    expect(alertModule).toContain("https://gen3ia.online/billing");
  });

  it("l'e-mail système N'EST JAMAIS facturé à l'utilisateur (pas de media-meter)", () => {
    expect(alertModule).not.toContain("media-meter");
    expect(alertModule).not.toContain("billUsage");
  });

  it("profil utilisateur lu depuis users/{uid} (email), validation avant envoi", () => {
    expect(alertModule).toContain('collection("users")');
    expect(alertModule).toContain("EMAIL_RE.test(email)");
  });

  it("tous les étages sont fail-soft (aucune propagation d'erreur vers l'exécution facturée)", () => {
    expect(alertModule).toContain('console.warn("[wallet] notification basse-alerte impossible (non bloquant):"');
    expect(alertModule).toContain('console.warn("[wallet] e-mail basse-alerte impossible (non bloquant):"');
    expect(alertModule).toContain('console.warn("[wallet] drapeau basse-alerte non écrit (non bloquant):"');
  });
});

describe("Régression d'interface (exports réellement consommés)", () => {
  it("les exports consommés par wallet.ts existent", () => {
    expect(typeof fireLowBalanceAlert).toBe("function");
    expect(typeof markLowBalanceNotified).toBe("function");
    expect(typeof cooldownElapsed).toBe("function");
    expect(typeof isLowBalance).toBe("function");
  });
});
